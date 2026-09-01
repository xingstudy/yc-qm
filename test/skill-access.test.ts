import assert from "node:assert/strict";
import test from "node:test";
import {
  createSkillAccessRepository,
  MAX_SKILL_ACCESS_SUBJECTS,
  SkillAccessConflictError,
  SkillAccessNotFoundError,
} from "../src/authorization/skill-access-repository.ts";
import { createSkillAccessResolver } from "../src/authorization/skill-access.ts";
import { createDirectoryVisibilityResolver } from "../src/authorization/directory-visibility.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createMemoryOrganizationStore, type OrganizationUser } from "../src/organization/organization-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSkillStore, type Skill } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";

const ORG = "acme";

function user(principalId: string): OrganizationUser {
  return {
    orgId: ORG,
    principalId,
    email: `${principalId}@example.com`,
    displayName: principalId.toUpperCase(),
    jobTitle: null,
    mobile: null,
    employeeNumber: null,
    status: "active",
    sessionVersion: 1,
    profileRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    lastLoginAt: 1,
    createdBy: "setup",
    updatedBy: "setup",
  };
}

async function fixture() {
  const backing = createMemoryMap<Skill>();
  const auditLog = createAuditLog();
  const store = createMemoryOrganizationStore({ auditLog, skillBacking: backing });
  await store.ensureOrgRoot({ orgId: ORG, name: "Acme", actor: "setup", now: 1 });
  for (const principalId of ["alice", "bob", "carol"]) await store.putUser(user(principalId));
  await store.putUnit({
    orgId: ORG,
    id: "engineering",
    parentId: "root",
    name: "Engineering",
    kind: "department",
    status: "active",
    sortOrder: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: "setup",
    updatedBy: "setup",
  });
  await store.putUnit({
    orgId: ORG,
    id: "platform",
    parentId: "engineering",
    name: "Platform",
    kind: "team",
    status: "active",
    sortOrder: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: "setup",
    updatedBy: "setup",
  });
  await store.putUnitMember({
    orgId: ORG,
    unitId: "platform",
    principalId: "bob",
    role: "member",
    createdAt: 1,
    createdBy: "setup",
  });
  await store.putGroup({
    orgId: ORG,
    id: "analysts",
    name: "Analysts",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    createdBy: "setup",
    updatedBy: "setup",
  });
  await store.putGroupMember({
    orgId: ORG,
    groupId: "analysts",
    principalId: "carol",
    role: "member",
    createdAt: 1,
    createdBy: "setup",
  });
  const base = createSkillStore({ orgId: ORG, signingSecret: "test-secret", backing });
  const directory = createDirectoryVisibilityResolver({ orgId: ORG, store });
  const repository = createSkillAccessRepository({
    orgId: ORG,
    signingSecret: "test-secret",
    store,
    base,
    directory,
  });
  await repository.ready();
  const resolver = createSkillAccessResolver({
    orgId: ORG,
    store,
    skills: repository,
    canReadHome: async (principalId, home) => home === scopeId("personal", principalId),
  });
  const skill = await repository.create({
    scopeId: scopeId("personal", "alice"),
    createdBy: "alice",
    manifest: { name: "forecast", description: "Forecast", requiredCapabilities: [], body: "Run forecast" },
  });
  await repository.review(skill.id, "alice", []);
  await repository.publish(skill.id);
  return { store, repository, resolver, skill };
}

test("skill access creates home policy and resolves home audience", async () => {
  const { repository, resolver, skill } = await fixture();
  const access = await repository.getAccess(skill.id, { principalId: "alice", isAdmin: false });
  assert.equal(access.mode, "home");
  assert.equal(access.revision, 1);
  assert.equal((await resolver.visibleForUser("alice", [scopeId("personal", "alice")]))[0]?.skill?.id, skill.id);
  assert.deepEqual(await resolver.visibleForUser("alice", [scopeId("channel", "general")]), []);
  assert.deepEqual(await resolver.visibleForUser("bob", [scopeId("personal", "bob")]), []);
});

