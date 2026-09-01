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
import type { RateLimiter } from "../src/ratelimit/rate-limiter.ts";
import { testConfig } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";
import { mintPortalLoginProof } from "../plugins/chassis/src/portal-login-proof.ts";

const SECRET = "test-signing-secret".repeat(3);
const PATH = "/v1/internal/auth/users/login";
const PID = "portal-identity-secret-for-org-tests-01";
const CAP = "capability-secret-for-org-tests-000001";
const INVITE_PATH = "/v1/admin/org/users";
const USER_SEARCH_PATH = "/v1/admin/org/users/search";
const UNITS_PATH = "/v1/admin/org/units";
const GROUPS_PATH = "/v1/admin/org/access-groups";
const DIRECTORY_POLICY_PATH = "/v1/admin/org/directory-visibility";

function replayDedupe() {
  const claimed = new Set<string>();
  return {
    durable: true,
    async claim(key: string) {
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  };
}

function start(overrides: Partial<Config> = {}): { built: BuiltApp; base: string; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "org-login-")),
      portalIdentitySecret: PID,
      ...overrides,
    }),
  );
  const server = createServer(built.app, {
    signingSecret: SECRET,
    portalIdentitySecret: PID,
    organization: built.organization,
    replayDedupe: replayDedupe(),
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { built, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function seedActive(built: BuiltApp, principalId: string): Promise<void> {
  await built.organization.invite({ principalId, email: null, displayName: principalId, actor: "test" });
  await built.organization.setStatus({ principalId, status: "active", actor: "test" });
}

async function startAdmin(
  overrides: Partial<Config> = {},
  deps: { rateLimiter?: RateLimiter } = {},
): Promise<{ built: BuiltApp; base: string; close: () => Promise<void> }> {
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
    advisoryLock: built.advisoryLock,
    replayDedupe: replayDedupe(),
    ...deps,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  await seedActive(built, "admin-alice");
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
    "x-portal-identity": await mintSignedPayload({ p: portalUser, sv: 2, exp: Date.now() + 60_000 }, PID),
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

function login(base: string, input: Record<string, unknown>): Promise<Response> {
  const body = { ...input, portalProof: mintPortalLoginProof(input, PID, Date.now()) };
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

test("shared source authentication cannot forge Portal or directory login identity", async () => {
  const srv = start();
  try {
    const unproved = loginBody({ issuer: "directory:source-1", subject: "tenant-1:member-1" });
    const unprovedRaw = JSON.stringify(unproved);
    const rejected = await fetch(`${srv.base}${PATH}`, {
      method: "POST",
      headers: sign("POST", PATH, unprovedRaw),
      body: unprovedRaw,
    });
    assert.equal(rejected.status, 403);
    assert.deepEqual(await rejected.json(), { error: "portal_login_rejected" });

    const directoryClaims = loginBody({ issuer: "directory:source-1", subject: "tenant-1:member-1" });
    const proved = { ...directoryClaims, portalProof: mintPortalLoginProof(directoryClaims, PID, Date.now()) };
    const provedRaw = JSON.stringify(proved);
    const missingAssertion = await fetch(`${srv.base}${PATH}`, {
      method: "POST",
      headers: sign("POST", PATH, provedRaw),
      body: provedRaw,
    });
    assert.equal(missingAssertion.status, 403);
    assert.deepEqual(await missingAssertion.json(), { error: "external_identity_required" });
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
      user: { principalId: "U-alice", status: "active", sessionVersion: 1, displayName: "Alice" },
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

test("managed external login fails closed before domain auto-join and cannot create a user", async () => {
  const srv = start({ orgAdmission: "domain_auto_join", orgAutoJoinDomains: ["example.com"] });
  try {
    const res = await login(
      srv.base,
      loginBody({
        principalId: "untrusted-managed-principal",
        externalIdentity: {
          sourceId: "missing-source",
          provider: "wecom",
          externalTenantId: "tenant-1",
          externalSubjectId: "member-1",
          displayName: "Managed User",
          corporateEmail: "managed@example.com",
          personalEmail: null,
          employeeNumber: null,
          mobile: null,
          status: "active",
          proof: "untrusted-proof",
        },
      }),
    );
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "external_identity_rejected" });
    assert.equal(await srv.built.organization.getUser("untrusted-managed-principal"), null);
    assert.equal(await srv.built.organization.getUser("managed@example.com"), null);
  } finally {
    await srv.close();
  }
});

test("managed external login rejects malformed assertions before invoking identity linking", async () => {
  const srv = start();
  try {
    const res = await login(
      srv.base,
      loginBody({
        externalIdentity: {
          sourceId: "source-1",
          provider: "wecom",
          externalTenantId: "tenant-1",
          externalSubjectId: "member-1",
          displayName: "Managed User",
          status: "unknown",
        },
      }),
    );
    assert.equal(res.status, 400);
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

test("directory APIs filter tree, search, details, and pagination with a personal multi-root policy", async () => {
  const srv = await startAdmin();
  try {
    for (const principalId of ["viewer", "alice", "bob"]) await seedActive(srv.built, principalId);
    const engineering = await createUnitAsAdmin(srv.base, {
      parentId: "root",
      name: "Engineering",
      kind: "department",
    });
    const finance = await createUnitAsAdmin(srv.base, {
      parentId: "root",
      name: "Finance",
      kind: "department",
    });
    for (const [unitId, principalId] of [
      [engineering.id, "alice"],
      [finance.id, "bob"],
    ]) {
      const added = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unitId}/members`, "admin-alice", {
        principalId,
        role: "member",
      });
      assert.equal(added.status, 200);
    }
    const policyPath = `${DIRECTORY_POLICY_PATH}/user/viewer`;
    const saved = await adminFetch(srv.base, "PUT", policyPath, "admin-alice", {
      mode: "limited",
      roots: [{ unitId: engineering.id, includeDescendants: true }],
      expectedRevision: 0,
    });
    assert.equal(saved.status, 200);
    const conflict = await adminFetch(srv.base, "PUT", policyPath, "admin-alice", {
      mode: "none",
      roots: [],
      expectedRevision: 0,
    });
    assert.equal(conflict.status, 409);

    const tree = await adminGet(srv.base, "/v1/org/tree", "viewer");
    assert.equal(tree.status, 200);
    assert.deepEqual(
      ((await tree.json()) as any).units.map((unit: any) => unit.id),
      [engineering.id],
    );
    const hiddenUnit = await adminGet(srv.base, `/v1/org/units/${finance.id}`, "viewer");
    assert.equal(hiddenUnit.status, 404);
    const search = await adminGet(srv.base, "/v1/org/users?q=&limit=1", "viewer");
    assert.equal(search.status, 200);
    const first: any = await search.json();
    assert.deepEqual(
      first.users.map((account: any) => account.principalId),
      ["alice"],
    );
    assert.equal(first.cursor, null);
    const me = await adminGet(srv.base, "/v1/me", "viewer");
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as any).user.principalId, "viewer");
  } finally {
    await srv.close();
  }
});

test("project member candidates and add validation both use the organization directory", async () => {
  const srv = await startAdmin();
  try {
    for (const principalId of ["owner", "candidate"]) await seedActive(srv.built, principalId);
    const project = await srv.built.app.createProject("owner", "Directory project");
    assert.ok(project);
    const path = `/v1/projects/${project!.id}/member-candidates?principalId=owner&q=cand`;
    const hidden = await srv.built.organization.setDirectoryPolicy({
      subjectKind: "user",
      subjectId: "owner",
      mode: "none",
      roots: [],
      expectedRevision: 0,
      actor: "admin-alice",
    });
    assert.equal(hidden.ok, true);
    const hiddenCandidates = await adminGet(srv.base, path, "owner");
    assert.equal(hiddenCandidates.status, 200);
    assert.deepEqual((await hiddenCandidates.json()) as any, { matches: [] });
    assert.equal((await srv.built.app.addProjectMember(project!.id, "owner", "candidate")).status, "invalid_member");
    const restored = await srv.built.organization.deleteDirectoryPolicy({
      subjectKind: "user",
      subjectId: "owner",
      expectedRevision: 1,
      actor: "admin-alice",
    });
    assert.equal(restored.ok, true);
    const candidates = await adminGet(srv.base, path, "owner");
    assert.equal(candidates.status, 200);
    assert.deepEqual(
      ((await candidates.json()) as any).matches.map((match: any) => match.principalId),
      ["candidate"],
    );
    assert.equal((await srv.built.app.addProjectMember(project!.id, "owner", "candidate")).status, "ok");
    const originalSearch = srv.built.organization.directory.searchUsers.bind(srv.built.organization.directory);
    const searches: Array<{ excludePrincipalIds?: readonly string[] }> = [];
    srv.built.organization.directory.searchUsers = async (actor, input) => {
      searches.push(input);
      return originalSearch(actor, input);
    };
    const after = await adminGet(srv.base, path, "owner");
    assert.equal(after.status, 200);
    assert.deepEqual((await after.json()) as any, { matches: [] });
    assert.equal(searches.length, 1);
    assert.deepEqual(new Set(searches[0]?.excludePrincipalIds), new Set(["owner", "candidate"]));
  } finally {
    await srv.close();
  }
});

test("unattended admin capabilities do not elevate organization directory visibility", async () => {
  const srv = await startAdmin();
  try {
    await seedActive(srv.built, "hidden-candidate");
    const policy = await srv.built.organization.setDirectoryPolicy({
      subjectKind: "user",
      subjectId: "admin-alice",
      mode: "none",
      roots: [],
      expectedRevision: 0,
      actor: "admin-alice",
    });
    assert.equal(policy.ok, true);
    const session = await srv.built.organization.checkActive("admin-alice");
    const cap = await mintCapabilityToken(
      {
        actorId: "admin-alice",
        sessionVersion: session!.sessionVersion,
        scopeId: "personal:admin-alice",
        aud: CONTROL_PLANE_AUD,
        exp: Date.now() + 60_000,
      },
      CAP,
    );
    const directory = await fetch(`${srv.base}/v1/org/users?q=hidden&limit=10`, {
      headers: { "x-agent-capability": cap },
    });
    assert.equal(directory.status, 200);
    assert.deepEqual(((await directory.json()) as any).users, []);
    const project = await srv.built.app.createProject("admin-alice", "Restricted candidates");
    assert.ok(project);
    const candidates = await fetch(
      `${srv.base}/v1/projects/${project!.id}/member-candidates?principalId=admin-alice&q=hidden`,
      { headers: { "x-agent-capability": cap } },
    );
    assert.equal(candidates.status, 200);
    assert.deepEqual(await candidates.json(), { matches: [] });
    assert.equal((await srv.built.app.resolveVisibleRecipient("admin-alice", "hidden-candidate")).kind, "none");
    assert.equal(
      (
        await srv.built.app.resolveVisibleRecipient("admin-alice", "hidden-candidate", {
          allowAdminElevation: true,
        })
      ).kind,
      "one",
    );
  } finally {
    await srv.close();
  }
});

test("playground provisioning creates a durable active user with an authoritative session version", async () => {
  const srv = start();
  const path = "/v1/internal/auth/users/playground";
  try {
    const raw = JSON.stringify({ principalId: "playground-0123456789abcdef" });
    const created = await fetch(`${srv.base}${path}`, { method: "POST", headers: sign("POST", path, raw), body: raw });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), { principalId: "playground-0123456789abcdef", sessionVersion: 1 });
    assert.deepEqual(await srv.built.organization.checkActive("playground-0123456789abcdef"), {
      status: "active",
      sessionVersion: 1,
    });
    const invalidRaw = JSON.stringify({ principalId: "playground-invalid" });
    const invalid = await fetch(`${srv.base}${path}`, {
      method: "POST",
      headers: sign("POST", path, invalidRaw),
      body: invalidRaw,
    });
    assert.equal(invalid.status, 400);
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
  const srv = await startAdmin();
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
      "employeeNumber",
      "jobTitle",
      "lastLoginAt",
      "mobile",
      "principalId",
      "profileRevision",
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
  const srv = await startAdmin({ orgAdmission: "invite_only" });
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

test("invite lowercases the stored email so case-variant login emails still match", async () => {
  const srv = await startAdmin({ orgAdmission: "invite_only" });
  try {
    const invited = await adminFetch(srv.base, "POST", INVITE_PATH, "admin-alice", {
      principalId: "U-case",
      email: "MixedCase@Example.COM",
      displayName: "Case",
    });
    assert.equal(((await invited.json()) as any).user.email, "mixedcase@example.com");
    const res = await login(
      srv.base,
      loginBody({ principalId: "U-case", subject: "sub-case", email: "mixedcase@example.com", displayName: "Case" }),
    );
    assert.deepEqual(await res.json(), {
      status: "ok",
      user: { principalId: "U-case", status: "active", sessionVersion: 2, displayName: "Case" },
    });
  } finally {
    await srv.close();
  }
});

test("suspending a user via PATCH denies subsequent logins; unknown users are 404", async () => {
  const srv = await startAdmin();
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
    assert.equal(suspendInvited.status, 409);
    const firstLogin = await login(
      srv.base,
      loginBody({ principalId: "U-erin", subject: "sub-erin", email: "erin@example.com", displayName: "Erin" }),
    );
    assert.equal(((await firstLogin.json()) as any).status, "ok");
  } finally {
    await srv.close();
  }
});

test("deprovisioning a UUID-keyed user via PATCH denies subsequent logins", async () => {
  const srv = await startAdmin();
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

test("concurrent administrator suspensions cannot leave the organization without an active admin", async () => {
  const srv = await startAdmin();
  try {
    await seedActive(srv.built, "admin-bob");
    await srv.built.admin.createGrant(
      { id: "admin-alice", type: "internal" },
      { principalId: "admin-bob", scopeId: scopeId("org", "default-org"), role: "org_admin" },
    );
    const responses = await Promise.all([
      adminFetch(srv.base, "POST", `${INVITE_PATH}/admin-alice/status`, "admin-alice", { status: "suspended" }),
      adminFetch(srv.base, "POST", `${INVITE_PATH}/admin-bob/status`, "admin-bob", { status: "suspended" }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const users = await Promise.all([
      srv.built.organization.getUser("admin-alice"),
      srv.built.organization.getUser("admin-bob"),
    ]);
    assert.equal(users.filter((user) => user?.status === "active").length, 1);
  } finally {
    await srv.close();
  }
});

test("case-variant administrator grants still protect the last active account", async () => {
  const srv = await startAdmin({
    adminGrants: "Admin@Example.com:org_admin,Backup@Example.com:org_admin",
  });
  try {
    await seedActive(srv.built, "admin@example.com");
    await seedActive(srv.built, "backup@example.com");
    assert.equal(
      (
        await adminFetch(srv.base, "POST", `${INVITE_PATH}/backup@example.com/status`, "Admin@Example.com", {
          status: "suspended",
        })
      ).status,
      200,
    );
    const blocked = await adminFetch(srv.base, "POST", `${INVITE_PATH}/admin@example.com/status`, "Admin@Example.com", {
      status: "suspended",
    });
    assert.equal(blocked.status, 409);
    assert.equal(((await blocked.json()) as any).error, "last_active_admin");
  } finally {
    await srv.close();
  }
});

test("non-admin actors are forbidden (403); a missing portal identity is unauthorized (401)", async () => {
  const srv = await startAdmin();
  try {
    await seedActive(srv.built, "U-nobody");
    const adminSession = await srv.built.organization.checkActive("admin-alice");
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
        sessionVersion: adminSession!.sessionVersion,
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

test("non-personal capability tokens are denied admin content reads (audit, errors, egress)", async () => {
  const srv = await startAdmin();
  try {
    const adminSession = await srv.built.organization.checkActive("admin-alice");
    const cap = await mintCapabilityToken(
      {
        actorId: "admin-alice",
        sessionVersion: adminSession!.sessionVersion,
        scopeId: "channel:C1",
        aud: CONTROL_PLANE_AUD,
        liveActor: true,
        exp: Date.now() + 60_000,
      },
      CAP,
    );
    for (const path of ["/v1/admin/audit", "/v1/admin/errors", "/v1/admin/egress"]) {
      const res = await fetch(`${srv.base}${path}`, { headers: { "x-agent-capability": cap } });
      assert.equal(res.status, 403, `GET ${path} with a non-personal capability token`);
    }
  } finally {
    await srv.close();
  }
});

test("invalid invite and status input is rejected 400", async () => {
  const srv = await startAdmin();
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

async function adminGet(base: string, path: string, portalUser: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: {
      ...sign("GET", path, ""),
      "x-portal-identity": await mintSignedPayload({ p: portalUser, sv: 2, exp: Date.now() + 60_000 }, PID),
    },
  });
}

test("Skill Access routes use authenticated identity and CAS replacement", async () => {
  const srv = await startAdmin();
  try {
    await seedActive(srv.built, "U-skill-reader");
    const skill = await srv.built.skills.create({
      scopeId: "personal:admin-alice",
      createdBy: "admin-alice",
      manifest: {
        name: "org-route-skill",
        description: "Route authorization fixture",
        requiredCapabilities: [],
        body: "Use the route fixture",
      },
    });
    await srv.built.skills.review(skill.id, "admin-alice", []);
    await srv.built.skills.publish(skill.id);
    const path = `/v1/skills/${encodeURIComponent(skill.id)}/access`;
    const initial = await adminGet(srv.base, path, "admin-alice");
    assert.equal(initial.status, 200);
    const initialBody = (await initial.json()) as { mode: string; revision: number };
    assert.equal(initialBody.mode, "home");
    assert.equal(initialBody.revision, 1);
    const forgedAdminHeader = await fetch(`${srv.base}${path}`, {
      headers: { ...sign("GET", path, ""), "x-admin-actor": "admin-alice" },
    });
    assert.equal(forgedAdminHeader.status, 401);
    const updated = await adminFetch(srv.base, "PUT", path, "admin-alice", {
      mode: "restricted",
      subjects: [{ kind: "user", id: "U-skill-reader" }],
      expectedRevision: 1,
    });
    assert.equal(updated.status, 200);
    assert.equal(((await updated.json()) as { revision: number }).revision, 2);
    const detailPath = `/v1/skills/${encodeURIComponent(skill.id)}`;
    const ownerResponse = await adminGet(srv.base, `${detailPath}?principalId=admin-alice`, "admin-alice");
    const ownerBody = await ownerResponse.text();
    assert.equal(ownerResponse.status, 200, ownerBody);
    const ownerDetail = JSON.parse(ownerBody) as {
      skill: { createdBy?: string };
    };
    assert.equal(ownerDetail.skill.createdBy, "admin-alice");
    const readerDetail = await adminGet(srv.base, `${detailPath}?principalId=U-skill-reader`, "U-skill-reader");
    assert.equal(readerDetail.status, 200);
    assert.equal(((await readerDetail.json()) as { skill: { createdBy?: string } }).skill.createdBy, undefined);
    const conflict = await adminFetch(srv.base, "PUT", path, "admin-alice", {
      mode: "home",
      subjects: [],
      expectedRevision: 1,
    });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { currentRevision: number }).currentRevision, 2);
    const raw = JSON.stringify({ mode: "home", subjects: [], expectedRevision: 2 });
    const missingIdentity = await fetch(`${srv.base}${path}`, {
      method: "PUT",
      headers: sign("PUT", path, raw),
      body: raw,
    });
    assert.equal(missingIdentity.status, 401);
  } finally {
    await srv.close();
  }
});

async function createUnitAsAdmin(base: string, body: Record<string, unknown>): Promise<any> {
  const res = await adminFetch(base, "POST", UNITS_PATH, "admin-alice", body);
  const payload: any = await res.json();
  assert.equal(res.status, 200, JSON.stringify(payload));
  return payload.unit;
}

test("admin creates, lists, and reads units with members", async () => {
  const srv = await startAdmin();
  try {
    const unit = await createUnitAsAdmin(srv.base, {
      parentId: "root",
      name: "Engineering",
      kind: "department",
      sortOrder: 3,
    });
    assert.ok(unit.id.startsWith("unit-"));
    assert.equal(unit.parentId, "root");
    assert.equal(unit.name, "Engineering");
    assert.equal(unit.kind, "department");
    assert.equal(unit.status, "active");
    assert.equal(unit.sortOrder, 3);
    assert.equal(unit.createdBy, "admin-alice");
    assert.equal(unit.updatedBy, "admin-alice");
    assert.equal(typeof unit.createdAt, "number");
    const list = await adminGet(srv.base, UNITS_PATH, "admin-alice");
    assert.equal(list.status, 200);
    const listed: any = await list.json();
    const ids = listed.units.map((u: any) => u.id);
    assert.ok(ids.includes("root"));
    assert.ok(ids.includes(unit.id));
    await seedActive(srv.built, "U-member-1");
    const added = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "admin-alice", {
      principalId: "U-member-1",
      role: "member",
    });
    assert.equal(added.status, 200);
    const addedBody: any = await added.json();
    assert.equal(addedBody.unit.id, unit.id);
    assert.equal(addedBody.members.length, 1);
    assert.equal(addedBody.members[0].unitId, unit.id);
    assert.equal(addedBody.members[0].principalId, "U-member-1");
    assert.equal(addedBody.members[0].role, "member");
    assert.equal(addedBody.members[0].createdBy, "admin-alice");
    const detail = await adminGet(srv.base, `${UNITS_PATH}/${unit.id}`, "admin-alice");
    assert.equal(detail.status, 200);
    const detailBody: any = await detail.json();
    assert.equal(detailBody.unit.id, unit.id);
    assert.equal(detailBody.members.length, 1);
    assert.equal(detailBody.members[0].principalId, "U-member-1");
    const missing = await adminGet(srv.base, `${UNITS_PATH}/unit-ghost`, "admin-alice");
    assert.equal(missing.status, 404);
  } finally {
    await srv.close();
  }
});

test("invalid unit create and patch input is rejected 400 and unknown parents 404", async () => {
  const srv = await startAdmin();
  try {
    const badCreates: Array<Record<string, unknown>> = [
      {},
      { parentId: "root" },
      { parentId: "root", name: "x" },
      { parentId: "root", name: "x", kind: "bogus" },
      { parentId: "root", name: "  ", kind: "team" },
      { parentId: "root", name: "x", kind: "team", sortOrder: "high" },
      { parentId: "", name: "x", kind: "team" },
      { parentId: 7, name: "x", kind: "team" },
    ];
    for (const body of badCreates) {
      const res = await adminFetch(srv.base, "POST", UNITS_PATH, "admin-alice", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const unknownParent = await adminFetch(srv.base, "POST", UNITS_PATH, "admin-alice", {
      parentId: "unit-ghost",
      name: "x",
      kind: "team",
    });
    assert.equal(unknownParent.status, 404);
    const parent = await createUnitAsAdmin(srv.base, { parentId: "root", name: "P", kind: "department" });
    const archived = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${parent.id}`, "admin-alice", {
      status: "archived",
    });
    assert.equal(archived.status, 200);
    const archivedParent = await adminFetch(srv.base, "POST", UNITS_PATH, "admin-alice", {
      parentId: parent.id,
      name: "child",
      kind: "team",
    });
    assert.equal(archivedParent.status, 400);
    assert.equal(((await archivedParent.json()) as any).error, "archived");
    const unit = await createUnitAsAdmin(srv.base, { parentId: "root", name: "Q", kind: "team" });
    const badPatches: Array<Record<string, unknown>> = [
      {},
      { name: "" },
      { sortOrder: "high" },
      { parentId: "" },
      { status: "banned" },
      { status: 42 },
    ];
    for (const body of badPatches) {
      const res = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${unit.id}`, "admin-alice", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  } finally {
    await srv.close();
  }
});

test("admin moves and renames units via PATCH with rejection reasons mapped to 400", async () => {
  const srv = await startAdmin();
  try {
    const a = await createUnitAsAdmin(srv.base, { parentId: "root", name: "A", kind: "department" });
    const b = await createUnitAsAdmin(srv.base, { parentId: a.id, name: "B", kind: "team" });
    const ontoDescendant = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${a.id}`, "admin-alice", {
      parentId: b.id,
    });
    assert.equal(ontoDescendant.status, 400);
    assert.equal(((await ontoDescendant.json()) as any).error, "self_or_descendant");
    const ontoSelf = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${a.id}`, "admin-alice", {
      parentId: a.id,
    });
    assert.equal(ontoSelf.status, 400);
    assert.equal(((await ontoSelf.json()) as any).error, "self_or_descendant");
    const moveRoot = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/root`, "admin-alice", { parentId: a.id });
    assert.equal(moveRoot.status, 400);
    assert.equal(((await moveRoot.json()) as any).error, "root");
    const missingParent = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${a.id}`, "admin-alice", {
      parentId: "unit-ghost",
    });
    assert.equal(missingParent.status, 400);
    assert.equal(((await missingParent.json()) as any).error, "missing_parent");
    const missingUnit = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/unit-ghost`, "admin-alice", {
      parentId: "root",
    });
    assert.equal(missingUnit.status, 404);
    const moved = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${b.id}`, "admin-alice", { parentId: "root" });
    assert.equal(moved.status, 200);
    assert.equal(((await moved.json()) as any).unit.parentId, "root");
    const renamed = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${a.id}`, "admin-alice", {
      name: "Alpha",
      sortOrder: 9,
    });
    assert.equal(renamed.status, 200);
    const renamedUnit: any = ((await renamed.json()) as any).unit;
    assert.equal(renamedUnit.name, "Alpha");
    assert.equal(renamedUnit.sortOrder, 9);
  } finally {
    await srv.close();
  }
});

test("ambiguous multi-key patches are rejected or fail atomically", async () => {
  const srv = await startAdmin();
  try {
    const a = await createUnitAsAdmin(srv.base, { parentId: "root", name: "A", kind: "department" });
    const b = await createUnitAsAdmin(srv.base, { parentId: "root", name: "B", kind: "department" });
    const combined = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${a.id}`, "admin-alice", {
      parentId: b.id,
      status: "archived",
    });
    assert.equal(combined.status, 400);
    const after = await adminGet(srv.base, `${UNITS_PATH}/${a.id}`, "admin-alice");
    const afterUnit: any = ((await after.json()) as any).unit;
    assert.equal(afterUnit.parentId, "root");
    assert.equal(afterUnit.status, "active");
    await seedActive(srv.built, "U-member-3");
    await adminFetch(srv.base, "POST", `${UNITS_PATH}/${b.id}/members`, "admin-alice", {
      principalId: "U-member-3",
      role: "member",
    });
    const conflictRename = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${b.id}`, "admin-alice", {
      status: "archived",
      name: "B-renamed",
    });
    assert.equal(conflictRename.status, 409);
    const afterConflict = await adminGet(srv.base, `${UNITS_PATH}/${b.id}`, "admin-alice");
    const afterConflictUnit: any = ((await afterConflict.json()) as any).unit;
    assert.equal(afterConflictUnit.name, "B");
    assert.equal(afterConflictUnit.status, "active");
  } finally {
    await srv.close();
  }
});

test("unit membership batches commit once and move impact previews the affected subtree", async () => {
  const srv = await startAdmin();
  try {
    const source = await createUnitAsAdmin(srv.base, { parentId: "root", name: "Source", kind: "department" });
    const child = await createUnitAsAdmin(srv.base, { parentId: source.id, name: "Child", kind: "team" });
    const target = await createUnitAsAdmin(srv.base, { parentId: "root", name: "Target", kind: "department" });
    await seedActive(srv.built, "U-batch-1");
    await seedActive(srv.built, "U-batch-2");
    const revision = await srv.built.organizationStore.getAuthzRevision("default-org");
    const added = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${source.id}/members`, "admin-alice", {
      principalIds: ["U-batch-1", "U-batch-2", "U-batch-1"],
      role: "member",
    });
    assert.equal(added.status, 200);
    assert.deepEqual(((await added.json()) as any).members.map((member: any) => member.principalId).sort(), [
      "U-batch-1",
      "U-batch-2",
    ]);
    assert.equal(await srv.built.organizationStore.getAuthzRevision("default-org"), revision + 1);
    const childAdd = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${child.id}/members`, "admin-alice", {
      principalId: "U-batch-2",
      role: "member",
    });
    assert.equal(childAdd.status, 200);
    const path = `${UNITS_PATH}/${source.id}/impact?newParentId=${encodeURIComponent(target.id)}`;
    const preview = await adminGet(srv.base, path, "admin-alice");
    assert.equal(preview.status, 200);
    assert.deepEqual(((await preview.json()) as any).impact, { activeUnits: 2, activeMembers: 2 });
    const invalid = await adminGet(srv.base, `${UNITS_PATH}/${source.id}/impact`, "admin-alice");
    assert.equal(invalid.status, 400);
  } finally {
    await srv.close();
  }
});

test("archiving a populated unit conflicts with an impact summary and restore reopens it", async () => {
  const srv = await startAdmin();
  try {
    const clean = await createUnitAsAdmin(srv.base, { parentId: "root", name: "C", kind: "team" });
    const archived = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${clean.id}`, "admin-alice", {
      status: "archived",
    });
    assert.equal(archived.status, 200);
    assert.equal(((await archived.json()) as any).unit.status, "archived");
    const withMember = await createUnitAsAdmin(srv.base, { parentId: "root", name: "D", kind: "team" });
    await seedActive(srv.built, "U-member-2");
    await adminFetch(srv.base, "POST", `${UNITS_PATH}/${withMember.id}/members`, "admin-alice", {
      principalId: "U-member-2",
      role: "member",
    });
    const conflict = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${withMember.id}`, "admin-alice", {
      status: "archived",
    });
    assert.equal(conflict.status, 409);
    const conflictBody: any = await conflict.json();
    assert.equal(conflictBody.error, "conflict");
    assert.equal(conflictBody.impact.activeMembers, 1);
    assert.equal(conflictBody.impact.activeChildUnits, 0);
    const withChild = await createUnitAsAdmin(srv.base, { parentId: "root", name: "E", kind: "department" });
    await createUnitAsAdmin(srv.base, { parentId: withChild.id, name: "F", kind: "team" });
    const childConflict = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${withChild.id}`, "admin-alice", {
      status: "archived",
    });
    assert.equal(childConflict.status, 409);
    assert.equal(((await childConflict.json()) as any).impact.activeChildUnits, 1);
    const removed = await adminFetch(
      srv.base,
      "DELETE",
      `${UNITS_PATH}/${withMember.id}/members/U-member-2`,
      "admin-alice",
      {},
    );
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as any).members.length, 0);
    const nowArchived = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${withMember.id}`, "admin-alice", {
      status: "archived",
      sortOrder: 1,
    });
    assert.equal(nowArchived.status, 200);
    assert.equal(((await nowArchived.json()) as any).unit.status, "archived");
    const restored = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${withMember.id}`, "admin-alice", {
      status: "active",
    });
    assert.equal(restored.status, 200);
    assert.equal(((await restored.json()) as any).unit.status, "active");
    const archiveRoot = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/root`, "admin-alice", {
      status: "archived",
    });
    assert.equal(archiveRoot.status, 400);
    assert.equal(((await archiveRoot.json()) as any).error, "root");
  } finally {
    await srv.close();
  }
});

