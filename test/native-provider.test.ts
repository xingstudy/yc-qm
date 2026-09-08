import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { nativeCustomModel, nativeProviderEnv, resolveNativeProvider } from "../src/harness/native-provider.ts";
import { customModelsJson, setCustomProviders, type CustomProviderSpec } from "../src/model/custom-providers.ts";
import { createCustomProviderStore, type StoredCustomProvider } from "../src/model/custom-provider-store.ts";
import { modelSupportedByHarness } from "../src/model/pi-models.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const spec: CustomProviderSpec = {
  id: "custom-native",
  name: "Custom native",
  protocol: "anthropic",
  baseUrl: "https://example.test/proxy/v1/",
  models: [{ id: "arbitrary/model[1M]", contextWindow: 1_000_000 }],
};
const modelId = `${spec.id}/${spec.models[0]!.id}`;
afterEach(() => setCustomProviders([]));

test("custom model eligibility follows wire protocol, including arbitrary native model names", () => {
  for (const protocol of ["openai", "openai-responses", "anthropic"] as const) {
    setCustomProviders([{ ...spec, protocol }]);
    for (const id of [modelId, spec.models[0]!.id]) {
      assert.equal(modelSupportedByHarness(id, "claude"), protocol === "anthropic");
      assert.equal(modelSupportedByHarness(id, "codex"), protocol === "openai-responses");
      for (const harness of ["pi", "opencode", "mock"]) assert.equal(modelSupportedByHarness(id, harness), true);
    }
    const providers = customModelsJson()?.providers as Record<string, { api: string }>;
    assert.equal(
      providers[spec.id]!.api,
      { anthropic: "anthropic-messages", openai: "openai-completions", "openai-responses": "openai-responses" }[
        protocol
      ],
    );
  }
});

test("native connections use durable endpoint and key together and reject missing or changed models", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "test-native" });
  await store.upsert(spec, "first-key", "admin");
  setCustomProviders(await store.enabled());
  const resolve = (id: string) => store.resolveConnection(id);
  const first = await resolveNativeProvider(modelId, "claude", resolve);
  assert.equal(first?.model.id, "arbitrary/model[1M]");
  assert.equal(first?.model.baseUrl, "https://example.test/proxy");
  assert.equal(first?.model.contextWindow, 1_000_000);
  await store.upsert(
    { ...spec, baseUrl: "https://other.test/v1", models: [{ id: spec.models[0]!.id, contextWindow: 500_000 }] },
    "second-key",
    "admin",
  );
  const second = await resolveNativeProvider(modelId, "claude", resolve);
  assert.equal(second?.model.baseUrl, "https://other.test");
  assert.equal(second?.apiKey, "second-key");
  assert.equal(second?.model.contextWindow, 500_000);
  await assert.rejects(resolveNativeProvider(modelId, "codex", resolve), /does not support codex/);
  await assert.rejects(resolveNativeProvider(modelId, "claude"), /unavailable/);
  await assert.rejects(
    resolveNativeProvider(modelId, "claude", async () => {
      throw new Error("secret decryption detail");
    }),
    { message: `Custom provider ${spec.id} credentials are unavailable` },
  );
  await store.upsert({ ...spec, models: [{ id: "replacement" }] }, "third-key", "admin");
  await assert.rejects(resolveNativeProvider(modelId, "claude", resolve), /unavailable/);
  await store.delete(spec.id, "admin");
  assert.equal(await store.resolveConnection(spec.id), null);
  await assert.rejects(resolveNativeProvider(modelId, "claude", resolve), /unavailable/);
});

test("native custom credentials replace conflicting auth without mutating built-in environments", async () => {
  const source = {
    ANTHROPIC_API_KEY: "official",
    ANTHROPIC_AUTH_TOKEN: "token",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    OPENAI_API_KEY: "official-openai",
    CODEX_ACCESS_TOKEN: "access",
  };
  for (const harness of ["claude", "codex"] as const) {
    const selected = {
      ...spec,
      protocol: harness === "claude" ? ("anthropic" as const) : ("openai-responses" as const),
    };
    setCustomProviders([selected]);
    const binding = await resolveNativeProvider(modelId, harness, async () => ({
      spec: selected,
      apiKey: "custom-key",
    }));
    const env = nativeProviderEnv(harness, source, binding);
    if (harness === "claude") {
      assert.equal(env.ANTHROPIC_API_KEY, "custom-key");
      assert.equal(env.ANTHROPIC_BASE_URL, "https://example.test/proxy");
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    } else {
      assert.equal(env.OPENAI_API_KEY, "custom-key");
      assert.equal(env.OPENAI_BASE_URL, "https://example.test/proxy/v1");
      assert.equal(env.CODEX_ACCESS_TOKEN, undefined);
    }
    assert.equal(nativeProviderEnv(harness, source), source);
  }
  assert.equal(source.ANTHROPIC_AUTH_TOKEN, "token");
  assert.equal(source.OPENAI_API_KEY, "official-openai");
});