test("skill access resolves eligible legacy users without overriding organization status", async () => {
  const { store, repository, skill } = await fixture();
  await repository.setAccess(
    skill.id,
    { principalId: "alice", isAdmin: true },
    { mode: "organization", subjects: [], expectedRevision: 1 },
  );
  let sessionVersion = 4;
  const resolver = createSkillAccessResolver({
    orgId: ORG,
    store,
    skills: repository,
    canReadHome: async () => false,
    resolveAudienceMember: async (principalId) => (principalId === "legacy" ? { principalId, sessionVersion } : null),
  });
  const snapshot = await resolver.snapshot({ audienceIds: ["legacy"], orderedScopes: [] });
  assert.equal(snapshot.resolutions[0]?.skill?.id, skill.id);
  await resolver.assertCurrent(snapshot);
  sessionVersion += 1;
  await assert.rejects(resolver.assertCurrent(snapshot), /skill authorization snapshot expired/);
  await store.putUser({ ...user("legacy"), status: "suspended", sessionVersion });
  assert.deepEqual(await resolver.visibleForUser("legacy", []), []);
});

test("restricted grants union subjects for one user and intersect the full audience", async () => {
  const { repository, resolver, skill } = await fixture();
  await repository.setAccess(
    skill.id,
    { principalId: "alice", isAdmin: false },
    {
      mode: "restricted",
      subjects: [
        { kind: "org_unit", id: "engineering" },
        { kind: "access_group", id: "analysts" },
      ],
      expectedRevision: 1,
    },
  );
  assert.equal((await resolver.visibleForUser("bob", [scopeId("personal", "bob")]))[0]?.skill?.id, skill.id);
  assert.equal((await resolver.visibleForUser("carol", [scopeId("personal", "carol")]))[0]?.skill?.id, skill.id);
  assert.equal(
    (
      await resolver.snapshot({
        audienceIds: ["bob", "carol"],
        orderedScopes: [scopeId("personal", "bob")],
      })
    ).resolutions[0]?.skill?.id,
    skill.id,
  );
  assert.deepEqual(
    (
      await resolver.snapshot({
        audienceIds: ["alice", "bob"],
        orderedScopes: [scopeId("personal", "alice")],
      })
    ).resolutions,
    [],
  );
});

test("Skill Access batches organization-unit membership evaluation", async () => {
  const { store, repository, skill } = await fixture();
  const listUnitMembers = store.listUnitMembers.bind(store);
  const listUnitMembersForUnits = store.listUnitMembersForUnits.bind(store);
  let directReads = 0;
  let batchReads = 0;
  store.listUnitMembers = async (...args) => {
    directReads += 1;
    return listUnitMembers(...args);
  };
  store.listUnitMembersForUnits = async (...args) => {
    batchReads += 1;
    return listUnitMembersForUnits(...args);
  };
  await repository.setAccess(
    skill.id,
    { principalId: "alice", isAdmin: false },
    {
      mode: "restricted",
      subjects: [{ kind: "org_unit", id: "engineering" }],
      expectedRevision: 1,
    },
  );
  assert.equal(batchReads, 2);
  assert.equal(directReads, 0);
  batchReads = 0;
  directReads = 0;
  const access = await repository.getAccess(skill.id, { principalId: "alice", isAdmin: false });
  assert.equal(access.effectiveSummary.activeUsers, 1);
  assert.equal(batchReads, 1);
  assert.equal(directReads, 0);
  batchReads = 0;
  directReads = 0;
  await repository.removeAccessSubject(
    skill.id,
    { principalId: "alice", isAdmin: false },
    { kind: "org_unit", id: "engineering" },
  );
  assert.equal(batchReads, 1);
  assert.equal(directReads, 0);
});

test("Skill Access rejects unauthorized writes before grant and directory reads", async () => {
  const { store, repository, skill } = await fixture();
  const listSkillAccessGrants = store.listSkillAccessGrants.bind(store);
  const listUsers = store.listUsers.bind(store);
  const listSubtreeUnitIds = store.listSubtreeUnitIds.bind(store);
  const listUnitMembersForUnits = store.listUnitMembersForUnits.bind(store);
  let protectedReads = 0;
  store.listSkillAccessGrants = async (...args) => {
    protectedReads += 1;
    return listSkillAccessGrants(...args);
  };
  store.listUsers = async (...args) => {
    protectedReads += 1;
    return listUsers(...args);
  };
  store.listSubtreeUnitIds = async (...args) => {
    protectedReads += 1;
    return listSubtreeUnitIds(...args);
  };
  store.listUnitMembersForUnits = async (...args) => {
    protectedReads += 1;
    return listUnitMembersForUnits(...args);
  };
  const actor = { principalId: "bob", isAdmin: false };
  const subject = { kind: "org_unit" as const, id: "engineering" };
  await assert.rejects(
    repository.setAccess(skill.id, actor, { mode: "restricted", subjects: [subject], expectedRevision: 1 }),
    /skill not found/,
  );
  await assert.rejects(repository.addAccessSubject(skill.id, actor, subject), /skill not found/);
  await assert.rejects(repository.removeAccessSubject(skill.id, actor, subject), /skill not found/);
  assert.equal(protectedReads, 0);
});

