import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditLog, type AuditLog } from "../src/audit/audit-log.ts";
import { createIdentityService, type IdentityService } from "../src/identity/identity-service.ts";
import {
  createOrganizationService,
  type LoginInput,
  type OrgAdmission,
} from "../src/organization/organization-service.ts";
import {
  createMemoryOrganizationStore,
  type OrganizationStore,
  type OrganizationUser,
} from "../src/organization/organization-store.ts";
import { activateBootstrapUsers, buildApp } from "../src/wiring.ts";
import { settle } from "./support/settle.ts";
import { testConfig } from "./support/test-config.ts";

const ORG = "default-org";
const ISSUER = "https://idp.example.com";
const SCOPE = "org:default-org";

interface Harness {
  store: OrganizationStore;
  auditLog: AuditLog;
  identity: IdentityService;
  service: ReturnType<typeof createOrganizationService>;
  advance(ms: number): void;
}

function setup(
  over: {
    admission?: OrgAdmission;
    autoJoinDomains?: readonly string[];
    store?: OrganizationStore;
    resolveLegacyRuntimeUser?: (principalId: string) => Promise<boolean>;
  } = {},
): Harness {
  const auditLog = createAuditLog();
  const store = over.store ?? createMemoryOrganizationStore({ auditLog });
  const identity = createIdentityService();
  let nowMs = 1_700_000_000_000;
  const service = createOrganizationService({
    store,
    orgId: ORG,
    admission: over.admission ?? "invite_only",
    autoJoinDomains: over.autoJoinDomains ?? [],
    auditLog,
    identity,
    now: () => nowMs,
    ...(over.resolveLegacyRuntimeUser ? { resolveLegacyRuntimeUser: over.resolveLegacyRuntimeUser } : {}),
  });
  return { store, auditLog, identity, service, advance: (ms) => void (nowMs += ms) };
}

const loginInput = (over: Partial<LoginInput> = {}): LoginInput => ({
  principalId: "alice@acme.com",
  issuer: ISSUER,
  subject: "sub-1",
  email: "alice@acme.com",
  emailVerified: true,
  displayName: "Alice",
  ...over,
});

const orgUser = (over: Partial<OrganizationUser> = {}): OrganizationUser => ({
  orgId: ORG,
  principalId: "alice@acme.com",
  email: "alice@acme.com",
  displayName: "Alice",
  jobTitle: null,
  mobile: null,
  employeeNumber: null,
  status: "active",
  sessionVersion: 1,
  profileRevision: 1,
  createdAt: 1,
  updatedAt: 1,
  lastLoginAt: null,
  createdBy: "system:bootstrap",
  updatedBy: "system:bootstrap",
  ...over,
});

const boundIdentity = (over: Partial<{ subject: string; principalId: string }> = {}) => ({
  orgId: ORG,
  issuer: ISSUER,
  subject: over.subject ?? "sub-1",
  principalId: over.principalId ?? "alice@acme.com",
  emailAtLink: "alice@acme.com",
  createdAt: 1,
  updatedAt: 1,
});

test("login: unknown user under invite_only is denied not_invited", async () => {
  const { service } = setup();
  const result = await service.login(loginInput());
  assert.deepEqual(result, { status: "denied", reason: "not_invited" });
});

