import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryOrganizationStore, type OrgUnitKind } from "../src/organization/organization-store.ts";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { organizationGovernanceAncestors } from "../src/resolution/governance-scopes.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { evaluateCommand, evaluateCommandWithLayer } from "../src/policy/command-policy.ts";
import { resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { egressDecision } from "../src/resolution/egress-policy.ts";
import { DEFAULT_AGENT_MODEL_ID } from "../src/model/pi-models.ts";
import type { Conversation, Principal } from "../src/types.ts";

const ORG = "governance-test";
const actor: Principal = { id: "alice", type: "internal" };
const dm: Conversation = { kind: "dm", threadRef: "dm:alice", audience: [actor] };

async function fixture() {
  const store = createMemoryOrganizationStore();
  await store.ensureOrgRoot({ orgId: ORG, name: "Test", actor: "admin", now: 1 });
  const unit = async (id: string, parentId: string, kind: OrgUnitKind) => {
    await store.putUnit({
      orgId: ORG,
      id,
      parentId,
      name: id,
      kind,
      status: "active",
      sortOrder: 0,
      createdAt: 1,
      updatedAt: 1,
      createdBy: "admin",
      updatedBy: "admin",
    });
  };
  await unit("department", "root", "department");
  await unit("team", "department", "team");
  await unit("other", "root", "department");
  await store.putUser({
    orgId: ORG,
    principalId: actor.id,
    email: null,
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
    createdBy: "admin",
    updatedBy: "admin",
  });
  await store.putUnitMember({
    orgId: ORG,
    unitId: "team",
    principalId: actor.id,
    role: "member",
    createdAt: 1,
    createdBy: "admin",
  });
  for (const id of ["a", "b"]) {
    await store.putGroup({
      orgId: ORG,
      id,
      name: id,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      createdBy: "admin",
      updatedBy: "admin",
    });
    await store.putGroupMember({
      orgId: ORG,
      groupId: id,
      principalId: actor.id,
      role: "member",
      createdAt: 1,
      createdBy: "admin",
    });
  }
  const opts = {
    governanceAncestors: (scope: string) => organizationGovernanceAncestors(store, ORG, scope),
    souls: createMemoryMap<import("../src/resolution/config-store.ts").PersistedSoul>(),
    commandPolicies: createMemoryMap<import("../src/resolution/config-store.ts").PersistedCommandPolicy>(),
    securityPostures: createMemoryMap<import("../src/resolution/config-store.ts").PersistedSecurityPosture>(),
    approvalGrantModes: createMemoryMap<import("../src/resolution/config-store.ts").PersistedApprovalGrantModes>(),
    egressPolicies: createMemoryMap<import("../src/resolution/config-store.ts").PersistedEgressPolicy>(),
    baseModels: createMemoryMap<import("../src/resolution/config-store.ts").PersistedBaseModel>(),
    approvedHarnesses: createMemoryMap<import("../src/resolution/config-store.ts").PersistedApprovedHarnesses>(),
    interactiveFastMode: createMemoryMap<import("../src/resolution/config-store.ts").PersistedScopedFlag>(),
    webuiModels: createMemoryMap<import("../src/resolution/config-store.ts").PersistedWebuiModels>(),
    browseModels: createMemoryMap<import("../src/resolution/config-store.ts").PersistedBrowseModel>(),
    browseMaxSteps: createMemoryMap<import("../src/resolution/config-store.ts").PersistedBrowseMaxSteps>(),
    turnWallClocks: createMemoryMap<import("../src/resolution/config-store.ts").PersistedTurnWallClock>(),
  };
  const writer = createMemoryConfigStore(ORG, opts);
  const reader = createMemoryConfigStore(ORG, opts);
  const resolution = createResolutionService(ORG, reader, createAclStore());
  return { store, writer, reader, resolution };
}

test("governance follows active ancestor units and all access groups without caching membership", async () => {
  const { store, reader } = await fixture();
  assert.deepEqual(await reader.governanceScopes("personal:alice"), [
    `org:${ORG}`,
    "org-unit:root",
    "org-unit:department",
    "org-unit:team",
    "access-group:a",
    "access-group:b",
    "personal:alice",
  ]);
  assert.deepEqual(await reader.governanceScopes("org-unit:team"), [
    `org:${ORG}`,
    "org-unit:root",
    "org-unit:department",
    "org-unit:team",
  ]);
  const team = (await store.getUnit(ORG, "team"))!;
  await store.putUnit({ ...team, parentId: "other" });
  const moved = await reader.governanceScopes("personal:alice");
  assert.ok(moved.includes("org-unit:other"));
  assert.ok(!moved.includes("org-unit:department"));
  await store.removeGroupMember(ORG, "a", actor.id);
  await store.putGroup({ ...(await store.getGroup(ORG, "b"))!, status: "archived" });
  assert.ok(!(await reader.governanceScopes("personal:alice")).some((scope) => scope.startsWith("access-group:")));
  await store.putUser({ ...(await store.getUser(ORG, actor.id))!, status: "suspended" });
  assert.deepEqual(await reader.governanceScopes("personal:alice"), [`org:${ORG}`, "personal:alice"]);
  assert.deepEqual(await organizationGovernanceAncestors(store, "other-tenant", "personal:alice"), []);
});

test("member turns receive durable group posture, approvals, commands, instructions and egress", async () => {
  const { writer, reader, resolution, store } = await fixture();
  await writer.setSecurityPosture("org-unit:department", "strict");
  await writer.setApprovalGrantModes("access-group:a", { session: false, always: true });
  await writer.setApprovalGrantModes("org-unit:team", { session: true, always: false });
  writer.setCommandPolicy(`org:${ORG}`, { mode: "denylist", rules: [{ pattern: "deploy", decision: "allow" }] });
  writer.setCommandPolicy("access-group:a", { mode: "denylist", rules: [{ pattern: "deploy", decision: "allow" }] });
  writer.setCommandPolicy("access-group:b", { mode: "denylist", rules: [{ pattern: "deploy", decision: "deny" }] });
  writer.setSoul("org-unit:department", "Use the department release checklist.");
  writer.setSoul("access-group:a", "Include the group ticket number.");
  writer.setEgress("org-unit:department", { allowedHosts: ["example.com"], deniedHosts: ["blocked.example.com"] });
  await Promise.all(
    [`org:${ORG}`, "access-group:a", "access-group:b", "org-unit:department"].map((id) => writer.flushScope(id)),
  );
  const result = await resolution.resolve(dm, actor);
  assert.equal(result.securityPolicy.toolApprovals, "all");
  assert.deepEqual(result.approvalGrantModes, { session: false, always: false });
  assert.equal(evaluateCommand("deploy service", result.commandPolicy).decision, "deny");
  assert.equal(
    evaluateCommandWithLayer("deploy service", result.commandPolicy, [{ pattern: "deploy", decision: "allow" }])
      .decision,
    "deny",
  );
  assert.match(result.systemPrompt, /department release checklist/);
  assert.match(result.systemPrompt, /group ticket number/);
  assert.equal(egressDecision("example.com", result.egress).allow, true);
  assert.equal(egressDecision("blocked.example.com", result.egress).allow, false);
  assert.equal(egressDecision("outside.test", result.egress).allow, false);
  const channel: Conversation = {
    kind: "channel",
    channelRef: "C1",
    threadRef: "C1:1",
    audience: [actor, { id: "bob", type: "internal" }],
  };
  const shared = await resolution.resolve(channel, actor);
  assert.equal(shared.securityPolicy.toolApprovals, "all");
  assert.equal(evaluateCommand("deploy service", shared.commandPolicy).decision, "deny");
  assert.doesNotMatch(shared.systemPrompt, /department release checklist|group ticket number/);
  assert.equal(await reader.getSecurityPostureDurable("channel:C1", [actor.id]), "strict");
  await store.removeGroupMember(ORG, "b", actor.id);
  await store.removeUnitMember(ORG, "team", actor.id);
  const removed = await resolution.resolve(dm, actor);
  assert.equal(removed.securityPolicy.toolApprovals, "none");
  assert.deepEqual(removed.approvalGrantModes, { session: false, always: true });
  assert.equal(evaluateCommand("deploy service", removed.commandPolicy).decision, "allow");
  assert.doesNotMatch(removed.systemPrompt, /department release checklist/);
});

test("independent group allowlists and approvals cannot weaken one another", async () => {
  const { writer, resolution } = await fixture();
  writer.setCommandPolicy("access-group:a", {
    mode: "allowlist",
    rules: [{ pattern: "^git (status|push)$", decision: "allow" }],
  });
  writer.setCommandPolicy("access-group:b", {
    mode: "allowlist",
    rules: [
      { pattern: "^git push$", decision: "require_approval" },
      { pattern: "^git diff$", decision: "allow" },
    ],
  });
  await Promise.all(["access-group:a", "access-group:b"].map((id) => writer.flushScope(id)));
  const { commandPolicy } = await resolution.resolve(dm, actor);
  assert.equal(evaluateCommand("git status", commandPolicy).decision, "deny");
  assert.equal(evaluateCommand("git diff", commandPolicy).decision, "deny");
  assert.equal(evaluateCommand("git push", commandPolicy).decision, "require_approval");
  assert.equal(evaluateCommandWithLayer("git status", commandPolicy, []).decision, "deny");
});

test("runtime defaults follow membership, deeper units and explicit scope overrides across instances", async () => {
  const { writer, reader, store } = await fixture();
  const runtime = { harnessId: "pi", modelId: "claude-sonnet-4-6" };
  for (const scope of [
    `org:${ORG}`,
    "org-unit:department",
    "org-unit:team",
    "access-group:a",
    "access-group:b",
    "personal:alice",
  ])
    await writer.setRuntimeSelectionLatest(scope, runtime);
  assert.equal(await reader.getRuntimeConfigScopeDurable("personal:alice"), "personal:alice");
  await writer.setRuntimeSelectionLatest("personal:alice", null);
  assert.equal(await reader.getRuntimeConfigScopeDurable("personal:alice"), "access-group:b");
  assert.equal(await reader.getRuntimeConfigScopeDurable("channel:C1", actor.id), "access-group:b");
  await store.removeGroupMember(ORG, "b", actor.id);
  assert.equal(await reader.getRuntimeConfigScopeDurable("personal:alice"), "access-group:a");
  await store.removeGroupMember(ORG, "a", actor.id);
  assert.equal(await reader.getRuntimeConfigScopeDurable("personal:alice"), "org-unit:team");
  await writer.setRuntimeSelectionLatest("org-unit:team", null);
  assert.equal(await reader.getRuntimeConfigScopeDurable("personal:alice"), "org-unit:department");
  assert.deepEqual(
    await resolveRuntimeChoiceDurable(reader, `org:${ORG}`, "personal:alice", {
      harnessId: "pi",
      modelId: DEFAULT_AGENT_MODEL_ID,
    }),
    runtime,
  );
  await store.removeUnitMember(ORG, "team", actor.id);
  assert.equal(await reader.getRuntimeConfigScopeDurable("personal:alice"), `org:${ORG}`);
});

test("a warm instance sees group edits and clearing organization rules on the next resolution", async () => {
  const { writer, resolution } = await fixture();
  writer.setCommandPolicy(`org:${ORG}`, { mode: "denylist", rules: [{ pattern: "echo", decision: "deny" }] });
  writer.setCommandPolicy("access-group:a", { mode: "denylist", rules: [{ pattern: "deploy", decision: "deny" }] });
  await Promise.all([`org:${ORG}`, "access-group:a"].map((id) => writer.flushScope(id)));
  let result = await resolution.resolve(dm, actor);
  assert.equal(evaluateCommand("echo ok", result.commandPolicy).decision, "deny");
  assert.equal(evaluateCommand("deploy", result.commandPolicy).decision, "deny");
  writer.clearCommandPolicy(`org:${ORG}`);
  writer.clearCommandPolicy("access-group:a");
  await Promise.all([`org:${ORG}`, "access-group:a"].map((id) => writer.flushScope(id)));
  result = await resolution.resolve(dm, actor);
  assert.equal(evaluateCommand("echo ok", result.commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("deploy", result.commandPolicy).decision, "allow");
  assert.equal(evaluateCommand("rm -rf /tmp/example", result.commandPolicy).decision, "require_approval");
});

test("membership lookup failures reject resolution instead of silently dropping restrictions", async () => {
  const config = createMemoryConfigStore(ORG, {
    governanceAncestors: async () => {
      throw new Error("directory unavailable");
    },
  });
  const resolution = createResolutionService(ORG, config, createAclStore());
  await assert.rejects(resolution.resolve(dm, actor), /directory unavailable/);
  await assert.rejects(config.getSecurityPostureDurable("personal:alice"), /directory unavailable/);
  await assert.rejects(config.getRuntimeConfigScopeDurable("personal:alice"), /directory unavailable/);
});

test("distinct runtime values cascade through every level and restore after clearing overrides", async () => {
  const { writer, reader, store } = await fixture();
  const layers = [
    [`org:${ORG}`, "claude-opus-4-8"],
    ["org-unit:root", "claude-sonnet-4-6"],
    ["org-unit:department", "claude-haiku-4-5"],
    ["org-unit:team", "claude-opus-4-8"],
    ["access-group:a", "claude-sonnet-4-6"],
    ["access-group:b", "claude-haiku-4-5"],
    ["personal:alice", "claude-opus-4-8"],
  ];
  const fallback = { harnessId: "pi" as const, modelId: DEFAULT_AGENT_MODEL_ID };
  for (const [scope, modelId] of layers) {
    await writer.setRuntimeSelectionLatest(scope!, { harnessId: "pi", modelId: modelId! });
    assert.equal(await reader.getRuntimeConfigScopeDurable("personal:alice"), scope);
    assert.deepEqual(await resolveRuntimeChoiceDurable(reader, `org:${ORG}`, "personal:alice", fallback), {
      harnessId: "pi",
      modelId,
    });
    assert.equal(await reader.getRuntimeConfigScopeDurable("personal:outsider"), `org:${ORG}`);
  }
  for (let i = layers.length - 1; i > 0; i--) {
    await writer.setRuntimeSelectionLatest(layers[i]![0]!, null);
    assert.equal(await reader.getRuntimeConfigScopeDurable("personal:alice"), layers[i - 1]![0]);
    assert.equal(
      (await resolveRuntimeChoiceDurable(reader, `org:${ORG}`, "personal:alice", fallback)).modelId,
      layers[i - 1]![1],
    );
  }
  await store.removeUnitMember(ORG, "team", actor.id);
  assert.equal(await reader.getRuntimeConfigScopeDurable("personal:alice"), `org:${ORG}`);
});

test("ancestor ordering is independent of insertion order and recursive depth is not limited", async () => {
  const { store, reader } = await fixture();
  let parentId = "team";
  for (let i = 0; i < 32; i++) {
    const id = `nested-${String(31 - i).padStart(2, "0")}`;
    await store.putUnit({ ...(await store.getUnit(ORG, "team"))!, id, parentId });
    parentId = id;
  }
  await store.putUnitMember({
    orgId: ORG,
    unitId: parentId,
    principalId: actor.id,
    role: "member",
    createdAt: 1,
    createdBy: "admin",
  });
  const scopes = await reader.governanceScopes("personal:alice");
  assert.equal(scopes.filter((id) => id.startsWith("org-unit:")).length, 35);
  assert.ok(scopes.indexOf("org-unit:nested-31") < scopes.indexOf("org-unit:nested-00"));
  assert.equal(new Set(scopes).size, scopes.length);
});

test("a restrictive ancestor cannot be weakened by descendant or personal settings", async () => {
  const { writer, resolution } = await fixture();
  await writer.setSecurityPosture("org-unit:root", "strict");
  await writer.setSecurityPosture("org-unit:department", "dangerous");
  await writer.setSecurityPosture("personal:alice", "dangerous");
  await writer.setApprovalGrantModes("org-unit:root", { session: false, always: false });
  await writer.setApprovalGrantModes("personal:alice", { session: true, always: true });
  writer.setCommandPolicy("org-unit:root", { mode: "denylist", rules: [{ pattern: "deploy", decision: "deny" }] });
  writer.setCommandPolicy("org-unit:team", { mode: "denylist", rules: [{ pattern: "deploy", decision: "allow" }] });
  writer.setCommandPolicy("personal:alice", { mode: "denylist", rules: [{ pattern: "deploy", decision: "allow" }] });
  writer.setEgress("org-unit:root", { allowedHosts: [], deniedHosts: ["blocked.example.com"] });
  writer.setEgress("personal:alice", { allowedHosts: ["blocked.example.com"], deniedHosts: [] });
  await Promise.all(["org-unit:root", "org-unit:team", "personal:alice"].map((id) => writer.flushScope(id)));
  const resolved = await resolution.resolve(dm, actor);
  assert.equal(resolved.securityPolicy.toolApprovals, "all");
  assert.deepEqual(resolved.approvalGrantModes, { session: false, always: false });
  assert.equal(evaluateCommand("deploy", resolved.commandPolicy).decision, "deny");
  assert.equal(egressDecision("blocked.example.com", resolved.egress).allow, false);
});

test("model and browsing settings inherit durably while restrictions intersect and tighter limits win", async () => {
  const { writer, reader, store } = await fixture();
  const org = `org:${ORG}`;
  const personal = "personal:alice";
  writer.setApprovedHarnesses(["pi", "codex"], org);
  writer.setApprovedHarnesses(["pi"], "org-unit:department");
  writer.setInteractiveFastMode(true, "org-unit:department");
  writer.setInteractiveFastMode(false, "access-group:a");
  writer.setWebuiModels(org, ["claude-sonnet-4-6", "claude-opus-4-8"]);
  writer.setWebuiModels("access-group:a", ["claude-sonnet-4-6"]);
  writer.setBrowseModel("org-unit:department", "claude-sonnet-4-6");
  writer.setBrowseMaxSteps(org, 50);
  writer.setBrowseMaxSteps("org-unit:department", 20);
  writer.setBrowseMaxSteps(personal, 100);
  await writer.setTurnWallClockSec(org, 600);
  await writer.setTurnWallClockSec("access-group:a", 120);
  await writer.setTurnWallClockSec(personal, 0);
  await Promise.all([org, "org-unit:department", "access-group:a", personal].map((id) => writer.flushScope(id)));
  assert.deepEqual(await reader.getApprovedHarnessesDurable(personal), ["pi"]);
  assert.deepEqual(await reader.getWebuiModelsDurable(personal), ["claude-sonnet-4-6"]);
  assert.equal(await reader.getInteractiveFastModeDurable(personal), false);
  assert.equal(await reader.getBrowseModelDurable(personal), "claude-sonnet-4-6");
  assert.equal(await reader.getBrowseMaxStepsDurable(personal), 20);
  assert.equal(await reader.getTurnWallClockSecDurable(personal), 120);
  writer.setInteractiveFastMode(true, personal);
  await writer.flushScope(personal);
  assert.equal(await reader.getInteractiveFastModeDurable(personal), true);
  writer.setInteractiveFastMode(null, personal);
  await writer.flushScope(personal);
  assert.equal(await reader.getInteractiveFastModeDurable(personal), false);
  await store.removeGroupMember(ORG, "a", actor.id);
  assert.equal(await reader.getInteractiveFastModeDurable(personal), true);
  assert.equal(await reader.getTurnWallClockSecDurable(personal), 600);
  assert.deepEqual(await reader.getWebuiModelsDurable(personal), ["claude-sonnet-4-6", "claude-opus-4-8"]);
  assert.equal(await reader.getBrowseMaxStepsDurable("channel:C1", actor.id), 20);
  assert.equal(await reader.getBrowseMaxStepsDurable("personal:outsider"), 50);
});

test("empty allowed intersections block runtimes and personal choices cannot bypass group restrictions", async () => {
  const { writer, reader } = await fixture();
  const org = `org:${ORG}`;
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };
  await writer.setRuntimeSelectionLatest(org, fallback);
  writer.setApprovedHarnesses(["pi", "codex"], org);
  writer.setWebuiModels("access-group:a", ["claude-sonnet-4-6"]);
  await Promise.all([org, "access-group:a"].map((id) => writer.flushScope(id)));
  assert.equal(
    (await resolveRuntimeChoiceDurable(reader, org, "personal:alice", fallback)).modelId,
    "claude-sonnet-4-6",
  );
  await assert.rejects(resolveRuntimeChoiceDurable(reader, org, "personal:alice", fallback, fallback), /not allowed/);
  writer.setWebuiModels("access-group:b", ["claude-haiku-4-5"]);
  await writer.flushScope("access-group:b");
  assert.deepEqual(await reader.getWebuiModelsDurable("personal:alice"), []);
  await assert.rejects(resolveRuntimeChoiceDurable(reader, org, "personal:alice", fallback), /no model/);
  writer.setWebuiModels("access-group:b", null);
  writer.setApprovedHarnesses(["pi"], "access-group:a");
  writer.setApprovedHarnesses(["codex"], "access-group:b");
  await Promise.all(["access-group:a", "access-group:b"].map((id) => writer.flushScope(id)));
  assert.deepEqual(await reader.getApprovedHarnessesDurable("personal:alice"), []);
  await assert.rejects(resolveRuntimeChoiceDurable(reader, org, "personal:alice", fallback), /no harness/);
});

test("private network grants refresh across instances, intersect audiences, and disappear after membership revocation", async () => {
  const { writer, reader, resolution, store } = await fixture();
  writer.setEgress(`org:${ORG}`, { allowedHosts: [], privateNetworkAllowedHosts: ["shared.internal"] });
  writer.setEgress("org-unit:department", { allowedHosts: [], privateNetworkAllowedHosts: ["10.1.37.0/24"] });
  writer.setEgress("access-group:a", { allowedHosts: [], privateNetworkAllowedHosts: ["kibana.example.com"] });
  await Promise.all([`org:${ORG}`, "org-unit:department", "access-group:a"].map((id) => writer.flushScope(id)));
  assert.equal(reader.getEgress("org-unit:department"), null);
  assert.deepEqual((await resolution.resolve(dm, actor)).egress.privateNetworkAllowedHosts, [
    "shared.internal",
    "10.1.37.0/24",
    "kibana.example.com",
  ]);
  const shared: Conversation = {
    kind: "channel",
    channelRef: "private-qa",
    threadRef: "private-qa:1",
    audience: [actor, { id: "bob", type: "internal" }],
  };
  assert.deepEqual((await resolution.resolve(shared, actor)).egress.privateNetworkAllowedHosts, ["shared.internal"]);
  await store.removeGroupMember(ORG, "a", actor.id);
  assert.deepEqual((await resolution.resolve(dm, actor)).egress.privateNetworkAllowedHosts, [
    "shared.internal",
    "10.1.37.0/24",
  ]);
  writer.setEgress("org-unit:department", { allowedHosts: [], privateNetworkAllowedHosts: [] });
  await writer.flushScope("org-unit:department");
  assert.deepEqual((await resolution.resolve(dm, actor)).egress.privateNetworkAllowedHosts, ["shared.internal"]);
});
