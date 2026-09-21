import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { configurePgCaTrust } from "../src/persistence/pg-pool.ts";

let config: Record<string, unknown> | undefined;

class FakePgBoss {
  constructor(options: Record<string, unknown>) {
    config = options;
  }

  on(): void {}
}

mock.module("pg-boss", { namedExports: { PgBoss: FakePgBoss } });

const { createPgBossCronQueue } = await import("../src/cron/job-queue.ts");

test("pg-boss delegates SQL through the shared PostgreSQL pool", () => {
  configurePgCaTrust({ cert: "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n" });
  try {
    createPgBossCronQueue("postgresql://db.example.test/qm?sslmode=require");
    assert.equal(typeof (config?.db as { executeSql?: unknown } | undefined)?.executeSql, "function");
    assert.equal(config?.ssl, undefined);
    assert.equal(config?.host, undefined);
    assert.equal(config?.database, undefined);
  } finally {
    configurePgCaTrust({});
  }
});

test("pg-boss leaves connection string SSL behavior unchanged without an extra CA", () => {
  configurePgCaTrust({});
  createPgBossCronQueue("postgresql://db.example.test/qm");
  assert.equal(config?.ssl, undefined);
});
