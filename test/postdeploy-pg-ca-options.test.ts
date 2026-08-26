import assert from "node:assert/strict";
import { mock, test } from "node:test";

let config: Record<string, unknown> | undefined;

class FakeClient {
  constructor(options: Record<string, unknown>) {
    config = options;
  }

  async connect(): Promise<void> {}

  async query(): Promise<{ rows: unknown[] }> {
    return { rows: [] };
  }

  async end(): Promise<void> {}
}

mock.module("pg", { defaultExport: { Client: FakeClient } });

const { checkPostdeployDatabase } = await import("../src/deployment/postdeploy-smoke.ts");

test("postdeploy database smoke preserves a custom CA when the URL has sslmode", async () => {
  await checkPostdeployDatabase({
    databaseUrl: "postgresql://db.example.test/qm?sslmode=verify-full",
    databaseCaCert: "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n",
  });

  assert.equal(
    (config?.ssl as { ca?: string } | undefined)?.ca,
    "-----BEGIN CERTIFICATE-----\\nMIIB\\n-----END CERTIFICATE-----\\n",
  );
  assert.equal(config?.host, "db.example.test");
});
