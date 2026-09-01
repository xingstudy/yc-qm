import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { buildApp } from "./support/test-app.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-keychain-")) }));
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("admin-keychain-test-key"),
  });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    keychain,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, keychain, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("/v1/admin/keychain returns allowlisted metadata, grants, and asks; non-admin denied; audited", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello",
    };
    assert.equal((await s.built.app.turn(dm)).status, "ok");

    const cred = await s.keychain.save({
      ownerId: "U1",
      service: "github",
      secret: "ghp_secret",
      envKey: "GITHUB_TOKEN",
      accountLabel: "alice",
      host: "github.com",
      origin: "test fixture",
      expiresAt: Date.now() + 3_600_000,
    });
    const fieldsCred = await s.keychain.save({
      ownerId: "U1",
      service: "opensearch",
      fields: [
        { envKey: "OPENSEARCH_USER", value: "alice" },
        { envKey: "OPENSEARCH_PASS", value: "search-password" },
      ],
      origin: "test fixture",
    });
    const fileCred = await s.keychain.save({
      ownerId: "U1",
      service: "aws",
      files: [{ path: ".aws/credentials", contentBase64: Buffer.from("aws-secret").toString("base64") }],
    });
    const grant = await s.keychain.createGrant({
      credentialId: cred.id,
      ownerId: "U1",
      audienceScopeId: scopeId("channel", "C1"),
      mode: "standing",
      purpose: "use github for deploys",
    });
    const { ask } = await s.keychain.createAsk({
      credentialId: cred.id,
      requesterId: "U2",
      requesterScopeId: scopeId("channel", "C2"),
      purpose: "need github for CI",
    });

    const r = await fetch(`${s.base}/v1/admin/keychain`, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.equal(d.enabled, true);
    assert.ok(
      d.people.some(
        (p: { principalId: string; credentialCount: number }) => p.principalId === "U1" && p.credentialCount === 3,
      ),
    );
    assert.ok(
      d.people.some((p: { principalId: string }) => p.principalId === "U2"),
      "ask requester appears even without sessions",
    );
    assert.deepEqual(
      d.credentials.map((c: { id: string }) => c.id).sort(),
      [cred.id, fieldsCred.id, fileCred.id].sort(),
    );
    const projected = d.credentials.find((c: { id: string }) => c.id === cred.id);
    const projectedFields = d.credentials.find((c: { id: string }) => c.id === fieldsCred.id);
    const projectedFile = d.credentials.find((c: { id: string }) => c.id === fileCred.id);
    assert.deepEqual(Object.keys(projected).sort(), [
      "accountLabel",
      "envKey",
      "expiresAt",
      "host",
      "id",
      "kind",
      "ownerId",
      "service",
    ]);
    assert.deepEqual(Object.keys(projectedFields).sort(), ["id", "kind", "ownerId", "service"]);
    assert.deepEqual(Object.keys(projectedFile).sort(), ["id", "kind", "ownerId", "service", "targets"]);
    assert.deepEqual(projectedFile.targets, [".aws/credentials"]);
    assert.equal(d.grants[0].id, grant.id);
    assert.equal(d.asks[0].id, ask.id);
    assert.ok(!JSON.stringify(d).includes("ghp_secret"), "admin projection must not include secret material");
    assert.ok(!JSON.stringify(d).includes("search-password"), "field credential values must not enter admin metadata");

    const denied = await fetch(`${s.base}/v1/admin/keychain`, { headers: { "x-admin-actor": "user-uma@default-org" } });
    assert.equal(denied.status, 403);
    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "keychain.read"));
  } finally {
    await s.close();
  }
});

test("/v1/admin/keychain remains available through signed Portal identity", async () => {
  const signingSecret = "admin-keychain-source-secret".repeat(3);
  const capabilitySecret = "admin-keychain-capability-secret".repeat(3);
  const portalIdentitySecret = "admin-keychain-portal-secret".repeat(3);
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-keychain-portal-")) }));
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: deriveConnectorKey("admin-keychain-portal-key"),
  });
  const server = createServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    keychain,
    signingSecret,
    capabilitySecret,
    portalIdentitySecret,
    requireSignedPortalIdentity: true,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    const pathname = "/v1/admin/keychain";
    const timestamp = Math.floor(Date.now() / 1000);
    const response = await fetch(`${base}${pathname}`, {
      headers: {
        "x-timestamp": String(timestamp),
        "x-signature": signRequest(signingSecret, timestamp, `GET\n${pathname}\n`),
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
          { p: "admin-alice", exp: Date.now() + 60_000 },
          portalIdentitySecret,
        ),
      },
    });
    assert.equal(response.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