test("directory policy updates use CAS, normalize roots, bump authorization revision, and audit", async () => {
  const { service, store, auditLog } = setup();
  await store.ensureOrgRoot({ orgId: ORG, name: "Acme", actor: "test", now: 1 });
  await store.putUser(orgUser({ principalId: "viewer" }));
  const engineering = await service.createUnit({
    parentId: "root",
    name: "Engineering",
    kind: "department",
    actor: "admin",
  });
  const platform = await service.createUnit({
    parentId: engineering.id,
    name: "Platform",
    kind: "team",
    actor: "admin",
  });
  const first = await service.setDirectoryPolicy({
    subjectKind: "user",
    subjectId: "viewer",
    mode: "limited",
    roots: [
      { unitId: engineering.id, includeDescendants: true },
      { unitId: platform.id, includeDescendants: false },
    ],
    expectedRevision: 0,
    actor: "admin",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(
    first.roots.map((root) => root.unitId),
    [engineering.id],
  );
  const conflict = await service.setDirectoryPolicy({
    subjectKind: "user",
    subjectId: "viewer",
    mode: "none",
    roots: [],
    expectedRevision: 0,
    actor: "admin",
  });
  assert.equal(conflict.ok, false);
  if (conflict.ok || conflict.reason !== "revision_conflict") return;
  assert.equal(conflict.currentRevision, 1);
  const deleted = await service.deleteDirectoryPolicy({
    subjectKind: "user",
    subjectId: "viewer",
    expectedRevision: 1,
    actor: "admin",
  });
  assert.equal(deleted.ok, true);
  assert.equal(await service.getDirectoryPolicy("user", "viewer"), null);
  assert.deepEqual(
    (await auditLog.events())
      .filter((event) => event.action.startsWith("org.directory_visibility"))
      .map((event) => event.action),
    ["org.directory_visibility.update", "org.directory_visibility.delete"],
  );
});

test("login: domain_auto_join creates an active user and links the identity", async () => {
  const { service, store } = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  const result = await service.login(loginInput());
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.user.status, "active");
  assert.equal(result.user.sessionVersion, 1);
  assert.equal(result.user.createdBy, "system:login");
  assert.equal(result.user.updatedBy, "system:login");
  const persisted = await store.getUser(ORG, "alice@acme.com");
  assert.equal(persisted?.status, "active");
  const linked = await store.getIdentity(ORG, ISSUER, "sub-1");
  assert.equal(linked?.principalId, "alice@acme.com");
});

test("login: domain_auto_join denies an email outside the allowed domains", async () => {
  const { service } = setup({ admission: "domain_auto_join", autoJoinDomains: ["other.com"] });
  const result = await service.login(loginInput());
  assert.deepEqual(result, { status: "denied", reason: "not_invited" });
});

test("login: domain_auto_join denies an unverified email as email_unverified", async () => {
  const { service } = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  const result = await service.login(loginInput({ emailVerified: false }));
  assert.deepEqual(result, { status: "denied", reason: "email_unverified" });
});

test("login: domain_auto_join with no configured domains still requires an email", async () => {
  const { service, store } = setup({ admission: "domain_auto_join", autoJoinDomains: [] });
  const result = await service.login(loginInput({ email: null, emailVerified: true }));
  assert.deepEqual(result, { status: "denied", reason: "not_invited" });
  assert.equal(await store.getUser(ORG, "alice@acme.com"), null, "an email-less login never creates a user");
});

test("login: an absent display name preserves the stored one", async () => {
  const { service } = setup();
  await service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  const first = await service.login(loginInput());
  assert.equal(first.status, "ok");
  const second = await service.login(loginInput({ displayName: "" }));
  assert.equal(second.status, "ok");
  if (second.status !== "ok") return;
  assert.equal(second.user.displayName, "Alice", "an absent display name never erases the stored one");
  const renamed = await service.login(loginInput({ displayName: "Alice Cooper" }));
  assert.equal(renamed.status, "ok");
  if (renamed.status !== "ok") return;
  assert.equal(renamed.user.displayName, "Alice", "login never overwrites administrator-owned profile data");
});

test("login: a lagging application clock never regresses persisted login timestamps", async () => {
  const { service, store } = setup();
  await store.putUser(orgUser({ updatedAt: 1_800_000_000_000, lastLoginAt: 1_800_000_000_000 }));
  await store.putIdentity(boundIdentity());
  const result = await service.login(loginInput({ displayName: "Alice Current" }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.user.updatedAt, 1_800_000_000_000);
  assert.equal(result.user.lastLoginAt, 1_800_000_000_000);
  assert.equal(result.user.displayName, "Alice");
});

test("login: verified-email evidence is bound to the exact email and cleared by an unverified change", async () => {
  const { service, store } = setup();
  await store.putUser(orgUser());
  await store.putIdentity(boundIdentity());
  assert.equal((await service.login(loginInput())).status, "ok");
  assert.deepEqual((await store.getIdentity(ORG, ISSUER, "sub-1"))?.evidence, {
    emailVerified: "true",
    emailVerifiedEmail: "alice@acme.com",
  });
  assert.equal((await service.login(loginInput({ email: "other@acme.com", emailVerified: false }))).status, "ok");
  const changed = await store.getIdentity(ORG, ISSUER, "sub-1");
  assert.equal(changed?.emailAtLink, "other@acme.com");
  assert.equal(changed?.evidence, null);
});

test("login: invited user matched by email activates and binds the identity", async () => {
  const { service, store } = setup();
  await service.invite({
    principalId: "alice@acme.com",
    email: "Alice@Acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  const result = await service.login(loginInput({ email: "alice@acme.com" }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.user.status, "active");
  assert.equal(result.user.sessionVersion, 2);
  const linked = await store.getIdentity(ORG, ISSUER, "sub-1");
  assert.equal(linked?.principalId, "alice@acme.com");
  const again = await service.login(loginInput({ email: null, emailVerified: false }));
  assert.equal(again.status, "ok");
  if (again.status !== "ok") return;
  assert.equal(again.user.principalId, "alice@acme.com");
});

test("login: pre-bound invited user activates on first login", async () => {
  const { service, store } = setup();
  await service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  await store.putIdentity(boundIdentity({ subject: "sub-9" }));
  const result = await service.login(loginInput({ subject: "sub-9", email: null, emailVerified: false }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.user.status, "active");
  assert.equal(result.user.sessionVersion, 2);
});

test("login: suspended and deprovisioned users are denied with their reason", async () => {
  const { service, store } = setup();
  await store.putUser(orgUser({ status: "suspended" }));
  await store.putIdentity(boundIdentity());
  const suspended = await service.login(loginInput());
  assert.deepEqual(suspended, { status: "denied", reason: "suspended" });
  await store.putUser(orgUser({ status: "deprovisioned" }));
  const deprovisioned = await service.login(loginInput());
  assert.deepEqual(deprovisioned, { status: "denied", reason: "deprovisioned" });
});

test("login: identity without a user row is denied unknown", async () => {
  const { service, store } = setup();
  await store.putIdentity(boundIdentity({ principalId: "ghost@acme.com" }));
  const result = await service.login(loginInput({ principalId: "ghost@acme.com", email: "ghost@acme.com" }));
  assert.deepEqual(result, { status: "denied", reason: "unknown" });
});

test("login: verified email binds an unbound active user without recreating the row", async () => {
  const { service, store, auditLog } = setup();
  await store.putUser(orgUser({ status: "active", sessionVersion: 5, createdBy: "system:migration" }));
  const result = await service.login(loginInput({ subject: "sub-new" }));
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.equal(result.user.sessionVersion, 5);
  assert.equal(result.user.createdBy, "system:migration");
  assert.equal((await store.getUser(ORG, "alice@acme.com"))?.lastLoginAt, 1_700_000_000_000);
  assert.equal((await store.getIdentity(ORG, ISSUER, "sub-new"))?.principalId, "alice@acme.com");
  assert.deepEqual(
    (await auditLog.events()).map((event) => event.action),
    ["org.user.login"],
  );
});

test("login: an active user with another identity binding rejects a second identity", async () => {
  const alreadyBound = setup();
  await alreadyBound.store.putUser(orgUser({ status: "active", sessionVersion: 6 }));
  await alreadyBound.store.putIdentity(boundIdentity({ subject: "sub-existing" }));
  const secondIdentity = await alreadyBound.service.login(loginInput({ subject: "sub-new" }));
  assert.deepEqual(secondIdentity, { status: "denied", reason: "unknown" });
  assert.equal(await alreadyBound.store.getIdentity(ORG, ISSUER, "sub-new"), null);
  assert.equal((await alreadyBound.store.getUser(ORG, "alice@acme.com"))?.sessionVersion, 6);
});

test("login: inactive email matches remain denied while a genuinely new email still auto-joins", async () => {
  const suspended = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  await suspended.store.putUser(orgUser({ status: "suspended", sessionVersion: 3 }));
  const suspendedResult = await suspended.service.login(loginInput({ subject: "sub-new" }));
  assert.deepEqual(suspendedResult, { status: "denied", reason: "suspended" });
  assert.equal(
    (await suspended.store.getUser(ORG, "alice@acme.com"))?.sessionVersion,
    3,
    "suspended user row untouched",
  );

  const fresh = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  const freshResult = await fresh.service.login(
    loginInput({ principalId: "new@acme.com", email: "new@acme.com", subject: "sub-new" }),
  );
  assert.equal(freshResult.status, "ok");
  if (freshResult.status !== "ok") return;
  assert.equal(freshResult.user.sessionVersion, 1, "genuinely new email still auto-joins");
});

test("login: domain auto-join never overwrites a suspended or deprovisioned row with the same principal", async () => {
  for (const status of ["suspended", "deprovisioned"] as const) {
    const { service, store } = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
    await store.putUser(
      orgUser({
        principalId: "same-principal",
        email: "old@example.net",
        status,
        sessionVersion: 7,
      }),
    );
    const result = await service.login(
      loginInput({ principalId: "same-principal", email: "new@acme.com", subject: `sub-${status}` }),
    );
    assert.deepEqual(result, { status: "denied", reason: status });
    const stored = await store.getUser(ORG, "same-principal");
    assert.equal(stored?.status, status);
    assert.equal(stored?.sessionVersion, 7);
    assert.equal(stored?.email, "old@example.net");
  }
});

test("setStatus: bumps sessionVersion, drives identity deactivation, and is idempotent", async () => {
  const { service, identity, auditLog } = setup();
  await service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  assert.equal(identity.classify("alice@acme.com").type, "guest");
  const suspended = await service.setStatus({
    principalId: "alice@acme.com",
    status: "suspended",
    actor: "admin@acme.com",
  });
  assert.equal(suspended?.sessionVersion, 2);
  assert.equal(suspended?.updatedBy, "admin@acme.com");
  assert.equal(identity.classify("alice@acme.com").type, "guest");
  const active = await service.setStatus({ principalId: "alice@acme.com", status: "active", actor: "admin@acme.com" });
  assert.equal(active?.sessionVersion, 3);
  assert.equal(identity.classify("alice@acme.com").type, "internal");
  const eventsBefore = (await auditLog.events()).length;
  const unchanged = await service.setStatus({
    principalId: "alice@acme.com",
    status: "active",
    actor: "admin@acme.com",
  });
  assert.equal(unchanged?.sessionVersion, 3, "same status is a no-op");
  assert.equal((await auditLog.events()).length, eventsBefore, "no audit event for a no-op");
  assert.equal(
    await service.setStatus({ principalId: "nobody@acme.com", status: "suspended", actor: "admin@acme.com" }),
    null,
  );
});

test("existing user, unit, and group mutations never regress updated timestamps", async () => {
  const { service, store } = setup();
  const future = 1_800_000_000_000;
  await store.putUser(orgUser({ updatedAt: future }));
  await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  assert.equal((await store.getUser(ORG, "alice@acme.com"))?.updatedAt, future);

  await bootstrapRoot(store);
  const unit = await service.createUnit({ parentId: "root", name: "Clock", kind: "team", actor: "admin@acme.com" });
  await store.putUnit({ ...unit, updatedAt: future });
  assert.equal(
    (await service.updateUnit({ unitId: unit.id, name: "Clock 2", actor: "admin@acme.com" }))?.updatedAt,
    future,
  );
  assert.deepEqual(await service.archiveUnit({ unitId: unit.id, actor: "admin@acme.com" }), { ok: true });
  assert.equal((await store.getUnit(ORG, unit.id))?.updatedAt, future);

  const group = await service.createGroup({ name: "Clock", actor: "admin@acme.com" });
  await store.putGroup({ ...group, updatedAt: future });
  assert.equal(
    (await service.updateGroup({ groupId: group.id, name: "Clock 2", actor: "admin@acme.com" }))?.updatedAt,
    future,
  );
  await service.archiveGroup({ groupId: group.id, actor: "admin@acme.com" });
  assert.equal((await store.getGroup(ORG, group.id))?.updatedAt, future);
});

test("login: activation reactivates the legacy identity after a suspend-then-invited detour", async () => {
  const { service, identity } = setup();
  await service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  await service.login(loginInput());
  await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  assert.equal(identity.classify("alice@acme.com").type, "guest");
  await service.setStatus({ principalId: "alice@acme.com", status: "invited", actor: "admin@acme.com" });
  assert.equal(identity.classify("alice@acme.com").type, "guest");
  const result = await service.login(loginInput());
  assert.equal(result.status, "ok");
  assert.equal(identity.classify("alice@acme.com").type, "internal", "activation reactivates the legacy identity");
});

test("bootstrap: the first run activates a listed user; later runs never resurrect a manual suspension", async () => {
  const { service } = setup();
  await activateBootstrapUsers(service, ["ops@acme.com"]);
  assert.deepEqual(await service.checkActive("ops@acme.com"), { status: "active", sessionVersion: 2 });
  await service.setStatus({ principalId: "ops@acme.com", status: "suspended", actor: "admin@acme.com" });
  await activateBootstrapUsers(service, ["ops@acme.com"]);
  assert.deepEqual(await service.checkActive("ops@acme.com"), { status: "suspended", sessionVersion: 3 });
});

test("checkActive: reflects local writes immediately and converges across instances after refresh", async () => {
  const { service, store, advance } = setup();
  assert.equal(await service.checkActive("alice@acme.com"), null);
  await service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  await service.login(loginInput());
  assert.deepEqual(await service.checkActive("alice@acme.com"), { status: "active", sessionVersion: 2 });
  await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  assert.deepEqual(await service.checkActive("alice@acme.com"), { status: "suspended", sessionVersion: 3 });
  const other = setup({ store });
  await other.service.setStatus({ principalId: "alice@acme.com", status: "active", actor: "admin@acme.com" });
  advance(10_000);
  await service.refresh();
  assert.deepEqual(await service.checkActive("alice@acme.com"), { status: "active", sessionVersion: 4 });
});

test("setStatus: a status change bumps the authz revision once and audits transactionally; a no-op writes nothing", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  await service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  const invited = await store.getAuthzRevision(ORG);
  await service.setStatus({ principalId: "alice@acme.com", status: "active", actor: "admin@acme.com" });
  const activated = await store.getAuthzRevision(ORG);
  assert.equal(activated, invited + 1, "invited -> active bumps the revision once");
  await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  assert.equal(await store.getAuthzRevision(ORG), activated + 1, "active -> suspended bumps the revision once");
  const statusEvents = (await auditLog.events()).filter((e) => e.action === "org.user.status");
  assert.deepEqual(
    statusEvents.map((e) => e.status),
    ["active", "suspended"],
  );
  assert.ok(statusEvents.every((e) => e.scopeLabel === SCOPE && e.resource === "alice@acme.com"));
  await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  assert.equal(await store.getAuthzRevision(ORG), activated + 1, "a same-status write never bumps the revision");
  assert.equal(
    (await auditLog.events()).filter((e) => e.action === "org.user.status").length,
    2,
    "a no-op writes no audit event",
  );
});

test("login: invited activation bumps the authz revision while a returning login does not", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  await service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  const invited = await store.getAuthzRevision(ORG);
  const first = await service.login(loginInput());
  assert.equal(first.status, "ok");
  const activated = await store.getAuthzRevision(ORG);
  assert.equal(activated, invited + 1, "invited -> active activation bumps the revision once");
  const second = await service.login(loginInput());
  assert.equal(second.status, "ok");
  assert.equal(await store.getAuthzRevision(ORG), activated, "a returning login never bumps the revision");
});

test("login: domain auto-join creation bumps the authz revision", async () => {
  const { service, store, auditLog } = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  await bootstrapRoot(store);
  const before = await store.getAuthzRevision(ORG);
  const result = await service.login(loginInput());
  assert.equal(result.status, "ok");
  assert.equal(await store.getAuthzRevision(ORG), before + 1, "auto-join creation bumps the revision once");
  assert.deepEqual(
    (await auditLog.events()).map((e) => e.action),
    ["org.user.auto_join"],
  );
});

test("backfillUser: creates an active user once and never changes an existing account", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const before = await store.getAuthzRevision(ORG);
  const created = await service.backfillUser({
    principalId: "legacy@acme.com",
    email: "legacy@acme.com",
    displayName: "legacy@acme.com",
  });
  assert.equal(created.created, true);
  assert.equal(created.user.status, "active");
  assert.equal(created.user.lastLoginAt, null);
  assert.equal(created.user.createdBy, "system:migration");
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  await service.setStatus({ principalId: "legacy@acme.com", status: "suspended", actor: "admin@acme.com" });
  const suspendedRevision = await store.getAuthzRevision(ORG);
  const existing = await service.backfillUser({
    principalId: "legacy@acme.com",
    email: "legacy@acme.com",
    displayName: "Changed",
  });
  assert.equal(existing.created, false);
  assert.equal(existing.user.status, "suspended");
  assert.equal(existing.user.displayName, "legacy@acme.com");
  assert.equal(await store.getAuthzRevision(ORG), suspendedRevision);
  await service.invite({
    principalId: "pending-account",
    email: "pending@acme.com",
    displayName: "Pending",
    actor: "admin@acme.com",
  });
  const invitedRevision = await store.getAuthzRevision(ORG);
  const matchedByEmail = await service.backfillUser({
    principalId: "pending@acme.com",
    email: "pending@acme.com",
    displayName: "pending@acme.com",
  });
  assert.equal(matchedByEmail.created, false);
  assert.equal(matchedByEmail.user.principalId, "pending-account");
  assert.equal(matchedByEmail.user.status, "invited");
  assert.equal(await store.getAuthzRevision(ORG), invitedRevision);
  assert.equal((await auditLog.events()).filter((event) => event.action === "org.user.backfill").length, 1);
});

test("legacy runtime compatibility never admits the user to organization APIs", async () => {
  const checked: string[] = [];
  const { service } = setup({
    resolveLegacyRuntimeUser: async (principalId) => {
      checked.push(principalId);
      return principalId === "legacy-slack-user";
    },
  });
  assert.equal(await service.checkActive("legacy-slack-user"), null);
  assert.deepEqual(await service.checkRuntimeActive("legacy-slack-user"), {
    status: "active",
    sessionVersion: 0,
  });
  assert.equal(await service.getUser("legacy-slack-user"), null);
  assert.equal(await service.checkRuntimeActive("uninvited-roster-user"), null);
  assert.deepEqual(checked, ["legacy-slack-user", "uninvited-roster-user"]);
});

test("deactivating legacy runtime compatibility writes a durable deprovisioned tombstone", async () => {
  const store = createMemoryOrganizationStore();
  store.legacyRuntimeAccessEligible = async (principalId) => principalId === "legacy-slack-user";
  const { service, identity } = setup({ store, resolveLegacyRuntimeUser: async () => true });
  assert.equal((await service.checkRuntimeActive("legacy-slack-user"))?.status, "active");
  assert.equal((await service.deactivatePrincipal({ principalId: "legacy-slack-user", actor: "admin" })).ok, true);
  assert.equal((await service.checkRuntimeActive("legacy-slack-user"))?.status, "deprovisioned");
  assert.equal((await service.getUser("legacy-slack-user"))?.status, "deprovisioned");
  assert.equal(identity.classify("legacy-slack-user").type, "guest");
  assert.equal((await service.deactivatePrincipal({ principalId: "legacy-slack-user", actor: "admin" })).ok, true);
  assert.equal((await service.deactivatePrincipal({ principalId: "unlisted-user", actor: "admin" })).ok, true);
  assert.equal((await service.getUser("unlisted-user"))?.status, "deprovisioned");
});

test("legacy deactivation wins a race with first organization user creation", async () => {
  const store = createMemoryOrganizationStore();
  store.legacyRuntimeAccessEligible = async (principalId) => principalId === "legacy-slack-user";
  const { service } = setup({ store });
  const [deactivated] = await Promise.all([
    service.deactivatePrincipal({ principalId: "legacy-slack-user", actor: "admin" }),
    service.backfillUser({ principalId: "legacy-slack-user", email: null, displayName: "Legacy User" }),
  ]);
  assert.equal(deactivated.ok, true);
  assert.notEqual((await service.getUser("legacy-slack-user"))?.status, "active");
});

test("source deactivation wins a race with domain auto-join", async () => {
  const { service } = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  const [deactivated] = await Promise.all([
    service.deactivatePrincipal({ principalId: "alice@acme.com", actor: "directory" }),
    service.login(loginInput()),
  ]);
  assert.equal(deactivated.ok, true);
  assert.notEqual((await service.getUser("alice@acme.com"))?.status, "active");
  const retry = await service.login(loginInput());
  assert.equal(retry.status, "denied");
});

test("source deactivation wins a race with an invitation", async () => {
  const { service } = setup();
  const invitation = service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  const deactivation = service.deactivatePrincipal({ principalId: "alice@acme.com", actor: "directory" });
  const [, deactivated] = await Promise.all([invitation, deactivation]);
  assert.equal(deactivated.ok, true);
  assert.equal((await service.getUser("alice@acme.com"))?.status, "deprovisioned");
  const login = await service.login(loginInput());
  assert.deepEqual(login, { status: "denied", reason: "deprovisioned" });
});

test("wiring: buildApp ensures the org root before seeding bootstrap users", async () => {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "qm-org-root-")),
    orgBootstrapUsers: ["ops@acme.com"],
  });
  const built = buildApp(config);
  await settle(async () => (await built.organizationStore.getUnit(config.orgId, "root")) !== null);
  const root = await built.organizationStore.getUnit(config.orgId, "root");
  assert.equal(root?.parentId, null);
  assert.equal(root?.kind, "organization");
  assert.equal(root?.status, "active");
  assert.ok((await built.organizationStore.getAuthzRevision(config.orgId)) >= 1);
});

