import "./support/auto-fake-sprites.ts";

import test from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";

test("web turns deliver recursive runtime and instructions to the harness and revoke them after membership removal", async (t) => {
  const observed: HarnessTurnInput[] = [];
  t.mock.module("../src/harness/mock-harness.ts", {
    namedExports: {
      createMockHarness: () => {
        const harness = createMockHarness();
        const run = harness.turns.runTurn.bind(harness.turns);
        harness.turns.runTurn = async (input) => {
          observed.push(input);
          return run(input);
        };
        return harness;
      },
    },
  });
  const { buildApp } = await import("./support/test-app.ts");
  const built = buildApp(testConfig({ harness: "mock", seedSkills: false, anthropicApiKey: "mock-only-provider-key" }));
  await built.organizationStore.ensureOrgRoot({ orgId: "default-org", name: "Test", actor: "admin", now: 1 });
  await built.organization.invite({
    principalId: "alice",
    email: "alice@example.test",
    displayName: "Alice",
    actor: "admin",
  });
  await built.organization.setStatus({ principalId: "alice", status: "active", actor: "admin" });
  const unit = await built.organization.createUnit({
    parentId: "root",
    name: "Parent",
    kind: "department",
    actor: "admin",
  });
  const team = await built.organization.createUnit({ parentId: unit.id, name: "Child", kind: "team", actor: "admin" });
  const group = await built.organization.createGroup({ name: "Access", actor: "admin" });
  await built.organization.addUnitMember({ unitId: team.id, principalId: "alice", role: "member", actor: "admin" });
  await built.organization.addGroupMember({ groupId: group.id, principalId: "alice", role: "member", actor: "admin" });
  const groupScope = `access-group:${group.id}`;
  const unitScope = `org-unit:${unit.id}`;
  await built.config.setRuntimeSelectionLatest("org:default-org", { harnessId: "mock", modelId: "claude-opus-4-8" });
  await built.config.setRuntimeSelectionLatest(unitScope, { harnessId: "mock", modelId: "claude-haiku-4-5" });
  await built.config.setRuntimeSelectionLatest(groupScope, { harnessId: "mock", modelId: "claude-sonnet-4-6" });
  built.config.setInteractiveFastMode(true, groupScope);
  await built.config.setTurnWallClockSec(groupScope, 120);
  built.config.setBrowseMaxSteps(unitScope, 20);
  built.config.setBrowseModel(unitScope, "claude-sonnet-4-6");
  const provisioned: Record<string, string | undefined>[] = [];
  const egressTokens: (string | undefined)[] = [];
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (layers, options) => {
    provisioned.push(options?.env ?? {});
    egressTokens.push(options?.egressToken);
    return provision(layers, options);
  };
  built.config.setEgress(unitScope, { allowedHosts: [], privateNetworkAllowedHosts: ["10.1.37.0/24"] });
  built.config.setEgress(groupScope, { allowedHosts: [], privateNetworkAllowedHosts: ["kibana.example.com"] });
  built.config.setSoul(unitScope, "RECURSIVE_DEPARTMENT_INSTRUCTIONS");
  built.config.setSoul(groupScope, "RECURSIVE_GROUP_INSTRUCTIONS");
  await Promise.all([unitScope, groupScope].map((scope) => built.config.flushScope(scope)));
  built.runtime.start();
  const turn = async (expectedModel: string, groupInstructions: boolean, departmentInstructions: boolean) => {
    const result = await built.app.turn({
      surface: "web",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: `web:alice:governance-${observed.length}` },
      text: "!run echo governance",
      origin: { kind: "human" },
    });
    assert.ok(result.status === "ok" || result.status === "queued", JSON.stringify(result));
    const deadline = Date.now() + 5000;
    while (observed.at(-1)?.model !== expectedModel && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    const input = observed.at(-1)!;
    assert.equal(input.model, expectedModel);
    const claims = await verifyCapabilityToken(egressTokens.at(-1)!, TEST_CAPABILITY_SECRET);
    assert.equal(claims?.egress?.denyPrivateNetworks, true);
    assert.deepEqual(claims?.egress?.privateNetworkAllowedHosts ?? [], [
      ...(departmentInstructions ? ["10.1.37.0/24"] : []),
      ...(groupInstructions ? ["kibana.example.com"] : []),
    ]);
    assert.equal(input.governancePrincipalId, "alice");
    assert.equal(input.fastMode, groupInstructions ? true : undefined);
    assert.equal(input.turnWallClockMs, groupInstructions ? 120_000 : undefined);
    assert.equal(provisioned.at(-1)?.BROWSE_LAB_MAX_STEPS, departmentInstructions ? "20" : undefined);
    if (departmentInstructions) assert.equal(provisioned.at(-1)?.BROWSE_LAB_MODEL, "claude-sonnet-4-6");
    assert.equal(input.systemPrompt.includes("RECURSIVE_GROUP_INSTRUCTIONS"), groupInstructions);
    assert.equal(input.systemPrompt.includes("RECURSIVE_DEPARTMENT_INSTRUCTIONS"), departmentInstructions);
  };
  try {
    await turn("claude-sonnet-4-6", true, true);
    await built.config.setRuntimeSelectionLatest("personal:alice", { harnessId: "mock", modelId: "claude-opus-4-8" });
    await turn("claude-opus-4-8", true, true);
    await built.config.setRuntimeSelectionLatest("personal:alice", null);
    await built.organizationStore.removeGroupMember("default-org", group.id, "alice");
    await turn("claude-haiku-4-5", false, true);
    await built.organizationStore.removeUnitMember("default-org", team.id, "alice");
    await turn("claude-opus-4-8", false, false);
    assert.equal(observed.length, 4);
  } finally {
    await built.runtime.stop();
  }
});
