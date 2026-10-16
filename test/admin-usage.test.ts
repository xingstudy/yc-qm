import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "./support/test-app.ts";
import { testConfig } from "./support/test-config.ts";
import { emptyMetrics, type UsageStore } from "../src/usage/usage-store.ts";
import { createUsagePricingStore } from "../src/usage/usage-pricing.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { UsageCostPreviewError, type UsageCostPreview } from "../src/usage/usage-cost-backfill.ts";
import type { PersistedUiState } from "../src/surfaces/ui-state.ts";

test("usage API requires org admin, pins org, validates queries and audits exports", async () => {
  const built = buildApp(testConfig());
  let reads = 0;
  let offline = false;
  let priceOffline = false;
  let layoutOffline = false;
  const layouts = createMemoryMap<PersistedUiState>();
  let costPreview: UsageCostPreview | undefined;
  const priceLock = createMemoryAdvisoryLock();
  const prices = createUsagePricingStore(createMemoryMap(), (key, fn) => priceLock.withLock(key, fn));
  const usage: UsageStore = {
    put: async () => {},
    get: async () => null,
    project: async () => 0,
    backfill: async () => 0,
    previewCost: async (orgId, actorId, price, input) => {
      if (offline) throw new Error("database down");
      assert.equal(orgId, "default-org");
      assert.equal(price.orgId, orgId);
      assert.equal(actorId, "admin-alice");
      costPreview = {
        id: "preview",
        orgId,
        actorId,
        price,
        ...input,
        createdAt: Date.now(),
        expiresAt: Date.now() + 900000,
        confirmedAt: null,
        unknown: 1,
        eligible: 1,
        known: 0,
        pending: 0,
        missingIdentity: 0,
        missingConditions: 0,
        missingTokensOrRates: 0,
        costUsd: 2,
      };
      return costPreview;
    },
    confirmCost: async (orgId, actorId, id) => {
      if (offline) throw new Error("database down");
      assert.equal(orgId, "default-org");
      assert.equal(actorId, "admin-alice");
      if (!costPreview || costPreview.id !== id) throw new UsageCostPreviewError("not_found");
      return { ...costPreview, confirmedAt: Date.now() };
    },
    close: async () => {},
    report: async (query) => {
      reads++;
      if (offline) throw new Error("offline");
      assert.equal(query.orgId, "default-org");
      return {
        query,
        total: emptyMetrics(),
        previous: emptyMetrics(),
        series: [],
        breakdown: [],
        status: { durable: true, pending: 0, unresolved: 0, updatedAt: null, firstAt: null, historical: 0 },
      };
    },
    trends: async (query, metric) => {
      if (offline) throw new Error("offline");
      assert.equal(query.orgId, "default-org");
      assert.equal(query.dimension, "user");
      assert.equal(metric, "tokens");
      return { items: [{ id: "a", name: "Alice", metrics: emptyMetrics(), series: [] }], total: 42 };
    },
    details: async () => ({ records: [], total: 0 }),
    facets: async () => ({ user: [], project: [], department: [], model: [], source: [], auth: [] }),
    export: async () => '\uFEFF"id"\r\n',
  };
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    uiState: {
      ...layouts,
      get: async (key) => {
        if (layoutOffline) throw new Error("database down");
        return layouts.get(key);
      },
      update: async (...args) => {
        if (layoutOffline) throw new Error("database down");
        return layouts.update!(...args);
      },
    },
    usage,
    usagePricing: {
      ...prices,
      save: async (...args) => {
        if (priceOffline) throw new Error("database down");
        return prices.save(...args);
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}/v1/admin/usage`;
  const headers = { "x-admin-actor": "admin-alice@default-org" };
  try {
    assert.equal((await fetch(base)).status, 403);
    assert.equal((await fetch(base, { headers: { "x-admin-actor": "nobody@default-org" } })).status, 403);
    assert.equal((await fetch(base, { headers: { "x-admin-actor": "admin-alice@other-org" } })).status, 403);
    assert.equal(reads, 0);
    const layoutBody = {
      panels: [{ id: "p1", dimension: "user", metric: "tokens", visual: "area", width: "half" }],
      expectedUpdatedAt: 0,
    };
    const postLayout = (value: unknown, actor = "admin-alice@default-org") =>
      fetch(`${base}/layout`, {
        method: "POST",
        headers: { "x-admin-actor": actor, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    assert.equal((await postLayout(layoutBody, "nobody@default-org")).status, 403);
    assert.equal(
      (await postLayout({ ...layoutBody, panels: [{ ...layoutBody.panels[0], dimension: "invalid" }] })).status,
      400,
    );
    assert.equal((await postLayout({ ...layoutBody, panels: Array(9).fill(layoutBody.panels[0]) })).status, 400);
    const storedLayout = await postLayout({ ...layoutBody, principalId: "someone-else", orgId: "other-org" });
    assert.equal(storedLayout.status, 200);
    const layoutRecord = (await storedLayout.json()) as { value: { panels: unknown[] }; updatedAt: number };
    assert.equal(layoutRecord.value.panels.length, 1);
    assert.equal((await postLayout(layoutBody)).status, 409);
    const loadedLayout = await (
      await fetch(`${base}/layout?principalId=someone-else&orgId=other-org`, { headers })
    ).json();
    assert.deepEqual(loadedLayout, layoutRecord);
    const otherLayout = await fetch(`${base}/layout`, { headers: { "x-admin-actor": "admin-bob@default-org" } });
    assert.equal(otherLayout.status, 200);
    assert.deepEqual(await otherLayout.json(), { value: null, updatedAt: 0 });
    layoutOffline = true;
    assert.equal((await fetch(`${base}/layout`, { headers })).status, 503);
    assert.equal((await postLayout({ ...layoutBody, expectedUpdatedAt: layoutRecord.updatedAt })).status, 503);
    layoutOffline = false;
    const page = await fetch(`${base}/panels?panel=user:tokens&limit=20&offset=20`, { headers });
    assert.equal(page.status, 200);
    const pageBody = (await page.json()) as {
      pagination: Record<string, { total: number; limit: number; offset: number }>;
      panels: Record<string, Array<{ id: string }>>;
    };
    assert.deepEqual(pageBody.pagination["user:tokens"], { total: 42, limit: 20, offset: 20 });
    assert.equal(pageBody.panels["user:tokens"]?.[0]?.id, "a");
    assert.equal((await fetch(`${base}/panels?panel=user:tokens&limit=201`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/panels?panel=user:tokens&offset=-1`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/panels?panel=user:bad`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/panels?panel=user:tokens:bad`, { headers })).status, 400);
    assert.equal(
      (await fetch(`${base}/panels?${Array(9).fill("panel=user:tokens").join("&")}`, { headers })).status,
      400,
    );
    assert.equal((await fetch(`${base}/pricing`)).status, 403);
    assert.equal(
      (
        await fetch(`${base}/pricing`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-admin-actor": "nobody@default-org" },
          body: "{}",
        })
      ).status,
      403,
    );
    const body = { orgId: "other-org", provider: "proxy", model: "custom", rates: { input: 2, output: 10 } };
    const postPrice = (value: unknown) =>
      fetch(`${base}/pricing`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    assert.equal((await postPrice({ ...body, rates: { input: -1 } })).status, 400);
    const saved = await postPrice(body);
    assert.equal(saved.status, 200);
    const savedPrice = ((await saved.json()) as { price: { id: string; orgId: string } }).price;
    assert.equal(savedPrice.orgId, "default-org");
    assert.ok(
      (await built.auditLog.events()).some((e) => e.action === "usage.price.update" && e.detail?.includes('"input":2')),
    );
    priceOffline = true;
    assert.equal((await postPrice(body)).status, 503);
    priceOffline = false;
    const postCost = (mode: string, value: unknown, actor = "admin-alice@default-org") =>
      fetch(`${base}/cost-${mode}`, {
        method: "POST",
        headers: { "x-admin-actor": actor, "content-type": "application/json" },
        body: JSON.stringify(value),
      });
    const costBody = {
      priceId: savedPrice.id,
      model: "custom",
      start: "2026-10-01",
      end: "2026-10-07",
      orgId: "other-org",
    };
    assert.equal((await postCost("preview", costBody, "nobody@default-org")).status, 403);
    assert.equal((await postCost("confirm", { previewId: "preview" }, "nobody@default-org")).status, 403);
    assert.equal((await postCost("preview", { ...costBody, priceId: "missing" })).status, 400);
    assert.equal((await postCost("preview", costBody)).status, 200);
    assert.equal((await postCost("confirm", { previewId: "missing" })).status, 404);
    assert.equal((await postCost("confirm", { previewId: "preview", orgId: "other-org" })).status, 200);
    assert.ok(
      (await built.auditLog.events()).some(
        (e) => e.action === "usage.cost.backfill" && e.detail?.includes(savedPrice.id),
      ),
    );
    offline = true;
    assert.equal((await fetch(`${base}/panels?panel=user:tokens`, { headers })).status, 503);
    assert.equal((await postCost("preview", costBody)).status, 503);
    assert.equal((await postCost("confirm", { previewId: "preview" })).status, 503);
    offline = false;
    const response = await fetch(`${base}?orgId=other-org&scope=org:other-org`, { headers });
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { query: { orgId: string } }).query.orgId, "default-org");
    assert.equal((await fetch(`${base}?start=2026-02-30`, { headers })).status, 400);
    assert.equal((await fetch(`${base}?limit=10000`, { headers })).status, 400);
    const csv = await fetch(`${base}/export?type=summary`, { headers });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get("content-type")!, /text\/csv/);
    assert.equal(csv.headers.get("cache-control"), "no-store");
    assert.ok((await built.auditLog.events()).some((event) => event.action === "usage.export"));
    offline = true;
    assert.equal((await fetch(base, { headers })).status, 503);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

test("usage API reports unavailable persistence explicitly", async () => {
  const built = buildApp(testConfig());
  const server = createInsecureTestServer(built.app, { admin: built.admin });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const response = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/v1/admin/usage`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { error: string }).error, "usage_unavailable");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});
