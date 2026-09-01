import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryOrganizationStore,
  type AccessGroup,
  type AccessGroupMember,
  type OrganizationUser,
  type OrgUnit,
  type OrgUnitMember,
} from "../src/organization/organization-store.ts";
import { createAuditLog, type AuditEvent } from "../src/audit/audit-log.ts";
import type { Skill } from "../src/skills/skill-store.ts";
import type { ScopeId } from "../src/types.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const user = (over: Partial<OrganizationUser> = {}): OrganizationUser => ({
  orgId: "default-org",
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

const skill = (over: Partial<Skill> = {}): Skill => ({
  id: "skill-access",
  orgId: "default-org",
  scopeId: "personal:owner",
  manifest: {
    name: "access-fixture",
    description: "Access fixture",
    requiredCapabilities: [],
    body: "Run",
  },
  signature: "fixture-signature",
  status: "published",
  createdBy: "owner",
  version: 1,
  grantedCapabilities: [],
  approvals: ["owner"],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

test("memory organization store: put/get/findByEmail/list round-trip", async () => {
  const s = createMemoryOrganizationStore();
  assert.equal(await s.getUser("default-org", "alice@acme.com"), null);
  await s.putUser(user());
  assert.equal((await s.getUser("default-org", "alice@acme.com"))?.status, "active");
  assert.equal((await s.findUserByEmail("default-org", "Alice@ACME.com"))?.principalId, "alice@acme.com");
  await s.putUser(user({ principalId: "bob@acme.com", email: "bob@acme.com", status: "invited" }));
  assert.equal((await s.listUsers("default-org")).length, 2);
  assert.equal((await s.listUsers("other-org")).length, 0, "org isolation");
  await s.putUser(user({ status: "suspended", sessionVersion: 2 }));
  assert.equal((await s.getUser("default-org", "alice@acme.com"))?.sessionVersion, 2, "upsert replaces");
});

test("memory organization store: user search is filtered, bounded, assignable, and org-scoped", async () => {
  const s = createMemoryOrganizationStore();
  await s.putUser(user({ principalId: "U-alice", email: "alice@example.com", displayName: "Alice Zhang" }));
  await s.putUser(user({ principalId: "U-alina", email: "alina@example.com", displayName: "Alina" }));
  await s.putUser(user({ principalId: "U-deleted", email: "alice.deleted@example.com", status: "deprovisioned" }));
  await s.putUser(user({ principalId: "U-pending", email: "alice.pending@example.com", status: "invited" }));
  await s.putUser(user({ principalId: "U-paused", email: "alice.paused@example.com", status: "suspended" }));
  await s.putUser(user({ orgId: "other-org", principalId: "U-other", displayName: "Alice Other" }));
  assert.deepEqual(
    (await s.searchUsers("default-org", "ali", 1)).map((candidate) => candidate.principalId),
    ["U-alice"],
  );
  assert.deepEqual(
    (await s.searchUsers("default-org", "example.com", 20)).map((candidate) => candidate.principalId),
    ["U-alice", "U-alina"],
  );
  await s.putUser(user({ principalId: "U-literal", email: "literal%_@example.com", displayName: "Literal %_" }));
  assert.deepEqual(
    (await s.searchUsers("default-org", "%_", 20)).map((candidate) => candidate.principalId),
    ["U-literal"],
  );
});

test("memory organization store: identities are keyed by issuer+subject", async () => {
  const s = createMemoryOrganizationStore();
  assert.equal(await s.getIdentity("default-org", "https://idp", "sub-1"), null);
  await s.putIdentity({
    orgId: "default-org",
    issuer: "https://idp",
    subject: "sub-1",
    principalId: "alice@acme.com",
    emailAtLink: "alice@acme.com",
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal((await s.getIdentity("default-org", "https://idp", "sub-1"))?.principalId, "alice@acme.com");
  assert.equal(await s.getIdentity("default-org", "https://other", "sub-1"), null);
});

const unit = (over: Partial<OrgUnit> = {}): OrgUnit => ({
  orgId: "default-org",
  id: "unit-a",
  parentId: "root",
  name: "Unit A",
  kind: "department",
  status: "active",
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  createdBy: "system:bootstrap",
  updatedBy: "system:bootstrap",
  ...over,
});

const unitMember = (over: Partial<OrgUnitMember> = {}): OrgUnitMember => ({
  orgId: "default-org",
  unitId: "unit-a",
  principalId: "alice@acme.com",
  role: "member",
  isPrimary: false,
  createdAt: 1,
  createdBy: "system:bootstrap",
  ...over,
});

const group = (over: Partial<AccessGroup> = {}): AccessGroup => ({
  orgId: "default-org",
  id: "grp-a",
  name: "Group A",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  createdBy: "system:bootstrap",
  updatedBy: "system:bootstrap",
  ...over,
});

const groupMember = (over: Partial<AccessGroupMember> = {}): AccessGroupMember => ({
  orgId: "default-org",
  groupId: "grp-a",
  principalId: "alice@acme.com",
  role: "member",
  createdAt: 1,
  createdBy: "system:bootstrap",
  ...over,
});

const auditEvent = (action: string): AuditEvent => ({
  at: 1,
  principalId: "admin@acme.com",
  action,
  resource: "unit:root",
  scopeLabel: "org:default-org",
  orgId: "default-org",
});

test("memory organization store: ensureOrgRoot creates root and revision 1, second call is a no-op", async () => {
  const s = createMemoryOrganizationStore();
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 10 });
  const root = await s.getUnit("default-org", "root");
  assert.equal(root?.kind, "organization");
  assert.equal(root?.parentId, null);
  assert.equal(root?.status, "active");
  assert.equal(root?.createdAt, 10);
  assert.equal(await s.getAuthzRevision("default-org"), 1);
  await s.ensureOrgRoot({ orgId: "default-org", name: "Renamed", actor: "system:bootstrap", now: 20 });
  const again = await s.getUnit("default-org", "root");
  assert.equal(again?.name, "Acme");
  assert.equal(again?.createdAt, 10);
  assert.equal((await s.listUnits("default-org")).length, 1);
  assert.equal(await s.getAuthzRevision("default-org"), 1);
});

test("memory organization store: ensureOrgRoot never regresses an existing revision", async () => {
  const s = createMemoryOrganizationStore();
  await s.transact("default-org", async (tx) => {
    await tx.bumpRevision("default-org");
  });
  assert.equal(await s.getAuthzRevision("default-org"), 2);
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 10 });
  assert.equal(await s.getAuthzRevision("default-org"), 2, "bootstrap never clobbers a concurrent bump");
  const root = await s.getUnit("default-org", "root");
  assert.equal(root?.kind, "organization");
  assert.equal(root?.status, "active");
});

