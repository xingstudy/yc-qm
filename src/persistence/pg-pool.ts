import { createKeyedQueue } from "../util/async.ts";
import { readFileSync } from "node:fs";
import type { ClientConfig, Pool, PoolClient } from "pg";
import { parse, toClientConfig, type ConnectionOptions } from "pg-connection-string";
import {
  applyPgMigrations,
  definePgMigration as defineMigration,
  pgMigrationChecksum,
  type PgMigration,
  type PgMigrationDefinition,
  type PgMaintenanceDefinition,
} from "./pg-schema-migrations.ts";
export {
  applyPgMigrations,
  assertOneStatement,
  concurrentIndexName,
  pgMigrationChecksum,
  pgSchemaMigrations,
  PG_MIGRATIONS_TABLE,
} from "./pg-schema-migrations.ts";
export type { PgMigration, PgMigrationDefinition, PgMaintenanceDefinition } from "./pg-schema-migrations.ts";
import { errMessage, swallowAs } from "../util/errors.ts";

export type { Pool, PoolClient };

export type Rows = Record<string, unknown>[];

interface PgPoolingConfig {
  databaseUrl?: string;
  poolUrl?: string;
  caCert?: string;
  queryMax?: number;
  sessionMax?: number;
}

let poolingConfig: PgPoolingConfig = {};

export function configurePgPooling(config: PgPoolingConfig): void {
  if (config.poolUrl && !config.databaseUrl) throw new Error("DATABASE_POOL_URL requires DATABASE_URL");
  for (const [name, value] of [
    ["DATABASE_POOL_MAX", config.queryMax],
    ["DATABASE_DIRECT_POOL_MAX", config.sessionMax],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > 100)) {
      throw new Error(`${name} must be an integer between 1 and 100`);
    }
  }
  poolingConfig = { ...config };
}

const migrationQueue = createKeyedQueue();

const sharedPools = new Map<string, { pool: Pool; users: number }>();

async function retainPool(connectionString: string, kind: "query" | "session" | "migration"): Promise<Pool> {
  const pg = (await import("pg")).default;
  const key = `${kind}:${connectionString}`;
  const existing = sharedPools.get(key);
  if (existing) {
    existing.users++;
    return existing.pool;
  }
  const setting = kind === "query" ? "DATABASE_POOL_MAX" : "DATABASE_DIRECT_POOL_MAX";
  const max = { query: poolingConfig.queryMax ?? 10, session: poolingConfig.sessionMax ?? 32, migration: 1 }[kind];
  if (!Number.isInteger(max) || max < 1 || max > 100)
    throw new Error(`${setting} must be an integer between 1 and 100`);
  const trust =
    kind === "query" && connectionString === poolingConfig.poolUrl && poolingConfig.caCert
      ? { ssl: { ca: poolingConfig.caCert } }
      : pgCaOptions();
  const pool = guardedPool(
    new pg.Pool({ ...pgConnectionOptions(connectionString, trust), max, connectionTimeoutMillis: 10_000 }),
  );
  pool.on("error", (error) => console.error("[pg] idle client error:", errMessage(error)));
  sharedPools.set(key, { pool, users: 1 });
  return pool;
}

function guardedPool(pool: Pool): Pool {
  pool.on("error", () => {});
  pool.on("connect", (client) => client.on("error", (error) => console.error("[pg] client error:", errMessage(error))));
  return pool;
}

async function releasePool(
  connectionString: string,
  pool: Pool,
  kind: "query" | "session" | "migration",
): Promise<void> {
  const key = `${kind}:${connectionString}`;
  const entry = sharedPools.get(key);
  if (!entry || entry.pool !== pool) return;
  if (--entry.users === 0) {
    sharedPools.delete(key);
    await pool.end();
  }
}

function pooledDatabaseUrl(connectionString: string): string {
  const pooled = poolingConfig.poolUrl;
  if (!pooled || connectionString !== poolingConfig.databaseUrl) return connectionString;
  const directUrl = new URL(connectionString);
  const pooledUrl = new URL(pooled);
  if (
    directUrl.username !== pooledUrl.username ||
    directUrl.password !== pooledUrl.password ||
    directUrl.pathname !== pooledUrl.pathname
  ) {
    throw new Error("DATABASE_POOL_URL must preserve the DATABASE_URL database and credentials");
  }
  return pooled;
}

export interface PgQueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface PgPool {
  pool(): Promise<Pool>;
  sessionPool(): Promise<Pool>;
  q(text: string, params?: unknown[], options?: PgQueryOptions): Promise<Rows>;
  query(text: string, params?: unknown[], options?: PgQueryOptions): Promise<{ rows: Rows; rowCount: number }>;
  registerMigration(migration: PgMigrationDefinition): void;
  migrate(migration: PgMigrationDefinition): Promise<void>;
  close(): Promise<void>;
}

async function withStatementTimeout<T>(
  client: PoolClient,
  timeoutMs: number | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined) return run();
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("Query timeout must be a positive finite number");
  await client.query("BEGIN");
  try {
    await client.query(`SET LOCAL statement_timeout = ${Math.round(timeoutMs)}`);
    const result = await run();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(swallowAs("pg-pool: rollback query timeout", undefined));
    throw error;
  }
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

