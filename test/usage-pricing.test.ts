import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryMap, createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock, createPostgresAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createUsagePricingStore, estimateUsage, type UsagePrice } from "../src/usage/usage-pricing.ts";
import type { UsageFact } from "../src/usage/usage-store.ts";
import { isolatedPgTestDatabase } from "./support/isolated-pg-test-database.ts";

const rates = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
const now = Date.parse("2026-10-15T00:00:00+08:00");
function fixture() {
  const map = createMemoryMap<{ versions: UsagePrice[] }>();
  const lock = createMemoryAdvisoryLock();
  return createUsagePricingStore(
    map,
    (key, fn) => lock.withLock(key, fn),
    () => now,
  );
}
const fact = {
  input: 1_000_000,
  output: 100_000,
  cacheRead: 100_000,
  cacheWrite: 0,
  grain: "call",
  pricingMode: "standard",
} as UsageFact;

test("reference rates preserve versions, effective time, overrides and organization isolation", async () => {
  const store = fixture();
  const base = await store.resolve("acme", "openai", "gpt-5.6-terra", now);
  assert.equal(base?.source, "official");
  assert.equal(await store.resolve("acme", "proxy", "gpt-5.6-terra", now), null);
  const a = await store.save("acme", { provider: "openai", model: "gpt-5.6-terra", rates }, "alice");
  const b = await store.save(
    "acme",
    { provider: "openai", model: "gpt-5.6-terra", rates: { ...rates, input: 3 } },
    "bob",
  );
  assert.equal((await store.resolve("acme", "openai", "gpt-5.6-terra", now))?.id, b.id);
  assert.equal((await store.resolve("acme", "openai", "gpt-5.6-terra", now - 1))?.id, base?.id);
  assert.equal((await store.resolve("other", "openai", "gpt-5.6-terra", now))?.source, "official");
  const future = await store.save(
    "acme",
    { provider: "openai", model: "gpt-5.6-terra", rates, effectiveAt: now + 60000 },
    "alice",
  );
  assert.equal((await store.resolve("acme", "openai", "gpt-5.6-terra", now))?.id, b.id);
  assert.equal((await store.resolve("acme", "openai", "gpt-5.6-terra", now + 60000))?.id, future.id);
  assert.ok((await store.versions("acme")).some((p) => p.id === a.id));
  assert.ok(!(await store.versions("other")).some((p) => p.id === a.id));
  const restored = await store.save("acme", { provider: "openai", model: "gpt-5.6-terra", restore: true }, "alice");
  assert.equal(restored.source, "official");
  assert.equal(restored.rates.input, 2);
  assert.notEqual(restored.id, base?.id);
  assert.equal((await store.resolve("acme", "openai", "gpt-5.6-terra", now))?.id, restored.id);
});

test("reference price validation rejects retroactive, invalid, incomplete tier and unsafe rates", async () => {
  const store = fixture();
  for (const patch of [
    { effectiveAt: now - 1 },
    { rates: { input: -1 } },
    { rates: { input: Infinity } },
    { rates: { input: "2" } },
    {
      tiers: [
        { ...rates, inputTokensAbove: 10 },
        { ...rates, inputTokensAbove: 9 },
      ],
    },
    { fastMultiplier: -1 },
    { provider: "bad\nprovider" },
    { model: "" },
    { restore: true },
  ])
    await assert.rejects(() => store.save("acme", { provider: "proxy", model: "custom", rates, ...patch }, "alice"));
  assert.equal((await store.versions("acme")).filter((p) => p.source === "administrator").length, 0);
});

test("estimation distinguishes zero and unknown, uses tiers and fast mode without double counting", async () => {
  const store = fixture();
  const price = await store.save(
    "acme",
    {
      provider: "proxy",
      model: "custom",
      rates,
      fastMultiplier: 2,
      tiers: [{ ...rates, input: 4, inputTokensAbove: 2_000_000 }],
    },
    "alice",
  );
  assert.equal(estimateUsage(fact, price), 3.02);
  assert.equal(estimateUsage({ ...fact, pricingMode: "fast" }, price), 6.04);
  assert.equal(estimateUsage({ ...fact, input: 3_000_000 }, price), 13.02);
  assert.equal(estimateUsage({ ...fact, input: 3_000_000, grain: "turn" }, price), null);
  assert.equal(estimateUsage({ ...fact, output: null }, price), null);
  assert.equal(estimateUsage({ ...fact, output: 0 }, { ...price, rates: { ...rates, output: null } }), 2.02);
  assert.equal(estimateUsage(fact, { ...price, rates: { ...rates, output: null } }), null);
  assert.equal(estimateUsage(fact, { ...price, rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), 0);
  const claude = (await store.resolve("acme", "anthropic", "claude-fable-5-1", now))!;
  assert.equal(estimateUsage({ ...fact, cacheWrite: 1_000, cacheWrite1h: undefined }, claude), null);
  assert.equal(
    estimateUsage({ ...fact, input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 500_000 }, claude),
    16.25,
  );
});

const dbUrl = await isolatedPgTestDatabase(process.env.DATABASE_URL);
test(
  "Postgres reference versions survive reopen and concurrent writers without losing history",
  { skip: !dbUrl },
  async () => {
    const db = createPostgresMapFactory(dbUrl!);
    const lock = createPostgresAdvisoryLock(db.pool);
    const a = createUsagePricingStore(
      db.map("usage_prices"),
      (key, fn) => lock.withLock(key, fn),
      () => now,
    );
    try {
      const written = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          a.save("acme", { provider: "proxy", model: "custom", rates: { ...rates, input: i } }, `admin${i}`),
        ),
      );
      const reopened = createUsagePricingStore(
        db.map("usage_prices"),
        (key, fn) => lock.withLock(key, fn),
        () => now,
      );
      const rows = (await reopened.versions("acme")).filter((p) => p.provider === "proxy");
      assert.equal(rows.length, 5);
      assert.deepEqual(new Set(rows.map((p) => p.id)), new Set(written.map((p) => p.id)));
    } finally {
      await db.pool.close();
    }
  },
);
