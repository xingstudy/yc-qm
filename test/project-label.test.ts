import assert from "node:assert/strict";
import { test } from "node:test";
import {
  projectDisplayName,
  projectIdFromScope,
  projectOptionName,
  projectScopeName,
} from "../plugins/chassis/src/project-label.js";
import { discoverScopes } from "../src/api/routes/admin/common.ts";
import type { App } from "../src/api/app.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createProjectStore, type Project } from "../src/projects/project-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { orgId } from "../src/config.ts";

test("Project labels distinguish names, ID snapshots and non-project scopes", () => {
  const id = "12345678-1234-abcd";
  assert.equal(projectScopeName(`group:web-project-${id}`, "  Launch  "), "Launch");
  for (const name of [undefined, "", id, `web-project-${id}`, `group:web-project-${id}`])
    assert.equal(projectDisplayName(id, name), "Unknown Project · 12345678");
  for (const scope of ["group:other", "personal:alice", "group:web-project-", "group:web-project-p:thread"])
    assert.equal(projectIdFromScope(scope), null);
  assert.equal(projectScopeName("channel:eng", "Engineering"), null);
});

test("admin scope directory includes unused Projects, refreshes stale names and propagates failures", async () => {
  const calls: string[] = [];
  const app = {
    directoryMembers: async () => [],
    directoryChannels: async () => [],
  } as unknown as App;
  const deps = {
    sessions: {
      distinctScopes: async () => [{ scopeId: "group:web-project-used", channelName: "used" }],
      distinctParticipants: async () => [],
    },
    projects: {
      directory: async (org: string) => {
        calls.push(org);
        return [
          { id: "used", name: "Renamed Project" },
          { id: "unused", name: "New Project" },
        ];
      },
    },
  } as unknown as ServerDeps;
  const scopes = await discoverScopes(app, deps, ["group:web-project-missing", "group:web-project-used"]);
  assert.deepEqual(calls, [orgId()]);
  assert.equal(scopes.get("group:web-project-used"), "Renamed Project");
  assert.equal(scopes.get("group:web-project-unused"), "New Project");
  assert.equal(scopes.get("group:web-project-missing"), "名称未知 Project · missing");
  deps.projects = {
    directory: async () => {
      throw new Error("directory unavailable");
    },
  };
  await assert.rejects(discoverScopes(app, deps), /directory unavailable/);
});

test("same-name Project choices prefer creators and only need IDs for missing or repeated creators", () => {
  const alice = { id: "aaaaaaaa-1", name: "devops", creatorId: "alice@example.com", creatorName: "Alice" };
  const bob = { id: "bbbbbbbb-2", name: "devops", creatorId: "bob@example.com", creatorName: "Bob" };
  assert.equal(projectOptionName(alice, [alice]), "devops");
  assert.equal(projectOptionName(alice, [alice, bob]), "devops · Alice");
  assert.equal(projectOptionName(bob, [alice, bob]), "devops · Bob");
  const again = { ...alice, id: "cccccccc-3" };
  assert.equal(projectOptionName(alice, [alice, again]), "devops · Alice · aaaaaaaa");
  const sameDisplayName = { ...bob, creatorName: "Alice" };
  assert.equal(projectOptionName(alice, [alice, sameDisplayName]), "devops · alice@example.com");
  assert.equal(projectOptionName(sameDisplayName, [alice, sameDisplayName]), "devops · bob@example.com");
  const noCreator = { id: "dddddddd-4", name: "devops" };
  assert.equal(projectOptionName(noCreator, [alice, noCreator]), "devops · dddddddd");
});

test("admin Project labels resolve creators from the directory without changing scope identities", async () => {
  const app = {
    directoryMembers: async () => [
      { principalId: "alice", displayName: "Alice" },
      { principalId: "bob", displayName: "Bob" },
    ],
    directoryChannels: async () => [],
  } as unknown as App;
  const deps = {
    projects: {
      directory: async () => [
        { id: "p1", name: "devops", creatorId: "alice" },
        { id: "p2", name: "devops", creatorId: "bob" },
      ],
    },
  } as unknown as ServerDeps;
  const scopes = await discoverScopes(app, deps);
  assert.equal(scopes.get("group:web-project-p1"), "devops · Alice");
  assert.equal(scopes.get("group:web-project-p2"), "devops · Bob");
});

test("Project directory only exposes the requested organization and does not grant membership", async () => {
  const backing = createMemoryMap<Project>();
  const store = createProjectStore(backing, { id: () => "local" });
  const local = await store.create({ name: "Local Project", ownerId: "owner" });
  await backing.put("foreign", { ...local, id: "foreign", orgId: "another-org", name: "Private foreign Project" });
  assert.deepEqual(await store.directory(local.orgId), [{ id: "local", name: "Local Project", creatorId: "owner" }]);
  assert.deepEqual(await store.directory("another-org"), [
    { id: "foreign", name: "Private foreign Project", creatorId: "owner" },
  ]);
  assert.deepEqual(await store.listForMember("outsider"), []);
  assert.equal(await store.membership("web-project-local", "outsider"), false);
  await store.rename("local", "owner", "Current Project");
  assert.equal((await store.directory(local.orgId))[0]?.name, "Current Project");
});
