import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { databaseUrlFromEnv } from "../src/util/postgres-url.ts";

test("an explicit database URL is preserved", () => {
  const databaseUrl = "postgresql://provider.example.test/qm?sslmode=require";
  assert.equal(databaseUrlFromEnv({ DATABASE_URL: databaseUrl, QM_DATABASE_MODE: "external" }), databaseUrl);
});

test("bundled PostgreSQL credentials are encoded without character restrictions", () => {
  const databaseUrl = databaseUrlFromEnv({
    QM_DATABASE_MODE: "bundled",
    POSTGRES_USER: "qm:user",
    POSTGRES_PASSWORD: "p@ss:/?#%word",
    POSTGRES_DB: "qm-prod",
    QM_POSTGRES_PORT: "6543",
  });
  assert.ok(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl });
  assert.equal(client.user, "qm:user");
  assert.equal(client.password, "p@ss:/?#%word");
  assert.equal(client.database, "qm-prod");
  assert.equal(client.port, 6543);
});

test("bundled mode does not drift to an explicit external URL", () => {
  const databaseUrl = databaseUrlFromEnv({
    QM_DATABASE_MODE: "bundled",
    DATABASE_URL: "postgresql://external.example.test/qm",
    POSTGRES_PASSWORD: "password",
  });

  assert.equal(new URL(databaseUrl!).hostname, "127.0.0.1");
});

test("an implicit database is not enabled outside bundled production mode", () => {
  assert.equal(databaseUrlFromEnv({ POSTGRES_PASSWORD: "password" }), undefined);
  assert.equal(databaseUrlFromEnv({ QM_DATABASE_MODE: "external", POSTGRES_PASSWORD: "password" }), undefined);
});