test("an archived child restore conflicts until its parent is active", async () => {
  const srv = await startAdmin();
  try {
    const parent = await createUnitAsAdmin(srv.base, { parentId: "root", name: "Parent", kind: "department" });
    const child = await createUnitAsAdmin(srv.base, { parentId: parent.id, name: "Child", kind: "team" });
    assert.equal(
      (await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${child.id}`, "admin-alice", { status: "archived" })).status,
      200,
    );
    assert.equal(
      (await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${parent.id}`, "admin-alice", { status: "archived" })).status,
      200,
    );
    const blocked = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${child.id}`, "admin-alice", {
      status: "active",
    });
    assert.equal(blocked.status, 409);
    assert.equal(((await blocked.json()) as any).error, "conflict");
    assert.equal(
      (await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${parent.id}`, "admin-alice", { status: "active" })).status,
      200,
    );
    assert.equal(
      (
        await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${child.id}`, "admin-alice", {
          status: "active",
          sortOrder: 1,
        })
      ).status,
      200,
    );
  } finally {
    await srv.close();
  }
});

test("a non-admin active user without a manager role is forbidden from unit reads and member writes", async () => {
  const srv = await startAdmin();
  try {
    await seedActive(srv.built, "U-plain");
    const unit = await createUnitAsAdmin(srv.base, { parentId: "root", name: "G", kind: "team" });
    const added = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "U-plain", {
      principalId: "U-plain",
      role: "member",
    });
    assert.equal(added.status, 404);
    const removed = await adminFetch(srv.base, "DELETE", `${UNITS_PATH}/${unit.id}/members/U-plain`, "U-plain", {});
    assert.equal(removed.status, 404);
    const list = await adminGet(srv.base, UNITS_PATH, "U-plain");
    assert.equal(list.status, 403);
    const detail = await adminGet(srv.base, `${UNITS_PATH}/${unit.id}`, "U-plain");
    assert.equal(detail.status, 403);
    const patched = await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${unit.id}`, "U-plain", { name: "H" });
    assert.equal(patched.status, 403);
  } finally {
    await srv.close();
  }
});

