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
import { CAPABILITY_TTL_MS, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "organization-gate-test-secret";

test("a session-version claim survives chassis mint to core verify", async () => {
  const now = 1_000_000;
  const token = mintPortalIdentity({ p: "alice@default-org", sv: 3, exp: now + 60_000 }, SECRET);
  const claims = await verifyPortalIdentity(token, SECRET, now);
  assert.equal(claims?.sv, 3);
  const fractional = mintPortalIdentity({ p: "alice@default-org", sv: 1.5, exp: now + 60_000 }, SECRET);
  assert.equal(await verifyPortalIdentity(fractional, SECRET, now), null);
  const impersonated = mintPortalIdentity(
    { p: "target@default-org", sv: 3, imp: "admin@default-org", isv: 5, exp: now + 60_000 },
    SECRET,
  );
  assert.equal((await verifyPortalIdentity(impersonated, SECRET, now))?.isv, 5);
  const incomplete = mintPortalIdentity(
    { p: "target@default-org", sv: 3, imp: "admin@default-org", exp: now + 60_000 },
    SECRET,
  );
  assert.equal(await verifyPortalIdentity(incomplete, SECRET, now), null);
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
    admin: built.admin,
    organization: built.organization,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { built, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function getContextsAsImpersonator(
  base: string,
  target: { principalId: string; sessionVersion: number },
  impersonator: { principalId: string; sessionVersion: number },
): Promise<Response> {
  const path = `/v1/contexts?principalId=${encodeURIComponent(target.principalId)}`;
  const ts = Math.floor(Date.now() / 1000);
  return fetch(`${base}${path}`, {
    headers: {
      "x-timestamp": String(ts),
      "x-signature": signRequest(SIGNING, ts, `GET\n${path}\n`),
      "x-portal-identity": mintPortalIdentity(
        {
          p: target.principalId,
          sv: target.sessionVersion,
          imp: impersonator.principalId,
          isv: impersonator.sessionVersion,
          exp: Date.now() + 60_000,
        },
        PID,
      ),
    },
  });
}

function postTurnAsImpersonator(
  base: string,
  target: { principalId: string; sessionVersion: number },
  impersonator: { principalId: string; sessionVersion: number },
): Promise<Response> {
  const path = "/v1/turns";
  const body = JSON.stringify({
    surface: "web",
    actor: { externalId: target.principalId },
    conversation: { kind: "dm", threadRef: "impersonated-turn" },
    text: "start",
    origin: { kind: "human" },
  });
  const ts = Math.floor(Date.now() / 1000);
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-timestamp": String(ts),
      "x-signature": signRequest(SIGNING, ts, `POST\n${path}\n${body}`),
      "x-portal-identity": mintPortalIdentity(
        {
          p: target.principalId,
          sv: target.sessionVersion,
          imp: impersonator.principalId,
          isv: impersonator.sessionVersion,
          exp: Date.now() + 60_000,
        },
        PID,
      ),
    },
    body,
  });
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

function sourceHeaders(method: string, path: string, body = ""): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "x-timestamp": String(ts),
    "x-signature": signRequest(SIGNING, ts, `${method}\n${path}\n${body}`),
  };
}

function protectedSourceRequest(
  base: string,
  method: string,
  path: string,
  principalId: string,
  sv: number,
  actorHeader: "x-consent-clicker" | "x-drop-owner",
  body = "",
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      ...sourceHeaders(method, path, body),
      ...(body ? { "content-type": "application/json" } : {}),
      [actorHeader]: principalId,
      "x-portal-identity": mintPortalIdentity({ p: principalId, sv, exp: Date.now() + 60_000 }, PID),
    },
    ...(body ? { body } : {}),
  });
}

function rawDeployment(base: string, principalId: string, sv: number): Promise<Response> {
  const path = "/d/missing/";
  const ts = Math.floor(Date.now() / 1000);
  return fetch(`${base}${path}`, {
    headers: {
      "x-timestamp": String(ts),
      "x-signature": signRequest(SIGNING, ts, `GET\n${path}\n${principalId}`),
      "x-as-principal": principalId,
      "x-portal-identity": mintPortalIdentity({ p: principalId, sv, exp: Date.now() + 60_000 }, PID),
    },
  });
}

