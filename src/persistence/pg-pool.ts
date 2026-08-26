import { readFileSync } from "node:fs";
import type { ClientConfig, Pool, PoolClient } from "pg";
import { parse, toClientConfig, type ConnectionOptions } from "pg-connection-string";
import { swallowAs } from "../util/errors.ts";
import { errMessage } from "../util/errors.ts";

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

export function assertOneStatement(stmt: string): void {
  const bare = stmt
    .replace(/--[^\n]*/g, "")
    .replace(/\$([A-Za-z0-9_]*)\$[\s\S]*?\$\1\$/g, "")
    .replace(/'(?:[^']|'')*'/g, "")
    .replace(/;\s*$/, "");
  if (bare.includes(";")) {
    throw new Error(`pg-pool: each schema element must be a single statement (found ';' in: ${stmt.slice(0, 80)}…)`);
  }
}

export function concurrentIndexName(stmt: string): string | undefined {
  return /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_$]*)\b/i.exec(stmt)?.[1];
}

async function applyDdl(pool: Pool, statements: string[]): Promise<void> {
  const ddl = await pool.connect();
  try {
    await ddl.query("SELECT pg_advisory_lock(hashtext('agent-platform:schema-init'))");
    for (const stmt of statements) {
      const indexName = concurrentIndexName(stmt);
      if (indexName) {
        const existing = await ddl.query(
          "SELECT NOT indisvalid OR NOT indisready AS invalid FROM pg_index WHERE indexrelid = to_regclass($1)",
          [indexName],
        );
        if (existing.rows[0]?.invalid) await ddl.query(`DROP INDEX CONCURRENTLY ${indexName}`);
      }
      await ddl.query(stmt);
    }
  } finally {
    await ddl
      .query("SELECT pg_advisory_unlock(hashtext('agent-platform:schema-init'))")
      .catch(swallowAs("pg-pool: schema-init unlock", undefined));
    ddl.release();
  }
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

export function createPgPool(connectionString: string, statements: string[]): PgPool {
  const schema = statements.map((s) => s.trim()).filter((s) => s.length > 0);
  for (const stmt of schema) assertOneStatement(stmt);
  let poolP: Promise<Pool> | null = null;
  function pool(): Promise<Pool> {
    if (!poolP) {
      poolP = (async () => {
        const pg = (await import("pg")).default;
        const p = new pg.Pool(pgConnectionOptions(connectionString));
        p.on("error", (err) => console.error("[pg] idle client error:", errMessage(err)));
        try {
          await applyDdl(p, schema);
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
  return { pool, q, query, schema: applySchema, close };
}