test("Skill Access limits replacement subjects", async () => {
  const { repository, skill } = await fixture();
  await assert.rejects(
    repository.setAccess(
      skill.id,
      { principalId: "alice", isAdmin: false },
      {
        mode: "restricted",
        subjects: Array.from({ length: MAX_SKILL_ACCESS_SUBJECTS + 1 }, (_, index) => ({
          kind: "user" as const,
          id: `user-${index}`,
        })),
        expectedRevision: 1,
      },
    ),
    /too many access subjects/,
  );
});

test("organization mode is admin-only and CAS protects access replacement", async () => {
  const { repository, skill } = await fixture();
  await assert.rejects(
    repository.setAccess(
      skill.id,
      { principalId: "alice", isAdmin: false },
      { mode: "organization", subjects: [], expectedRevision: 1 },
    ),
  );
  const access = await repository.setAccess(
    skill.id,
    { principalId: "alice", isAdmin: true },
    { mode: "organization", subjects: [], expectedRevision: 1 },
  );
  assert.equal(access.revision, 2);
  await assert.rejects(
    repository.setAccess(
      skill.id,
      { principalId: "alice", isAdmin: true },
      { mode: "home", subjects: [], expectedRevision: 1 },
    ),
    SkillAccessConflictError,
  );
});

test("an org-homed Skill cannot be widened to home mode by its non-admin creator", async () => {
  const { repository } = await fixture();
  const skill = await repository.create({
    scopeId: scopeId("org", ORG),
    createdBy: "alice",
    manifest: { name: "org-home", description: "Org home", requiredCapabilities: [], body: "Org home" },
  });
  const restricted = await repository.setAccess(
    skill.id,
    { principalId: "alice", isAdmin: true },
    { mode: "restricted", subjects: [{ kind: "user", id: "bob" }], expectedRevision: 1 },
  );
  await assert.rejects(
    repository.setAccess(
      skill.id,
      { principalId: "alice", isAdmin: false },
      { mode: "home", subjects: [], expectedRevision: restricted.revision },
    ),
    SkillAccessNotFoundError,
  );
});

test("agent subject add and remove are atomic restricted-policy mutations", async () => {
  const { repository, resolver, skill } = await fixture();
  await repository.setAccess(
    skill.id,
    { principalId: "alice", isAdmin: false },
    { mode: "restricted", subjects: [], expectedRevision: 1 },
  );
  const added = await repository.addAccessSubject(
    skill.id,
    { principalId: "alice", isAdmin: false },
    { kind: "user", id: "bob" },
  );
  assert.equal(added.revision, 3);
  assert.equal(added.subjects[0]?.id, "bob");
  assert.equal((await resolver.visibleForUser("bob", [scopeId("personal", "bob")]))[0]?.skill?.id, skill.id);
  const removed = await repository.removeAccessSubject(
    skill.id,
    { principalId: "alice", isAdmin: false },
    { kind: "user", id: "bob" },
  );
  assert.equal(removed.revision, 4);
  assert.deepEqual(removed.subjects, []);
  assert.deepEqual(await resolver.visibleForUser("bob", [scopeId("personal", "bob")]), []);
});

test("move cannot widen home access implicitly and promotion carries an explicit policy", async () => {
  const { repository, skill } = await fixture();
  await assert.rejects(repository.move(skill.id, scopeId("channel", "shared"), "alice"), /explicit Skill Access mode/);
  await repository.setAccess(
    skill.id,
    { principalId: "alice", isAdmin: false },
    { mode: "restricted", subjects: [{ kind: "user", id: "bob" }], expectedRevision: 1 },
  );
  const moved = await repository.move(skill.id, scopeId("channel", "shared"), "alice");
  const movedAccess = await repository.getAccess(moved.id, { principalId: "alice", isAdmin: false });
  assert.equal(movedAccess.mode, "restricted");
  assert.equal(movedAccess.subjects[0]?.id, "bob");

  const fresh = await repository.create({
    scopeId: scopeId("personal", "alice"),
    createdBy: "alice",
    manifest: { name: "promoted", description: "Promoted", requiredCapabilities: [], body: "Promote it" },
  });
  await repository.review(fresh.id, "alice", []);
  await repository.publish(fresh.id, "alice");
  const promoted = await repository.promote(fresh.id, scopeId("org", ORG), "alice");
  const promotedAccess = await repository.getAccess(promoted.id, { principalId: "alice", isAdmin: true });
  assert.equal(promotedAccess.mode, "organization");
  assert.deepEqual(promotedAccess.subjects, []);
});

