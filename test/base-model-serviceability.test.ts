import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

function start(overrides: Parameters<typeof testConfig>[0] = { anthropicApiKey: "deployment-anthropic-key" }) {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "base-model-svc-")), harness: "pi", ...overrides });
  const built = buildApp(config);
  const server = createInsecureTestServer(built.app, serverDeps(config, built));
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function effectiveModel(base: string): Promise<string> {
  const res = await fetch(`${base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { effective: { modelId: string } }).effective.modelId;
}

test("runtime-config serves group defaults without reporting an inherited model as a personal override", async () => {
  const s = start();
  try {
    await s.built.organizationStore.putUser({
      orgId: "default-org",
      principalId: "alice",
      email: "alice@example.test",
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
    const group = await s.built.organization.createGroup({ name: "Runtime group", actor: "admin-alice" });
    await s.built.organizationStore.putGroupMember({
      orgId: "default-org",
      groupId: group.id,
      principalId: "alice",
      role: "member",
      createdAt: 1,
      createdBy: "admin-alice",
    });
    const groupScope = `access-group:${group.id}`;
    await s.built.config.setRuntimeSelectionLatest(groupScope, { harnessId: "pi", modelId: "claude-sonnet-4-6" });
    const response = await fetch(`${s.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as any;
    assert.equal(body.effective.modelId, "claude-sonnet-4-6");
    assert.equal(body.scopeOverride, null);
    assert.equal(body.inheritedFrom, groupScope);
    assert.equal(body.inheritedDefault.modelId, "claude-sonnet-4-6");
    await s.built.config.setRuntimeSelectionLatest("personal:alice", { harnessId: "pi", modelId: "claude-opus-4-8" });
    assert.equal(await effectiveModel(s.base), "claude-opus-4-8");
    const pinned = (await (
      await fetch(`${s.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`)
    ).json()) as any;
    assert.equal(pinned.inheritedDefault.modelId, "claude-sonnet-4-6");
    await s.built.config.setRuntimeSelectionLatest("personal:alice", null);
    await s.built.organizationStore.removeGroupMember("default-org", group.id, "alice");
    assert.equal(await effectiveModel(s.base), "claude-opus-5");
  } finally {
    await s.close();
  }
});

test("base-model set rejects a model whose provider key is absent (would fail provider-side)", async () => {
  const srv = start();
  try {
    const bad = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "gpt-5.6-sol" }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { message?: string }).message ?? "", /serviceable|provider key/i);

    const ok = await fetch(`${srv.base}/v1/admin/scopes/org:default-org/base-model`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ modelId: "claude-opus-4-8" }),
    });
    assert.equal(ok.status, 200, "an Anthropic model stays selectable when the Anthropic key is present");
  } finally {
    await srv.close();
  }
});

test("a deployment that declares a provider runs that provider's base model", async () => {
  for (const [modelProvider, key, expected] of [
    ["anthropic", "anthropicApiKey", "claude-opus-5"],
    ["openai", "openaiApiKey", "gpt-5.6-sol"],
    ["openrouter", "openrouterApiKey", "openrouter/auto"],
  ] as const) {
    const srv = start({ modelProvider, [key]: `deployment-${modelProvider}-key` });
    try {
      assert.equal(
        await effectiveModel(srv.base),
        expected,
        `modelProvider "${modelProvider}" must land on a model that provider can bill`,
      );
    } finally {
      await srv.close();
    }
  }
});

test("an undeclared deployment keeps the shipped default, whatever keys it holds", async () => {
  for (const overrides of [{}, { openrouterApiKey: "k" }, { openaiApiKey: "k" }] as const) {
    const srv = start(overrides);
    try {
      assert.equal(
        await effectiveModel(srv.base),
        "claude-opus-5",
        "upgrading must not move an existing deployment's model or its billing",
      );
    } finally {
      await srv.close();
    }
  }
});

test("the declaration outranks a stray key from another vendor", async () => {
  const srv = start({
    modelProvider: "openrouter",
    openrouterApiKey: "deployment-openrouter-key",
    anthropicApiKey: "stray-anthropic-key",
  });
  try {
    assert.equal(await effectiveModel(srv.base), "openrouter/auto");
  } finally {
    await srv.close();
  }
});

