import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryConfigStore,
  type PersistedApprovedHarnesses,
  type PersistedBaseModel,
} from "../src/resolution/config-store.ts";
import { resolveRuntimeChoice, resolveRuntimeChoiceDurable } from "../src/harness/harness-router.ts";
import { registerOpenRouterCatalogModel, setModelOverlays } from "../src/model/pi-models.ts";
import { runtimeConfigBody } from "../src/api/runtime-config.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const ORG = "org:default-org" as const;
const PERSONAL = "personal:alice" as const;

test("runtime selection is sparse, revisioned, and acknowledges a changed org default", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex", "claude"]);
  config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  config.setRuntimeSelection(PERSONAL, { harnessId: "codex", modelId: "gpt-5.5" });
  await config.flushScope(ORG);
  await config.flushScope(PERSONAL);

  assert.equal(config.getRuntimeSelection(ORG)?.revision, 1);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-4-8" });
  assert.equal(config.getRuntimeSelection(ORG)?.revision, 2);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 1);

  config.acknowledgeRuntimeSelection(PERSONAL);
  assert.equal(config.getRuntimeSelection(PERSONAL)?.orgRevision, 2);

  config.setRuntimeSelection(PERSONAL, null);
  assert.equal(config.getRuntimeSelection(PERSONAL), null);
});

test("runtime resolution uses explicit choice, then scope, then org and rejects unapproved requests", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "codex", "claude"]);
  config.setRuntimeSelection(ORG, { harnessId: "claude", modelId: "claude-opus-4-8" });
  config.setRuntimeSelection(PERSONAL, { harnessId: "codex", modelId: "gpt-5.5" });
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback), { harnessId: "codex", modelId: "gpt-5.5" });
  assert.deepEqual(
    resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { harnessId: "pi", modelId: "claude-sonnet-4-6" }),
    { harnessId: "pi", modelId: "claude-sonnet-4-6" },
  );
  assert.throws(
    () => resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { harnessId: "opencode", modelId: "claude-opus-4-8" }),
    /not approved/,
  );
});

test("runtime resolution carries reasoning and fast-mode defaults into turns", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "opencode", "codex"]);
  config.setRuntimeSelection(ORG, {
    harnessId: "pi",
    modelId: "claude-opus-5",
    effortLevel: "high",
    fastMode: true,
  });
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, { harnessId: "pi", modelId: "claude-fable-5" }), {
    harnessId: "pi",
    modelId: "claude-opus-5",
    effortLevel: "high",
    fastMode: true,
  });
  assert.deepEqual(
    resolveRuntimeChoice(
      config,
      ORG,
      PERSONAL,
      { harnessId: "pi", modelId: "claude-fable-5" },
      {
        harnessId: "codex",
        modelId: "gpt-5.5",
      },
    ),
    {
      harnessId: "codex",
      modelId: "gpt-5.5",
      effortLevel: "high",
      fastMode: false,
    },
  );
  assert.deepEqual(
    resolveRuntimeChoice(
      config,
      ORG,
      PERSONAL,
      { harnessId: "pi", modelId: "claude-fable-5" },
      {
        harnessId: "opencode",
        modelId: "claude-opus-5",
      },
    ),
    { harnessId: "opencode", modelId: "claude-opus-5", fastMode: false },
  );
});

test("runtime resolution falls back to the first approved harness when deployment defaults are not approved", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["codex"]);
  assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, { harnessId: "pi", modelId: "claude-opus-4-8" }), {
    harnessId: "codex",
    modelId: "gpt-5.6-sol",
  });
});

test("runtime resolution falls back after the selected custom model is removed", () => {
  const config = createMemoryConfigStore("default-org");
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };
  config.setApprovedHarnesses(["pi"]);
  setCustomProviders([
    {
      id: "gateway",
      name: "Gateway",
      protocol: "openai",
      baseUrl: "https://gateway.example/v1",
      models: [{ id: "gateway-model" }],
    },
  ]);
  try {
    config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "gateway-model" });
    assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback), {
      harnessId: "pi",
      modelId: "gateway-model",
    });
    setCustomProviders([]);
    assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback), fallback);
  } finally {
    setCustomProviders([]);
  }
});

