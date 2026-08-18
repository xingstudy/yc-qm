import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "test-signing-secret".repeat(3);
const PATH = "/v1/internal/auth/users/login";
const PID = "portal-identity-secret-for-org-tests-01";
const CAP = "capability-secret-for-org-tests-000001";
const INVITE_PATH = "/v1/admin/org/users";

function start(overrides: Partial<Config> = {}): { built: BuiltApp; base: string; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "org-login-")),
      ...overrides,
    }),
  );
  const server = createServer(built.app, { signingSecret: SECRET, organization: built.organization });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { built, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function startAdmin(overrides: Partial<Config> = {}): { built: BuiltApp; base: string; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "org-admin-")),
      ...overrides,
    }),
  );
  const server = createServer(built.app, {
    signingSecret: SECRET,
    capabilitySecret: CAP,
    portalIdentitySecret: PID,
    requireSignedPortalIdentity: true,
    admin: built.admin,
    organization: built.organization,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { built, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function adminFetch(
  base: string,
  method: string,
  path: string,
  portalUser: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const raw = JSON.stringify(body);
  const headers = {
    ...sign(method, path, raw),
    "x-portal-identity": await mintSignedPayload({ p: portalUser, exp: Date.now() + 60_000 }, PID),
  };
  return fetch(`${base}${path}`, { method, headers, body: raw });
}

function sign(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

function login(base: string, body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body);
  return fetch(`${base}${PATH}`, { method: "POST", headers: sign("POST", PATH, raw), body: raw });
}

const loginBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  principalId: "U-alice",
  issuer: "https://issuer.example",
  subject: "sub-1",
  email: "Alice@Example.COM",
  emailVerified: true,
  displayName: "Alice",
  ...overrides,
});

test("unsigned login request is rejected 401", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(loginBody()),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("unknown user auto-joins under domain_auto_join, then logs in via the bound identity", async () => {
  const srv = start();
  try {
    const first = await login(srv.base, loginBody());
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      status: "ok",
      user: { principalId: "U-alice", status: "active", sessionVersion: 1, displayName: "Alice" },
    });
    const second = await login(srv.base, loginBody({ principalId: "U-other", displayName: "Alice Again" }));
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), {
      status: "ok",
      user: { principalId: "U-alice", status: "active", sessionVersion: 1, displayName: "Alice Again" },
    });
  } finally {
    await srv.close();
  }
});

test("unverified email is denied email_unverified", async () => {
  const srv = start();
  try {
    const res = await login(srv.base, loginBody({ subject: "sub-unverified", emailVerified: false }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "denied", reason: "email_unverified" });
  } finally {
    await srv.close();
  }
});

test("missing or invalid fields are rejected 400", async () => {
  const srv = start();
  try {
    const bad: Array<Record<string, unknown>> = [
      loginBody({ principalId: undefined }),
      loginBody({ issuer: undefined }),
      loginBody({ subject: undefined }),
      loginBody({ principalId: "  " }),
      loginBody({ principalId: 42 }),
      loginBody({ emailVerified: "yes" }),
    ];
    for (const body of bad) {
      const res = await login(srv.base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  } finally {
    await srv.close();
  }
});

test("system:-prefixed principal ids cannot acquire human accounts", async () => {
  const srv = start();
  try {
    const res = await login(srv.base, loginBody({ principalId: "system:plugin-skills" }));
    assert.equal(res.status, 400);
  } finally {
    await srv.close();
  }
});

test("unknown user is denied not_invited under invite_only admission", async () => {
  const srv = start({ orgAdmission: "invite_only" });
  try {
    const res = await login(srv.base, loginBody());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "denied", reason: "not_invited" });
  } finally {
    await srv.close();
  }
});

test("admin invite creates an invited user with the exact response shape", async () => {
  const srv = startAdmin();
  try {
    const res = await adminFetch(srv.base, "POST", INVITE_PATH, "admin-alice", {
      principalId: "U-bob",
      email: "Bob@Example.COM",
      displayName: "Bob",
    });
    assert.equal(res.status, 200);
    const body: any = await res.json();
    assert.deepEqual(Object.keys(body), ["user"]);
    assert.deepEqual(Object.keys(body.user).sort(), [
      "createdAt",
      "createdBy",
      "displayName",
      "email",
      "lastLoginAt",
      "principalId",
      "sessionVersion",
      "status",
      "updatedAt",
      "updatedBy",
    ]);
    assert.equal(body.user.principalId, "U-bob");
    assert.equal(body.user.email, "bob@example.com");
    assert.equal(body.user.displayName, "Bob");
    assert.equal(body.user.status, "invited");
    assert.equal(body.user.sessionVersion, 1);
    assert.equal(body.user.lastLoginAt, null);
    assert.equal(body.user.createdBy, "admin-alice");
    assert.equal(body.user.updatedBy, "admin-alice");
    assert.equal(typeof body.user.createdAt, "number");
    assert.equal(typeof body.user.updatedAt, "number");
  } finally {
    await srv.close();
  }
});

test("an invited user activates through the login endpoint under invite_only admission", async () => {
  const srv = startAdmin({ orgAdmission: "invite_only" });
  try {
    const invited = await adminFetch(srv.base, "POST", INVITE_PATH, "admin-alice", {
      principalId: "U-bob",
      email: "bob@example.com",
      displayName: "Bob",
    });
    assert.equal(invited.status, 200);
    const res = await login(
      srv.base,
      loginBody({ principalId: "U-bob", subject: "sub-bob", email: "bob@example.com", displayName: "Bob" }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: "ok",
      user: { principalId: "U-bob", status: "active", sessionVersion: 2, displayName: "Bob" },
    });
  } finally {
    await srv.close();
  }
});

