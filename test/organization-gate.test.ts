import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity } from "../plugins/chassis/src/portal-identity.ts";
import { verifyPortalIdentity } from "../src/auth/portal-identity.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "organization-gate-test-secret";

test("a session-version claim survives chassis mint to core verify", async () => {
  const now = 1_000_000;
  const token = mintPortalIdentity({ p: "alice@default-org", sv: 3, exp: now + 60_000 }, SECRET);
  const claims = await verifyPortalIdentity(token, SECRET, now);
  assert.equal(claims?.sv, 3);
});

const SIGNING = "organization-gate-signing-secret-00001";
const CAP = "organization-gate-capability-secret-0001";
const PID = "organization-gate-portal-identity-secret";

function start(): { built: BuiltApp; base: string; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "org-gate-")),
    }),
  );
  const server = createServer(built.app, {
    signingSecret: SIGNING,
    capabilitySecret: CAP,
    portalIdentitySecret: PID,
    requireSignedPortalIdentity: true,
    organization: built.organization,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { built, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function getContexts(base: string, principalId: string, sv?: number): Promise<Response> {
  const path = `/v1/contexts?principalId=${encodeURIComponent(principalId)}`;
  const ts = Math.floor(Date.now() / 1000);
  return fetch(`${base}${path}`, {
    headers: {
      "x-timestamp": String(ts),
      "x-signature": signRequest(SIGNING, ts, `GET\n${path}\n`),
      "x-portal-identity": mintPortalIdentity(
        { p: principalId, ...(sv !== undefined ? { sv } : {}), exp: Date.now() + 60_000 },
        PID,
      ),
    },
  });
}

async function seedActive(built: BuiltApp, principalId: string) {
  await built.organization.invite({ principalId, email: null, displayName: principalId, actor: "test" });
  const user = await built.organization.setStatus({ principalId, status: "active", actor: "test" });
  assert.ok(user);
  return user;
}

test("a portal identity for an unknown principal is rejected 401", async () => {
  const srv = start();
  try {
    assert.equal((await getContexts(srv.base, "U-ghost")).status, 401);
  } finally {
    await srv.close();
  }
});

test("a seeded active user without a session version passes the gate", async () => {
  const srv = start();
  try {
    await seedActive(srv.built, "U-alice");
    assert.equal((await getContexts(srv.base, "U-alice")).status, 200);
  } finally {
    await srv.close();
  }
});

test("a matching session version passes and a stale one is rejected 401", async () => {
  const srv = start();
  try {
    const user = await seedActive(srv.built, "U-bob");
    assert.equal((await getContexts(srv.base, "U-bob", user.sessionVersion)).status, 200);
    assert.equal((await getContexts(srv.base, "U-bob", user.sessionVersion + 1)).status, 401);
    await srv.built.organization.setStatus({ principalId: "U-bob", status: "suspended", actor: "test" });
    const restored = await srv.built.organization.setStatus({
      principalId: "U-bob",
      status: "active",
      actor: "test",
    });
    assert.ok(restored && restored.sessionVersion > user.sessionVersion);
    assert.equal((await getContexts(srv.base, "U-bob", user.sessionVersion)).status, 401);
  } finally {
    await srv.close();
  }
});

test("a suspended user is rejected 401 even with a matching session version", async () => {
  const srv = start();
  try {
    await seedActive(srv.built, "U-carol");
    const suspended = await srv.built.organization.setStatus({
      principalId: "U-carol",
      status: "suspended",
      actor: "test",
    });
    assert.ok(suspended);
    assert.equal((await getContexts(srv.base, "U-carol", suspended.sessionVersion)).status, 401);
    assert.equal((await getContexts(srv.base, "U-carol")).status, 401);
  } finally {
    await srv.close();
  }
});
