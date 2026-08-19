import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresOrganizationStore } from "../src/organization/postgres-organization-store.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import type {
  AccessGroup,
  AccessGroupMember,
  AuthIdentity,
  OrganizationUser,
  OrgUnit,
  OrgUnitMember,
} from "../src/organization/organization-store.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres organization-store tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query(
    "DROP TABLE IF EXISTS org_unit_members, org_unit_closure, org_units, access_group_members, access_groups, organization_authz_state, auth_identities, organization_users CASCADE",
  );
  await p.end();
});

async function rawRows(text: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  try {
    return (await p.query(text, params)).rows as Record<string, unknown>[];
  } finally {
    await p.end();
  }
}

const user = (over: Partial<OrganizationUser> = {}): OrganizationUser => ({
  orgId: "org1",
  principalId: "U1",
  email: "alice@example.com",
  displayName: "Alice",
  status: "active",
  sessionVersion: 1,
  createdAt: 100,
  updatedAt: 100,
  lastLoginAt: null,
  createdBy: "admin",
  updatedBy: "admin",
  ...over,
});

const identity = (over: Partial<AuthIdentity> = {}): AuthIdentity => ({
  orgId: "org1",
  issuer: "https://idp.example.com",
  subject: "sub-1",
  principalId: "U1",
  emailAtLink: "alice@example.com",
  createdAt: 100,
  updatedAt: 100,
  ...over,
});

test("pg organization store: putUser upserts on (org, principal); getUser and listUsers round-trip", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  assert.equal(await store.getUser("org1", "U1"), null);

  await store.putUser(user());
  await store.putUser(user());
  assert.deepEqual(await store.getUser("org1", "U1"), user());
  assert.equal((await store.listUsers("org1")).length, 1, "put dedups on (org, principal)");

  await store.putUser(user({ displayName: "Alice Cooper", updatedAt: 200, lastLoginAt: 150 }));
  const got = await store.getUser("org1", "U1");
  assert.equal(got!.displayName, "Alice Cooper");
  assert.equal(got!.lastLoginAt, 150);
  assert.equal((await store.listUsers("org1")).length, 1, "second put is an upsert, not an insert");

  await store.putUser(user({ orgId: "org2" }));
  assert.equal((await store.listUsers("org1")).length, 1);
  assert.equal((await store.listUsers("org2")).length, 1, "listUsers is org-scoped");
  assert.equal(await store.getUser("org1", "missing"), null);
});

test("pg organization store: findUserByEmail is case-insensitive and org-scoped", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user({ email: "Alice@Example.com" }));
  assert.equal((await store.findUserByEmail("org1", "alice@example.COM"))!.principalId, "U1");
  assert.equal(await store.findUserByEmail("org2", "alice@example.com"), null);
  assert.equal(await store.findUserByEmail("org1", "nobody@example.com"), null);
});

test("pg organization store: duplicate email rejected within an org, allowed across orgs; null emails exempt", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user({ email: "alice@example.com" }));
  await assert.rejects(
    () => store.putUser(user({ principalId: "U2", email: "ALICE@example.com" })),
    (e: unknown) => (e as { code?: string }).code === "23505",
    "unique index rejects a case-variant duplicate email in the same org",
  );

  await store.putUser(user({ principalId: "U2", orgId: "org2", email: "alice@example.com" }));
  await store.putUser(user({ principalId: "U3", email: null }));
  await store.putUser(user({ principalId: "U4", email: null }));
  assert.equal((await store.listUsers("org1")).length, 3, "other orgs and null emails coexist");
});

test("pg organization store: identities round-trip keyed by (org, issuer, subject)", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user());
  assert.equal(await store.getIdentity("org1", "https://idp.example.com", "sub-1"), null);

  await store.putIdentity(identity());
  assert.deepEqual(await store.getIdentity("org1", "https://idp.example.com", "sub-1"), identity());

  await store.putIdentity(identity({ emailAtLink: "new@example.com", updatedAt: 200 }));
  const got = await store.getIdentity("org1", "https://idp.example.com", "sub-1");
  assert.equal(got!.emailAtLink, "new@example.com", "putIdentity upserts on (org, issuer, subject)");

  await store.putIdentity(identity({ subject: "sub-2" }));
  assert.equal((await store.getIdentity("org1", "https://idp.example.com", "sub-2"))!.subject, "sub-2");
  assert.equal(await store.getIdentity("org1", "https://idp.example.com", "missing"), null);
  assert.equal(await store.getIdentity("org2", "https://idp.example.com", "sub-1"), null);
});

