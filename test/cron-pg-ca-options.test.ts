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

test("pg-boss receives the root CA configured for PostgreSQL pools", () => {
  configurePgCaTrust({ cert: "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n" });
  try {
    createPgBossCronQueue("postgresql://db.example.test/qm?sslmode=require");
    assert.equal(
      (config?.ssl as { ca?: string } | undefined)?.ca,
      "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n",
    );
    assert.equal(config?.host, "db.example.test");
    assert.equal(config?.database, "qm");
  } finally {
    configurePgCaTrust({});
  }
});

test("pg-boss leaves connection string SSL behavior unchanged without an extra CA", () => {
  configurePgCaTrust({});
  createPgBossCronQueue("postgresql://db.example.test/qm");
  assert.equal(config?.ssl, undefined);
});