export function definePgMigration(
  id: string,
  statements: readonly string[],
  expectedChecksum?: string,
  legacyId?: string,
): PgMigration {
  const concurrent = statements.filter((statement) =>
    /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement),
  );
  if (concurrent.length && (concurrent.length !== statements.length || statements.length !== 1))
    return {
      id,
      statements,
      expectedChecksum,
      legacyId,
      transactional: false,
      checksum: pgMigrationChecksum(statements),
    };
  return defineMigration({
    id,
    statements,
    expectedChecksum,
    legacyId,
    ...(concurrent.length ? { transactional: false } : {}),
  });
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

const registeredMigrations = new Map<string, Map<string, PgMigration>>();
const registeredPreMigrationMaintenance = new Map<string, Map<string, PgMigration>>();
const registeredPostMigrationMaintenance = new Map<string, Map<string, PgMigration>>();
const registeredReadyMarkers = new Map<string, Set<() => void>>();
const initializationQueue = createKeyedQueue<string>();

function registerPgMigration(connectionString: string, migration: PgMigration, registry = registeredMigrations): void {
  let database = registry.get(connectionString);
  if (!database) {
    database = new Map();
    registry.set(connectionString, database);
  }
  const key = registry === registeredMigrations ? migration.id : `${migration.id}:${migration.checksum}`;
  const existing = database.get(key);
  if (existing && existing.checksum !== migration.checksum) {
    throw new Error(`pg-pool: migration ${migration.id} was registered twice with different checksums`);
  }
  database.set(key, migration);
}

export function registeredPgMigrations(connectionString: string): readonly PgMigration[] {
  return [...(registeredMigrations.get(connectionString)?.values() ?? [])].sort((a, b) => a.id.localeCompare(b.id));
}

export async function migrateRegisteredPgSchemas(connectionString?: string): Promise<void> {
  const databases = connectionString
    ? [connectionString]
    : [
        ...new Set([
          ...registeredMigrations.keys(),
          ...registeredPreMigrationMaintenance.keys(),
          ...registeredPostMigrationMaintenance.keys(),
        ]),
      ];
  for (const databaseUrl of databases)
    await initializationQueue(databaseUrl, async () => {
      const migrations = [...(registeredMigrations.get(databaseUrl)?.values() ?? [])].sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      const maintenance = [
        ...[...(registeredPreMigrationMaintenance.get(databaseUrl)?.values() ?? [])].map((operation) => ({
          ...operation,
          beforeMigrations: true,
        })),
        ...(registeredPostMigrationMaintenance.get(databaseUrl)?.values() ?? []),
      ];
      if (!migrations.length && !maintenance.length) return;
      const markers = [...(registeredReadyMarkers.get(databaseUrl) ?? [])];
      const pg = (await import("pg")).default;
      const pool = guardedPool(new pg.Pool({ ...pgConnectionOptions(databaseUrl), connectionTimeoutMillis: 10_000 }));
      pool.on("error", (error) => console.error("[pg] migration pool error:", errMessage(error)));
      try {
        await applyPgMigrations(pool, migrations, { maintenance });
        for (const mark of markers) mark();
      } finally {
        await pool.end();
      }
    });
}

