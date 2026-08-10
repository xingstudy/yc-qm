import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const USER = { "content-type": "application/json", "x-admin-actor": "bob@default-org" };

afterEach(() => setCustomProviders([]));

function start(modelCredentialFetch: typeof fetch = async () => new Response(null, { status: 200 })): {
  base: string;
  built: BuiltApp;
  close: () => Promise<void>;
} {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "custom-provider-route-")) }), {
    modelCredentialFetch,
  });
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    modelCredentials: built.modelCredentials,
    customProviders: built.customProviders,
    refreshCustomProviders: built.refreshCustomProviders,
    modelCredentialFetch,
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: false, openrouter: false },
    admin: built.admin,
    auditLog: built.auditLog,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BODY = {
  name: "Acme Gateway",
  protocol: "openai" as const,
  baseUrl: "https://llm.acme.internal/v1",
  models: [
    { id: "acme-large", name: "Acme Large" },
    { id: "gpt-4o", name: "Gateway GPT" },
  ],
  apiKey: "sk-acme-secret",
};

test("custom provider lifecycle: register, list, resolve, delete — admin only, no key leakage", async () => {
  const validated: string[] = [];
  const srv = start(async (input) => {
    validated.push(String(input));
    return new Response(null, { status: 200 });
  });
  try {
    // Register (validates against the endpoint's /models).
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 200);
    assert.ok(validated.some((u) => u === "https://llm.acme.internal/v1/models"));
    const putBody = (await put.json()) as { status: { hasKey: boolean } };
    assert.equal(putBody.status.hasKey, true);
    assert.equal(JSON.stringify(putBody).includes("sk-acme-secret"), false);

    const edit = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, apiKey: undefined, validate: false }),
    });
    assert.equal(edit.status, 200);
    assert.equal(await srv.built.customProviders.resolveKey("acme-gateway"), "sk-acme-secret");

    const movedWithoutKey = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        baseUrl: "https://different.example/v1",
        apiKey: undefined,
        validate: false,
      }),
    });
    assert.equal(movedWithoutKey.status, 400);
    assert.match(((await movedWithoutKey.json()) as { message: string }).message, /API key is required/);
    assert.equal(await srv.built.customProviders.resolveKey("acme-gateway"), "sk-acme-secret");

    // The runtime registry serves the model immediately.
    assert.equal(String(resolveModel("acme-large")?.provider), "acme-gateway");

    // List never leaks the key.
    const list = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: ADMIN });
    assert.equal(list.status, 200);
    const listBody = await list.text();
    assert.equal(listBody.includes("sk-acme-secret"), false);
    assert.ok(listBody.includes("acme-gateway"));

    const picker = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(picker.status, 200);
    const pickerBody = (await picker.json()) as {
      providers: Array<{ provider: string; name?: string; configured: boolean; kind: string }>;
      models: Array<{ id: string; provider: string }>;
    };
    assert.deepEqual(
      pickerBody.providers.find((provider) => provider.provider === "acme-gateway"),
      {
        provider: "acme-gateway",
        name: "Acme Gateway",
        configured: true,
        source: "admin",
        kind: "custom",
      },
    );
    assert.ok(pickerBody.models.some((model) => model.id === "acme-large" && model.provider === "acme-gateway"));

    const scope = await fetch(`${srv.base}/v1/admin/scopes/org%3Adefault-org`, { headers: ADMIN });
    assert.equal(scope.status, 200);
    const scopeBody = (await scope.json()) as {
      baseModelOptions: Array<{ id: string }>;
    };
    assert.ok(scopeBody.baseModelOptions.some((model) => model.id === "acme-large"));

    const surface = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(surface.status, 200);
    assert.equal(((await surface.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, true);

    const webTurn = await srv.built.app.turn({
      surface: "web",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "web:alice:custom-model" },
      text: "hello",
      model: "gpt-4o",
      async: true,
    });
    assert.equal(webTurn.status, "queued");
    srv.built.config.setWebuiModels("org:default-org", ["claude-opus-4-8"]);
    await srv.built.config.flushScope("org:default-org");
    const blockedWebTurn = await srv.built.app.turn({
      surface: "web",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "web:alice:blocked-custom-model" },
      text: "hello",
      model: "gpt-4o",
      async: true,
    });
    assert.equal(blockedWebTurn.status, "refused");
    assert.match(blockedWebTurn.reason ?? "", /not enabled for the web UI/);

    // Non-admin gets refused.
    const denied = await fetch(`${srv.base}/v1/admin/custom-providers`, { headers: USER });
    assert.notEqual(denied.status, 200);

    // Delete disables and clears the registry.
    const del = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(del.status, 200);
    assert.equal(resolveModel("acme-large"), undefined);
    assert.equal(await srv.built.customProviders.resolveKey("acme-gateway"), null);
    const revive = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, apiKey: undefined, validate: false }),
    });
    assert.equal(revive.status, 400);
  } finally {
    await srv.close();
  }
});

