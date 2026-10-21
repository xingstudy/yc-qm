import assert from "node:assert/strict";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { Type } from "typebox";
import { normalizeContext } from "@earendil-works/pi-ai";
import { buildModelRuntime } from "../src/harness/pi-harness.ts";
import { CODEX_SUBSCRIPTION_PROVIDER, getRequiredModel } from "../src/model/pi-models.ts";

const subscriptionToken = `e30.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
).toString("base64url")}.test`;

test("a derived ChatGPT access token authenticates pi-ai's oauth-only codex provider for its own runtime only", async () => {
  const runtime = await buildModelRuntime({ [CODEX_SUBSCRIPTION_PROVIDER]: subscriptionToken });
  assert.equal(runtime.hasConfiguredAuth(CODEX_SUBSCRIPTION_PROVIDER), true);
  assert.equal((await runtime.getAuth(CODEX_SUBSCRIPTION_PROVIDER))?.auth.apiKey, subscriptionToken);
  const metered = await buildModelRuntime({ openai: "sk-metered-test-key" });
  assert.equal(metered.hasConfiguredAuth(CODEX_SUBSCRIPTION_PROVIDER), false);
  assert.equal(await metered.getAuth(CODEX_SUBSCRIPTION_PROVIDER), undefined);
});

test("Responses requests keep optional MCP parameters when a custom model omits strict-mode compatibility", async (t) => {
  const runtime = await buildModelRuntime({ openai: "offline-test-key" });
  const model = { ...getRequiredModel("gpt-6.1-sol"), compat: { supportsStrictMode: false } };
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const parameters = Type.Object({ action: Type.String(), boardId: Type.Optional(Type.String()) });
  for (const [method, transcript] of [
    ["stream", false],
    ["streamSimple", false],
    ["stream", true],
    ["streamSimple", true],
  ] as const) {
    let request: { tools: Array<{ strict?: boolean; parameters: unknown }> } | undefined;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const encoded = new Headers(init?.headers).get("content-encoding") === "zstd";
      const text = encoded ? zstdDecompressSync(init?.body as Uint8Array).toString() : String(init?.body);
      request = JSON.parse(text);
      return new Response(JSON.stringify({ error: { message: "offline test response" } }), { status: 400 });
    }) as typeof fetch;
    const context = {
      messages: [{ role: "user" as const, content: "List boards", timestamp: 0 }],
      tools: [
        { name: "read_board", description: "Read boards", parameters, constrainedSampling: false as const },
        { name: "other_tool", description: "Unchanged tool", parameters },
      ],
    };
    await runtime[method](model, transcript ? normalizeContext(context) : context, {
      maxRetries: 0,
      onPayload: (payload) => ({ ...(payload as object) }),
    }).result();
    assert.ok(request, `${method} must reach the provider request`);
    assert.equal(request.tools[0]!.strict, false);
    assert.deepEqual(request.tools[0]!.parameters, parameters);
    assert.equal(request.tools[1]!.strict, undefined, "other tools must keep the provider's original settings");
  }
});

test("codex subscription requests reach chatgpt.com with the bare model id on both streaming paths", async (t) => {
  const runtime = await buildModelRuntime({ [CODEX_SUBSCRIPTION_PROVIDER]: subscriptionToken });
  const model = getRequiredModel("codex/gpt-5.6-sol");
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  for (const method of ["stream", "streamSimple"] as const) {
    let request:
      | { url: string; body: { model?: string; tools: Array<{ strict?: boolean | null; parameters: unknown }> } }
      | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const encoded = new Headers(init?.headers).get("content-encoding") === "zstd";
      const text = encoded ? zstdDecompressSync(init?.body as Uint8Array).toString() : String(init?.body);
      request = { url: String(url), body: JSON.parse(text) };
      return new Response(JSON.stringify({ error: { message: "offline test response" } }), { status: 400 });
    }) as typeof fetch;
    const parameters = Type.Object({ action: Type.String(), boardId: Type.Optional(Type.String()) });
    const response = await runtime[method](
      model,
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [
          { name: "read_board", description: "Read boards", parameters, constrainedSampling: false },
          {
            name: "strict_tool",
            description: "Explicit strict tool",
            parameters,
            constrainedSampling: { type: "json_schema", strict: "require" },
          },
          { name: "other_tool", description: "Unchanged tool", parameters },
        ],
      },
      { transport: "sse", maxRetries: 0 },
    ).result();
    assert.ok(request, `${method} must reach the provider request: ${response.errorMessage ?? "no error"}`);
    assert.match(request.url, /^https:\/\/chatgpt\.com\/backend-api\//);
    assert.equal(request.body.model, "gpt-5.6-sol", `${method} must send the provider's own model id`);
    assert.equal(request.body.tools[0]!.strict, false, "optional fields must remain optional at the provider");
    assert.deepEqual(request.body.tools[0]!.parameters, parameters);
    assert.equal(request.body.tools[1]!.strict, true, "explicit strict sampling must be preserved");
    assert.equal(request.body.tools[2]!.strict, null, "other tools must keep the provider's original settings");
    assert.equal(response.model, "codex/gpt-5.6-sol", `${method} keeps QM's namespaced id on the assistant message`);
  }
});