test("pg organization store: rows survive a second store instance", { skip }, async () => {
  const boot1 = createPostgresOrganizationStore(URL!);
  await boot1.putUser(user({ principalId: "U-durable" }));
  await boot1.putIdentity(identity({ principalId: "U-durable", subject: "sub-durable" }));

  const boot2 = createPostgresOrganizationStore(URL!);
  assert.equal((await boot2.getUser("org1", "U-durable"))!.principalId, "U-durable");
  assert.equal(
    (await boot2.getIdentity("org1", "https://idp.example.com", "sub-durable"))!.principalId,
    "U-durable",
  );
});

const unit = (over: Partial<OrgUnit> = {}): OrgUnit => ({
  orgId: "org-tree",
  id: "unit-a",
  parentId: "root",
  name: "Unit A",
  kind: "department",
  status: "active",
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  createdBy: "admin",
  updatedBy: "admin",
  ...over,
});

const unitMember = (over: Partial<OrgUnitMember> = {}): OrgUnitMember => ({
  orgId: "org-tree",
  unitId: "unit-a",
  principalId: "U1",
  role: "member",
  createdAt: 1,
  createdBy: "admin",
  ...over,
});

const group = (over: Partial<AccessGroup> = {}): AccessGroup => ({
  orgId: "org-tree",
  id: "grp-a",
  name: "Group A",
  status: "active",
  createdAt: 1,
  updatedAt: 1,
  createdBy: "admin",
  updatedBy: "admin",
  ...over,
});

const groupMember = (over: Partial<AccessGroupMember> = {}): AccessGroupMember => ({
  orgId: "org-tree",
  groupId: "grp-a",
  principalId: "U1",
  role: "member",
  createdAt: 1,
  createdBy: "admin",
  ...over,
});

const auditEvent = (orgId: string, action: string): AuditEvent => ({
  at: 1,
  principalId: "admin",
  action,
  resource: "unit:root",
  scopeLabel: `org:${orgId}`,
  orgId,
});

async function assertClosureMatchesParentWalk(orgId: string): Promise<void> {
  const units = await rawRows("SELECT id, parent_id FROM org_units WHERE org_id = $1", [orgId]);
  const closure = await rawRows("SELECT ancestor_id, descendant_id, depth FROM org_unit_closure WHERE org_id = $1", [orgId]);
  const parentOf = new Map(units.map((u) => [u.id as string, u.parent_id as string | null]));
  const byDescendant = new Map<string, Map<string, number>>();
  for (const row of closure) {
    const key = row.descendant_id as string;
    if (!byDescendant.has(key)) byDescendant.set(key, new Map());
    byDescendant.get(key)!.set(row.ancestor_id as string, Number(row.depth));
  }
  const childrenOf = new Map<string | null, string[]>();
  for (const u of units) {
    const p = u.parent_id as string | null;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(u.id as string);
  }
  const reached: string[] = [];
  const walk = (id: string) => {
    reached.push(id);
    for (const child of childrenOf.get(id) ?? []) walk(child);
  };
  walk("root");
  assert.deepEqual(
    [...reached].sort(),
    units.map((u) => u.id as string).sort(),
    "walking from root reaches every unit exactly once (acyclic, connected)",
  );
  for (const u of units) {
    const id = u.id as string;
    const expected = new Map<string, number>();
    let current: string | null = id;
    let depth = 0;
    while (current !== null) {
      expected.set(current, depth);
      depth += 1;
      current = parentOf.get(current) ?? null;
    }
    assert.deepEqual(byDescendant.get(id) ?? new Map(), expected, `closure rows for ${id} match the parent walk`);
  }
}