test("suspending a user via PATCH denies subsequent logins; unknown users are 404", async () => {
  const srv = startAdmin();
  try {
    await adminFetch(srv.base, "POST", INVITE_PATH, "admin-alice", {
      principalId: "U-carol",
      email: "carol@example.com",
      displayName: "Carol",
    });
    const first = await login(
      srv.base,
      loginBody({ principalId: "U-carol", subject: "sub-carol", email: "carol@example.com", displayName: "Carol" }),
    );
    assert.equal(((await first.json()) as any).status, "ok");
    const patch = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/U-carol`, "admin-alice", {
      status: "suspended",
    });
    assert.equal(patch.status, 200);
    const patched: any = ((await patch.json()) as any).user;
    assert.equal(patched.status, "suspended");
    assert.equal(patched.sessionVersion, 3);
    assert.equal(patched.updatedBy, "admin-alice");
    const denied = await login(
      srv.base,
      loginBody({ principalId: "U-carol", subject: "sub-carol", email: "carol@example.com", displayName: "Carol S" }),
    );
    assert.deepEqual(await denied.json(), { status: "denied", reason: "suspended" });
    const missing = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/U-ghost`, "admin-alice", { status: "active" });
    assert.equal(missing.status, 404);
    await adminFetch(srv.base, "POST", INVITE_PATH, "admin-alice", {
      principalId: "U-erin",
      email: "erin@example.com",
      displayName: "Erin",
    });
    const suspendInvited = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/U-erin`, "admin-alice", {
      status: "suspended",
    });
    assert.equal(suspendInvited.status, 200);
    const firstLogin = await login(
      srv.base,
      loginBody({ principalId: "U-erin", subject: "sub-erin", email: "erin@example.com", displayName: "Erin" }),
    );
    assert.deepEqual(
      await firstLogin.json(),
      { status: "denied", reason: "suspended" },
      "an invited user with no bound identity is still matched by email and denied",
    );
  } finally {
    await srv.close();
  }
});

test("deprovisioning a UUID-keyed user via PATCH denies subsequent logins", async () => {
  const srv = startAdmin();
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  try {
    const invited = await adminFetch(srv.base, "POST", INVITE_PATH, "admin-alice", {
      principalId: uuid,
      email: "uuid@example.com",
      displayName: "Uuid User",
    });
    assert.equal(invited.status, 200);
    const first = await login(
      srv.base,
      loginBody({ principalId: uuid, subject: "sub-uuid", email: "uuid@example.com", displayName: "Uuid User" }),
    );
    assert.equal(((await first.json()) as any).status, "ok");
    const patch = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/${uuid}`, "admin-alice", {
      status: "deprovisioned",
    });
    assert.equal(patch.status, 200);
    const patched: any = ((await patch.json()) as any).user;
    assert.equal(patched.principalId, uuid);
    assert.equal(patched.status, "deprovisioned");
    const denied = await login(
      srv.base,
      loginBody({ principalId: uuid, subject: "sub-uuid", email: "uuid@example.com", displayName: "Uuid User D" }),
    );
    assert.deepEqual(await denied.json(), { status: "denied", reason: "deprovisioned" });
  } finally {
    await srv.close();
  }
});

test("non-admin actors are forbidden (403); a missing portal identity is unauthorized (401)", async () => {
  const srv = startAdmin();
  try {
    const forbidden = await adminFetch(srv.base, "POST", INVITE_PATH, "U-nobody", {
      principalId: "U-dave",
      email: "dave@example.com",
    });
    assert.equal(forbidden.status, 403);
    const forbiddenPatch = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/U-dave`, "U-nobody", {
      status: "active",
    });
    assert.equal(forbiddenPatch.status, 403);
    const cap = await mintCapabilityToken(
      {
        actorId: "admin-alice",
        scopeId: "personal:admin-alice",
        aud: CONTROL_PLANE_AUD,
        liveActor: true,
        exp: Date.now() + 60_000,
      },
      CAP,
    );
    const capInvite = await fetch(`${srv.base}${INVITE_PATH}`, {
      method: "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U-dave", email: "dave@example.com" }),
    });
    assert.equal(capInvite.status, 403, "capability tokens must not reach org user mutations");
    const capPatch = await fetch(`${srv.base}${INVITE_PATH}/U-dave`, {
      method: "PATCH",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(capPatch.status, 403, "capability tokens must not reach org user mutations");
    const raw = JSON.stringify({ principalId: "U-dave", email: "dave@example.com" });
    const noIdentity = await fetch(`${srv.base}${INVITE_PATH}`, {
      method: "POST",
      headers: sign("POST", INVITE_PATH, raw),
      body: raw,
    });
    assert.equal(noIdentity.status, 401);
  } finally {
    await srv.close();
  }
});

test("invalid invite and status input is rejected 400", async () => {
  const srv = startAdmin();
  try {
    const badInvites: Array<Record<string, unknown>> = [
      {},
      { principalId: "  " },
      { principalId: 42 },
      { principalId: "system:plugin-skills" },
      { principalId: "U-x" },
      { principalId: "U-x", email: 5 },
      { principalId: "U-x", email: "" },
      { principalId: "U-x", email: "not-an-email" },
      { principalId: "U-x", email: "bob@example.com", displayName: 7 },
    ];
    for (const body of badInvites) {
      const res = await adminFetch(srv.base, "POST", INVITE_PATH, "admin-alice", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const badStatuses: Array<Record<string, unknown>> = [
      {},
      { status: "banned" },
      { status: "ACTIVE" },
      { status: 42 },
    ];
    for (const body of badStatuses) {
      const res = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/U-bob`, "admin-alice", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  } finally {
    await srv.close();
  }
});
