import { createHash } from "node:crypto";
import type { Client, Pool, PoolClient } from "pg";
import { sleep } from "../util/async.ts";

export const PG_MIGRATIONS_TABLE = "qm_schema_migrations";
const PG_SCHEMA_LOCK_TIMEOUT_MS = 5 * 60_000;

export interface PgMigrationDefinition {
  id: string;
  statements: readonly string[];
  expectedChecksum?: string;
  legacyId?: string;
  transactional?: boolean;
}

export interface PgMigration extends PgMigrationDefinition {
  checksum: string;
}

export type PgMaintenanceDefinition = Pick<PgMigrationDefinition, "id" | "statements" | "transactional"> & {
  beforeMigrations?: boolean;
};

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

export function pgMigrationChecksum(statements: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(statements.map((statement) => statement.trim())))
    .digest("hex");
}

export function definePgMigration(definition: PgMigrationDefinition): PgMigration {
  const { id, legacyId, expectedChecksum } = definition;
  if (!/^[a-z0-9][a-z0-9._/-]*$/i.test(id) || id.includes("..")) {
    throw new Error(`pg-pool: invalid migration id ${JSON.stringify(id)}`);
  }
  const statements = definition.statements.map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) assertOneStatement(statement);
  const concurrent = statements.some((statement) => /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(statement));
  if (definition.transactional === false) {
    if (statements.length !== 1 || !concurrentIndexName(statements[0]!)) {
      throw new Error("pg-pool: nontransactional migrations require one idempotent concurrent index");
    }
    if (legacyId) throw new Error("pg-pool: concurrent index migrations cannot adopt a legacy record");
  } else if (concurrent) {
    throw new Error("pg-pool: concurrent indexes require a nontransactional migration");
  }
  const checksum = pgMigrationChecksum(statements);
  if (expectedChecksum !== undefined && checksum !== expectedChecksum) {
    throw new Error(`pg-pool: migration ${id} source checksum mismatch`);
  }
  return { ...definition, statements, checksum };
}

export function pgSchemaMigrations(
  prefix: string,
  statements: readonly string[],
  expectedChecksums?: readonly string[],
): PgMigrationDefinition[] {
  const definitions: PgMigrationDefinition[] = [];
  let pending: string[] = [];
  const append = (sql: string[], transactional = true) => {
    definitions.push(
      definePgMigration({
        id: `${prefix}/${String(definitions.length).padStart(4, "0")}`,
        statements: sql,
        expectedChecksum: expectedChecksums?.[definitions.length],
        ...(transactional ? {} : { transactional: false }),
      }),
    );
  };
  for (const statement of statements) {
    if (!concurrentIndexName(statement)) {
      pending.push(statement);
      continue;
    }
    if (pending.length) append(pending);
    pending = [];
    append([statement], false);
  }
  if (pending.length) append(pending);
  if (expectedChecksums && expectedChecksums.length !== definitions.length) {
    throw new Error(`pg-pool: migration ${prefix} frozen bootstrap length mismatch`);
  }
  return definitions;
}