test("runtime resolution reads approvals and selections from shared durable state on every turn", async () => {
  const baseModels = createMemoryMap<PersistedBaseModel>();
  const approvedHarnesses = createMemoryMap<PersistedApprovedHarnesses>();
  const writer = createMemoryConfigStore("default-org", { baseModels, approvedHarnesses });
  const reader = createMemoryConfigStore("default-org", { baseModels, approvedHarnesses });
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  writer.setApprovedHarnesses(["pi"]);
  await writer.setRuntimeSelectionLatest(ORG, fallback);
  await writer.flushScope(ORG);
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), fallback);

  writer.setApprovedHarnesses(["codex"]);
  await writer.setRuntimeSelectionLatest(ORG, { harnessId: "codex", modelId: "gpt-5.5" });
  await writer.flushScope(ORG);
  assert.deepEqual(await resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback), {
    harnessId: "codex",
    modelId: "gpt-5.5",
  });
  await assert.rejects(
    resolveRuntimeChoiceDurable(reader, ORG, PERSONAL, fallback, { harnessId: "pi", modelId: "claude-opus-4-8" }),
    /not approved/,
  );
});

test("every write that changes a scope's served model notifies listeners", async () => {
  const config = createMemoryConfigStore("default-org");
  const seen: string[] = [];
  config.onRuntimeSelectionChanged((id) => seen.push(id));
  config.setApprovedHarnesses(["pi", "codex"]);

  config.setRuntimeSelection(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  await config.setRuntimeSelectionLatest(PERSONAL, { harnessId: "codex", modelId: "gpt-5.5" });
  config.setBaseModel(PERSONAL, "gpt-5.6-sol");
  await config.setRuntimeSelectionLatest(PERSONAL, null);
  config.acknowledgeRuntimeSelection(PERSONAL);
  assert.deepEqual(seen, [ORG, PERSONAL, PERSONAL, PERSONAL]);
});

test("a listener that throws cannot break the write that notified it", async () => {
  const config = createMemoryConfigStore("default-org");
  config.onRuntimeSelectionChanged(() => {
    throw new Error("surface unreachable");
  });
  config.setApprovedHarnesses(["pi"]);
  await config.setRuntimeSelectionLatest(ORG, { harnessId: "pi", modelId: "claude-opus-4-8" });
  assert.equal((await config.getRuntimeSelectionDurable(ORG))?.modelId, "claude-opus-4-8");
});

test("native runtime choices accept only the matching custom protocol", () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi", "claude", "codex", "opencode"]);
  setCustomProviders([
    {
      id: "messages",
      name: "Messages",
      protocol: "anthropic",
      baseUrl: "https://example.test",
      models: [{ id: "custom/model" }],
    },
    {
      id: "responses",
      name: "Responses",
      protocol: "openai-responses",
      baseUrl: "https://example.test/v1",
      models: [{ id: "custom/model" }],
    },
    {
      id: "chat",
      name: "Chat",
      protocol: "openai",
      baseUrl: "https://example.test/v1",
      models: [{ id: "custom/model" }],
    },
  ]);
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-5" };
  try {
    for (const choice of [
      { harnessId: "claude" as const, modelId: "messages/custom/model" },
      { harnessId: "codex" as const, modelId: "responses/custom/model" },
    ]) {
      config.setRuntimeSelection(ORG, choice);
      assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback), choice);
      assert.deepEqual(resolveRuntimeChoice(config, ORG, PERSONAL, fallback, choice), choice);
    }
    assert.throws(
      () => resolveRuntimeChoice(config, ORG, PERSONAL, fallback, { harnessId: "codex", modelId: "chat/custom/model" }),
      /not approved/,
    );
    assert.throws(
      () =>
        resolveRuntimeChoice(config, ORG, PERSONAL, fallback, {
          harnessId: "claude",
          modelId: "responses/custom/model",
        }),
      /not approved/,
    );
  } finally {
    setCustomProviders([]);
  }
});