test("organization admins and managers can search assignable users without receiving deprovisioned matches", async () => {
  const srv = await startAdmin();
  try {
    await srv.built.organization.invite({
      principalId: "U-alice-search",
      email: "alice.search@example.com",
      displayName: "Alice Search",
      actor: "admin-alice",
    });
    await srv.built.organization.setStatus({
      principalId: "U-alice-search",
      status: "active",
      actor: "admin-alice",
    });
    await srv.built.organization.invite({
      principalId: "U-search-suspended",
      email: "suspended.search@example.com",
      displayName: "Suspended Search",
      actor: "admin-alice",
    });
    await srv.built.organization.setStatus({
      principalId: "U-search-suspended",
      status: "suspended",
      actor: "admin-alice",
    });
    await seedActive(srv.built, "U-search-manager");
    await seedActive(srv.built, "U-search-deprovisioned");
    await srv.built.organization.setStatus({
      principalId: "U-search-deprovisioned",
      status: "deprovisioned",
      actor: "admin-alice",
    });
    const unit = await createUnitAsAdmin(srv.base, { parentId: "root", name: "Search", kind: "team" });
    await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "admin-alice", {
      principalId: "U-search-manager",
      role: "manager",
    });
    const path = `${USER_SEARCH_PATH}?q=search`;
    const adminResult = await adminGet(srv.base, path, "admin-alice");
    assert.equal(adminResult.status, 200);
    assert.deepEqual(
      ((await adminResult.json()) as { users: Array<{ principalId: string }> }).users.map((user) => user.principalId),
      ["U-alice-search", "U-search-manager"],
    );
    const managerResult = await adminGet(srv.base, path, "U-search-manager");
    assert.equal(managerResult.status, 200);
    assert.equal(((await managerResult.json()) as { users: unknown[] }).users.length, 2);
    const hidden = await srv.built.organization.setDirectoryPolicy({
      subjectKind: "user",
      subjectId: "U-search-manager",
      mode: "none",
      roots: [],
      expectedRevision: 0,
      actor: "admin-alice",
    });
    assert.equal(hidden.ok, true);
    const hiddenResult = await adminGet(srv.base, path, "U-search-manager");
    assert.equal(hiddenResult.status, 200);
    assert.deepEqual((await hiddenResult.json()) as { users: unknown[] }, { users: [] });
    assert.equal((await adminGet(srv.base, `${USER_SEARCH_PATH}?q=x`, "admin-alice")).status, 400);
  } finally {
    await srv.close();
  }
});

