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
const UNITS_PATH = "/v1/admin/org/units";

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

async function seedActive(built: BuiltApp, principalId: string): Promise<void> {
  await built.organization.invite({ principalId, email: null, displayName: principalId, actor: "test" });
  await built.organization.setStatus({ principalId, status: "active", actor: "test" });
}

async function startAdmin(
  overrides: Partial<Config> = {},
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

test("non-admin actors are forbidden (403); a missing portal identity is unauthorized (401)", async () => {
  const srv = await startAdmin();
  try {
    await seedActive(srv.built, "U-nobody");
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

test("non-personal capability tokens are denied admin content reads (audit, errors, egress)", async () => {
  const srv = await startAdmin();
  try {
    const cap = await mintCapabilityToken(
      {
        actorId: "admin-alice",
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
      "x-portal-identity": await mintSignedPayload({ p: portalUser, exp: Date.now() + 60_000 }, PID),
    },
  });
}

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

test("a non-admin active user without a manager role is forbidden from unit reads and member writes", async () => {
  const srv = await startAdmin();
  try {
    await seedActive(srv.built, "U-plain");
    const unit = await createUnitAsAdmin(srv.base, { parentId: "root", name: "G", kind: "team" });
    const added = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "U-plain", {
      principalId: "U-plain",
      role: "member",
    });
    assert.equal(added.status, 403);
    const removed = await adminFetch(
      srv.base,
      "DELETE",
      `${UNITS_PATH}/${unit.id}/members/U-plain`,
      "U-plain",
      {},
    );
    assert.equal(removed.status, 403);
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
    const added = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${managed.id}/members`, "U-mgr", {
      principalId: "U-join",
      role: "member",
    });
    assert.equal(added.status, 200);
    const addedBody: any = await added.json();
    assert.equal(addedBody.members.length, 2);
    assert.equal(addedBody.members.find((m: any) => m.principalId === "U-join").role, "member");
    const removed = await adminFetch(
      srv.base,
      "DELETE",
      `${UNITS_PATH}/${managed.id}/members/U-join`,
      "U-mgr",
      {},
    );
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as any).members.length, 1);
    const crossUnit = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${sibling.id}/members`, "U-mgr", {
      principalId: "U-join",
      role: "member",
    });
    assert.equal(crossUnit.status, 403);
    const managerGrant = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${managed.id}/members`, "U-mgr", {
      principalId: "U-join",
      role: "manager",
    });
    assert.equal(managerGrant.status, 403);
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
    const removed = await adminFetch(
      srv.base,
      "DELETE",
      `${UNITS_PATH}/${child.id}/members/U-join2`,
      "U-mgr2",
      {},
    );
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

test("member add rejects unknown or deprovisioned principals with 400 missing_user", async () => {
  const srv = await startAdmin();
  try {
    const unit = await createUnitAsAdmin(srv.base, { parentId: "root", name: "E2", kind: "team" });
    const unknown = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "admin-alice", {
      principalId: "U-ghost",
      role: "member",
    });
    assert.equal(unknown.status, 400);
    assert.equal(((await unknown.json()) as any).error, "missing_user");
    await seedActive(srv.built, "U-dep");
    const deprovisioned = await adminFetch(srv.base, "PATCH", `${INVITE_PATH}/U-dep`, "admin-alice", {
      status: "deprovisioned",
    });
    assert.equal(deprovisioned.status, 200);
    const res = await adminFetch(srv.base, "POST", `${UNITS_PATH}/${unit.id}/members`, "admin-alice", {
      principalId: "U-dep",
      role: "member",
    });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, "missing_user");
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