test("audit: login, denial, activation, auto-join, and status changes are recorded", async () => {
  const { service, auditLog } = setup();
  await service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  await service.login(loginInput());
  await service.login(loginInput());
  await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  await service.login(loginInput());
  await service.login(loginInput({ principalId: "stranger@acme.com", email: "stranger@acme.com", subject: "sub-2" }));
  const events = await auditLog.events();
  assert.ok(events.every((e) => e.scopeLabel === SCOPE));
  const actions = events.map((e) => `${e.action}:${e.status ?? ""}`);
  assert.deepEqual(actions, [
    "org.user.invite:",
    "org.user.activate:",
    "org.user.login:",
    "org.user.login:",
    "org.user.status:suspended",
    "org.user.login_denied:suspended",
    "org.user.login_denied:not_invited",
  ]);
  const deniedStranger = events.find((e) => e.principalId === "stranger@acme.com");
  assert.equal(deniedStranger?.resource, "stranger@acme.com");
  const reinvite = await service.invite({
    principalId: "alice@acme.com",
    email: "alice@acme.com",
    displayName: "Alice",
    actor: "admin@acme.com",
  });
  assert.equal(reinvite.status, "suspended", "re-invite returns the stored row unchanged");
  assert.equal((await auditLog.events()).length, events.length, "re-invite no-op records no event");

  const autoJoin = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  await autoJoin.service.login(
    loginInput({ principalId: "carol@acme.com", email: "carol@acme.com", subject: "sub-3" }),
  );
  const autoJoinEvents = await autoJoin.auditLog.events();
  assert.deepEqual(
    autoJoinEvents.map((e) => e.action),
    ["org.user.auto_join"],
  );
  assert.equal(autoJoinEvents[0]?.scopeLabel, SCOPE);
});