test("organization user search is rate limited per actor", async () => {
  let calls = 0;
  const srv = await startAdmin(
    {},
    {
      rateLimiter: {
        async check(key) {
          assert.equal(key, "org-user-search:admin-alice");
          calls += 1;
          return calls === 1 ? { allowed: true } : { allowed: false, retryAfterMs: 5000 };
        },
      },
    },
  );
  try {
    const path = `${USER_SEARCH_PATH}?q=admin`;
    assert.equal((await adminGet(srv.base, path, "admin-alice")).status, 200);
    const limited = await adminGet(srv.base, path, "admin-alice");
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      error: "rate_limited",
      message: "too many organization user searches; try again later",
      retryAfterMs: 5000,
    });
  } finally {
    await srv.close();
  }
});

test("unit managers add and remove member-role members only inside their managed subtree", async () => {
  const srv = await startAdmin();
  try {
    const managed = await createUnitAsAdmin(srv.base, { parentId: "root", name: "M", kind: "department" });
    const sibling = await createUnitAsAdmin(srv.base, { parentId: "root", name: "S", kind: "department" });
    await seedActive(srv.built, "U-mgr");
    await seedActive(srv.built, "U-join");
    const grant = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${managed.id}/members`, "admin-alice", {
      principalId: "U-mgr",
      role: "manager",
    });
    assert.equal(grant.status, 200);
    const list = await adminGet(srv.base, UNITS_PATH, "U-mgr");
    assert.equal(list.status, 200);
    assert.deepEqual(
      ((await list.json()) as any).units.map((unit: any) => unit.id),
      [managed.id],
    );
    assert.equal((await adminGet(srv.base, `${UNITS_PATH}/${managed.id}`, "U-mgr")).status, 200);
    assert.equal((await adminGet(srv.base, `${UNITS_PATH}/${sibling.id}`, "U-mgr")).status, 404);
    const added = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${managed.id}/members`, "U-mgr", {
      principalId: "U-join",
      role: "member",
    });
    assert.equal(added.status, 200);
    const addedBody: any = await added.json();
    assert.equal(addedBody.members.length, 2);
    assert.equal(addedBody.members.find((m: any) => m.principalId === "U-join").role, "member");
    const removed = await adminFetch(srv.base, "DELETE", `${UNITS_PATH}/${managed.id}/members/U-join`, "U-mgr", {});
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as any).members.length, 1);
    const crossUnit = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${sibling.id}/members`, "U-mgr", {
      principalId: "U-join",
      role: "member",
    });
    assert.equal(crossUnit.status, 404);
    const managerGrant = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${managed.id}/members`, "U-mgr", {
      principalId: "U-join",
      role: "manager",
    });
    assert.equal(managerGrant.status, 403);
    const managerDemotion = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${managed.id}/members`, "U-mgr", {
      principalId: "U-mgr",
      role: "member",
    });
    assert.equal(managerDemotion.status, 403);
    const managerRevoke = await adminFetch(
      srv.base,
      "DELETE",
      `${UNITS_PATH}/${managed.id}/members/U-mgr`,
      "U-mgr",
      {},
    );
    assert.equal(managerRevoke.status, 403);
    const unknown = await adminFetch(srv.base, "POST", `${UNITS_PATH}/unit-ghost/members`, "U-mgr", {
      principalId: "U-join",
      role: "member",
    });
    assert.equal(unknown.status, 404);
    const archived = await createUnitAsAdmin(srv.base, { parentId: "root", name: "T", kind: "team" });
    await adminFetch(srv.base, "PATCH", `${UNITS_PATH}/${archived.id}`, "admin-alice", { status: "archived" });
    const hidden = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${archived.id}/members`, "U-mgr", {
      principalId: "U-join",
      role: "member",
    });
    assert.equal(hidden.status, 404);
    const adminUnknown = await adminFetch(srv.base, "POST", `${UNITS_PATH}/unit-ghost/members`, "admin-alice", {
      principalId: "U-join-admin-probe",
      role: "member",
    });
    assert.equal(adminUnknown.status, 404);
  } finally {
    await srv.close();
  }
});