export function createPgPool(connectionString: string): PgPool;
export function createPgPool(
  connectionString: string,
  migrationId: string,
  statements: readonly string[],
  maintenance?: readonly PgMaintenanceDefinition[],
): PgPool;
export function createPgPool(
  connectionString: string,
  definitions: readonly PgMigrationDefinition[],
  maintenance?: readonly PgMaintenanceDefinition[],
): PgPool;
export function createPgPool(
  connectionString: string,
  idOrDefinitions: string | readonly PgMigrationDefinition[] = [],
  statementsOrMaintenance: readonly string[] | readonly PgMaintenanceDefinition[] = [],
  maintenanceDefinitions: readonly PgMaintenanceDefinition[] = [],
): PgPool {
  const definitions =
    typeof idOrDefinitions === "string"
      ? [{ id: idOrDefinitions, statements: statementsOrMaintenance as readonly string[] }]
      : idOrDefinitions;
  const migrations = definitions.map(defineMigration);
  for (const migration of migrations) registerPgMigration(connectionString, migration);
  const maintenanceSource =
    typeof idOrDefinitions === "string"
      ? maintenanceDefinitions
      : (statementsOrMaintenance as readonly PgMaintenanceDefinition[]);
  const preMigrationMaintenance = maintenanceSource
    .filter((definition) => definition.beforeMigrations)
    .map(defineMigration);
  for (const maintenance of preMigrationMaintenance) {
    registerPgMigration(connectionString, maintenance, registeredPreMigrationMaintenance);
  }
  const postMigrationMaintenance = maintenanceSource
    .filter((definition) => !definition.beforeMigrations)
    .map(defineMigration);
  for (const maintenance of postMigrationMaintenance)
    registerPgMigration(connectionString, maintenance, registeredPostMigrationMaintenance);
  let initialized = false;
  const markReady = (): void => {
    initialized = true;
  };
  const markers = registeredReadyMarkers.get(connectionString) ?? new Set<() => void>();
  registeredReadyMarkers.set(connectionString, markers);
  markers.add(markReady);
  let readyP: Promise<void> | null = null;
  let sessionPoolP: Promise<Pool> | null = null;
  let queryPoolP: Promise<Pool> | null = null;
  let closed = false;
  const queryUrl = pooledDatabaseUrl(connectionString);
  async function withMigrationPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
    return migrationQueue(connectionString, async () => {
      const instance = await retainPool(connectionString, "migration");
      try {
        return await fn(instance);
      } finally {
        await releasePool(connectionString, instance, "migration");
      }
    });
  }
  async function ready(): Promise<void> {
    if (closed) throw new Error("Postgres store is closed");
    if (initialized) return;
    await (readyP ??= initializationQueue(connectionString, async () => {
      if (initialized) return;
      await withMigrationPool((instance) =>
        applyPgMigrations(instance, migrations, {
          maintenance: [
            ...preMigrationMaintenance.map((operation) => ({ ...operation, beforeMigrations: true })),
            ...postMigrationMaintenance,
          ],
        }),
      );
      initialized = true;
    }).catch((error) => {
      readyP = null;
      throw error;
    }));
    if (closed) throw new Error("Postgres store is closed");
  }
  async function pool(): Promise<Pool> {
    await ready();
    if (closed) throw new Error("Postgres store is closed");
    return (queryPoolP ??= retainPool(queryUrl, "query"));
  }
  async function sessionPool(): Promise<Pool> {
    await ready();
    if (closed) throw new Error("Postgres store is closed");
    return (sessionPoolP ??= retainPool(connectionString, "session"));
  }
  async function query(
    text: string,
    params: unknown[] = [],
    options: PgQueryOptions = {},
  ): Promise<{ rows: Rows; rowCount: number }> {
    const p = await pool();
    if (!options.signal && options.timeoutMs === undefined) {
      const res = await p.query(text, params);
      return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
    }
    if (!options.signal) {
      const client = await p.connect();
      let queryError: Error | undefined;
      try {
        return await withStatementTimeout(client, options.timeoutMs, async () => {
          const res = await client.query({ text, values: params });
          return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
        });
      } catch (error) {
        queryError = error instanceof Error ? error : new Error(String(error));
        throw error;
      } finally {
        client.release(queryError);
      }
    }
    if (options.signal.aborted) throw new DOMException("Postgres query cancelled", "AbortError");
    const connectPromise = p.connect();
    let connectAbort: (() => void) | undefined;
    const connectAbortPromise = new Promise<never>((_, reject) => {
      connectAbort = () => reject(new DOMException("Postgres query cancelled", "AbortError"));
      options.signal!.addEventListener("abort", connectAbort, { once: true });
    });
    let client: PoolClient;
    try {
      client = await Promise.race([connectPromise, connectAbortPromise]);
    } catch (error) {
      void connectPromise
        .then(
          (lateClient) => lateClient.release(error instanceof Error ? error : new Error(String(error))),
          () => undefined,
        )
        .catch(() => undefined);
      throw error;
    } finally {
      if (connectAbort) options.signal.removeEventListener("abort", connectAbort);
    }
    let queryError: Error | undefined;
    let released = false;
    const cancel = () => {
      if (released) return;
      released = true;
      client.release(new Error("Postgres query cancelled"));
    };
    options.signal.addEventListener("abort", cancel, { once: true });
    try {
      if (released) throw new Error("Postgres query cancelled");
      return await withStatementTimeout(client, options.timeoutMs, async () => {
        const res = await client.query({ text, values: params });
        return { rows: res.rows as Rows, rowCount: res.rowCount ?? 0 };
      });
    } catch (error) {
      queryError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", cancel);
      if (!released) client.release(queryError);
    }
  }
  async function q(text: string, params: unknown[] = [], options?: PgQueryOptions): Promise<Rows> {
    return (await query(text, params, options)).rows;
  }
  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    markers.delete(markReady);
    if (!markers.size) registeredReadyMarkers.delete(connectionString);
    await readyP?.catch(() => {});
    await Promise.all([
      queryPoolP?.then((instance) => releasePool(queryUrl, instance, "query")),
      sessionPoolP?.then((instance) => releasePool(connectionString, instance, "session")),
    ]);
  }
  async function migrate(definition: PgMigrationDefinition): Promise<void> {
    const migration = defineMigration(definition);
    registerPgMigration(connectionString, migration);
    if (closed) throw new Error("Postgres store is closed");
    await ready();
    await withMigrationPool((instance) => applyPgMigrations(instance, [migration]));
  }
  function registerMigration(definition: PgMigrationDefinition): void {
    registerPgMigration(connectionString, defineMigration(definition));
  }
  return { pool, sessionPool, q, query, registerMigration, migrate, close };
}