function rawDeploymentAsImpersonator(
  base: string,
  target: { principalId: string; sessionVersion: number },
  impersonator: { principalId: string; sessionVersion: number },
): Promise<Response> {
  const path = "/d/missing/";
  const ts = Math.floor(Date.now() / 1000);
  return fetch(`${base}${path}`, {
    headers: {
      "x-timestamp": String(ts),
      "x-signature": signRequest(SIGNING, ts, `GET\n${path}\n${target.principalId}`),
      "x-as-principal": target.principalId,
      "x-portal-identity": mintPortalIdentity(
        {
          p: target.principalId,
          sv: target.sessionVersion,
          imp: impersonator.principalId,
          isv: impersonator.sessionVersion,
          exp: Date.now() + 60_000,
        },
        PID,
      ),
    },
  });
}

function rawAdminDeployment(base: string, principalId: string, sv?: number): Promise<Response> {
  const path = "/v1/admin/deployments/missing/proxy/";
  const ts = Math.floor(Date.now() / 1000);
  return fetch(`${base}${path}`, {
    headers: {
      "x-timestamp": String(ts),
      "x-signature": signRequest(SIGNING, ts, `GET\n${path}\n${principalId}`),
      "x-admin-actor": principalId,
      ...(sv === undefined
        ? {}
        : {
            "x-portal-identity": mintPortalIdentity({ p: principalId, sv, exp: Date.now() + 60_000 }, PID),
          }),
    },
  });
}