const bootstrapRoot = async (store: OrganizationStore): Promise<void> => {
  await store.ensureOrgRoot({ orgId: ORG, name: "Acme", actor: "system:bootstrap", now: 1 });
};

const unitMember = (unitId: string, principalId: string) => ({
  orgId: ORG,
  unitId,
  principalId,
  role: "member" as const,
  createdAt: 1,
  createdBy: "admin@acme.com",
});

test("createUnit: creates a child under the root with closure, audit, and one revision bump", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({
    parentId: "root",
    name: "Engineering",
    kind: "department",
    actor: "admin@acme.com",
  });
  assert.ok(unit.id.startsWith("unit-"));
  assert.equal(unit.orgId, ORG);
  assert.equal(unit.parentId, "root");
  assert.equal(unit.status, "active");
  assert.equal(unit.sortOrder, 0);
  assert.equal(unit.createdBy, "admin@acme.com");
  assert.equal(await store.isDescendant(ORG, "root", unit.id), true);
  assert.equal(await store.isDescendant(ORG, unit.id, "root"), false);
  assert.equal(await store.getAuthzRevision(ORG), 2);
  const events = (await auditLog.events()).filter((e) => e.action === "org.unit.create");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.principalId, "admin@acme.com");
  assert.equal(events[0]?.scopeLabel, SCOPE);
  assert.equal(events[0]?.resource, `unit:${unit.id}`);
  assert.deepEqual(JSON.parse(events[0]?.detail ?? ""), { unitId: unit.id, parentId: "root" });
});

test("createUnit: a second root is rejected while an active root exists", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  await assert.rejects(
    service.createUnit({ parentId: null, name: "Second Root", kind: "organization", actor: "admin@acme.com" }),
    /root/,
  );
  assert.equal((await store.listUnits(ORG)).length, 1, "no second root persisted");
});

test("createUnit: a missing or archived parent is rejected", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  await assert.rejects(
    service.createUnit({ parentId: "unit-missing", name: "X", kind: "team", actor: "admin@acme.com" }),
  );
  const dept = await service.createUnit({
    parentId: "root",
    name: "Dept",
    kind: "department",
    actor: "admin@acme.com",
  });
  await service.archiveUnit({ unitId: dept.id, actor: "admin@acme.com" });
  await assert.rejects(service.createUnit({ parentId: dept.id, name: "Y", kind: "team", actor: "admin@acme.com" }));
  assert.equal((await store.listUnits(ORG)).length, 2, "only root and the archived dept exist");
});