test("built-in model collisions retain built-in credentials, qualified names select custom", async () => {
  setCustomProviders([{ ...spec, models: [{ id: "claude-opus-5" }] }]);
  assert.equal(nativeCustomModel("claude-opus-5"), undefined);
  assert.equal(
    await resolveNativeProvider("claude-opus-5", "claude", async () => {
      throw new Error("must not resolve");
    }),
    undefined,
  );
  assert.equal(nativeCustomModel(`${spec.id}/claude-opus-5`)?.provider, spec.id);
});

test("switching OpenAI wire APIs preserves encrypted credentials only at the same endpoint", async () => {
  const backing = createMemoryMap<StoredCustomProvider>();
  const store = createCustomProviderStore({ backing, keyMaterial: "test-native" });
  await store.upsert({ ...spec, protocol: "openai" }, "secret", "admin");
  const encrypted = (await backing.get(spec.id))?.apiKeyEnc;
  await store.upsert({ ...spec, protocol: "openai-responses" }, undefined, "admin");
  assert.equal((await backing.get(spec.id))?.apiKeyEnc, encrypted);
  assert.equal((await store.resolveConnection(spec.id))?.apiKey, "secret");
  await assert.rejects(store.upsert(spec, undefined, "admin"), /API key is required/);
  await assert.rejects(
    store.upsert({ ...spec, protocol: "openai-responses", baseUrl: "https://other.test/v1" }, undefined, "admin"),
    /API key is required/,
  );
  const corruptReader = createCustomProviderStore({ backing, keyMaterial: "other-material" });
  await assert.rejects(corruptReader.resolveConnection(spec.id));
});

test("known provider endpoints select native protocols without trusting lookalike hosts", async () => {
  for (const [baseUrl, claudeUrl, codexUrl] of [
    ["https://openrouter.ai/api/v1", "https://openrouter.ai/api", "https://openrouter.ai/api/v1"],
    ["https://api.deepseek.com/v1", "https://api.deepseek.com/anthropic", null],
    ["https://openrouter.ai.example.test/api/v1", null, null],
    ["https://openrouter.ai/custom/v1", null, null],
  ] as const) {
    const provider = { ...spec, protocol: "openai" as const, baseUrl };
    setCustomProviders([provider]);
    for (const harness of ["claude", "codex"] as const) {
      const expected = harness === "claude" ? claudeUrl : codexUrl;
      assert.equal(modelSupportedByHarness(modelId, harness), Boolean(expected));
      const resolve = () => Promise.resolve({ spec: provider, apiKey: "vendor-key" });
      if (!expected) {
        await assert.rejects(resolveNativeProvider(modelId, harness, resolve), /does not support/);
        continue;
      }
      const binding = await resolveNativeProvider(modelId, harness, resolve);
      assert.equal(binding?.model.baseUrl, expected);
      const env = nativeProviderEnv(harness, { CLAUDE_CODE_OAUTH_TOKEN: "ambient" }, binding);
      if (harness === "claude") {
        assert.equal(env.ANTHROPIC_AUTH_TOKEN, "vendor-key");
        assert.equal(env.ANTHROPIC_API_KEY, "");
        assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      }
    }
  }
});

test("native official and OpenRouter models use live managed credentials and fail closed", async () => {
  let key: string | null = "first";
  for (const [model, harness, provider] of [
    ["claude-opus-5", "claude", "anthropic"],
    ["gpt-5.6-sol", "codex", "openai"],
    ["openrouter/auto", "claude", "openrouter"],
    ["openrouter/auto", "codex", "openrouter"],
  ] as const) {
    const resolve = async (id: string) => {
      assert.equal(id, provider);
      return key;
    };
    key = "first";
    assert.equal((await resolveNativeProvider(model, harness, undefined, resolve))?.apiKey, "first");
    key = "rotated";
    assert.equal((await resolveNativeProvider(model, harness, undefined, resolve))?.apiKey, "rotated");
    key = null;
    await assert.rejects(resolveNativeProvider(model, harness, undefined, resolve), /not configured/);
    await assert.rejects(
      resolveNativeProvider(model, harness, undefined, async () => {
        throw new Error("secret details");
      }),
      { message: `Model provider ${provider} credentials are unavailable` },
    );
  }
});
