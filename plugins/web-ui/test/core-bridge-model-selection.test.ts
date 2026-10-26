import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { makeCoreStreamFn, queueTurn } from "../src/core-bridge.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

for (const mode of ["send", "queue"] as const) {
  test(`${mode} takes the model and harness from the current selection instead of stale agent state`, async () => {
    const model = { id: "old-model", provider: "anthropic", api: "anthropic-messages" } as Model<Api>;
    const agent = {
      state: { model, messages: [{ role: "user", content: "hello", timestamp: 1 }] },
    } as unknown as Agent;
    const selected = { modelId: "openai-qf3/gpt-6.1-sol", harness: "pi", scopeId: "group:web-project-IT" };
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json(mode === "queue" ? { runId: "queued-run" } : { status: "refused", reason: "test refusal" });
    };
    if (mode === "queue") {
      await queueTurn("web:tester:model-selection", "hello", agent, () => selected);
    } else {
      const stream = await makeCoreStreamFn(
        "web:tester:model-selection",
        agent,
        () => selected,
      )(model, { messages: [] });
      await stream.result();
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.model, selected.modelId);
    assert.equal(requests[0]!.harness, selected.harness);
    assert.equal(requests[0]!.scopeId, selected.scopeId);
  });
}