test("memory organization store: rejects a second active root and archiving the root", async () => {
  const s = createMemoryOrganizationStore();
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 1 });
  await assert.rejects(s.putUnit(unit({ id: "other-root", parentId: null, kind: "organization" })), /active root/);
  await assert.rejects(
    s.putUnit(unit({ id: "root", parentId: null, kind: "organization", status: "archived" })),
    /remain active/,
  );
  assert.equal((await s.listUnits("default-org")).length, 1);
});

test("memory organization store: putUnit maintains closure self-rows, isDescendant and listSubtreeUnitIds reflect the tree", async () => {
  const s = createMemoryOrganizationStore();
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 1 });
  await s.putUnit(unit({ id: "unit-a" }));
  await s.putUnit(unit({ id: "unit-b", parentId: "unit-a" }));
  assert.equal(await s.isDescendant("default-org", "root", "unit-b"), true);
  assert.equal(await s.isDescendant("default-org", "root", "root"), true, "self-row");
  assert.equal(await s.isDescendant("default-org", "unit-b", "root"), false);
  assert.equal(await s.isDescendant("default-org", "unit-b", "unit-a"), false);
  assert.deepEqual((await s.listSubtreeUnitIds("default-org", "root")).sort(), ["root", "unit-a", "unit-b"]);
  assert.deepEqual(await s.listSubtreeUnitIds("default-org", "unit-b"), ["unit-b"]);
});