test("moveUnit: rejects root moves, self and descendant moves, and missing or archived parents", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  const a = await service.createUnit({ parentId: "root", name: "A", kind: "department", actor: "admin@acme.com" });
  const b = await service.createUnit({ parentId: a.id, name: "B", kind: "team", actor: "admin@acme.com" });
  const old = await service.createUnit({ parentId: "root", name: "Old", kind: "team", actor: "admin@acme.com" });
  await service.archiveUnit({ unitId: old.id, actor: "admin@acme.com" });
  assert.deepEqual(await service.moveUnit({ unitId: "root", newParentId: a.id, actor: "admin@acme.com" }), {
    ok: false,
    reason: "root",
  });
  assert.deepEqual(await service.moveUnit({ unitId: a.id, newParentId: a.id, actor: "admin@acme.com" }), {
    ok: false,
    reason: "self_or_descendant",
  });
  assert.deepEqual(await service.moveUnit({ unitId: a.id, newParentId: b.id, actor: "admin@acme.com" }), {
    ok: false,
    reason: "self_or_descendant",
  });
  assert.deepEqual(await service.moveUnit({ unitId: b.id, newParentId: "unit-missing", actor: "admin@acme.com" }), {
    ok: false,
    reason: "missing_parent",
  });
  assert.deepEqual(await service.moveUnit({ unitId: b.id, newParentId: old.id, actor: "admin@acme.com" }), {
    ok: false,
    reason: "archived",
  });
  assert.equal((await store.getUnit(ORG, a.id))?.parentId, "root", "rejected moves never re-parent");
});

test("moveUnit: re-links the subtree, bumps revision once, and writes one audit event", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const a = await service.createUnit({ parentId: "root", name: "A", kind: "department", actor: "admin@acme.com" });
  const b = await service.createUnit({ parentId: a.id, name: "B", kind: "team", actor: "admin@acme.com" });
  const c = await service.createUnit({ parentId: "root", name: "C", kind: "department", actor: "admin@acme.com" });
  const before = await store.getAuthzRevision(ORG);
  assert.deepEqual(await service.moveUnit({ unitId: a.id, newParentId: c.id, actor: "admin@acme.com" }), { ok: true });
  assert.equal((await store.getUnit(ORG, a.id))?.parentId, c.id);
  assert.equal(await store.isDescendant(ORG, c.id, b.id), true, "subtree follows the move");
  assert.equal(await store.isDescendant(ORG, "root", b.id), true);
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  const moves = (await auditLog.events()).filter((e) => e.action === "org.unit.move");
  assert.equal(moves.length, 1);
  assert.equal(moves[0]?.principalId, "admin@acme.com");
  assert.equal(moves[0]?.resource, `unit:${a.id}`);
  assert.deepEqual(JSON.parse(moves[0]?.detail ?? ""), { unitId: a.id, parentId: c.id });
});

test("moveUnit: choosing the current parent is a no-op", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({
    parentId: "root",
    name: "A",
    kind: "department",
    actor: "admin@acme.com",
  });
  const revision = await store.getAuthzRevision(ORG);
  const events = (await auditLog.events()).length;
  assert.deepEqual(await service.previewMoveUnit({ unitId: unit.id, newParentId: "root" }), {
    ok: true,
    impact: { activeUnits: 0, activeMembers: 0 },
  });
  assert.deepEqual(await service.moveUnit({ unitId: unit.id, newParentId: "root", actor: "admin@acme.com" }), {
    ok: true,
  });
  assert.equal(await store.getAuthzRevision(ORG), revision);
  assert.equal((await auditLog.events()).length, events);
});

test("previewMoveUnit: validates the destination and reports unique active users across the subtree without writing", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const a = await service.createUnit({ parentId: "root", name: "A", kind: "department", actor: "admin@acme.com" });
  const b = await service.createUnit({ parentId: a.id, name: "B", kind: "team", actor: "admin@acme.com" });
  const c = await service.createUnit({ parentId: "root", name: "C", kind: "department", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "one@acme.com", email: "one@acme.com" }));
  await store.putUser(orgUser({ principalId: "two@acme.com", email: "two@acme.com" }));
  await store.putUser(orgUser({ principalId: "paused@acme.com", email: "paused@acme.com", status: "suspended" }));
  await store.putUnitMember(unitMember(a.id, "one@acme.com"));
  await store.putUnitMember(unitMember(b.id, "one@acme.com"));
  await store.putUnitMember(unitMember(b.id, "two@acme.com"));
  await store.putUnitMember(unitMember(b.id, "paused@acme.com"));
  const revision = await store.getAuthzRevision(ORG);
  const events = (await auditLog.events()).length;
  assert.deepEqual(await service.previewMoveUnit({ unitId: a.id, newParentId: c.id }), {
    ok: true,
    impact: { activeUnits: 2, activeMembers: 2 },
  });
  assert.equal((await store.getUnit(ORG, a.id))?.parentId, "root");
  assert.equal(await store.getAuthzRevision(ORG), revision);
  assert.equal((await auditLog.events()).length, events);
  assert.deepEqual(await service.previewMoveUnit({ unitId: a.id, newParentId: b.id }), {
    ok: false,
    reason: "self_or_descendant",
  });
});

test("archiveUnit: refuses the root, reports conflicts, archives clean units, and restores via updateUnit", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  assert.deepEqual(await service.archiveUnit({ unitId: "root", actor: "admin@acme.com" }), {
    ok: false,
    reason: "root",
  });
  const parent = await service.createUnit({
    parentId: "root",
    name: "Parent",
    kind: "department",
    actor: "admin@acme.com",
  });
  const child = await service.createUnit({ parentId: parent.id, name: "Child", kind: "team", actor: "admin@acme.com" });
  const childBlocked = await service.archiveUnit({ unitId: parent.id, actor: "admin@acme.com" });
  assert.equal(childBlocked.ok, false);
  if (childBlocked.ok) return;
  assert.equal(childBlocked.reason, "conflict");
  assert.equal(childBlocked.impact?.activeChildUnits, 1);
  const membered = await service.createUnit({
    parentId: "root",
    name: "Membered",
    kind: "team",
    actor: "admin@acme.com",
  });
  await store.putUser(orgUser({ principalId: "bob@acme.com", email: "bob@acme.com" }));
  await store.putUnitMember(unitMember(membered.id, "bob@acme.com"));
  const memberBlocked = await service.archiveUnit({ unitId: membered.id, actor: "admin@acme.com" });
  assert.equal(memberBlocked.ok, false);
  if (memberBlocked.ok) return;
  assert.equal(memberBlocked.reason, "conflict");
  assert.equal(memberBlocked.impact?.activeMembers, 1);
  const before = await store.getAuthzRevision(ORG);
  assert.deepEqual(await service.archiveUnit({ unitId: child.id, actor: "admin@acme.com" }), { ok: true });
  assert.equal((await store.getUnit(ORG, child.id))?.status, "archived");
  assert.equal(
    (await store.unitImpact(ORG, parent.id)).activeChildUnits,
    0,
    "archived child no longer counts as active",
  );
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.unit.archive").length, 1);
  const restoreBefore = await store.getAuthzRevision(ORG);
  const restored = await service.updateUnit({ unitId: child.id, status: "active", actor: "admin@acme.com" });
  assert.equal(restored?.status, "active");
  assert.equal(await store.getAuthzRevision(ORG), restoreBefore + 1);
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.unit.update").length, 1);
});