test("department model lists require serviceable provider IDs and Codex reappears when compatible models are available", async () => {
  const srv = start({ anthropicApiKey: undefined, openaiApiKey: undefined, openrouterApiKey: undefined });
  const org = "org:default-org";
  const gpt = {
    id: "qa-gpt",
    name: "QA GPT",
    protocol: "openai" as const,
    baseUrl: "https://provider.example.test/v1",
    models: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6-sol" }],
  };
  const ids = ["qa-gpt/gpt-5.6-terra", "qa-claude/claude-sonnet-5", "qa-gpt/gpt-5.6-sol"];
  const put = (scope: string, key: string, body: unknown) =>
    fetch(`${srv.base}/v1/admin/scopes/${encodeURIComponent(scope)}/${key}`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify(body),
    });
  const read = async () => {
    const response = await fetch(`${srv.base}/v1/runtime-config?principalId=alice&scopeId=personal%3Aalice`);
    assert.equal(response.status, 200);
    return (await response.json()) as {
      approvedHarnesses: string[];
      modelsByHarness: Record<string, string[]>;
      effective: { harnessId: string; modelId: string };
    };
  };
  try {
    await srv.built.customProviders.upsert(gpt, "qa-key", "admin-alice");
    await srv.built.customProviders.upsert(
      {
        id: "qa-claude",
        name: "QA Claude",
        protocol: "anthropic",
        baseUrl: "https://provider.example.test",
        models: [{ id: "claude-sonnet-5" }],
      },
      "qa-key",
      "admin-alice",
    );
    await srv.built.organizationStore.ensureOrgRoot({ orgId: "default-org", name: "QA", actor: "admin-alice", now: 1 });
    await srv.built.organization.invite({
      principalId: "alice",
      email: "alice@example.test",
      displayName: "Alice",
      actor: "admin-alice",
    });
    await srv.built.organization.setStatus({ principalId: "alice", status: "active", actor: "admin-alice" });
    const dept = await srv.built.organization.createUnit({
      parentId: "root",
      name: "Development",
      kind: "department",
      actor: "admin-alice",
    });
    const team = await srv.built.organization.createUnit({
      parentId: dept.id,
      name: "Development team",
      kind: "team",
      actor: "admin-alice",
    });
    await srv.built.organization.addUnitMember({
      unitId: team.id,
      principalId: "alice",
      role: "member",
      actor: "admin-alice",
    });
    const scope = `org-unit:${dept.id}`;
    const adminResponse = await fetch(`${srv.base}/v1/admin/scopes/${encodeURIComponent(scope)}`, { headers: ADMIN });
    assert.equal(adminResponse.status, 200);
    const admin = (await adminResponse.json()) as {
      baseModelOptions: { id: string }[];
      modelsByHarness: Record<string, { id: string }[]>;
    };
    assert.equal("mock" in admin.modelsByHarness, false);
    const offered = [...admin.baseModelOptions, ...Object.values(admin.modelsByHarness).flat()].map(
      (model) => model.id,
    );
    assert.equal(offered.includes("gpt-5.6-terra"), false);
    assert.equal(offered.includes("gpt-5.6-sol"), false);
    for (const id of ids) assert.ok(offered.includes(id), id);
    assert.equal((await put(org, "approved-harnesses", { ids: ["pi", "opencode", "codex"] })).status, 200);
    assert.equal((await put(org, "runtime", { harnessId: "pi", modelId: ids[2] })).status, 200);
    assert.equal((await put(scope, "approved-harnesses", { ids: ["pi", "opencode"] })).status, 200);
    assert.equal((await put(scope, "webui-models", { ids })).status, 200);
    const rejected = await put(scope, "webui-models", { ids: ["gpt-5.6-terra", ids[1], "gpt-5.6-sol"] });
    assert.equal(rejected.status, 400);
    assert.equal(((await rejected.json()) as { error: string }).error, "model_provider_not_configured");
    assert.deepEqual(await srv.built.config.getWebuiModelsDurable(scope), ids);
    let user = await read();
    assert.deepEqual(user.modelsByHarness.pi, ids);
    assert.deepEqual(user.approvedHarnesses, ["pi", "opencode"]);
    assert.equal(user.effective.modelId, ids[2], "the allowlist order does not overwrite the inherited default");
    assert.equal((await put(scope, "runtime", { harnessId: "pi", modelId: ids[0] })).status, 200);
    assert.equal((await read()).effective.modelId, ids[0]);
    assert.equal((await put(scope, "approved-harnesses", { ids: ["pi", "opencode", "codex"] })).status, 200);
    user = await read();
    assert.deepEqual(user.approvedHarnesses, ["pi", "opencode", "codex"]);
    assert.deepEqual(user.modelsByHarness.codex, [], "Chat Completions is not a Codex runtime");
    await srv.built.customProviders.upsert({ ...gpt, protocol: "openai-responses" }, undefined, "admin-alice");
    user = await read();
    assert.deepEqual(user.modelsByHarness.codex, [ids[0], ids[2]]);
    assert.deepEqual(user.modelsByHarness.pi, ids);
    assert.equal(user.effective.modelId, ids[0]);
    assert.equal((await put(scope, "approved-harnesses", { ids: ["pi", "opencode"] })).status, 200);
    assert.deepEqual((await read()).approvedHarnesses, ["pi", "opencode"]);
    assert.equal((await put(scope, "approved-harnesses", { ids: ["pi", "opencode", "codex"] })).status, 200);
    assert.deepEqual((await read()).modelsByHarness.codex, [ids[0], ids[2]]);
  } finally {
    await srv.close();
  }
});

test("admin model catalogs do not expose unavailable native models through the mock harness", async () => {
  const srv = start({
    harness: "mock",
    anthropicApiKey: undefined,
    openaiApiKey: undefined,
    openrouterApiKey: undefined,
  });
  try {
    const response = await fetch(`${srv.base}/v1/admin/scopes/org:default-org`, { headers: ADMIN });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      baseModelOptions: unknown[];
      browseModelOptions: unknown[];
      modelsByHarness: Record<string, unknown[]>;
    };
    assert.deepEqual(body.baseModelOptions, []);
    assert.deepEqual(body.browseModelOptions, []);
    assert.equal("mock" in body.modelsByHarness, false);
    assert.deepEqual(Object.values(body.modelsByHarness).flat(), []);
  } finally {
    await srv.close();
  }
});