test("memory organization store: transact moveUnitSubtree re-links the subtree and keeps closure self-rows", async () => {
  const s = createMemoryOrganizationStore();
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 1 });
  await s.putUnit(unit({ id: "unit-a" }));
  await s.putUnit(unit({ id: "unit-c" }));
  await s.putUnit(unit({ id: "unit-b", parentId: "unit-a" }));
  await s.putUnit(unit({ id: "unit-b1", parentId: "unit-b" }));
  await s.transact("default-org", async (tx) => {
    await tx.moveUnitSubtree("default-org", "unit-b", "unit-c");
  });
  assert.equal(await s.isDescendant("default-org", "unit-c", "unit-b1"), true);
  assert.equal(await s.isDescendant("default-org", "unit-a", "unit-b1"), false);
  assert.equal(await s.isDescendant("default-org", "unit-b", "unit-b1"), true);
  assert.equal(await s.isDescendant("default-org", "unit-b1", "unit-b1"), true, "self-row intact");
  assert.equal(await s.isDescendant("default-org", "root", "unit-b1"), true);
  assert.deepEqual((await s.listSubtreeUnitIds("default-org", "unit-c")).sort(), ["unit-b", "unit-b1", "unit-c"]);
});

test("memory organization store: listManagedSubtreeUnitIds gives a manager their unit and descendants, not siblings or ancestors", async () => {
  const s = createMemoryOrganizationStore();
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 1 });
  await s.putUnit(unit({ id: "unit-a" }));
  await s.putUnit(unit({ id: "unit-a2", parentId: "unit-a" }));
  await s.putUnit(unit({ id: "unit-b", parentId: "unit-a" }));
  await s.putUnit(unit({ id: "unit-b1", parentId: "unit-b" }));
  await s.putUnitMember(unitMember({ unitId: "unit-b", principalId: "alice@acme.com", role: "manager" }));
  await s.putUnitMember(unitMember({ unitId: "unit-b", principalId: "bob@acme.com", role: "member" }));
  assert.deepEqual((await s.listManagedSubtreeUnitIds("default-org", "alice@acme.com")).sort(), ["unit-b", "unit-b1"]);
  assert.deepEqual(
    await s.listManagedSubtreeUnitIds("default-org", "bob@acme.com"),
    [],
    "plain members manage nothing",
  );
  await s.putUnit(unit({ id: "unit-b", parentId: "unit-a", status: "archived" }));
  assert.deepEqual(await s.listManagedSubtreeUnitIds("default-org", "alice@acme.com"), []);
});