test("updateUnit: an archived child cannot be restored before its parent", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  const parent = await service.createUnit({
    parentId: "root",
    name: "Parent",
    kind: "department",
    actor: "admin@acme.com",
  });
  const child = await service.createUnit({ parentId: parent.id, name: "Child", kind: "team", actor: "admin@acme.com" });
  assert.deepEqual(await service.archiveUnit({ unitId: child.id, actor: "admin@acme.com" }), { ok: true });
  assert.deepEqual(await service.archiveUnit({ unitId: parent.id, actor: "admin@acme.com" }), { ok: true });
  assert.equal(await service.updateUnit({ unitId: child.id, status: "active", actor: "admin@acme.com" }), null);
  assert.equal((await store.getUnit(ORG, child.id))?.status, "archived");
  assert.equal(
    (await service.updateUnit({ unitId: parent.id, status: "active", actor: "admin@acme.com" }))?.status,
    "active",
  );
  assert.equal(
    (await service.updateUnit({ unitId: child.id, status: "active", actor: "admin@acme.com" }))?.status,
    "active",
  );
});

test("archiveUnit: a suspended member still blocks archival while deprovisioned and missing users do not", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "suspended@acme.com", status: "suspended" }));
  await store.putUser(orgUser({ principalId: "gone@acme.com", status: "deprovisioned" }));
  await store.putUnitMember(unitMember(unit.id, "suspended@acme.com"));
  await store.putUnitMember(unitMember(unit.id, "gone@acme.com"));
  await store.putUnitMember(unitMember(unit.id, "missing@acme.com"));
  const blocked = await service.archiveUnit({ unitId: unit.id, actor: "admin@acme.com" });
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.reason, "conflict");
  assert.equal(blocked.impact?.activeMembers, 1, "only the suspended member counts");
});

test("addUnitMember: adds a row with role, audit, and one revision bump; re-add updates the role in place", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "bob@acme.com", email: "bob@acme.com" }));
  const before = await store.getAuthzRevision(ORG);
  assert.deepEqual(
    await service.addUnitMember({
      unitId: unit.id,
      principalId: "bob@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: true,
    },
  );
  let members = await store.listUnitMembers(ORG, unit.id);
  assert.equal(members.length, 1);
  assert.equal(members[0]?.role, "member");
  assert.equal(members[0]?.createdBy, "admin@acme.com");
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  const adds = (await auditLog.events()).filter((e) => e.action === "org.unit.member.add");
  assert.equal(adds.length, 1);
  assert.equal(adds[0]?.principalId, "admin@acme.com");
  assert.equal(adds[0]?.scopeLabel, SCOPE);
  assert.equal(adds[0]?.resource, `unit:${unit.id}`);
  assert.deepEqual(JSON.parse(adds[0]?.detail ?? ""), { unitId: unit.id, principalId: "bob@acme.com", role: "member" });
  const roleBefore = await store.getAuthzRevision(ORG);
  assert.deepEqual(
    await service.addUnitMember({
      unitId: unit.id,
      principalId: "bob@acme.com",
      role: "manager",
      actor: "admin@acme.com",
    }),
    {
      ok: true,
    },
  );
  members = await store.listUnitMembers(ORG, unit.id);
  assert.equal(members.length, 1, "re-add keeps a single row");
  assert.equal(members[0]?.role, "manager");
  assert.equal(members[0]?.createdBy, "admin@acme.com", "role update preserves the original row fields");
  assert.equal(await store.getAuthzRevision(ORG), roleBefore + 1);
  const noopBefore = await store.getAuthzRevision(ORG);
  assert.deepEqual(
    await service.addUnitMember({
      unitId: unit.id,
      principalId: "bob@acme.com",
      role: "manager",
      actor: "admin@acme.com",
    }),
    {
      ok: true,
    },
  );
  assert.equal(await store.getAuthzRevision(ORG), noopBefore, "a same-role re-add is a no-op");
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.unit.member.add").length, 2);
});

test("addUnitMembers: validates the full batch and adds all members with one revision bump", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "one@acme.com", email: "one@acme.com" }));
  await store.putUser(orgUser({ principalId: "two@acme.com", email: "two@acme.com" }));
  const before = await store.getAuthzRevision(ORG);
  assert.deepEqual(
    await service.addUnitMembers({
      unitId: unit.id,
      principalIds: ["one@acme.com", "missing@acme.com"],
      role: "member",
      actor: "admin@acme.com",
    }),
    { ok: false, reason: "missing_user", invalidPrincipalIds: ["missing@acme.com"] },
  );
  assert.equal((await store.listUnitMembers(ORG, unit.id)).length, 0);
  assert.equal(await store.getAuthzRevision(ORG), before);
  assert.deepEqual(
    await service.addUnitMembers({
      unitId: unit.id,
      principalIds: ["one@acme.com", "two@acme.com"],
      role: "member",
      actor: "admin@acme.com",
    }),
    { ok: true },
  );
  assert.deepEqual((await store.listUnitMembers(ORG, unit.id)).map((member) => member.principalId).sort(), [
    "one@acme.com",
    "two@acme.com",
  ]);
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  assert.equal((await auditLog.events()).filter((event) => event.action === "org.unit.member.add").length, 2);
});

test("addUnitMember: only active users can be assigned", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "gone@acme.com", status: "deprovisioned" }));
  await store.putUser(orgUser({ principalId: "pending@acme.com", status: "invited" }));
  assert.deepEqual(
    await service.addUnitMember({
      unitId: unit.id,
      principalId: "ghost@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: false,
      reason: "missing_user",
      invalidPrincipalIds: ["ghost@acme.com"],
    },
  );
  assert.deepEqual(
    await service.addUnitMember({
      unitId: unit.id,
      principalId: "gone@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: false,
      reason: "missing_user",
      invalidPrincipalIds: ["gone@acme.com"],
    },
  );
  assert.deepEqual(
    await service.addUnitMember({
      unitId: unit.id,
      principalId: "pending@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: false,
      reason: "missing_user",
      invalidPrincipalIds: ["pending@acme.com"],
    },
  );
  assert.equal((await store.listUnitMembers(ORG, unit.id)).length, 0);
});

test("addUnitMember: archived or missing units reject without touching membership", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  await store.putUser(orgUser({ principalId: "bob@acme.com", email: "bob@acme.com" }));
  assert.deepEqual(
    await service.addUnitMember({
      unitId: "unit-missing",
      principalId: "bob@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: false,
      reason: "missing_unit",
    },
  );
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  await service.archiveUnit({ unitId: unit.id, actor: "admin@acme.com" });
  assert.deepEqual(
    await service.addUnitMember({
      unitId: unit.id,
      principalId: "bob@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: false,
      reason: "archived",
    },
  );
  assert.equal((await store.listUnitMembers(ORG, unit.id)).length, 0);
});

test("removeUnitMember: removes the row with audit and one revision bump; removing a non-member is a no-op success", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "bob@acme.com", email: "bob@acme.com" }));
  await service.addUnitMember({
    unitId: unit.id,
    principalId: "bob@acme.com",
    role: "member",
    actor: "admin@acme.com",
  });
  assert.deepEqual(
    await service.removeUnitMember({ unitId: "unit-missing", principalId: "bob@acme.com", actor: "admin@acme.com" }),
    {
      ok: false,
      reason: "missing_unit",
    },
  );
  const before = await store.getAuthzRevision(ORG);
  assert.deepEqual(
    await service.removeUnitMember({ unitId: unit.id, principalId: "bob@acme.com", actor: "admin@acme.com" }),
    { ok: true },
  );
  assert.equal((await store.listUnitMembers(ORG, unit.id)).length, 0);
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  const removes = (await auditLog.events()).filter((e) => e.action === "org.unit.member.remove");
  assert.equal(removes.length, 1);
  assert.equal(removes[0]?.principalId, "admin@acme.com");
  assert.equal(removes[0]?.resource, `unit:${unit.id}`);
  assert.deepEqual(JSON.parse(removes[0]?.detail ?? ""), { unitId: unit.id, principalId: "bob@acme.com" });
  const noopBefore = await store.getAuthzRevision(ORG);
  assert.deepEqual(
    await service.removeUnitMember({ unitId: unit.id, principalId: "bob@acme.com", actor: "admin@acme.com" }),
    { ok: true },
  );
  assert.equal(await store.getAuthzRevision(ORG), noopBefore, "removing a non-member writes nothing");
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.unit.member.remove").length, 1);
});

