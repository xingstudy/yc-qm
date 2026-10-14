import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createUsageService,
  measuredDirectCall,
  measuredHarnessTurn,
  measuredModelStream,
} from "../src/usage/usage-service.ts";
import type { UsageFact, UsageStore } from "../src/usage/usage-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator/types.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createUsagePricingStore } from "../src/usage/usage-pricing.ts";

function firstFact(facts: Map<string, UsageFact>): UsageFact {
  const fact = [...facts.values()][0];
  assert.ok(fact);
  return fact;
}

function fixture(pricing?: Parameters<typeof createUsageService>[3]) {
  const facts = new Map<string, UsageFact>();
  let fail = false;
  let snapshots = 0;
  const store: UsageStore = {
    put: async (fact, insertOnly) => {
      if (fail) throw new Error("database offline");
      if (!insertOnly || !facts.has(fact.id)) facts.set(fact.id, structuredClone(fact));
    },
    get: async (_org, id) => structuredClone(facts.get(id) ?? null),
    project: async () => 0,
    backfill: async () => 0,
    previewCost: async () => {
      throw new Error("unused");
    },
    confirmCost: async () => {
      throw new Error("unused");
    },
    report: async () => {
      throw new Error("unused");
    },
    details: async () => {
      throw new Error("unused");
    },
    facets: async () => {
      throw new Error("unused");
    },
    export: async () => "",
    close: async () => {},
  };
  const service = createUsageService(
    store,
    "acme",
    async () => ({
      principalName: `Snapshot ${++snapshots}`,
      projectId: "p1",
      projectName: "Project",
      unitId: "dept",
      unitName: "Dept",
      unitPath: ["dept"],
    }),
    pricing,
  );
  const input = {
    actor: { id: "alice" },
    origin: { kind: "direct" },
    runId: "stable-run",
    attempt: 1,
  } as OrchestratorInput;
  return {
    facts,
    service,
    input,
    setFailure: (value: boolean) => {
      fail = value;
    },
  };
}

test("usage intent failure blocks dispatch; retried human requests preserve their identity and snapshot", async () => {
  const f = fixture();
  let calls = 0;
  f.setFailure(true);
  await assert.rejects(() =>
    f.service.task(
      f.input,
      async () => {
        calls++;
        return {};
      },
      "personal:alice",
    ),
  );
  assert.equal(calls, 0);
  f.setFailure(false);
  await f.service.task(
    f.input,
    async () => {
      calls++;
      return {};
    },
    "personal:alice",
  );
  await f.service.task(
    { ...f.input, attempt: 2 },
    async () => {
      assert.equal(f.facts.get("request:stable-run")?.state, "pending");
      assert.equal(f.facts.get("request:stable-run")?.attempt, 2);
      calls++;
      return {};
    },
    "group:new",
  );
  assert.equal(calls, 2);
  assert.equal(f.facts.size, 1);
  assert.equal(f.facts.get("request:stable-run")?.principalName, "Snapshot 2");
  assert.equal(f.facts.get("request:stable-run")?.scopeId, "personal:alice");
});

