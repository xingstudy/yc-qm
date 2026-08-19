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

const user = (over: Partial<OrganizationUser> = {}): OrganizationUser => ({
  orgId: "default-org",
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

test("memory organization store: identities are keyed by issuer+subject", async () => {
  const s = createMemoryOrganizationStore();
  assert.equal(await s.getIdentity("default-org", "https://idp", "sub-1"), null);
  await s.putIdentity({ orgId: "default-org", issuer: "https://idp", subject: "sub-1", principalId: "alice@acme.com", emailAtLink: "alice@acme.com", createdAt: 1, updatedAt: 1 });
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
  await s.transact(async (tx) => {
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
  assert.deepEqual(await s.listManagedSubtreeUnitIds("default-org", "bob@acme.com"), [], "plain members manage nothing");
});

test("memory organization store: unitImpact counts active child units and members whose user exists and is not deprovisioned (missing user rows do not count)", async () => {
  const s = createMemoryOrganizationStore();
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
  const impact = await s.unitImpact("default-org", "unit-a");
  assert.equal(impact.activeChildUnits, 1);
  assert.equal(impact.activeMembers, 2);
  assert.equal(impact.directoryRoots, 0);
  assert.equal(impact.skillGrants, 0);
});

test("memory organization store: transact flushes buffered audits after success and none when fn throws", async () => {
  const auditLog = createAuditLog();
  const s = createMemoryOrganizationStore({ auditLog });
  await s.transact(async (tx) => {
    await tx.audit(auditEvent("org.unit.create"));
    await tx.audit(auditEvent("org.unit.move"));
  });
  assert.deepEqual((await auditLog.events()).map((e) => e.action), ["org.unit.create", "org.unit.move"]);
  await assert.rejects(
    s.transact(async (tx) => {
      await tx.audit(auditEvent("org.unit.archive"));
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal((await auditLog.events()).length, 2, "failed transaction flushes nothing");
  const unlogged = createMemoryOrganizationStore();
  await unlogged.transact(async (tx) => {
    await tx.audit(auditEvent("org.unit.create"));
  });
});

test("memory organization store: bumpRevision increments and returns 2, 3, ... per org", async () => {
  const s = createMemoryOrganizationStore();
  await s.ensureOrgRoot({ orgId: "default-org", name: "Acme", actor: "system:bootstrap", now: 1 });
  await s.ensureOrgRoot({ orgId: "other-org", name: "Other", actor: "system:bootstrap", now: 1 });
  await s.transact(async (tx) => {
    assert.equal(await tx.bumpRevision("default-org"), 2);
    assert.equal(await tx.bumpRevision("default-org"), 3);
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
  assert.deepEqual((await s.listGroups("default-org")).map((g) => g.id), ["grp-a"], "org isolation");
  await s.putGroup(group({ name: "Group A v2", updatedAt: 2 }));
  assert.equal((await s.getGroup("default-org", "grp-a"))?.name, "Group A v2", "upsert replaces");
  await s.putGroupMember(groupMember({ principalId: "alice@acme.com" }));
  await s.putGroupMember(groupMember({ principalId: "bob@acme.com", role: "manager" }));
  assert.equal((await s.listGroupMembers("default-org", "grp-a")).length, 2);
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