async function getSoulWithCapability(base: string, principalId: string, sessionVersion: number): Promise<Response> {
  const token = await mintCapabilityToken(
    {
      actorId: principalId,
      sessionVersion,
      scopeId: `personal:${principalId}`,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    CAP,
  );
  return fetch(`${base}/v1/soul`, { headers: { "x-agent-capability": token } });
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

test("a seeded active user without a session version is rejected 401", async () => {
  const srv = start();
  try {
    await seedActive(srv.built, "U-alice");
    assert.equal((await getContexts(srv.base, "U-alice")).status, 401);
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

test("an invited user cannot steer an existing run and is projected as a guest", async () => {
  const srv = start();
  try {
    await seedActive(srv.built, "U-steer");
    const first = await srv.built.app.turn({
      surface: "slack",
      actor: { externalId: "U-steer" },
      conversation: { kind: "dm", threadRef: "inactive-steer" },
      text: "start",
      origin: { kind: "human", messageTs: "1", entryTs: "1" },
      async: true,
    });
    assert.equal(first.status, "queued");
    const invited = await srv.built.organization.setStatus({
      principalId: "U-steer",
      status: "invited",
      actor: "test",
    });
    assert.ok(invited);
    assert.equal(srv.built.identity.classify("U-steer").type, "guest");
    const second = await srv.built.app.turn({
      surface: "slack",
      actor: { externalId: "U-steer" },
      conversation: { kind: "dm", threadRef: "inactive-steer" },
      text: "stop",
      origin: { kind: "human", messageTs: "2", entryTs: "2" },
      async: true,
    });
    assert.equal(second.status, "refused");
    assert.match(second.reason ?? "", /non-internal principals/);
    assert.deepEqual(await srv.built.signals.takePending(first.runId!), []);
  } finally {
    await srv.close();
  }
});

test("a capability minted before suspension stays revoked after the principal is reactivated", async () => {
  const srv = start();
  try {
    const original = await seedActive(srv.built, "U-capability");
    assert.equal((await getSoulWithCapability(srv.base, "U-capability", original.sessionVersion)).status, 200);
    await srv.built.organization.setStatus({
      principalId: "U-capability",
      status: "suspended",
      actor: "test",
    });
    const reactivated = await srv.built.organization.setStatus({
      principalId: "U-capability",
      status: "active",
      actor: "test",
    });
    assert.ok(reactivated && reactivated.sessionVersion > original.sessionVersion);
    assert.equal((await getSoulWithCapability(srv.base, "U-capability", original.sessionVersion)).status, 401);
  } finally {
    await srv.close();
  }
});

test("raw deployments, consent links, and secret drops enforce current organization status and session version", async () => {
  const srv = start();
  try {
    const user = await seedActive(srv.built, "U-sensitive");
    assert.notEqual((await rawDeployment(srv.base, "U-sensitive", user.sessionVersion)).status, 403);
    assert.equal((await rawDeployment(srv.base, "U-sensitive", user.sessionVersion - 1)).status, 403);
    assert.notEqual(
      (
        await protectedSourceRequest(
          srv.base,
          "GET",
          "/v1/connectors/oauth/consent/redeem/missing",
          "U-sensitive",
          user.sessionVersion,
          "x-consent-clicker",
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await protectedSourceRequest(
          srv.base,
          "GET",
          "/v1/connectors/oauth/consent/redeem/missing",
          "U-sensitive",
          user.sessionVersion - 1,
          "x-consent-clicker",
        )
      ).status,
      401,
    );
    assert.notEqual(
      (
        await protectedSourceRequest(
          srv.base,
          "GET",
          "/v1/keychain/drops/missing/form",
          "U-sensitive",
          user.sessionVersion,
          "x-drop-owner",
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await protectedSourceRequest(
          srv.base,
          "POST",
          "/v1/keychain/drops/missing",
          "U-sensitive",
          user.sessionVersion - 1,
          "x-drop-owner",
          JSON.stringify({ secret: "unused" }),
        )
      ).status,
      401,
    );
    const suspended = await srv.built.organization.setStatus({
      principalId: "U-sensitive",
      status: "suspended",
      actor: "test",
    });
    assert.ok(suspended);
    assert.equal((await rawDeployment(srv.base, "U-sensitive", suspended.sessionVersion)).status, 403);
    assert.equal(
      (
        await protectedSourceRequest(
          srv.base,
          "GET",
          "/v1/keychain/drops/missing/form",
          "U-sensitive",
          suspended.sessionVersion,
          "x-drop-owner",
        )
      ).status,
      401,
    );
  } finally {
    await srv.close();
  }
});

test("the raw admin deployment proxy requires a current portal administrator", async () => {
  const srv = start();
  try {
    const admin = await seedActive(srv.built, "admin-alice");
    assert.notEqual((await rawAdminDeployment(srv.base, "admin-alice", admin.sessionVersion)).status, 401);
    assert.equal((await rawAdminDeployment(srv.base, "admin-alice")).status, 401);
    assert.equal((await rawAdminDeployment(srv.base, "admin-alice", admin.sessionVersion - 1)).status, 401);
    const suspended = await srv.built.organization.setStatus({
      principalId: "admin-alice",
      status: "suspended",
      actor: "test",
    });
    assert.ok(suspended);
    assert.equal((await rawAdminDeployment(srv.base, "admin-alice", suspended.sessionVersion)).status, 401);
  } finally {
    await srv.close();
  }
});

test("impersonation requires the impersonator to remain active, current, and an org admin", async () => {
  const srv = start();
  try {
    const target = await seedActive(srv.built, "U-target");
    let admin = await seedActive(srv.built, "admin-alice");
    await seedActive(srv.built, "admin-bob");
    assert.equal(
      (
        await getContextsAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await postTurnAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion },
        )
      ).status,
      403,
    );
    assert.notEqual(
      (
        await rawDeploymentAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion },
        )
      ).status,
      403,
    );
    await srv.built.admin.revokeGrant(
      { id: "admin-bob", type: "internal" },
      "admin-alice",
      "org:default-org",
      "org_admin",
    );
    assert.equal(
      (
        await getContextsAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await rawDeploymentAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion },
        )
      ).status,
      403,
    );
    await srv.built.admin.createGrant(
      { id: "admin-bob", type: "internal" },
      { principalId: "admin-alice", scopeId: "org:default-org", role: "org_admin" },
    );
    await srv.built.organization.setStatus({ principalId: "admin-alice", status: "suspended", actor: "test" });
    assert.equal(
      (
        await getContextsAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await rawDeploymentAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion },
        )
      ).status,
      403,
    );
    admin = (await srv.built.organization.setStatus({
      principalId: "admin-alice",
      status: "active",
      actor: "test",
    }))!;
    assert.equal(
      (
        await getContextsAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion - 1 },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await rawDeploymentAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion - 1 },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await getContextsAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion },
        )
      ).status,
      200,
    );
    assert.notEqual(
      (
        await rawDeploymentAsImpersonator(
          srv.base,
          { principalId: "U-target", sessionVersion: target.sessionVersion },
          { principalId: "admin-alice", sessionVersion: admin.sessionVersion },
        )
      ).status,
      403,
    );
  } finally {
    await srv.close();
  }
});