test("pg org tree: ensureOrgRoot creates root and revision 1, second call is a no-op", { skip }, async () => {
  const org = "org-ensure-root";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 10 });
  const root = await store.getUnit(org, "root");
  assert.equal(root?.kind, "organization");
  assert.equal(root?.parentId, null);
  assert.equal(root?.status, "active");
  assert.equal(root?.createdAt, 10);
  assert.equal(await store.getAuthzRevision(org), 1);
  assert.equal(await store.isDescendant(org, "root", "root"), true, "root self-row in closure");

  await store.ensureOrgRoot({ orgId: org, name: "Renamed", actor: "admin", now: 20 });
  const again = await store.getUnit(org, "root");
  assert.equal(again?.name, "Acme");
  assert.equal(again?.createdAt, 10);
  assert.equal((await store.listUnits(org)).length, 1);
  assert.equal(await store.getAuthzRevision(org), 1);
});

test("pg org tree: ensureOrgRoot never regresses an existing revision", { skip }, async () => {
  const org = "org-ensure-root-bump";
  const store = createPostgresOrganizationStore(URL!);
  await store.transact(async (tx) => {
    await tx.bumpRevision(org);
  });
  assert.equal(await store.getAuthzRevision(org), 2);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 10 });
  assert.equal(await store.getAuthzRevision(org), 2, "bootstrap never clobbers a concurrent bump");
  const root = await store.getUnit(org, "root");
  assert.equal(root?.kind, "organization");
  assert.equal(root?.status, "active");
});

test("pg org tree: putUnit maintains closure self-rows, isDescendant and listSubtreeUnitIds reflect the tree", { skip }, async () => {
  const org = "org-closure-basic";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a" }));
  assert.equal(await store.isDescendant(org, "root", "unit-b"), true);
  assert.equal(await store.isDescendant(org, "root", "root"), true, "self-row");
  assert.equal(await store.isDescendant(org, "unit-b", "root"), false);
  assert.equal(await store.isDescendant(org, "unit-b", "unit-a"), false);
  assert.deepEqual((await store.listSubtreeUnitIds(org, "root")).sort(), ["root", "unit-a", "unit-b"]);
  assert.deepEqual(await store.listSubtreeUnitIds(org, "unit-b"), ["unit-b"]);
  assert.equal((await store.getUnit(org, "unit-b"))?.name, "Unit A");

  await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a", name: "Unit B v2", updatedAt: 2 }));
  assert.equal((await store.getUnit(org, "unit-b"))?.name, "Unit B v2", "putUnit upserts");
  assert.equal((await store.listUnits(org)).length, 3, "upsert does not duplicate");
  await assertClosureMatchesParentWalk(org);
});

test("pg org tree: transact moveUnitSubtree re-links the subtree and keeps closure self-rows", { skip }, async () => {
  const org = "org-move";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-c" }));
  await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-b1", parentId: "unit-b" }));
  await store.transact(async (tx) => {
    await tx.moveUnitSubtree(org, "unit-b", "unit-c");
  });
  assert.equal((await store.getUnit(org, "unit-b"))?.parentId, "unit-c");
  assert.equal(await store.isDescendant(org, "unit-c", "unit-b1"), true);
  assert.equal(await store.isDescendant(org, "unit-a", "unit-b1"), false);
  assert.equal(await store.isDescendant(org, "unit-b", "unit-b1"), true);
  assert.equal(await store.isDescendant(org, "unit-b1", "unit-b1"), true, "self-row intact");
  assert.equal(await store.isDescendant(org, "root", "unit-b1"), true);
  assert.deepEqual((await store.listSubtreeUnitIds(org, "unit-c")).sort(), ["unit-b", "unit-b1", "unit-c"]);
  await assertClosureMatchesParentWalk(org);
});

