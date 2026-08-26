import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgConnectionOptions, resolvePgCaTrust } from "../src/persistence/pg-pool.ts";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

test("no CA configured → no ssl override (connection string semantics untouched)", () => {
  assert.deepEqual(resolvePgCaTrust({}), {});
  assert.deepEqual(resolvePgCaTrust({ cert: "  " }), {});
});

test("PEM content wires into ssl.ca", () => {
  assert.deepEqual(resolvePgCaTrust({ cert: PEM }), { ssl: { ca: PEM } });
});

test("a cert file is read; inline PEM wins when both are set", () => {
  const dir = mkdtempSync(join(tmpdir(), "pgca-"));
  const file = join(dir, "root.crt");
  writeFileSync(file, PEM);
  assert.deepEqual(resolvePgCaTrust({ certFile: file }), { ssl: { ca: PEM } });
  assert.deepEqual(resolvePgCaTrust({ cert: PEM, certFile: "/nope" }), { ssl: { ca: PEM } });
});

test("an unreadable cert file fails loudly, not as silent no-verify", () => {
  assert.throws(() => resolvePgCaTrust({ certFile: "/does/not/exist.crt" }), /unreadable/);
});

test("custom CA survives node-postgres parsing of SSL URL options", async () => {
  const pg = (await import("pg")).default;
  for (const query of [
    "sslmode=require",
    "sslmode=verify-ca",
    "sslmode=verify-full",
    "sslmode=no-verify",
    "uselibpqcompat=true&sslmode=verify-ca",
  ]) {
    const options = pgConnectionOptions(
      `postgresql://user:pass@db.example.test:5433/qm?application_name=qm-core&${query}`,
      { ssl: { ca: PEM } },
    );
    const client = new pg.Client(options) as unknown as {
      connectionParameters: {
        application_name?: string;
        ssl?: { ca?: string; rejectUnauthorized?: boolean; checkServerIdentity?: unknown };
      };
    };

    assert.equal(client.connectionParameters.ssl?.ca, PEM);
    assert.equal(client.connectionParameters.application_name, "qm-core");
    assert.equal(client.connectionParameters.ssl?.rejectUnauthorized, undefined);
    assert.equal(client.connectionParameters.ssl?.checkServerIdentity, undefined);
  }
});

test("custom CA preserves mTLS and explicit direct SSL negotiation", async () => {
  const pg = (await import("pg")).default;
  const dir = mkdtempSync(join(tmpdir(), "pg-mtls-"));
  const certFile = join(dir, "client.crt");
  const keyFile = join(dir, "client.key");
  writeFileSync(certFile, "client certificate");
  writeFileSync(keyFile, "client key");
  const options = pgConnectionOptions(
    `postgresql://db.example.test/qm?sslnegotiation=direct&sslmode=no-verify&sslcert=${encodeURIComponent(certFile)}&sslkey=${encodeURIComponent(keyFile)}`,
    { ssl: { ca: PEM } },
  );
  const client = new pg.Client(options) as unknown as {
    connectionParameters: {
      ssl?: { ca?: string; cert?: string; key?: string; rejectUnauthorized?: boolean; checkServerIdentity?: unknown };
      sslnegotiation?: string;
    };
  };

  assert.equal(client.connectionParameters.ssl?.ca, PEM);
  assert.equal(client.connectionParameters.ssl?.cert, "client certificate");
  assert.equal(client.connectionParameters.ssl?.key, "client key");
  assert.equal(client.connectionParameters.ssl?.rejectUnauthorized, undefined);
  assert.equal(client.connectionParameters.ssl?.checkServerIdentity, undefined);
  assert.equal(client.connectionParameters.sslnegotiation, "direct");
});
