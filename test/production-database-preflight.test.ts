import assert from "node:assert/strict";
import { mock, test } from "node:test";

let releaseLock = true;
let tlsActive = true;
let ended = false;
let queries: string[] = [];

class FakeClient {
  constructor(config: Record<string, unknown>) {
    assert.equal(config.connectionTimeoutMillis, 5000);
    assert.equal(config.query_timeout, 5000);
    assert.equal(config.statement_timeout, 5000);
  }

  async connect(): Promise<void> {}

  async query<T>(text: string): Promise<{ rows: T[] }> {
    queries.push(text);
    if (text.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true } as T] };
    if (text.includes("AS released")) return { rows: [{ released: releaseLock } as T] };
    if (text.includes("pg_stat_ssl")) return { rows: [{ ssl: tlsActive } as T] };
    return { rows: [] };
  }

  async end(): Promise<void> {
    ended = true;
  }
}

mock.module("pg", { defaultExport: { Client: FakeClient } });

const { productionDatabaseProblem } = await import("../scripts/production-preflight.ts");

test("database preflight verifies query, advisory lock round-trip, and notification support", async () => {
  releaseLock = true;
  tlsActive = true;
  ended = false;
  queries = [];

  const problem = await productionDatabaseProblem({
    QM_DATABASE_MODE: "external",
    QM_DATABASE_TRANSPORT: "private-network",
    DATABASE_URL: "postgresql://provider-user:provider-password@db.provider.test/qm",
  });

  assert.equal(problem, undefined);
  assert.equal(ended, true);
  assert.ok(queries.includes("SELECT 1"));
  assert.ok(queries.some((query) => query.includes("pg_try_advisory_lock")));
  assert.ok(queries.some((query) => query.includes("pg_advisory_unlock")));
  assert.ok(queries.some((query) => query.startsWith("LISTEN qm_preflight_")));
  assert.ok(queries.some((query) => query.startsWith("UNLISTEN qm_preflight_")));
});

test("database preflight rejects a session whose advisory lock cannot be released without leaking credentials", async () => {
  releaseLock = false;
  ended = false;
  queries = [];

  const problem = await productionDatabaseProblem({
    QM_DATABASE_MODE: "external",
    QM_DATABASE_TRANSPORT: "private-network",
    DATABASE_URL: "postgresql://provider-user:provider-password@db.provider.test/qm",
  });

  assert.equal(problem, "database does not provide required session features");
  assert.equal(ended, true);
  assert.doesNotMatch(problem, /provider-user|provider-password|db\.provider/);
});

test("database preflight rejects a declared TLS transport when PostgreSQL reports plaintext", async () => {
  releaseLock = true;
  tlsActive = false;
  ended = false;
  queries = [];

  const problem = await productionDatabaseProblem({
    QM_DATABASE_MODE: "external",
    QM_DATABASE_TRANSPORT: "tls",
    DATABASE_URL: "postgresql://provider-user:provider-password@db.provider.test/qm",
  });

  assert.equal(problem, "database connection did not establish required TLS");
  assert.equal(ended, true);
});