test("pg org tree: moveUnitSubtree rejects a move under the unit's own descendant", { skip }, async () => {
  const org = "org-move-cycle";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a" }));
  await assert.rejects(
    store.transact((tx) => tx.moveUnitSubtree(org, "unit-a", "unit-b")),
    /descendant/,
  );
  await assert.rejects(
    store.transact((tx) => tx.moveUnitSubtree(org, "unit-a", "unit-a")),
    /descendant|itself/,
  );
  await assert.rejects(
    store.transact((tx) => tx.moveUnitSubtree(org, "missing", "root")),
    /not found/,
  );
  await assertClosureMatchesParentWalk(org);
});

test("pg org tree: listManagedSubtreeUnitIds gives a manager their unit and descendants, not siblings or ancestors", { skip }, async () => {
  const org = "org-managed";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUser(user({ orgId: org, principalId: "U-mgr", email: "mgr@example.com" }));
  await store.putUser(user({ orgId: org, principalId: "U-plain", email: "plain@example.com" }));
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-a2", parentId: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-b", parentId: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-b1", parentId: "unit-b" }));
  await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-b", principalId: "U-mgr", role: "manager" }));
  await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-b", principalId: "U-plain", role: "member" }));
  assert.deepEqual((await store.listManagedSubtreeUnitIds(org, "U-mgr")).sort(), ["unit-b", "unit-b1"]);
  assert.deepEqual(await store.listManagedSubtreeUnitIds(org, "U-plain"), [], "plain members manage nothing");
  assert.deepEqual(await store.listManagedSubtreeUnitIds(org, "U-absent"), []);
});

test("pg org tree: unitImpact counts active child units and members whose user exists and is not deprovisioned", { skip }, async () => {
  const org = "org-impact";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-a1", parentId: "unit-a" }));
  await store.putUnit(unit({ orgId: org, id: "unit-a2", parentId: "unit-a", status: "archived" }));
  await store.putUser(user({ orgId: org, principalId: "U-active", email: "active@example.com", status: "active" }));
  await store.putUser(user({ orgId: org, principalId: "U-susp", email: "susp@example.com", status: "suspended" }));
  await store.putUser(user({ orgId: org, principalId: "U-gone", email: "gone@example.com", status: "deprovisioned" }));
  await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-a", principalId: "U-active" }));
  await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-a", principalId: "U-susp" }));
  await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-a", principalId: "U-gone" }));
  await store.putUnitMember(unitMember({ orgId: org, unitId: "unit-a1", principalId: "U-active" }));
  const impact = await store.unitImpact(org, "unit-a");
  assert.equal(impact.activeChildUnits, 1);
  assert.equal(impact.activeMembers, 2, "member rows require a user row (FK) and count unless deprovisioned");
  assert.equal(impact.directoryRoots, 0);
  assert.equal(impact.skillGrants, 0);
});

test("pg org tree: transact commits audits through the audit log; failure rolls back unit, revision, and audit", { skip }, async () => {
  const org = "org-tx-audit";
  const auditLog = createPostgresAuditLog(URL!);
  const store = createPostgresOrganizationStore(URL!, { auditLog });
  await auditLog.events();
  await rawRows("DELETE FROM audit_log WHERE org_id = $1", [org]);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));

  await store.transact(async (tx) => {
    await tx.audit(auditEvent(org, "org.unit.create"));
    await tx.audit(auditEvent(org, "org.unit.move"));
  });
  const committed = (await auditLog.events()).filter((e) => e.orgId === org);
  assert.deepEqual(committed.map((e) => e.action), ["org.unit.create", "org.unit.move"]);

  await assert.rejects(
    store.transact(async (tx) => {
      await tx.putUnit(unit({ orgId: org, id: "unit-a", name: "Renamed", updatedAt: 2 }));
      await tx.bumpRevision(org);
      await tx.audit(auditEvent(org, "org.unit.archive"));
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal((await store.getUnit(org, "unit-a"))?.name, "Unit A", "unit update rolled back");
  assert.equal(await store.getAuthzRevision(org), 1, "revision bump rolled back");
  assert.equal(
    (await auditLog.events()).filter((e) => e.orgId === org).length,
    2,
    "audit insert rolled back with the transaction",
  );

  const unlogged = createPostgresOrganizationStore(URL!);
  await assert.rejects(
    unlogged.transact((tx) => tx.audit(auditEvent(org, "org.unit.create"))),
    /auditLog/,
    "tx.audit without a configured auditLog throws",
  );
});

test("pg org tree: bumpRevision increments and returns 2, 3, ... per org", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: "org-bump-a", name: "Acme", actor: "admin", now: 1 });
  await store.ensureOrgRoot({ orgId: "org-bump-b", name: "Other", actor: "admin", now: 1 });
  await store.transact(async (tx) => {
    assert.equal(await tx.bumpRevision("org-bump-a"), 2);
    assert.equal(await tx.bumpRevision("org-bump-a"), 3);
    assert.equal(await tx.bumpRevision("org-bump-b"), 2, "per-org counter");
  });
  assert.equal(await store.getAuthzRevision("org-bump-a"), 3);
  assert.equal(await store.getAuthzRevision("org-bump-b"), 2);
  assert.equal(await store.getAuthzRevision("org-bump-never"), 0, "no authz row yet");
});