test("group lifecycle: create, rename, archive blocks member adds, and restore re-enables them", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  await store.putUser(orgUser({ principalId: "bob@acme.com", email: "bob@acme.com" }));
  const before = await store.getAuthzRevision(ORG);
  const group = await service.createGroup({ name: "On-call", actor: "admin@acme.com" });
  assert.ok(group.id.startsWith("grp-"));
  assert.equal(group.orgId, ORG);
  assert.equal(group.status, "active");
  assert.equal(group.createdBy, "admin@acme.com");
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  const creates = (await auditLog.events()).filter((e) => e.action === "org.group.create");
  assert.equal(creates.length, 1);
  assert.equal(creates[0]?.principalId, "admin@acme.com");
  assert.equal(creates[0]?.scopeLabel, SCOPE);
  assert.equal(creates[0]?.resource, `group:${group.id}`);
  assert.deepEqual(JSON.parse(creates[0]?.detail ?? ""), { groupId: group.id });
  assert.equal(await service.updateGroup({ groupId: "grp-missing", name: "X", actor: "admin@acme.com" }), null);
  const renamed = await service.updateGroup({ groupId: group.id, name: "On-call Renamed", actor: "admin@acme.com" });
  assert.equal(renamed?.name, "On-call Renamed");
  assert.equal(renamed?.updatedBy, "admin@acme.com");
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.group.update").length, 1);
  assert.deepEqual(await service.archiveGroup({ groupId: group.id, actor: "admin@acme.com" }), { ok: true });
  assert.equal((await store.getGroup(ORG, group.id))?.status, "archived");
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.group.archive").length, 1);
  assert.deepEqual(
    await service.addGroupMember({
      groupId: group.id,
      principalId: "bob@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: false,
      reason: "archived",
    },
  );
  const restoreBefore = await store.getAuthzRevision(ORG);
  const restored = await service.updateGroup({ groupId: group.id, status: "active", actor: "admin@acme.com" });
  assert.equal(restored?.status, "active");
  assert.equal(await store.getAuthzRevision(ORG), restoreBefore + 1);
  assert.deepEqual(
    await service.addGroupMember({
      groupId: group.id,
      principalId: "bob@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: true,
    },
  );
  assert.deepEqual(
    await service.archiveGroup({ groupId: "grp-missing", actor: "admin@acme.com" }),
    { ok: true },
    "archiving a missing group is a no-op success",
  );
  assert.deepEqual(await service.archiveGroup({ groupId: group.id, actor: "admin@acme.com" }), { ok: true });
  const rearchiveBefore = await store.getAuthzRevision(ORG);
  assert.deepEqual(await service.archiveGroup({ groupId: group.id, actor: "admin@acme.com" }), { ok: true });
  assert.equal(await store.getAuthzRevision(ORG), rearchiveBefore, "re-archiving an archived group writes nothing");
});

test("group members: add and remove round-trip, role update on re-add, and missing branches", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  await store.putUser(orgUser({ principalId: "bob@acme.com", email: "bob@acme.com" }));
  await store.putUser(orgUser({ principalId: "gone@acme.com", status: "deprovisioned" }));
  assert.deepEqual(
    await service.addGroupMember({
      groupId: "grp-missing",
      principalId: "bob@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: false,
      reason: "missing_group",
    },
  );
  assert.deepEqual(
    await service.removeGroupMember({ groupId: "grp-missing", principalId: "bob@acme.com", actor: "admin@acme.com" }),
    {
      ok: false,
      reason: "missing_group",
    },
  );
  const group = await service.createGroup({ name: "On-call", actor: "admin@acme.com" });
  assert.deepEqual(
    await service.addGroupMember({
      groupId: group.id,
      principalId: "ghost@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: false,
      reason: "missing_user",
      invalidPrincipalIds: ["ghost@acme.com"],
    },
  );
  assert.deepEqual(
    await service.addGroupMember({
      groupId: group.id,
      principalId: "gone@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: false,
      reason: "missing_user",
      invalidPrincipalIds: ["gone@acme.com"],
    },
  );
  assert.deepEqual(
    await service.addGroupMember({
      groupId: group.id,
      principalId: "bob@acme.com",
      role: "member",
      actor: "admin@acme.com",
    }),
    {
      ok: true,
    },
  );
  assert.deepEqual(
    await service.addGroupMember({
      groupId: group.id,
      principalId: "bob@acme.com",
      role: "manager",
      actor: "admin@acme.com",
    }),
    {
      ok: true,
    },
  );
  const members = await store.listGroupMembers(ORG, group.id);
  assert.equal(members.length, 1, "re-add keeps a single row");
  assert.equal(members[0]?.role, "manager");
  const adds = (await auditLog.events()).filter((e) => e.action === "org.group.member.add");
  assert.equal(adds.length, 2);
  assert.equal(adds[0]?.resource, `group:${group.id}`);
  assert.deepEqual(JSON.parse(adds[0]?.detail ?? ""), {
    groupId: group.id,
    principalId: "bob@acme.com",
    role: "member",
  });
  const before = await store.getAuthzRevision(ORG);
  assert.deepEqual(
    await service.removeGroupMember({ groupId: group.id, principalId: "bob@acme.com", actor: "admin@acme.com" }),
    { ok: true },
  );
  assert.equal((await store.listGroupMembers(ORG, group.id)).length, 0);
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  const removes = (await auditLog.events()).filter((e) => e.action === "org.group.member.remove");
  assert.equal(removes.length, 1);
  assert.deepEqual(JSON.parse(removes[0]?.detail ?? ""), { groupId: group.id, principalId: "bob@acme.com" });
  assert.deepEqual(
    await service.removeGroupMember({ groupId: group.id, principalId: "bob@acme.com", actor: "admin@acme.com" }),
    {
      ok: true,
    },
  );
  assert.equal(
    (await auditLog.events()).filter((e) => e.action === "org.group.member.remove").length,
    1,
    "removing a non-member is a no-op",
  );
});

test("addGroupMembers is atomic and archived groups cannot be mutated by managers", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const group = await service.createGroup({ name: "Batch", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "manager@acme.com", email: "manager@acme.com" }));
  await store.putUser(orgUser({ principalId: "one@acme.com", email: "one@acme.com" }));
  await store.putUser(orgUser({ principalId: "two@acme.com", email: "two@acme.com" }));
  await service.addGroupMember({
    groupId: group.id,
    principalId: "manager@acme.com",
    role: "manager",
    actor: "admin@acme.com",
  });
  const before = await store.getAuthzRevision(ORG);
  assert.deepEqual(
    await service.addGroupMembers({
      groupId: group.id,
      principalIds: ["one@acme.com", "two@acme.com"],
      role: "member",
      actor: "manager@acme.com",
      asManager: true,
    }),
    { ok: true },
  );
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  assert.equal((await auditLog.events()).filter((event) => event.action === "org.group.member.add").length, 3);
  await service.archiveGroup({ groupId: group.id, actor: "admin@acme.com" });
  assert.deepEqual(
    await service.removeGroupMember({
      groupId: group.id,
      principalId: "one@acme.com",
      actor: "manager@acme.com",
      asManager: true,
    }),
    { ok: false, reason: "missing_group" },
  );
  assert.ok((await store.listGroupMembers(ORG, group.id)).some((member) => member.principalId === "one@acme.com"));
});

test("listManagedSubtreeUnitIds: management follows direct manager rows through moves, not tree position", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  const a = await service.createUnit({ parentId: "root", name: "A", kind: "department", actor: "admin@acme.com" });
  const b = await service.createUnit({ parentId: a.id, name: "B", kind: "team", actor: "admin@acme.com" });
  const d = await service.createUnit({ parentId: b.id, name: "D", kind: "team", actor: "admin@acme.com" });
  const c = await service.createUnit({ parentId: "root", name: "C", kind: "department", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "mgr-b@acme.com" }));
  await store.putUser(orgUser({ principalId: "mgr-c@acme.com" }));
  await service.addUnitMember({
    unitId: b.id,
    principalId: "mgr-b@acme.com",
    role: "manager",
    actor: "admin@acme.com",
  });
  await service.addUnitMember({
    unitId: c.id,
    principalId: "mgr-c@acme.com",
    role: "manager",
    actor: "admin@acme.com",
  });
  assert.deepEqual((await service.listManagedSubtreeUnitIds("mgr-b@acme.com")).sort(), [b.id, d.id].sort());
  assert.deepEqual(await service.listManagedSubtreeUnitIds("mgr-c@acme.com"), [c.id]);
  assert.deepEqual(await service.listManagedSubtreeUnitIds("alice@acme.com"), [], "no manager rows manage nothing");
  assert.deepEqual(await service.moveUnit({ unitId: b.id, newParentId: c.id, actor: "admin@acme.com" }), { ok: true });
  assert.deepEqual(
    (await service.listManagedSubtreeUnitIds("mgr-b@acme.com")).sort(),
    [b.id, d.id].sort(),
    "a manager keeps their subtree when it moves under a new ancestor",
  );
  assert.deepEqual(
    (await service.listManagedSubtreeUnitIds("mgr-c@acme.com")).sort(),
    [b.id, c.id, d.id].sort(),
    "the new ancestor's manager manages the moved-in subtree through the closure",
  );
});

