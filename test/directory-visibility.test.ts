import assert from "node:assert/strict";
import test from "node:test";
import { createDirectoryVisibilityResolver } from "../src/authorization/directory-visibility.ts";
import {
  createMemoryOrganizationStore,
  type DirectorySubjectKind,
  type OrganizationStore,
  type OrganizationUser,
  type OrgUnit,
} from "../src/organization/organization-store.ts";

const ORG = "acme";
const NOW = 1_700_000_000_000;

function user(principalId: string, displayName = principalId): OrganizationUser {
  return {
    orgId: ORG,
    principalId,
    email: `${principalId.toLowerCase()}@example.com`,
    displayName,
    jobTitle: null,
    mobile: null,
    employeeNumber: null,
    status: "active",
    sessionVersion: 1,
    profileRevision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastLoginAt: NOW,
    createdBy: "test",
    updatedBy: "test",
  };
}

function unit(id: string, parentId: string | null): OrgUnit {
  return {
    orgId: ORG,
    id,
    parentId,
    name: id,
    kind: parentId === null ? "organization" : "department",
    status: "active",
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "test",
    updatedBy: "test",
  };
}

async function seed(): Promise<OrganizationStore> {
  const store = createMemoryOrganizationStore();
  await store.ensureOrgRoot({ orgId: ORG, name: "Acme", actor: "test", now: NOW });
  for (const target of [unit("engineering", "root"), unit("platform", "engineering"), unit("finance", "root")]) {
    await store.putUnit(target);
  }
  for (const account of [
    user("viewer", "Viewer"),
    user("alice", "Alice"),
    user("bob", "Bob"),
    user("carol", "Carol"),
  ]) {
    await store.putUser(account);
  }
  await store.putUnitMember({
    orgId: ORG,
    unitId: "platform",
    principalId: "alice",
    role: "member",
    createdAt: NOW,
    createdBy: "test",
  });
  await store.putUnitMember({
    orgId: ORG,
    unitId: "engineering",
    principalId: "bob",
    role: "member",
    createdAt: NOW,
    createdBy: "test",
  });
  await store.putUnitMember({
    orgId: ORG,
    unitId: "finance",
    principalId: "carol",
    role: "member",
    createdAt: NOW,
    createdBy: "test",
  });
  return store;
}

async function policy(
  store: OrganizationStore,
  subjectKind: DirectorySubjectKind,
  subjectId: string,
  mode: "all" | "limited" | "none",
  roots: Array<{ unitId: string; includeDescendants: boolean }> = [],
): Promise<void> {
  await store.transact(ORG, async (tx) => {
    const id = `policy-${subjectKind}-${subjectId}`;
    await tx.putDirectoryPolicy({
      id,
      orgId: ORG,
      subjectKind,
      subjectId,
      mode,
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      updatedBy: "test",
    });
    await tx.replaceDirectoryRoots(
      ORG,
      id,
      roots.map((root) => ({ orgId: ORG, policyId: id, ...root })),
    );
    await tx.bumpRevision(ORG);
  });
}

test("directory defaults to all active users and an administrator always sees all", async () => {
  const store = await seed();
  const resolver = createDirectoryVisibilityResolver({ store, orgId: ORG });
  assert.equal((await resolver.resolve({ principalId: "viewer", isAdmin: false }))?.mode, "all");
  await policy(store, "user", "viewer", "none");
  assert.deepEqual(
    await resolver.searchUsers({ principalId: "viewer", isAdmin: false }, { query: "", after: null, limit: 20 }),
    {
      users: [],
      next: null,
    },
  );
  assert.deepEqual(
    (
      await resolver.searchUsers({ principalId: "viewer", isAdmin: true }, { query: "", after: null, limit: 20 })
    )?.users.map((account) => account.principalId),
    ["alice", "bob", "carol", "viewer"],
  );
});

test("limited roots merge, honor descendant flags, remove overlap, and filter search before pagination", async () => {
  const store = await seed();
  await policy(store, "user", "viewer", "limited", [
    { unitId: "engineering", includeDescendants: true },
    { unitId: "platform", includeDescendants: false },
    { unitId: "finance", includeDescendants: false },
  ]);
  const resolver = createDirectoryVisibilityResolver({ store, orgId: ORG });
  const visibility = await resolver.resolve({ principalId: "viewer", isAdmin: false });
  assert.deepEqual(
    visibility?.roots.map((root) => [root.unitId, root.includeDescendants]),
    [
      ["engineering", true],
      ["finance", false],
    ],
  );
  assert.deepEqual(
    (
      await resolver.searchUsers({ principalId: "viewer", isAdmin: false }, { query: "", after: null, limit: 2 })
    )?.users.map((account) => account.principalId),
    ["alice", "bob"],
  );
  const first = await resolver.searchUsers(
    { principalId: "viewer", isAdmin: false },
    { query: "", after: null, limit: 2 },
  );
  assert.deepEqual(
    (
      await resolver.searchUsers(
        { principalId: "viewer", isAdmin: false },
        { query: "", after: first?.next ?? null, limit: 2 },
      )
    )?.users.map((account) => account.principalId),
    ["carol"],
  );
  assert.deepEqual(
    (
      await resolver.searchUsers(
        { principalId: "viewer", isAdmin: false },
        { query: "", excludePrincipalIds: ["alice", "bob"], after: null, limit: 1 },
      )
    )?.users.map((account) => account.principalId),
    ["carol"],
  );
});

