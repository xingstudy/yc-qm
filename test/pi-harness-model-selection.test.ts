import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import type { HarnessCompactInput } from "../src/harness/harness.ts";
import { createPiHarness, resolveConfiguredModelId } from "../src/harness/pi-harness.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";
import { DEFAULT_AGENT_MODEL_ID, setModelOverlays } from "../src/model/pi-models.ts";

const BASE_MODEL = "openai-qf2/gpt-6.1-sol";
const OVERRIDE_MODEL = "openai-qf2/gpt-6-sol";
const SUMMARY = "## Goal\nCheck the Excel values.\n## Progress\nDownloaded four workbooks.";

function compactInput(model?: string): HarnessCompactInput {
  return {
    session: { id: "summary-session", scopeId: "personal:test" } as HarnessCompactInput["session"],
    history: [
      {
        sessionId: "summary-session",
        seq: 1,
        parentSeq: null,
        type: "user",
        payload: { text: "Check the values displayed in the downloaded workbooks." },
        scopeLabel: "personal:test",
        createdAt: 1,
      },
    ],
    ...(model ? { model } : {}),
    recordModelCall: () => {},
  };
}

async function upstream(t: TestContext) {
  const requests: Array<{ model: string; authorization: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body = JSON.parse(raw) as { model: string };
    requests.push({ model: body.model, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_summary" } },
      { type: "response.output_text.delta", output_index: 0, delta: SUMMARY },
      { type: "response.completed", response: { id: "resp_summary", status: "completed", output: [] } },
    ]) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
  t.after(() => {
    setCustomProviders([]);
    setModelOverlays([]);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  setCustomProviders([
    {
      id: "openai-qf2",
      name: "Company OpenAI",
      protocol: "openai-responses",
      baseUrl: url,
      models: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-sol" }],
    },
  ]);
  return { requests, url };
}

test("Pi compaction and one-shot use the live organization model without a deployment model or Anthropic key", async (t) => {
  const { requests } = await upstream(t);
  let organizationModel = BASE_MODEL;
  const harness = createPiHarness({
    resolveBaseModelId: () => organizationModel,
    resolveProviderKeys: async () => ({ "openai-qf2": "company-key" }),
  });
  const recorded: string[] = [];
  const input = { ...compactInput(), recordModelCall: ({ model }: { model: string }) => recorded.push(model) };
  assert.equal(await harness.models.compactHistory!(input), SUMMARY);
  organizationModel = OVERRIDE_MODEL;
  assert.equal(await harness.models.compactHistory!(input), SUMMARY);
  assert.equal(await harness.models.oneShot!("Summarize the task.", "Check Excel."), SUMMARY);
  assert.deepEqual(recorded, [BASE_MODEL, OVERRIDE_MODEL]);
  assert.deepEqual(requests, [
    { model: "gpt-6.1-sol", authorization: "Bearer company-key" },
    { model: "gpt-6-sol", authorization: "Bearer company-key" },
    { model: "gpt-6-sol", authorization: "Bearer company-key" },
  ]);
});

test("Pi compaction honors the turn model ahead of the organization model", async (t) => {
  const { requests } = await upstream(t);
  const harness = createPiHarness({
    resolveBaseModelId: () => BASE_MODEL,
    resolveProviderKeys: async () => ({ "openai-qf2": "company-key" }),
  });
  const recorded: string[] = [];
  assert.equal(
    await harness.models.compactHistory!({
      ...compactInput(OVERRIDE_MODEL),
      recordModelCall: ({ model }) => recorded.push(model),
    }),
    SUMMARY,
  );
  assert.deepEqual(recorded, [OVERRIDE_MODEL]);
  assert.deepEqual(
    requests.map(({ model }) => model),
    ["gpt-6-sol"],
  );
});

test("Pi compaction resolves scope-specific models using the session scope", async (t) => {
  const { requests } = await upstream(t);
  const harness = createPiHarness({
    modelId: (scope) => (scope === "personal:test" ? OVERRIDE_MODEL : undefined),
    resolveBaseModelId: () => BASE_MODEL,
    resolveProviderKeys: async () => ({ "openai-qf2": "company-key" }),
  });
  assert.equal(await harness.models.compactHistory!(compactInput()), SUMMARY);
  assert.deepEqual(
    requests.map(({ model }) => model),
    ["gpt-6-sol"],
  );
});

test("Pi compaction rechecks provider credentials after revocation and makes no further request", async (t) => {
  const { requests } = await upstream(t);
  let enabled = true;
  const harness = createPiHarness({
    resolveBaseModelId: () => BASE_MODEL,
    resolveProviderKeys: async () => (enabled ? { "openai-qf2": "company-key" } : {}),
  });
  assert.equal(await harness.models.compactHistory!(compactInput()), SUMMARY);
  enabled = false;
  await assert.rejects(harness.models.compactHistory!(compactInput()), NonRetryableTurnError);
  assert.equal(await harness.models.oneShot!("Summarize.", "Check Excel."), undefined);
  assert.equal(requests.length, 1);
});

test("Pi compaction does not replace an unavailable explicit model with a working default", async (t) => {
  const { requests } = await upstream(t);
  const harness = createPiHarness({
    resolveBaseModelId: () => BASE_MODEL,
    resolveProviderKeys: async () => ({ "openai-qf2": "company-key" }),
  });
  for (const model of ["unknown-model", "claude-opus-5", "gpt-5.4"]) {
    await assert.rejects(harness.models.compactHistory!(compactInput(model)), NonRetryableTurnError);
  }
  setCustomProviders([]);
  await assert.rejects(harness.models.compactHistory!(compactInput(BASE_MODEL)), NonRetryableTurnError);
  assert.equal(requests.length, 0);
});

test("Pi skips disabled models even when the gateway can route them", async (t) => {
  const { requests, url } = await upstream(t);
  setModelOverlays([], [DEFAULT_AGENT_MODEL_ID, "gpt-6-sol"]);
  const harness = createPiHarness({
    defaultModelId: "gpt-6-sol",
    titleModelId: "gpt-6-sol",
    judgeModelId: "gpt-6-sol",
    detectModelId: "gpt-6-sol",
    modelGateway: {
      url,
      apiKey: "gateway-key",
      apiKeyHeader: "api-key",
      models: { "gpt-6-sol": "gpt-6-sol", [DEFAULT_AGENT_MODEL_ID]: DEFAULT_AGENT_MODEL_ID },
    },
  });
  await assert.rejects(harness.models.compactHistory!(compactInput()), NonRetryableTurnError);
  await assert.rejects(harness.models.compactHistory!(compactInput("gpt-6-sol")), NonRetryableTurnError);
  assert.equal(await harness.models.oneShot!("Summarize.", "Check Excel."), undefined);
  assert.equal(await harness.models.generateTitle!("User: check Excel."), undefined);
  assert.equal(await harness.models.summarizeApproval!("cat report.xlsx", "review"), undefined);
  assert.equal(await harness.models.judge!("Judge.", "Check Excel."), undefined);
  assert.equal(
    await harness.models.screenSecurity!({
      payload: "Check Excel.",
      signal: new AbortController().signal,
      recordModelCall: () => {},
    }),
    undefined,
  );
  assert.deepEqual(
    await harness.models.shouldRespond!({
      session: compactInput().session,
      message: "Check Excel.",
      recentContext: "",
      systemPrompt: "Respond.",
      history: [],
      recordModelCall: () => {},
    }),
    { respond: true },
  );
  assert.throws(() => resolveConfiguredModelId(undefined), NonRetryableTurnError);
  assert.equal(requests.length, 0);
});

test("Pi utility fallback skips an unconfigured provider in favor of a configured deployment model", async (t) => {
  const { requests } = await upstream(t);
  const harness = createPiHarness({
    resolveBaseModelId: () => "claude-opus-5",
    defaultModelId: BASE_MODEL,
    resolveProviderKeys: async () => ({ "openai-qf2": "company-key" }),
  });
  assert.equal(await harness.models.compactHistory!(compactInput()), SUMMARY);
  assert.deepEqual(
    requests.map(({ model }) => model),
    ["gpt-6.1-sol"],
  );
});

test("Pi explicit utility overrides never fall back when their provider is unconfigured", async (t) => {
  const { requests } = await upstream(t);
  const harness = createPiHarness({
    resolveBaseModelId: () => BASE_MODEL,
    titleModelId: "claude-haiku-4-5",
    judgeModelId: "claude-haiku-4-5",
    resolveProviderKeys: async () => ({ "openai-qf2": "company-key" }),
  });
  assert.equal(await harness.models.generateTitle!("User: check Excel."), undefined);
  assert.equal(await harness.models.summarizeApproval!("cat report.xlsx", "review"), undefined);
  assert.equal(await harness.models.judge!("Judge.", "Check Excel."), undefined);
  assert.equal(requests.length, 0);
});

test("Pi utility fallback uses the base model when its auxiliary model has no gateway route", async (t) => {
  const { requests, url } = await upstream(t);
  const harness = createPiHarness({
    defaultModelId: "gpt-5.4",
    modelGateway: {
      url,
      apiKey: "gateway-key",
      apiKeyHeader: "api-key",
      models: { "gpt-5.4": "gpt-5.4" },
    },
  });
  assert.equal(await harness.models.judge!("Judge.", "Check Excel."), SUMMARY);
  assert.deepEqual(
    requests.map(({ model }) => model),
    ["gpt-5.4"],
  );
});

test("Pi utility selection retains a configured auxiliary gateway route without a base-model credential", async (t) => {
  const { requests, url } = await upstream(t);
  const harness = createPiHarness({
    defaultModelId: "gpt-5.4",
    modelGateway: {
      url,
      apiKey: "gateway-key",
      apiKeyHeader: "api-key",
      models: { "gpt-5.6-luna": "auxiliary" },
    },
  });
  assert.equal(await harness.models.judge!("Judge.", "Check Excel."), SUMMARY);
  assert.deepEqual(
    requests.map(({ model }) => model),
    ["auxiliary"],
  );
});