test("updateUnit: renames and reorders an existing unit and returns null for a missing one", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  assert.equal(await service.updateUnit({ unitId: "unit-missing", name: "X", actor: "admin@acme.com" }), null);
  const before = await store.getAuthzRevision(ORG);
  const updated = await service.updateUnit({
    unitId: unit.id,
    name: "Team Renamed",
    sortOrder: 5,
    actor: "admin@acme.com",
  });
  assert.equal(updated?.name, "Team Renamed");
  assert.equal(updated?.sortOrder, 5);
  assert.equal(updated?.updatedBy, "admin@acme.com");
  assert.equal((await store.getUnit(ORG, unit.id))?.name, "Team Renamed");
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  const updates = (await auditLog.events()).filter((e) => e.action === "org.unit.update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.resource, `unit:${unit.id}`);
});

test("member profile updates normalize fields, enforce uniqueness, and use profile revision CAS", async () => {
  const { service, store } = setup();
  await store.putUser(orgUser());
  await store.putUser(orgUser({ principalId: "bob@acme.com", email: "bob@acme.com", employeeNumber: "E-2" }));
  const changed = await service.updateUserProfile({
    principalId: "alice@acme.com",
    expectedProfileRevision: 1,
    patch: {
      displayName: "  Alice Zhang  ",
      email: "ALICE.ZHANG@ACME.COM",
      jobTitle: " Platform Engineer ",
      mobile: " +86 13800138000 ",
      employeeNumber: " E-1 ",
    },
    actor: "admin@acme.com",
  });
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.equal(changed.user.displayName, "Alice Zhang");
  assert.equal(changed.user.email, "alice.zhang@acme.com");
  assert.equal(changed.user.profileRevision, 2);
  assert.deepEqual(
    await service.updateUserProfile({
      principalId: "alice@acme.com",
      expectedProfileRevision: 1,
      patch: { jobTitle: "Stale" },
      actor: "admin@acme.com",
    }),
    { ok: false, reason: "revision_conflict", current: changed.user },
  );
  assert.deepEqual(
    await service.updateUserProfile({
      principalId: "alice@acme.com",
      expectedProfileRevision: 2,
      patch: { employeeNumber: "E-2" },
      actor: "admin@acme.com",
    }),
    { ok: false, reason: "duplicate_employee_number" },
  );
});

test("member mutation retries return the committed result without repeating writes", async () => {
  const { service, store, auditLog } = setup();
  await store.putUser(orgUser());
  const expectedAuthzRevision = await store.getAuthzRevision(ORG);
  const input = {
    mutations: [
      {
        principalId: "alice@acme.com",
        expectedProfileRevision: 1,
        status: "suspended" as const,
      },
    ],
    expectedAuthzRevision,
    actor: "admin@acme.com",
    idempotencyKey: "member-job-retry",
  };
  const first = await service.applyMemberMutations(input);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  await service.updateUserProfile({
    principalId: "alice@acme.com",
    expectedProfileRevision: 1,
    patch: { displayName: "Later Name" },
    actor: "admin@acme.com",
  });
  await service.createGroup({ name: "Later Group", actor: "admin@acme.com" });
  const replay = await service.applyMemberMutations(input);
  assert.deepEqual(replay, first);
  assert.equal((await store.getUser(ORG, "alice@acme.com"))?.sessionVersion, 2);
  assert.deepEqual(
    (await auditLog.events())
      .filter((event) => event.action.startsWith("org.user.batch"))
      .map((event) => event.idempotencyKey),
    ["member-job-retry:member:alice@acme.com", "member-job-retry:summary"],
  );
});

test("primary unit replacement is explicit and the primary membership cannot be removed directly", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  await store.putUser(orgUser());
  const first = await service.createUnit({ parentId: "root", name: "First", kind: "department", actor: "admin" });
  const second = await service.createUnit({ parentId: "root", name: "Second", kind: "department", actor: "admin" });
  assert.equal(
    (
      await service.setPrimaryUnit({
        principalId: "alice@acme.com",
        unitId: first.id,
        keepPreviousMembership: true,
        actor: "admin",
      })
    ).ok,
    true,
  );
  assert.deepEqual(
    await service.removeUnitMember({ unitId: first.id, principalId: "alice@acme.com", actor: "admin" }),
    { ok: false, reason: "primary_unit" },
  );
  await service.setPrimaryUnit({
    principalId: "alice@acme.com",
    unitId: second.id,
    keepPreviousMembership: false,
    actor: "admin",
  });
  const memberships = await store.listUnitMembersForUsers(ORG, ["alice@acme.com"]);
  assert.deepEqual(
    memberships.map((member) => [member.unitId, member.isPrimary]),
    [[second.id, true]],
  );
});

test("managed status transitions make deprovisioning terminal", async () => {
  const { service, store } = setup();
  await store.putUser(orgUser());
  assert.equal(
    (
      await service.changeManagedStatus({
        principalId: "alice@acme.com",
        status: "deprovisioned",
        actor: "admin",
      })
    ).ok,
    true,
  );
  assert.deepEqual(
    await service.changeManagedStatus({ principalId: "alice@acme.com", status: "active", actor: "admin" }),
    { ok: false, reason: "invalid_transition", current: "deprovisioned" },
  );
});