test("pg org tree: group CRUD and members round-trip, removeGroupMember removes only the target row", { skip }, async () => {
  const org = "org-groups";
  const store = createPostgresOrganizationStore(URL!);
  await store.putUser(user({ orgId: org, principalId: "U1", email: "u1@example.com" }));
  await store.putUser(user({ orgId: org, principalId: "U2", email: "u2@example.com" }));
  assert.equal(await store.getGroup(org, "grp-a"), null);
  await store.putGroup(group({ orgId: org }));
  await store.putGroup(group({ orgId: "org-groups-other", id: "grp-b", name: "Group B" }));
  assert.equal((await store.getGroup(org, "grp-a"))?.name, "Group A");
  assert.deepEqual((await store.listGroups(org)).map((g) => g.id), ["grp-a"], "org isolation");
  await store.putGroup(group({ orgId: org, name: "Group A v2", updatedAt: 2 }));
  assert.equal((await store.getGroup(org, "grp-a"))?.name, "Group A v2", "upsert replaces");
  await store.putGroupMember(groupMember({ orgId: org, principalId: "U1" }));
  await store.putGroupMember(groupMember({ orgId: org, principalId: "U2", role: "manager" }));
  assert.equal((await store.listGroupMembers(org, "grp-a")).length, 2);
  await store.removeGroupMember(org, "grp-a", "U1");
  const remaining = await store.listGroupMembers(org, "grp-a");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.principalId, "U2");
  await store.removeGroupMember(org, "grp-a", "U-absent");
  assert.equal((await store.listGroupMembers(org, "grp-a")).length, 1, "removing a non-member is a no-op");
});

test("pg org tree: unit members round-trip and removeUnitMember removes only the target row", { skip }, async () => {
  const org = "org-members";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "unit-a" }));
  await store.putUser(user({ orgId: org, principalId: "U1", email: "u1@example.com" }));
  await store.putUser(user({ orgId: org, principalId: "U2", email: "u2@example.com" }));
  await store.putUnitMember(unitMember({ orgId: org, principalId: "U1" }));
  await store.putUnitMember(unitMember({ orgId: org, principalId: "U2", role: "manager" }));
  await store.putUnitMember(unitMember({ orgId: org, principalId: "U1", unitId: "root" }));
  assert.equal((await store.listUnitMembers(org, "unit-a")).length, 2);
  await store.removeUnitMember(org, "unit-a", "U1");
  const remaining = await store.listUnitMembers(org, "unit-a");
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.principalId, "U2");
  assert.equal((await store.listUnitMembers(org, "root")).length, 1, "other units untouched");
});