test("a rejected key blocks registration unless validate:false", async () => {
  const srv = start(async () => new Response(null, { status: 401 }));
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(BODY),
    });
    assert.equal(put.status, 400);
    assert.equal(((await put.json()) as { error: string }).error, "invalid_api_key");

    const skip = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(skip.status, 200);
  } finally {
    await srv.close();
  }
});

test("a new provider requires a key even when validation is skipped", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, apiKey: undefined, validate: false }),
    });
    assert.equal(put.status, 400);
    assert.match(((await put.json()) as { message: string }).message, /API key is required/);
  } finally {
    await srv.close();
  }
});

test("the model provider picker refreshes a registry changed outside the request", async () => {
  const srv = start();
  try {
    await srv.built.refreshCustomProviders();
    await srv.built.customProviders.upsert(
      {
        id: "acme-gateway",
        name: BODY.name,
        protocol: BODY.protocol,
        baseUrl: BODY.baseUrl,
        models: BODY.models,
      },
      BODY.apiKey,
      "admin-remote@default-org",
    );
    assert.equal(resolveModel("acme-large"), undefined);

    const webTurn = await srv.built.app.turn({
      surface: "web",
      actor: { externalId: "alice" },
      conversation: { kind: "dm", threadRef: "web:alice:remote-custom-model" },
      text: "hello",
      model: "acme-large",
      async: true,
    });
    assert.equal(webTurn.status, "queued");
    assert.equal(String(resolveModel("acme-large")?.provider), "acme-gateway");

    const picker = await fetch(`${srv.base}/v1/admin/model-providers`, { headers: ADMIN });
    assert.equal(picker.status, 200);
    const body = (await picker.json()) as {
      providers: Array<{ provider: string }>;
      models: Array<{ id: string }>;
    };
    assert.ok(
      body.providers.some((provider) => provider.provider === "acme-gateway"),
      JSON.stringify(body),
    );
    assert.ok(
      body.models.some((model) => model.id === "acme-large"),
      JSON.stringify(body),
    );
    assert.equal(String(resolveModel("acme-large")?.provider), "acme-gateway");
  } finally {
    await srv.close();
  }
});

test("a custom provider with only shadowed model ids does not satisfy the portal model gate", async () => {
  const srv = start();
  try {
    const put = await fetch(`${srv.base}/v1/admin/custom-providers/shadow`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({
        ...BODY,
        name: "Shadow",
        models: [{ id: "claude-opus-5" }],
        validate: false,
      }),
    });
    assert.equal(put.status, 200);
    const surface = await fetch(`${srv.base}/v1/surface-config`);
    assert.equal(surface.status, 200);
    assert.equal(((await surface.json()) as { modelProviderConfigured?: boolean }).modelProviderConfigured, false);
  } finally {
    await srv.close();
  }
});

test("bad specs are refused with a reason", async () => {
  const srv = start();
  try {
    for (const [patch, reason] of [
      [{ models: [] }, /at least one model/],
      [{ protocol: "grpc" }, /protocol/],
      [{ baseUrl: "https://x?y=1" }, /query/],
    ] as const) {
      const res = await fetch(`${srv.base}/v1/admin/custom-providers/acme-gateway`, {
        method: "PUT",
        headers: ADMIN,
        body: JSON.stringify({ ...BODY, ...patch, validate: false }),
      });
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as { message: string }).message, reason);
    }
    // Reserved slug via the path.
    const reserved = await fetch(`${srv.base}/v1/admin/custom-providers/openai`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ ...BODY, validate: false }),
    });
    assert.equal(reserved.status, 400);
    assert.match(((await reserved.json()) as { message: string }).message, /reserved/);
  } finally {
    await srv.close();
  }
});