test("a current-node root excludes descendants", async () => {
  const store = await seed();
  await policy(store, "user", "viewer", "limited", [{ unitId: "engineering", includeDescendants: false }]);
  const resolver = createDirectoryVisibilityResolver({ store, orgId: ORG });
  assert.deepEqual(
    (
      await resolver.searchUsers({ principalId: "viewer", isAdmin: false }, { query: "", after: null, limit: 20 })
    )?.users.map((account) => account.principalId),
    ["bob"],
  );
});

test("recipient resolution never returns users outside the actor's directory view", async () => {
  const store = await seed();
  await policy(store, "user", "viewer", "limited", [{ unitId: "engineering", includeDescendants: true }]);
  const resolver = createDirectoryVisibilityResolver({ store, orgId: ORG });
  assert.equal((await resolver.resolveUser({ principalId: "viewer", isAdmin: false }, "Alice"))?.kind, "one");
  assert.deepEqual(await resolver.resolveUser({ principalId: "viewer", isAdmin: false }, "Carol"), { kind: "none" });
});

test("personal policy overrides inherited unit and group policies", async () => {
  const store = await seed();
  await store.putUnitMember({
    orgId: ORG,
    unitId: "platform",
    principalId: "viewer",
    role: "member",
    createdAt: NOW,
    createdBy: "test",
  });
  await store.putGroup({
    orgId: ORG,
    id: "sensitive",
    name: "Sensitive",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "test",
    updatedBy: "test",
  });
  await store.putGroupMember({
    orgId: ORG,
    groupId: "sensitive",
    principalId: "viewer",
    role: "member",
    createdAt: NOW,
    createdBy: "test",
  });
  await policy(store, "org_unit", "engineering", "limited", [{ unitId: "engineering", includeDescendants: true }]);
  await policy(store, "access_group", "sensitive", "all");
  await policy(store, "user", "viewer", "none");
  const resolver = createDirectoryVisibilityResolver({ store, orgId: ORG });
  assert.equal((await resolver.resolve({ principalId: "viewer", isAdmin: false }))?.mode, "none");
});

test("group visibility requires every active member to be visible", async () => {
  const store = await seed();
  await store.putGroup({
    orgId: ORG,
    id: "mixed",
    name: "Mixed",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "test",
    updatedBy: "test",
  });
  for (const principalId of ["alice", "carol"]) {
    await store.putGroupMember({
      orgId: ORG,
      groupId: "mixed",
      principalId,
      role: "member",
      createdAt: NOW,
      createdBy: "test",
    });
  }
  await policy(store, "user", "viewer", "limited", [{ unitId: "engineering", includeDescendants: true }]);
  const resolver = createDirectoryVisibilityResolver({ store, orgId: ORG });
  assert.deepEqual(await resolver.visibleGroups({ principalId: "viewer", isAdmin: false }), []);
  assert.equal(await resolver.groupMembers({ principalId: "viewer", isAdmin: false }, "mixed"), null);
});

test("none visibility does not expose empty groups or groups with only inactive members", async () => {
  const store = await seed();
  await store.putGroup({
    orgId: ORG,
    id: "empty",
    name: "Empty",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "test",
    updatedBy: "test",
  });
  await store.putUser(user("inactive"));
  await store.putGroup({
    orgId: ORG,
    id: "inactive-only",
    name: "Inactive only",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: "test",
    updatedBy: "test",
  });
  await store.putGroupMember({
    orgId: ORG,
    groupId: "inactive-only",
    principalId: "inactive",
    role: "member",
    createdAt: NOW,
    createdBy: "test",
  });
  await store.putUser({ ...user("inactive"), status: "suspended", sessionVersion: 2, updatedAt: NOW + 1 });
  await policy(store, "user", "viewer", "none");
  const resolver = createDirectoryVisibilityResolver({ store, orgId: ORG });
  assert.deepEqual(await resolver.visibleGroups({ principalId: "viewer", isAdmin: false }), []);
  assert.equal(await resolver.visibleGroup({ principalId: "viewer", isAdmin: false }, "empty"), null);
  assert.equal(await resolver.visibleGroup({ principalId: "viewer", isAdmin: false }, "inactive-only"), null);
});