export async function withPgSchemaLock<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
  timeoutMs = PG_SCHEMA_LOCK_TIMEOUT_MS,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("schema lock timeout must be positive");
  const client = await pool.connect();
  const deadline = performance.now() + timeoutMs;
  const held: string[] = [];
  const errors: unknown[] = [];
  let discard = false;
  let result!: T;
  try {
    for (const key of ["qm:schema-migrations", "agent-platform:schema-init"]) {
      for (;;) {
        const remaining = Math.ceil(deadline - performance.now());
        if (remaining <= 0) throw new Error("timeout acquiring schema initialization lock");
        const lockQuery = {
          text: "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
          values: [key],
          query_timeout: remaining,
        };
        const lock = await client.query<{ acquired: boolean }>(lockQuery);
        if (lock.rows[0]?.acquired === true) {
          held.push(key);
          break;
        }
        await sleep(Math.min(25, remaining));
      }
    }
    result = await run(client);
  } catch (error) {
    discard = true;
    errors.push(error);
  } finally {
    for (const key of held.reverse()) {
      try {
        const unlockQuery = {
          text: "SELECT pg_advisory_unlock(hashtext($1)) AS released",
          values: [key],
          query_timeout: 1_000,
        };
        const unlocked = await client.query<{ released: boolean }>(unlockQuery);
        if (unlocked.rows[0]?.released !== true) {
          discard = true;
          errors.push(new Error("schema initialization lock was not released"));
        }
      } catch (error) {
        discard = true;
        errors.push(error);
      }
    }
    try {
      client.release(discard);
    } catch (error) {
      errors.push(error);
      try {
        await (client as PoolClient & Pick<Client, "end">).end();
      } catch (endError) {
        errors.push(endError);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "schema initialization and cleanup failed");
  return result;
}

export async function applyPgStatements(client: PoolClient, statements: readonly string[]): Promise<void> {
  for (const statement of statements) {
    const indexName = concurrentIndexName(statement);
    if (indexName) {
      const existing = await client.query<{ invalid: boolean }>(
        "SELECT NOT indisvalid OR NOT indisready AS invalid FROM pg_index WHERE indexrelid = to_regclass($1)",
        [indexName],
      );
      if (existing.rows[0]?.invalid) await client.query(`DROP INDEX CONCURRENTLY ${indexName}`);
    }
    await client.query(statement);
  }
}

async function transaction<T>(client: PoolClient, run: () => Promise<T>): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await run();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "schema transaction and rollback failed", {
        cause: rollbackError,
      });
    }
    throw error;
  }
}

export async function applyPgMigrations(
  pool: Pool,
  definitions: readonly PgMigrationDefinition[],
  options: { maintenance?: readonly PgMaintenanceDefinition[]; lockTimeoutMs?: number } = {},
): Promise<void> {
  const migrations = definitions.map(definePgMigration);
  const maintenance = (options.maintenance ?? []).map((definition) => ({
    ...definePgMigration(definition),
    beforeMigrations: definition.beforeMigrations === true,
  }));
  if (!migrations.length && !maintenance.length) return;
  const ids = new Set<string>();
  for (const migration of migrations) {
    if (ids.has(migration.id)) throw new Error(`pg-pool: duplicate migration id ${migration.id}`);
    ids.add(migration.id);
  }
  await withPgSchemaLock(
    pool,
    async (client) => {
      const maintain = async (before: boolean) => {
        for (const operation of maintenance.filter((item) => item.beforeMigrations === before)) {
          if (operation.transactional === false) await applyPgStatements(client, operation.statements);
          else await transaction(client, () => applyPgStatements(client, operation.statements));
        }
      };
      await maintain(true);
      if (migrations.length) {
        await client.query(`CREATE TABLE IF NOT EXISTS ${PG_MIGRATIONS_TABLE}(
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
      }
      for (const migration of migrations) {
        const applied = await client.query<{ checksum: string }>(
          `SELECT checksum FROM ${PG_MIGRATIONS_TABLE} WHERE id = $1`,
          [migration.id],
        );
        if (applied.rows[0]) {
          if (applied.rows[0].checksum !== migration.checksum) {
            throw new Error(`pg-pool: migration ${migration.id} checksum mismatch`);
          }
          continue;
        }
        const execute = async () => {
          let adopted = false;
          if (migration.legacyId) {
            const legacyTable = await client.query<{ present: boolean }>(
              "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
            );
            if (legacyTable.rows[0]?.present) {
              const legacy = await client.query("SELECT id FROM schema_migrations WHERE id = $1", [migration.legacyId]);
              adopted = legacy.rows.length > 0;
            }
          }
          if (!adopted) await applyPgStatements(client, migration.statements);
          await client.query(`INSERT INTO ${PG_MIGRATIONS_TABLE}(id, checksum) VALUES ($1, $2)`, [
            migration.id,
            migration.checksum,
          ]);
        };
        if (migration.transactional === false) await execute();
        else await transaction(client, execute);
      }
      await maintain(false);
    },
    options.lockTimeoutMs,
  );
}