test("memory organization store: unitImpact counts children, members, and every access reference", async () => {
  const s = createMemoryOrganizationStore({ skillBacking: createMemoryMap<Skill>() });
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 1 });
  await s.putUnit(unit({ id: "unit-a" }));
  await s.putUnit(unit({ id: "unit-a1", parentId: "unit-a" }));
  await s.putUnit(unit({ id: "unit-a2", parentId: "unit-a", status: "archived" }));
  await s.putUser(user({ principalId: "active@acme.com", status: "active" }));
  await s.putUser(user({ principalId: "suspended@acme.com", status: "suspended" }));
  await s.putUser(user({ principalId: "gone@acme.com", status: "deprovisioned" }));
  await s.putUnitMember(unitMember({ unitId: "unit-a", principalId: "active@acme.com" }));
  await s.putUnitMember(unitMember({ unitId: "unit-a", principalId: "suspended@acme.com" }));
  await s.putUnitMember(unitMember({ unitId: "unit-a", principalId: "gone@acme.com" }));
  await s.putUnitMember(unitMember({ unitId: "unit-a", principalId: "missing@acme.com" }));
  await s.putUnitMember(unitMember({ unitId: "unit-a1", principalId: "active@acme.com" }));
  await s.transact("default-org", async (tx) => {
    const owned = skill({ id: "skill-owned", scopeId: "org-unit:unit-a" as ScopeId });
    const granted = skill({ id: "skill-granted" });
    await tx.putSkill(owned);
    await tx.putSkillAccessPolicy({
      orgId: "default-org",
      skillId: owned.id,
      ownerScopeId: owned.scopeId,
      mode: "restricted",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      updatedBy: "owner",
    });
    await tx.replaceSkillAccessGrants("default-org", owned.id, [
      {
        orgId: "default-org",
        ownerScopeId: owned.scopeId,
        path: `skill:${owned.id}`,
        granteeScopeId: "personal:reader",
        permission: "read",
        grantedBy: "owner",
        grantedAt: 1,
      },
    ]);
    await tx.putSkill(granted);
    await tx.putSkillAccessPolicy({
      orgId: "default-org",
      skillId: granted.id,
      ownerScopeId: granted.scopeId,
      mode: "restricted",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      updatedBy: "owner",
    });
    await tx.replaceSkillAccessGrants("default-org", granted.id, [
      {
        orgId: "default-org",
        ownerScopeId: granted.scopeId,
        path: `skill:${granted.id}`,
        granteeScopeId: "org-unit:unit-a" as ScopeId,
        permission: "read",
        grantedBy: "owner",
        grantedAt: 1,
      },
    ]);
  });
  const impact = await s.unitImpact("default-org", "unit-a");
  assert.equal(impact.activeChildUnits, 1);
  assert.equal(impact.activeMembers, 2);
  assert.equal(impact.directoryRoots, 0);
  assert.equal(impact.accessGrants, 3);
});