test("durable runtime resolution hydrates the model catalog before rejecting an unknown dynamic model", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi"]);
  await config.setRuntimeSelectionLatest(PERSONAL, { harnessId: "pi", modelId: "testvendor/cold-router-model" });
  await config.flushScope(PERSONAL);
  const fallback = { harnessId: "pi" as const, modelId: "claude-opus-4-8" };

  assert.deepEqual(await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback), fallback);

  let hydrations = 0;
  const hydrate = async () => {
    hydrations += 1;
    registerOpenRouterCatalogModel({
      id: "testvendor/cold-router-model",
      name: "Cold Router Model",
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      input: ["text"],
      reasoning: true,
      cost: { input: 0, output: 0 },
    });
  };
  assert.deepEqual(await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback, undefined, hydrate), {
    harnessId: "pi",
    modelId: "testvendor/cold-router-model",
  });
  assert.equal(hydrations, 1);

  assert.deepEqual(
    await resolveRuntimeChoiceDurable(
      config,
      ORG,
      PERSONAL,
      fallback,
      { modelId: "testvendor/cold-router-model" },
      hydrate,
    ),
    { harnessId: "pi", modelId: "testvendor/cold-router-model" },
  );

  const before = hydrations;
  await resolveRuntimeChoiceDurable(config, ORG, PERSONAL, fallback, undefined, hydrate);
  assert.equal(hydrations, before);
});

test("unavailable deployment and legacy models remain repairable without bypassing scope restrictions", async () => {
  const modelId = "runtime-deleted-default";
  setModelOverlays([], [modelId]);
  const config = createMemoryConfigStore("default-org");
  config.setApprovedHarnesses(["pi"]);
  const ctx = { deps: { config, harnessId: "pi", baseModelDefault: modelId } };
  try {
    const body = await runtimeConfigBody(ctx, PERSONAL, "alice");
    assert.equal(body.effective.modelId, modelId);
    assert.equal(body.orgDefault.modelId, modelId);
    assert.match(body.unavailableReason ?? "", /deleted/);
    assert.equal(body.modelsByHarness.pi?.includes(modelId), false);
    config.setWebuiModels(ORG, ["gpt-5.6-sol"]);
    assert.equal((await runtimeConfigBody(ctx, PERSONAL, "alice")).effective.modelId, modelId);
    await assert.rejects(resolveRuntimeChoiceDurable(config, ORG, PERSONAL, { harnessId: "pi", modelId }), /deleted/);
    ctx.deps.baseModelDefault = "gpt-5.6-sol";
    config.setBaseModel(ORG, modelId);
    const legacyOrg = await runtimeConfigBody(ctx, PERSONAL, "alice");
    assert.equal(legacyOrg.orgDefault.modelId, modelId);
    assert.equal(legacyOrg.effective.modelId, modelId);
    config.setBaseModel(ORG, null);
    config.setWebuiModels(ORG, null);
    config.setBaseModel(PERSONAL, modelId);
    const legacyScope = await runtimeConfigBody(ctx, PERSONAL, "alice");
    assert.equal(legacyScope.effective.modelId, modelId);
    assert.equal(legacyScope.scopeOverride?.modelId, modelId);
    config.setWebuiModels(PERSONAL, ["gpt-5.6-sol"]);
    await assert.rejects(runtimeConfigBody(ctx, PERSONAL, "alice"));
    config.setWebuiModels(PERSONAL, null);
    config.setApprovedHarnesses(["codex"]);
    await assert.rejects(runtimeConfigBody(ctx, PERSONAL, "alice"));
  } finally {
    setModelOverlays([]);
  }
});
