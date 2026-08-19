import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditLog, type AuditLog } from "../src/audit/audit-log.ts";
import { createIdentityService, type IdentityService } from "../src/identity/identity-service.ts";
import { createOrganizationService, type LoginInput, type OrgAdmission } from "../src/organization/organization-service.ts";
import {
  createMemoryOrganizationStore,
  type OrganizationStore,
  type OrganizationUser,
} from "../src/organization/organization-store.ts";
import { activateBootstrapUsers } from "../src/wiring.ts";

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

function setup(over: { admission?: OrgAdmission; autoJoinDomains?: readonly string[]; store?: OrganizationStore } = {}): Harness {
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
  status: "active",
  sessionVersion: 1,
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
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
  const first = await service.login(loginInput());
  assert.equal(first.status, "ok");
  const second = await service.login(loginInput({ displayName: "" }));
  assert.equal(second.status, "ok");
  if (second.status !== "ok") return;
  assert.equal(second.user.displayName, "Alice", "an absent display name never erases the stored one");
  const renamed = await service.login(loginInput({ displayName: "Alice Cooper" }));
  assert.equal(renamed.status, "ok");
  if (renamed.status !== "ok") return;
  assert.equal(renamed.user.displayName, "Alice Cooper", "a present display name still updates");
});

test("login: invited user matched by email activates and binds the identity", async () => {
  const { service, store } = setup();
  await service.invite({ principalId: "alice@acme.com", email: "Alice@Acme.com", displayName: "Alice", actor: "admin@acme.com" });
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
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
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

test("login: email match on a non-invited user fails closed and never recreates the row", async () => {
  const active = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  await active.store.putUser(orgUser({ status: "active", sessionVersion: 5 }));
  const activeResult = await active.service.login(loginInput({ subject: "sub-new" }));
  assert.deepEqual(activeResult, { status: "denied", reason: "unknown" });
  assert.equal((await active.store.getUser(ORG, "alice@acme.com"))?.sessionVersion, 5, "active user row untouched");

  const suspended = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  await suspended.store.putUser(orgUser({ status: "suspended", sessionVersion: 3 }));
  const suspendedResult = await suspended.service.login(loginInput({ subject: "sub-new" }));
  assert.deepEqual(suspendedResult, { status: "denied", reason: "suspended" });
  assert.equal((await suspended.store.getUser(ORG, "alice@acme.com"))?.sessionVersion, 3, "suspended user row untouched");

  const fresh = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  const freshResult = await fresh.service.login(loginInput({ principalId: "new@acme.com", email: "new@acme.com", subject: "sub-new" }));
  assert.equal(freshResult.status, "ok");
  if (freshResult.status !== "ok") return;
  assert.equal(freshResult.user.sessionVersion, 1, "genuinely new email still auto-joins");
});

test("setStatus: bumps sessionVersion, drives identity deactivation, and is idempotent", async () => {
  const { service, identity, auditLog } = setup();
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
  const suspended = await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  assert.equal(suspended?.sessionVersion, 2);
  assert.equal(suspended?.updatedBy, "admin@acme.com");
  assert.equal(identity.classify("alice@acme.com").type, "guest");
  const active = await service.setStatus({ principalId: "alice@acme.com", status: "active", actor: "admin@acme.com" });
  assert.equal(active?.sessionVersion, 3);
  assert.equal(identity.classify("alice@acme.com").type, "internal");
  const eventsBefore = (await auditLog.events()).length;
  const unchanged = await service.setStatus({ principalId: "alice@acme.com", status: "active", actor: "admin@acme.com" });
  assert.equal(unchanged?.sessionVersion, 3, "same status is a no-op");
  assert.equal((await auditLog.events()).length, eventsBefore, "no audit event for a no-op");
  assert.equal(await service.setStatus({ principalId: "nobody@acme.com", status: "suspended", actor: "admin@acme.com" }), null);
});

test("login: activation reactivates the legacy identity after a suspend-then-invited detour", async () => {
  const { service, identity } = setup();
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
  await service.login(loginInput());
  await service.setStatus({ principalId: "alice@acme.com", status: "suspended", actor: "admin@acme.com" });
  assert.equal(identity.classify("alice@acme.com").type, "guest");
  await service.setStatus({ principalId: "alice@acme.com", status: "invited", actor: "admin@acme.com" });
  assert.equal(identity.classify("alice@acme.com").type, "guest", "invited never touches the legacy identity");
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
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
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

test("audit: login, denial, activation, auto-join, and status changes are recorded", async () => {
  const { service, auditLog } = setup();
  await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
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
    "org.user.status:suspended",
    "org.user.login_denied:suspended",
    "org.user.login_denied:not_invited",
  ]);
  const deniedStranger = events.find((e) => e.principalId === "stranger@acme.com");
  assert.equal(deniedStranger?.resource, "stranger@acme.com");
  const reinvite = await service.invite({ principalId: "alice@acme.com", email: "alice@acme.com", displayName: "Alice", actor: "admin@acme.com" });
  assert.equal(reinvite.status, "suspended", "re-invite returns the stored row unchanged");
  assert.equal((await auditLog.events()).length, events.length, "re-invite no-op records no event");

  const autoJoin = setup({ admission: "domain_auto_join", autoJoinDomains: ["acme.com"] });
  await autoJoin.service.login(loginInput({ principalId: "carol@acme.com", email: "carol@acme.com", subject: "sub-3" }));
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
  const unit = await service.createUnit({ parentId: "root", name: "Engineering", kind: "department", actor: "admin@acme.com" });
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
  await assert.rejects(service.createUnit({ parentId: "unit-missing", name: "X", kind: "team", actor: "admin@acme.com" }));
  const dept = await service.createUnit({ parentId: "root", name: "Dept", kind: "department", actor: "admin@acme.com" });
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
  assert.deepEqual(await service.moveUnit({ unitId: "root", newParentId: a.id, actor: "admin@acme.com" }), { ok: false, reason: "root" });
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

test("archiveUnit: refuses the root, reports conflicts, archives clean units, and restores via updateUnit", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  assert.deepEqual(await service.archiveUnit({ unitId: "root", actor: "admin@acme.com" }), { ok: false, reason: "root" });
  const parent = await service.createUnit({ parentId: "root", name: "Parent", kind: "department", actor: "admin@acme.com" });
  const child = await service.createUnit({ parentId: parent.id, name: "Child", kind: "team", actor: "admin@acme.com" });
  const childBlocked = await service.archiveUnit({ unitId: parent.id, actor: "admin@acme.com" });
  assert.equal(childBlocked.ok, false);
  if (childBlocked.ok) return;
  assert.equal(childBlocked.reason, "conflict");
  assert.equal(childBlocked.impact?.activeChildUnits, 1);
  const membered = await service.createUnit({ parentId: "root", name: "Membered", kind: "team", actor: "admin@acme.com" });
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
  assert.equal((await store.unitImpact(ORG, parent.id)).activeChildUnits, 0, "archived child no longer counts as active");
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.unit.archive").length, 1);
  const restoreBefore = await store.getAuthzRevision(ORG);
  const restored = await service.updateUnit({ unitId: child.id, status: "active", actor: "admin@acme.com" });
  assert.equal(restored?.status, "active");
  assert.equal(await store.getAuthzRevision(ORG), restoreBefore + 1);
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.unit.update").length, 1);
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
  assert.deepEqual(await service.addUnitMember({ unitId: unit.id, principalId: "bob@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: true,
  });
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
  assert.deepEqual(await service.addUnitMember({ unitId: unit.id, principalId: "bob@acme.com", role: "manager", actor: "admin@acme.com" }), {
    ok: true,
  });
  members = await store.listUnitMembers(ORG, unit.id);
  assert.equal(members.length, 1, "re-add keeps a single row");
  assert.equal(members[0]?.role, "manager");
  assert.equal(members[0]?.createdBy, "admin@acme.com", "role update preserves the original row fields");
  assert.equal(await store.getAuthzRevision(ORG), roleBefore + 1);
  const noopBefore = await store.getAuthzRevision(ORG);
  assert.deepEqual(await service.addUnitMember({ unitId: unit.id, principalId: "bob@acme.com", role: "manager", actor: "admin@acme.com" }), {
    ok: true,
  });
  assert.equal(await store.getAuthzRevision(ORG), noopBefore, "a same-role re-add is a no-op");
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.unit.member.add").length, 2);
});

test("addUnitMember: unknown and deprovisioned users are missing_user while invited users are allowed", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "gone@acme.com", status: "deprovisioned" }));
  await store.putUser(orgUser({ principalId: "pending@acme.com", status: "invited" }));
  assert.deepEqual(await service.addUnitMember({ unitId: unit.id, principalId: "ghost@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: false,
    reason: "missing_user",
  });
  assert.deepEqual(await service.addUnitMember({ unitId: unit.id, principalId: "gone@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: false,
    reason: "missing_user",
  });
  assert.deepEqual(await service.addUnitMember({ unitId: unit.id, principalId: "pending@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: true,
  });
  assert.equal((await store.listUnitMembers(ORG, unit.id)).length, 1);
});

test("addUnitMember: archived or missing units reject without touching membership", async () => {
  const { service, store } = setup();
  await bootstrapRoot(store);
  await store.putUser(orgUser({ principalId: "bob@acme.com", email: "bob@acme.com" }));
  assert.deepEqual(await service.addUnitMember({ unitId: "unit-missing", principalId: "bob@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: false,
    reason: "missing_unit",
  });
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  await service.archiveUnit({ unitId: unit.id, actor: "admin@acme.com" });
  assert.deepEqual(await service.addUnitMember({ unitId: unit.id, principalId: "bob@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: false,
    reason: "archived",
  });
  assert.equal((await store.listUnitMembers(ORG, unit.id)).length, 0);
});

test("removeUnitMember: removes the row with audit and one revision bump; removing a non-member is a no-op success", async () => {
  const { service, store, auditLog } = setup();
  await bootstrapRoot(store);
  const unit = await service.createUnit({ parentId: "root", name: "Team", kind: "team", actor: "admin@acme.com" });
  await store.putUser(orgUser({ principalId: "bob@acme.com", email: "bob@acme.com" }));
  await service.addUnitMember({ unitId: unit.id, principalId: "bob@acme.com", role: "member", actor: "admin@acme.com" });
  assert.deepEqual(await service.removeUnitMember({ unitId: "unit-missing", principalId: "bob@acme.com", actor: "admin@acme.com" }), {
    ok: false,
    reason: "missing_unit",
  });
  const before = await store.getAuthzRevision(ORG);
  assert.deepEqual(await service.removeUnitMember({ unitId: unit.id, principalId: "bob@acme.com", actor: "admin@acme.com" }), { ok: true });
  assert.equal((await store.listUnitMembers(ORG, unit.id)).length, 0);
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  const removes = (await auditLog.events()).filter((e) => e.action === "org.unit.member.remove");
  assert.equal(removes.length, 1);
  assert.equal(removes[0]?.principalId, "admin@acme.com");
  assert.equal(removes[0]?.resource, `unit:${unit.id}`);
  assert.deepEqual(JSON.parse(removes[0]?.detail ?? ""), { unitId: unit.id, principalId: "bob@acme.com" });
  const noopBefore = await store.getAuthzRevision(ORG);
  assert.deepEqual(await service.removeUnitMember({ unitId: unit.id, principalId: "bob@acme.com", actor: "admin@acme.com" }), { ok: true });
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
  assert.deepEqual(await service.addGroupMember({ groupId: group.id, principalId: "bob@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: false,
    reason: "archived",
  });
  const restoreBefore = await store.getAuthzRevision(ORG);
  const restored = await service.updateGroup({ groupId: group.id, status: "active", actor: "admin@acme.com" });
  assert.equal(restored?.status, "active");
  assert.equal(await store.getAuthzRevision(ORG), restoreBefore + 1);
  assert.deepEqual(await service.addGroupMember({ groupId: group.id, principalId: "bob@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: true,
  });
  assert.deepEqual(await service.archiveGroup({ groupId: "grp-missing", actor: "admin@acme.com" }), { ok: true }, "archiving a missing group is a no-op success");
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
  assert.deepEqual(await service.addGroupMember({ groupId: "grp-missing", principalId: "bob@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: false,
    reason: "missing_group",
  });
  assert.deepEqual(await service.removeGroupMember({ groupId: "grp-missing", principalId: "bob@acme.com", actor: "admin@acme.com" }), {
    ok: false,
    reason: "missing_group",
  });
  const group = await service.createGroup({ name: "On-call", actor: "admin@acme.com" });
  assert.deepEqual(await service.addGroupMember({ groupId: group.id, principalId: "ghost@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: false,
    reason: "missing_user",
  });
  assert.deepEqual(await service.addGroupMember({ groupId: group.id, principalId: "gone@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: false,
    reason: "missing_user",
  });
  assert.deepEqual(await service.addGroupMember({ groupId: group.id, principalId: "bob@acme.com", role: "member", actor: "admin@acme.com" }), {
    ok: true,
  });
  assert.deepEqual(await service.addGroupMember({ groupId: group.id, principalId: "bob@acme.com", role: "manager", actor: "admin@acme.com" }), {
    ok: true,
  });
  const members = await store.listGroupMembers(ORG, group.id);
  assert.equal(members.length, 1, "re-add keeps a single row");
  assert.equal(members[0]?.role, "manager");
  const adds = (await auditLog.events()).filter((e) => e.action === "org.group.member.add");
  assert.equal(adds.length, 2);
  assert.equal(adds[0]?.resource, `group:${group.id}`);
  assert.deepEqual(JSON.parse(adds[0]?.detail ?? ""), { groupId: group.id, principalId: "bob@acme.com", role: "member" });
  const before = await store.getAuthzRevision(ORG);
  assert.deepEqual(await service.removeGroupMember({ groupId: group.id, principalId: "bob@acme.com", actor: "admin@acme.com" }), { ok: true });
  assert.equal((await store.listGroupMembers(ORG, group.id)).length, 0);
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  const removes = (await auditLog.events()).filter((e) => e.action === "org.group.member.remove");
  assert.equal(removes.length, 1);
  assert.deepEqual(JSON.parse(removes[0]?.detail ?? ""), { groupId: group.id, principalId: "bob@acme.com" });
  assert.deepEqual(await service.removeGroupMember({ groupId: group.id, principalId: "bob@acme.com", actor: "admin@acme.com" }), {
    ok: true,
  });
  assert.equal((await auditLog.events()).filter((e) => e.action === "org.group.member.remove").length, 1, "removing a non-member is a no-op");
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
  await service.addUnitMember({ unitId: b.id, principalId: "mgr-b@acme.com", role: "manager", actor: "admin@acme.com" });
  await service.addUnitMember({ unitId: c.id, principalId: "mgr-c@acme.com", role: "manager", actor: "admin@acme.com" });
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
  const updated = await service.updateUnit({ unitId: unit.id, name: "Team Renamed", sortOrder: 5, actor: "admin@acme.com" });
  assert.equal(updated?.name, "Team Renamed");
  assert.equal(updated?.sortOrder, 5);
  assert.equal(updated?.updatedBy, "admin@acme.com");
  assert.equal((await store.getUnit(ORG, unit.id))?.name, "Team Renamed");
  assert.equal(await store.getAuthzRevision(ORG), before + 1);
  const updates = (await auditLog.events()).filter((e) => e.action === "org.unit.update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.resource, `unit:${unit.id}`);
});