test("a manager on a parent unit manages members in descendant units", async () => {
  const srv = await startAdmin();
  try {
    const parent = await createUnitAsAdmin(srv.base, { parentId: "root", name: "P", kind: "department" });
    const child = await createUnitAsAdmin(srv.base, { parentId: parent.id, name: "Q", kind: "team" });
    await seedActive(srv.built, "U-mgr2");
    await seedActive(srv.built, "U-join2");
    await adminFetch(srv.base, "POST", `${UNITS_PATH}/${parent.id}/members`, "admin-alice", {
      principalId: "U-mgr2",
      role: "manager",
    });
    const added = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${child.id}/members`, "U-mgr2", {
      principalId: "U-join2",
      role: "member",
    });
    assert.equal(added.status, 200);
    const removed = await adminFetch(srv.base, "DELETE", `${UNITS_PATH}/${child.id}/members/U-join2`, "U-mgr2", {});
    assert.equal(removed.status, 200);
  } finally {
    await srv.close();
  }
});

test("a suspended manager is rejected by the portal gate before authorization runs", async () => {
  const srv = await startAdmin();
  try {
    const unit = await createUnitAsAdmin(srv.base, { parentId: "root", name: "R", kind: "team" });
    await seedActive(srv.built, "U-mgr3");
    await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "admin-alice", {
      principalId: "U-mgr3",
      role: "manager",
    });
    const suspended = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/U-mgr3`, "admin-alice", {
      status: "suspended",
    });
    assert.equal(suspended.status, 200);
    const res = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "U-mgr3", {
      principalId: "U-mgr3",
      role: "member",
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("member add reports unknown or deprovisioned principals without partially writing", async () => {
  const srv = await startAdmin();
  try {
    const unit = await createUnitAsAdmin(srv.base, { parentId: "root", name: "E2", kind: "team" });
    const unknown = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "admin-alice", {
      principalId: "U-ghost",
      role: "member",
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual((await unknown.json()) as any, {
      error: "not_found",
      message: "one or more organization users are unavailable",
      invalidPrincipalIds: ["U-ghost"],
    });
    await seedActive(srv.built, "U-dep");
    const deprovisioned = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/U-dep`, "admin-alice", {
      status: "deprovisioned",
    });
    assert.equal(deprovisioned.status, 200);
    const res = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "admin-alice", {
      principalId: "U-dep",
      role: "member",
    });
    assert.equal(res.status, 404);
    assert.deepEqual((await res.json()) as any, {
      error: "not_found",
      message: "one or more organization users are unavailable",
      invalidPrincipalIds: ["U-dep"],
    });
    const badRoles: Array<Record<string, unknown>> = [
      {},
      { principalId: "U-x" },
      { principalId: "U-x", role: "owner" },
      { principalId: "", role: "member" },
    ];
    for (const body of badRoles) {
      const bad = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "admin-alice", body);
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
  } finally {
    await srv.close();
  }
});

test("capability tokens are denied org unit routes", async () => {
  const srv = await startAdmin();
  try {
    const adminSession = await srv.built.organization.checkActive("admin-alice");
    const cap = await mintCapabilityToken(
      {
        actorId: "admin-alice",
        sessionVersion: adminSession!.sessionVersion,
        scopeId: "personal:admin-alice",
        aud: CONTROL_PLANE_AUD,
        liveActor: true,
        exp: Date.now() + 60_000,
      },
      CAP,
    );
    const created = await fetch(`${srv.base}${UNITS_PATH}`, {
      method: "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ parentId: "root", name: "X", kind: "team" }),
    });
    assert.equal(created.status, 403, "capability tokens must not reach org unit mutations");
    const list = await fetch(`${srv.base}${UNITS_PATH}`, { headers: { "x-agent-capability": cap } });
    assert.equal(list.status, 403, "capability tokens must not reach org unit reads");
  } finally {
    await srv.close();
  }
});

async function createGroupAsAdmin(base: string, body: Record<string, unknown>): Promise<any> {
  const res = await adminFetch(base, "POST", GROUPS_PATH, "admin-alice", body);
  const payload: any = await res.json();
  assert.equal(res.status, 200, JSON.stringify(payload));
  return payload.group;
}

test("admin creates, lists, and reads access groups with members", async () => {
  const srv = await startAdmin();
  try {
    const group = await createGroupAsAdmin(srv.base, { name: "On-call" });
    assert.ok(group.id.startsWith("grp-"));
    assert.equal(group.name, "On-call");
    assert.equal(group.status, "active");
    assert.equal(group.createdBy, "admin-alice");
    assert.equal(group.updatedBy, "admin-alice");
    assert.equal(typeof group.createdAt, "number");
    assert.equal(typeof group.updatedAt, "number");
    const list = await adminGet(srv.base, GROUPS_PATH, "admin-alice");
    assert.equal(list.status, 200);
    const listed: any = await list.json();
    assert.ok(listed.groups.some((g: any) => g.id === group.id));
    await seedActive(srv.built, "U-grp-member");
    const added = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${group.id}/members`, "admin-alice", {
      principalId: "U-grp-member",
      role: "member",
    });
    assert.equal(added.status, 200);
    const addedBody: any = await added.json();
    assert.equal(addedBody.group.id, group.id);
    assert.equal(addedBody.members.length, 1);
    assert.equal(addedBody.members[0].groupId, group.id);
    assert.equal(addedBody.members[0].principalId, "U-grp-member");
    assert.equal(addedBody.members[0].role, "member");
    assert.equal(addedBody.members[0].createdBy, "admin-alice");
    const detail = await adminGet(srv.base, `${GROUPS_PATH}/${group.id}`, "admin-alice");
    assert.equal(detail.status, 200);
    const detailBody: any = await detail.json();
    assert.equal(detailBody.group.id, group.id);
    assert.equal(detailBody.members.length, 1);
    assert.equal(detailBody.members[0].principalId, "U-grp-member");
    const missing = await adminGet(srv.base, `${GROUPS_PATH}/grp-ghost`, "admin-alice");
    assert.equal(missing.status, 404);
  } finally {
    await srv.close();
  }
});

test("access group member batches are deduplicated and atomic", async () => {
  const srv = await startAdmin();
  try {
    const group = await createGroupAsAdmin(srv.base, { name: "Batch" });
    await seedActive(srv.built, "U-group-1");
    await seedActive(srv.built, "U-group-2");
    const before = await srv.built.organizationStore.getAuthzRevision("default-org");
    const added = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${group.id}/members`, "admin-alice", {
      principalIds: ["U-group-1", "U-group-2", "U-group-1"],
      role: "member",
    });
    assert.equal(added.status, 200);
    assert.deepEqual(((await added.json()) as any).members.map((member: any) => member.principalId).sort(), [
      "U-group-1",
      "U-group-2",
    ]);
    assert.equal(await srv.built.organizationStore.getAuthzRevision("default-org"), before + 1);
    const failed = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${group.id}/members`, "admin-alice", {
      principalIds: ["U-group-1", "U-missing"],
      role: "manager",
    });
    assert.equal(failed.status, 404);
    assert.deepEqual((await failed.json()) as any, {
      error: "not_found",
      message: "one or more organization users are unavailable",
      invalidPrincipalIds: ["U-missing"],
    });
    const detail = await adminGet(srv.base, `${GROUPS_PATH}/${group.id}`, "admin-alice");
    assert.ok(((await detail.json()) as any).members.every((member: any) => member.role === "member"));
  } finally {
    await srv.close();
  }
});

test("admin renames, archives, and restores access groups via PATCH with invalid input rejected 400", async () => {
  const srv = await startAdmin();
  try {
    const group = await createGroupAsAdmin(srv.base, { name: "Old" });
    const renamed = await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${group.id}`, "admin-alice", { name: "New" });
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as any).group.name, "New");
    const archived = await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${group.id}`, "admin-alice", {
      status: "archived",
    });
    assert.equal(archived.status, 200);
    assert.equal(((await archived.json()) as any).group.status, "archived");
    const restored = await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${group.id}`, "admin-alice", {
      status: "active",
    });
    assert.equal(restored.status, 200);
    assert.equal(((await restored.json()) as any).group.status, "active");
    const combined = await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${group.id}`, "admin-alice", {
      status: "archived",
      name: "Both",
    });
    assert.equal(combined.status, 200);
    const combinedGroup: any = ((await combined.json()) as any).group;
    assert.equal(combinedGroup.status, "archived");
    assert.equal(combinedGroup.name, "Both");
    const missing = await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/grp-ghost`, "admin-alice", { name: "x" });
    assert.equal(missing.status, 404);
    const badPatches: Array<Record<string, unknown>> = [{}, { name: "" }, { status: "banned" }, { status: 42 }];
    for (const body of badPatches) {
      const res = await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${group.id}`, "admin-alice", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const badCreates: Array<Record<string, unknown>> = [{}, { name: "" }, { name: "  " }, { name: 7 }];
    for (const body of badCreates) {
      const res = await adminFetch(srv.base, "POST", GROUPS_PATH, "admin-alice", body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  } finally {
    await srv.close();
  }
});

test("a non-admin active user without a manager role is forbidden from group reads and writes", async () => {
  const srv = await startAdmin();
  try {
    await seedActive(srv.built, "U-gplain");
    const group = await createGroupAsAdmin(srv.base, { name: "Locked" });
    const created = await adminFetch(srv.base, "POST", GROUPS_PATH, "U-gplain", { name: "Nope" });
    assert.equal(created.status, 403);
    const added = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${group.id}/members`, "U-gplain", {
      principalId: "U-gplain",
      role: "member",
    });
    assert.equal(added.status, 404);
    const removed = await adminFetch(srv.base, "DELETE", `${GROUPS_PATH}/${group.id}/members/U-gplain`, "U-gplain", {});
    assert.equal(removed.status, 404);
    const list = await adminGet(srv.base, GROUPS_PATH, "U-gplain");
    assert.equal(list.status, 403);
    const detail = await adminGet(srv.base, `${GROUPS_PATH}/${group.id}`, "U-gplain");
    assert.equal(detail.status, 403);
    const patched = await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${group.id}`, "U-gplain", { name: "H" });
    assert.equal(patched.status, 403);
  } finally {
    await srv.close();
  }
});

test("group managers add and remove member-role members only in their own group", async () => {
  const srv = await startAdmin();
  try {
    const managed = await createGroupAsAdmin(srv.base, { name: "Managed" });
    const other = await createGroupAsAdmin(srv.base, { name: "Other" });
    await seedActive(srv.built, "U-gmgr");
    await seedActive(srv.built, "U-gjoin");
    const grant = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${managed.id}/members`, "admin-alice", {
      principalId: "U-gmgr",
      role: "manager",
    });
    assert.equal(grant.status, 200);
    const list = await adminGet(srv.base, GROUPS_PATH, "U-gmgr");
    assert.equal(list.status, 200);
    assert.deepEqual(
      ((await list.json()) as any).groups.map((group: any) => group.id),
      [managed.id],
    );
    assert.equal((await adminGet(srv.base, `${GROUPS_PATH}/${managed.id}`, "U-gmgr")).status, 200);
    assert.equal((await adminGet(srv.base, `${GROUPS_PATH}/${other.id}`, "U-gmgr")).status, 404);
    const added = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${managed.id}/members`, "U-gmgr", {
      principalId: "U-gjoin",
      role: "member",
    });
    assert.equal(added.status, 200);
    const addedBody: any = await added.json();
    assert.equal(addedBody.members.length, 2);
    assert.equal(addedBody.members.find((m: any) => m.principalId === "U-gjoin").role, "member");
    const removed = await adminFetch(srv.base, "DELETE", `${GROUPS_PATH}/${managed.id}/members/U-gjoin`, "U-gmgr", {});
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as any).members.length, 1);
    const crossGroup = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${other.id}/members`, "U-gmgr", {
      principalId: "U-gjoin",
      role: "member",
    });
    assert.equal(crossGroup.status, 404);
    const managerGrant = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${managed.id}/members`, "U-gmgr", {
      principalId: "U-gjoin",
      role: "manager",
    });
    assert.equal(managerGrant.status, 403);
    const managerDemotion = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${managed.id}/members`, "U-gmgr", {
      principalId: "U-gmgr",
      role: "member",
    });
    assert.equal(managerDemotion.status, 403);
    const managerRevoke = await adminFetch(
      srv.base,
      "DELETE",
      `${GROUPS_PATH}/${managed.id}/members/U-gmgr`,
      "U-gmgr",
      {},
    );
    assert.equal(managerRevoke.status, 403);
    const unknown = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/grp-ghost/members`, "U-gmgr", {
      principalId: "U-gjoin",
      role: "member",
    });
    assert.equal(unknown.status, 404);
    const archived = await createGroupAsAdmin(srv.base, { name: "Archived" });
    await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${archived.id}`, "admin-alice", { status: "archived" });
    const hidden = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${archived.id}/members`, "U-gmgr", {
      principalId: "U-gjoin",
      role: "member",
    });
    assert.equal(hidden.status, 404);
    const managerRestore = await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${archived.id}`, "U-gmgr", {
      status: "active",
    });
    assert.equal(managerRestore.status, 403);
    const adminUnknown = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/grp-ghost/members`, "admin-alice", {
      principalId: "U-gjoin-admin-probe",
      role: "member",
    });
    assert.equal(adminUnknown.status, 404);
    const archivedManaged = await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${managed.id}`, "admin-alice", {
      status: "archived",
    });
    assert.equal(archivedManaged.status, 200);
    assert.equal((await adminGet(srv.base, GROUPS_PATH, "U-gmgr")).status, 403);
  } finally {
    await srv.close();
  }
});

test("group member add rejects unknown, deprovisioned, or archived targets with mapped statuses", async () => {
  const srv = await startAdmin();
  try {
    const group = await createGroupAsAdmin(srv.base, { name: "Members" });
    const unknown = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${group.id}/members`, "admin-alice", {
      principalId: "U-ghost",
      role: "member",
    });
    assert.equal(unknown.status, 404);
    assert.deepEqual((await unknown.json()) as any, {
      error: "not_found",
      message: "one or more organization users are unavailable",
      invalidPrincipalIds: ["U-ghost"],
    });
    await seedActive(srv.built, "U-gdep");
    const deprovisioned = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/U-gdep`, "admin-alice", {
      status: "deprovisioned",
    });
    assert.equal(deprovisioned.status, 200);
    const res = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${group.id}/members`, "admin-alice", {
      principalId: "U-gdep",
      role: "member",
    });
    assert.equal(res.status, 404);
    assert.deepEqual((await res.json()) as any, {
      error: "not_found",
      message: "one or more organization users are unavailable",
      invalidPrincipalIds: ["U-gdep"],
    });
    const archivedGroup = await createGroupAsAdmin(srv.base, { name: "Arc" });
    await adminFetch(srv.base, "PATCH", `${GROUPS_PATH}/${archivedGroup.id}`, "admin-alice", { status: "archived" });
    const archivedAdd = await adminFetch(
      srv.base,
      "POST",
      `${GROUPS_PATH}/${archivedGroup.id}/members`,
      "admin-alice",
      { principalId: "U-ghost", role: "member" },
    );
    assert.equal(archivedAdd.status, 400);
    assert.equal(((await archivedAdd.json()) as any).error, "archived");
    const badRoles: Array<Record<string, unknown>> = [
      {},
      { principalId: "U-x" },
      { principalId: "U-x", role: "owner" },
      { principalId: "", role: "member" },
    ];
    for (const body of badRoles) {
      const bad = await adminFetch(srv.base, "POST", `${GROUPS_PATH}/${group.id}/members`, "admin-alice", body);
      assert.equal(bad.status, 400, JSON.stringify(body));
    }
  } finally {
    await srv.close();
  }
});

test("capability tokens are denied org access group routes", async () => {
  const srv = await startAdmin();
  try {
    const adminSession = await srv.built.organization.checkActive("admin-alice");
    const cap = await mintCapabilityToken(
      {
        actorId: "admin-alice",
        sessionVersion: adminSession!.sessionVersion,
        scopeId: "personal:admin-alice",
        aud: CONTROL_PLANE_AUD,
        liveActor: true,
        exp: Date.now() + 60_000,
      },
      CAP,
    );
    const created = await fetch(`${srv.base}${GROUPS_PATH}`, {
      method: "POST",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    assert.equal(created.status, 403, "capability tokens must not reach org access group mutations");
  } finally {
    await srv.close();
  }
});