test("authorization revision invalidates a turn snapshot", async () => {
  const { store, resolver } = await fixture();
  const snapshot = await resolver.snapshot({
    audienceIds: ["alice"],
    orderedScopes: [scopeId("personal", "alice")],
  });
  await store.transact(ORG, async (tx) => {
    await tx.bumpRevision(ORG);
  });
  await assert.rejects(resolver.assertCurrent(snapshot), /expired/);
});

test("recording Skill use does not invalidate an authorization snapshot", async () => {
  const { store, repository, skill } = await fixture();
  const revision = await store.getAuthzRevision(ORG);
  await repository.recordUse(skill.id, 123);
  const current = await repository.get(skill.id);
  assert.equal(current?.lastUsedAt, 123);
  assert.equal(current?.version, skill.version);
  assert.equal(await store.getAuthzRevision(ORG), revision);
});

test("project membership version and authoritative audience invalidate a turn snapshot", async () => {
  const { resolver } = await fixture();
  const snapshot = await resolver.snapshot({
    audienceIds: ["alice"],
    orderedScopes: [scopeId("group", "project")],
    membershipVersion: "1",
  });
  await resolver.assertCurrent(snapshot, { audienceIds: ["alice"], membershipVersion: "1" });
  await assert.rejects(
    resolver.assertCurrent(snapshot, { audienceIds: ["alice", "bob"], membershipVersion: "2" }),
    /expired/,
  );
});

test("move rechecks the active Skill manager inside the transaction", async () => {
  const { repository, skill } = await fixture();
  await assert.rejects(repository.move(skill.id, scopeId("personal", "bob"), "bob"), /skill not found/);
  assert.equal((await repository.get(skill.id))?.scopeId, scopeId("personal", "alice"));
});

test("inactive creators and administrators immediately lose Skill management", async () => {
  const { store, repository, skill } = await fixture();
  await store.putUser({ ...user("alice"), status: "suspended", sessionVersion: 2, updatedAt: 2 });
  assert.equal(await repository.canManage(skill.id, { principalId: "alice", isAdmin: false }), false);
  assert.equal(await repository.canManage(skill.id, { principalId: "alice", isAdmin: true }), false);
});

test("an unauthorized narrower same-name Skill cannot shadow an authorized wider Skill", async () => {
  const { repository, resolver } = await fixture();
  const narrow = await repository.create({
    scopeId: scopeId("channel", "private"),
    createdBy: "alice",
    manifest: { name: "status", description: "Private", requiredCapabilities: [], body: "Private status" },
  });
  await repository.review(narrow.id, "alice", []);
  await repository.publish(narrow.id, "alice");
  const wider = await repository.create({
    scopeId: scopeId("org", ORG),
    createdBy: "alice",
    manifest: { name: "status", description: "Organization", requiredCapabilities: [], body: "Organization status" },
  });
  await repository.setAccess(
    wider.id,
    { principalId: "alice", isAdmin: true },
    { mode: "organization", subjects: [], expectedRevision: 1 },
  );
  await repository.review(wider.id, "alice", []);
  await repository.publish(wider.id, "alice");
  const resolutions = await resolver.visibleForUser("bob", [scopeId("channel", "private"), scopeId("org", ORG)]);
  const status = resolutions.find((resolution) => resolution.skill?.manifest.name === "status");
  assert.equal(status?.skill?.id, wider.id);
  assert.deepEqual(status?.shadowed, []);
});

test("an unknown audience member makes Skill resolution fail closed", async () => {
  const { repository, resolver, skill } = await fixture();
  await repository.setAccess(
    skill.id,
    { principalId: "alice", isAdmin: true },
    { mode: "organization", subjects: [], expectedRevision: 1 },
  );
  const snapshot = await resolver.snapshot({
    audienceIds: ["bob", "external:guest"],
    orderedScopes: [scopeId("org", ORG)],
  });
  assert.deepEqual(snapshot.resolutions, []);
  assert.deepEqual(
    snapshot.audience.map((member) => member.principalId),
    ["bob"],
  );
});