test("memory organization store: transact flushes buffered audits after success and none when fn throws", async () => {
  const auditLog = createAuditLog();
  const s = createMemoryOrganizationStore({ auditLog });
  await s.transact("default-org", async (tx) => {
    await tx.audit(auditEvent("org.unit.create"));
    await tx.audit(auditEvent("org.unit.move"));
  });
  assert.deepEqual(
    (await auditLog.events()).map((e) => e.action),
    ["org.unit.create", "org.unit.move"],
  );
  await assert.rejects(
    s.transact("default-org", async (tx) => {
      await tx.audit(auditEvent("org.unit.archive"));
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal((await auditLog.events()).length, 2, "failed transaction flushes nothing");
  const unlogged = createMemoryOrganizationStore();
  await unlogged.transact("default-org", async (tx) => {
    await tx.audit(auditEvent("org.unit.create"));
  });
});

test("memory organization store: transact rolls back organization state and rejects cross-org access", async () => {
  const auditLog = createAuditLog();
  const s = createMemoryOrganizationStore({ auditLog });
  await assert.rejects(
    s.transact("default-org", async (tx) => {
      await tx.putUser(user({ principalId: "new-user" }));
      await tx.putIdentity({
        orgId: "default-org",
        issuer: "https://idp",
        subject: "new-subject",
        principalId: "new-user",
        emailAtLink: null,
        createdAt: 1,
        updatedAt: 1,
      });
      await tx.bumpRevision("default-org");
      await tx.audit(auditEvent("org.user.activate"));
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await s.getUser("default-org", "new-user"), null);
  assert.equal(await s.getIdentity("default-org", "https://idp", "new-subject"), null);
  assert.equal(await s.getAuthzRevision("default-org"), 0);
  assert.equal((await auditLog.events()).length, 0);

  await assert.rejects(
    s.transact("default-org", (tx) => tx.getUser("other-org", "new-user")),
    /scope mismatch/,
  );
});

test("memory organization store: readers cannot observe uncommitted transaction state", async () => {
  const s = createMemoryOrganizationStore();
  let entered!: () => void;
  let release!: () => void;
  const transactionEntered = new Promise<void>((resolve) => (entered = resolve));
  const transactionRelease = new Promise<void>((resolve) => (release = resolve));
  const running = s.transact("default-org", async (tx) => {
    await tx.putUser(user({ principalId: "pending" }));
    entered();
    await transactionRelease;
  });
  await transactionEntered;
  assert.equal(await s.getUser("default-org", "pending"), null);
  release();
  await running;
  assert.equal((await s.getUser("default-org", "pending"))?.principalId, "pending");
});

test("memory organization store: bumpRevision increments and returns 2, 3, ... per org", async () => {
  const s = createMemoryOrganizationStore();
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 1 });
  await s.ensureOrgRoot({ orgId: "other-org", name: "Other", actor: "system:bootstrap", now: 1 });
  await s.transact("default-org", async (tx) => {
    assert.equal(await tx.bumpRevision("default-org"), 2);
    assert.equal(await tx.bumpRevision("default-org"), 3);
  });
  await s.transact("other-org", async (tx) => {
    assert.equal(await tx.bumpRevision("other-org"), 2, "per-org counter");
  });
  assert.equal(await s.getAuthzRevision("default-org"), 3);
  assert.equal(await s.getAuthzRevision("other-org"), 2);
});

test("memory organization store: group CRUD and members round-trip, removeGroupMember removes only the target row", async () => {
  const s = createMemoryOrganizationStore();
  assert.equal(await s.getGroup("default-org", "grp-a"), null);
  await s.putGroup(group());
  await s.putGroup(group({ id: "grp-b", name: "Group B", orgId: "other-org" }));
  assert.equal((await s.getGroup("default-org", "grp-a"))?.name, "Group A");
  assert.deepEqual(
    (await s.listGroups("default-org")).map((g) => g.id),
    ["grp-a"],
    "org isolation",
  );
  await s.putGroup(group({ name: "Group A v2", updatedAt: 2 }));
  assert.equal((await s.getGroup("default-org", "grp-a"))?.name, "Group A v2", "upsert replaces");
  await s.putGroupMember(groupMember({ principalId: "alice@acme.com" }));
  await s.putGroupMember(groupMember({ principalId: "bob@acme.com", role: "manager" }));
  assert.equal((await s.listGroupMembers("default-org", "grp-a")).length, 2);
  assert.deepEqual(await s.listManagedGroupIds("default-org", "bob@acme.com"), ["grp-a"]);
  await s.putGroup(group({ status: "archived" }));
  assert.deepEqual(await s.listManagedGroupIds("default-org", "bob@acme.com"), []);
  await s.removeGroupMember("default-org", "grp-a", "alice@acme.com");
  const remaining = await s.listGroupMembers("default-org", "grp-a");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.principalId, "bob@acme.com");
  await s.removeGroupMember("default-org", "grp-a", "nobody@acme.com");
  assert.equal((await s.listGroupMembers("default-org", "grp-a")).length, 1, "removing a non-member is a no-op");
});

test("memory organization store: unit members round-trip and removeUnitMember removes only the target row", async () => {
  const s = createMemoryOrganizationStore();
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 1 });
  await s.putUnit(unit({ id: "unit-a" }));
  await s.putUnitMember(unitMember({ principalId: "alice@acme.com" }));
  await s.putUnitMember(unitMember({ principalId: "bob@acme.com", role: "manager" }));
  await s.putUnitMember(unitMember({ principalId: "alice@acme.com", unitId: "root" }));
  assert.equal((await s.listUnitMembers("default-org", "unit-a")).length, 2);
  await s.removeUnitMember("default-org", "unit-a", "alice@acme.com");
  const remaining = await s.listUnitMembers("default-org", "unit-a");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.principalId, "bob@acme.com");
  assert.equal((await s.listUnitMembers("default-org", "root")).length, 1, "other units untouched");
});