test("pg org tree: closure stays consistent with the parent walk after a sequence of moves", { skip }, async () => {
  const org = "org-closure-consistency";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "a" }));
  await store.putUnit(unit({ orgId: org, id: "b" }));
  await store.putUnit(unit({ orgId: org, id: "c", parentId: "b" }));
  await store.putUnit(unit({ orgId: org, id: "a1", parentId: "a" }));
  await store.putUnit(unit({ orgId: org, id: "a2", parentId: "a" }));
  await store.putUnit(unit({ orgId: org, id: "a1x", parentId: "a1" }));
  await assertClosureMatchesParentWalk(org);
  await store.transact((tx) => tx.moveUnitSubtree(org, "a1", "c"));
  await assertClosureMatchesParentWalk(org);
  await store.transact((tx) => tx.moveUnitSubtree(org, "b", "a2"));
  await assertClosureMatchesParentWalk(org);
  await store.transact((tx) => tx.moveUnitSubtree(org, "a", "root"));
  await assertClosureMatchesParentWalk(org);
});

test("pg org tree: concurrent sibling-swap moves serialize — exactly one wins and the closure stays acyclic", { skip }, async () => {
  const org = "org-concurrent-move";
  const store = createPostgresOrganizationStore(URL!);
  await store.ensureOrgRoot({ orgId: org, name: "Acme", actor: "admin", now: 1 });
  await store.putUnit(unit({ orgId: org, id: "a" }));
  await store.putUnit(unit({ orgId: org, id: "a1", parentId: "a" }));
  await store.putUnit(unit({ orgId: org, id: "b" }));
  await store.putUnit(unit({ orgId: org, id: "b1", parentId: "b" }));
  const results = await Promise.allSettled([
    store.transact((tx) => tx.moveUnitSubtree(org, "a", "b")),
    store.transact((tx) => tx.moveUnitSubtree(org, "b", "a")),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one move commits");
  assert.equal(results.filter((r) => r.status === "rejected").length, 1, "the losing move is rejected");
  await assertClosureMatchesParentWalk(org);
});

test("pg org tree: cross-org isolation — same unit ids in two orgs never interact", { skip }, async () => {
  const store = createPostgresOrganizationStore(URL!);
  for (const org of ["org-iso-a", "org-iso-b"]) {
    await store.ensureOrgRoot({ orgId: org, name: `Name ${org}`, actor: "admin", now: 1 });
    await store.putUnit(unit({ orgId: org, id: "shared" }));
    await store.putUnit(unit({ orgId: org, id: "child", parentId: "shared" }));
    await store.putUser(user({ orgId: org, principalId: "U1" }));
    await store.putUnitMember(unitMember({ orgId: org, unitId: "shared", principalId: "U1" }));
  }
  await store.transact(async (tx) => {
    await tx.moveUnitSubtree("org-iso-a", "shared", "root");
    await tx.bumpRevision("org-iso-a");
  });
  await store.putUnit(unit({ orgId: "org-iso-a", id: "extra", parentId: "shared" }));

  assert.equal((await store.getUnit("org-iso-a", "shared"))?.parentId, "root");
  assert.equal((await store.getUnit("org-iso-b", "shared"))?.parentId, "root", "same shape, untouched rows");
  assert.equal((await store.getUnit("org-iso-b", "shared"))?.name, "Unit A");
  assert.deepEqual((await store.listSubtreeUnitIds("org-iso-a", "shared")).sort(), ["child", "extra", "shared"]);
  assert.deepEqual((await store.listSubtreeUnitIds("org-iso-b", "shared")).sort(), ["child", "shared"]);
  assert.equal((await store.unitImpact("org-iso-a", "shared")).activeMembers, 1);
  assert.equal((await store.unitImpact("org-iso-b", "shared")).activeChildUnits, 1);
  assert.equal(await store.getAuthzRevision("org-iso-a"), 2);
  assert.equal(await store.getAuthzRevision("org-iso-b"), 1, "other org revision untouched");
  await assertClosureMatchesParentWalk("org-iso-a");
  await assertClosureMatchesParentWalk("org-iso-b");
  const closureA = await rawRows("SELECT 1 FROM org_unit_closure WHERE org_id = 'org-iso-a'");
  const closureB = await rawRows("SELECT 1 FROM org_unit_closure WHERE org_id = 'org-iso-b'");
  assert.equal(closureA.length, 9, "org-iso-a closure covers exactly its own four-unit tree");
  assert.equal(closureB.length, 6, "org-iso-b closure unchanged by the other org's move and insert");
});
