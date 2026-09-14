import { readFileSync } from "node:fs";
import type { ClientConfig, Pool, PoolClient } from "pg";
import { parse, toClientConfig, type ConnectionOptions } from "pg-connection-string";
import { errMessage, swallowAs } from "../util/errors.ts";

import {
  applyPgMigrations,
  applyPgStatements,
  assertOneStatement,
  definePgMigration,
  withPgSchemaLock,
  type PgMaintenanceDefinition,
  type PgMigrationDefinition,
} from "./pg-schema-migrations.ts";

export { assertOneStatement, concurrentIndexName, pgSchemaMigrations } from "./pg-schema-migrations.ts";

export type { Pool, PoolClient };

export type Rows = Record<string, unknown>[];

export interface PgPool {
  pool(): Promise<Pool>;
  q(text: string, params?: unknown[]): Promise<Rows>;
  query(text: string, params?: unknown[]): Promise<{ rows: Rows; rowCount: number }>;
  schema?(schemaSql: string): Promise<void>;
  close(): Promise<void>;
}

export async function withPgTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyDdl(pool: Pool, statements: readonly string[]): Promise<void> {
  if (!statements.length) return;
  await withPgSchemaLock(pool, (client) => applyPgStatements(client, statements));
}

export function resolvePgCaTrust(opts: { cert?: string; certFile?: string }): { ssl?: { ca: string } } {
  if (opts.cert?.trim()) return { ssl: { ca: opts.cert } };
  if (opts.certFile?.trim()) {
    try {
      return { ssl: { ca: readFileSync(opts.certFile, "utf8") } };
    } catch (e) {
      throw new Error(`DATABASE_CA_CERT_FILE is set but unreadable (${opts.certFile}): ${errMessage(e)}`, {
        cause: e,
      });
    }
  }
  return {};
}

let installedCaTrust: { ssl?: { ca: string } } = {};

export function configurePgCaTrust(opts: { cert?: string; certFile?: string }): void {
  installedCaTrust = resolvePgCaTrust(opts);
}

export function configurePgCaTrustFromEnv(env: NodeJS.ProcessEnv): void {
  configurePgCaTrust({ cert: env.DATABASE_CA_CERT, certFile: env.DATABASE_CA_CERT_FILE });
}

export function pgCaOptions(): { ssl?: { ca: string } } {
  return installedCaTrust;
}

export type PgConnectionConfig = ClientConfig & { sslnegotiation?: "postgres" | "direct" };

export function pgConnectionOptions(
  connectionString: string,
  caTrust: { ssl?: { ca: string } } = pgCaOptions(),
): PgConnectionConfig {
  if (!caTrust.ssl) return { connectionString };
  const url = new URL(connectionString);
  url.searchParams.delete("sslrootcert");
  url.searchParams.delete("uselibpqcompat");
  const config = parse(url.toString());
  const ssl = (typeof config.ssl === "object" && config.ssl ? config.ssl : {}) as Record<string, unknown>;
  const {
    ca: _ca,
    checkServerIdentity: _checkServerIdentity,
    rejectUnauthorized: _rejectUnauthorized,
    ...clientAuth
  } = ssl;
  return toClientConfig({
    ...config,
    ssl: { ...clientAuth, ca: caTrust.ssl.ca },
  } as ConnectionOptions) as PgConnectionConfig;
}

export function pgConnectionOptionsFromEnv(
  connectionString: string | undefined,
  env: NodeJS.ProcessEnv,
): PgConnectionConfig {
  if (!connectionString) return {};
  return pgConnectionOptions(
    connectionString,
    resolvePgCaTrust({ cert: env.DATABASE_CA_CERT, certFile: env.DATABASE_CA_CERT_FILE }),
  );
}

interface ConcretePgPool extends PgPool {
  sessionPool(): Promise<Pool>;
}

export function createPgPool(connectionString: string, statements: readonly string[]): ConcretePgPool;
export function createPgPool(
  connectionString: string,
  definitions: readonly PgMigrationDefinition[],
  maintenance?: readonly PgMaintenanceDefinition[],
): ConcretePgPool;
export function createPgPool(
  connectionString: string,
  migrationId: string,
  statements: readonly string[],
  maintenance?: readonly PgMaintenanceDefinition[],
): ConcretePgPool;
export function createPgPool(
  connectionString: string,
  input: string | readonly string[] | readonly PgMigrationDefinition[],
  statementsOrMaintenance: readonly string[] | readonly PgMaintenanceDefinition[] = [],
  maintenanceDefinitions: readonly PgMaintenanceDefinition[] = [],
): ConcretePgPool {
  const legacy =
    Array.isArray(input) && (input.length === 0 ? statementsOrMaintenance.length === 0 : typeof input[0] === "string");
  const schema = legacy ? (input as readonly string[]).map((s) => s.trim()).filter(Boolean) : [];
  for (const stmt of schema) assertOneStatement(stmt);
  let definitions: readonly PgMigrationDefinition[] = [];
  if (!legacy) {
    if (typeof input === "string")
      definitions = [{ id: input, statements: statementsOrMaintenance as readonly string[] }];
    else definitions = input as readonly PgMigrationDefinition[];
  }
  const migrations = definitions.map(definePgMigration);
  const maintenance =
    typeof input === "string"
      ? maintenanceDefinitions
      : (statementsOrMaintenance as readonly PgMaintenanceDefinition[]);
  let poolP: Promise<Pool> | null = null;
  function pool(): Promise<Pool> {
    if (!poolP) {
      poolP = (async () => {
        const pg = (await import("pg")).default;
        const p = new pg.Pool(pgConnectionOptions(connectionString));
        p.on("error", (err) => console.error("[pg] idle client error:", errMessage(err)));
        try {
          if (legacy) await applyDdl(p, schema);
          else await applyPgMigrations(p, migrations, { maintenance });
        } catch (e) {
          await p.end().catch(swallowAs("pg-pool: close after schema failure", undefined));
          throw e;
        }
        return p;
      })().catch((e) => {
        poolP = null;
        throw e;
      });
    }
    return poolP;
  }
  async function query(text: string, params: unknown[] = []): Promise<{ rows: Rows; rowCount: number }> {
    const res = await (await pool()).query(text, params);
    return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
  }
  async function q(text: string, params: unknown[] = []): Promise<Rows> {
    return (await query(text, params)).rows;
  }
  async function close(): Promise<void> {
    if (poolP) await (await poolP).end();
  }
  async function applySchema(schemaSql: string): Promise<void> {
    const stmt = schemaSql.trim();
    assertOneStatement(stmt);
    await applyDdl(await pool(), [stmt]);
  }
  return { pool, sessionPool: pool, q, query, schema: applySchema, close };
}