test("new measurements snapshot prices before dispatch, retain SDK costs and do not reprice on finish", async () => {
  const lock = createMemoryAdvisoryLock();
  const prices = createUsagePricingStore(createMemoryMap(), (key, fn) => lock.withLock(key, fn));
  const first = await prices.save(
    "acme",
    { provider: "proxy", model: "custom", rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 } },
    "admin",
  );
  const f = fixture({ store: prices, model: (id) => ({ provider: "proxy", id }) });
  await f.service.system(async () => {
    const fact = await f.service.begin("custom");
    assert.equal(fact.price?.id, first.id);
    assert.equal(fact.pricingModel, "custom");
    assert.equal(fact.provider, "proxy");
    await prices.save("acme", { provider: "proxy", model: "custom", rates: { input: 20 } }, "admin");
    await f.service.finish(fact, { state: "success", input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(f.facts.get(fact.id)?.costUsd, 2);
    assert.equal(f.facts.get(fact.id)?.costSource, "estimate");
    await f.service.finish(fact, { state: "failed" });
    assert.equal(f.facts.get(fact.id)?.costUsd, 2);
    await f.service.finish(fact, { costUsd: 7, costSource: "sdk" });
    assert.equal(f.facts.get(fact.id)?.costUsd, 7);
  });
});

test("missing OpenCode SDK cost remains unknown instead of free without a reference price", async () => {
  const f = fixture();
  const input = { runtime: { modelId: "model" } } as HarnessTurnInput;
  await f.service.system(() =>
    measuredHarnessTurn("opencode", input, async (turn) => {
      await turn.recordLlmRequest?.({
        turnSeq: null,
        step: 0,
        model: "model",
        truncated: false,
        usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, costUsd: 0, costKnown: false },
      });
      return { reply: "ok", modelCalls: 1 };
    }),
  );
  assert.equal(firstFact(f.facts).costUsd, null);
  assert.equal(firstFact(f.facts).costSource, "unknown");
});

test("post-consumption persistence retries writes only and leaves a durable intent", async () => {
  const f = fixture();
  let calls = 0;
  await f.service.system(() =>
    measuredDirectCall("model", async () => {
      calls++;
      f.setFailure(true);
      return {
        result: "done",
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, costUsd: 0.01 },
      };
    }),
  );
  assert.equal(calls, 1);
  assert.equal(firstFact(f.facts).state, "pending");
  f.setFailure(false);
  await f.service.drain();
  assert.equal(calls, 1);
  assert.equal(firstFact(f.facts).input, 10);
  assert.equal(firstFact(f.facts).state, "success");
});

test("native utility turns normalize Codex cache, retain unknown subscription cost, avoid child double counts", async () => {
  const f = fixture();
  const input = { runtime: { modelId: "gpt-test" } } as HarnessTurnInput;
  await f.service.system(() =>
    measuredHarnessTurn("codex", input, async (turn) => {
      await turn.recordLlmRequest?.({
        turnSeq: null,
        step: 0,
        model: "gpt-test",
        truncated: false,
        usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, totalTokens: 120, costUsd: 0 },
      });
      await measuredHarnessTurn("codex", turn, async () => ({ reply: "child" }));
      return { reply: "done", modelCalls: 2 };
    }),
  );
  assert.equal(f.facts.size, 1);
  const fact = firstFact(f.facts);
  assert.equal(fact.input, 70);
  assert.equal(fact.cacheRead, 30);
  assert.equal(fact.costUsd, null);
  assert.equal(fact.grain, "turn");
  assert.equal(fact.calls, 2);
  assert.equal(fact.source, "system");
});

test("Pi stream persists intent before start and measures terminal usage once", async () => {
  const f = fixture();
  let started = 0;
  const model = {
    id: "pi-test",
    api: "openai-responses",
    provider: "openai",
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    ...model,
    model: model.id,
    timestamp: Date.now(),
    stopReason: "stop",
    usage: {
      input: 10,
      output: 3,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
    },
  };
  const start = () => {
    started++;
    assert.equal(f.facts.size, 1);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
    return stream;
  };
  await f.service.system(async () => {
    const stream = measuredModelStream(model, start);
    for await (const _event of stream) assert.ok(_event);
    assert.equal((await stream.result()).stopReason, "stop");
  });
  assert.equal(started, 1);
  assert.equal(firstFact(f.facts).costSource, "estimate");
  assert.equal(firstFact(f.facts).calls, 1);
  const blocked = fixture();
  blocked.setFailure(true);
  await blocked.service.system(async () => {
    const stream = measuredModelStream(model, () => {
      throw new Error("must not dispatch");
    });
    for await (const _event of stream) assert.equal(_event.type, "error");
    assert.equal((await stream.result()).stopReason, "error");
  });
});
