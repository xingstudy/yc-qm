import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { createPostgresUsageStore } from "../src/usage/postgres-usage-store.ts";
import { confirmUsageCost, UsageCostPreviewError } from "../src/usage/usage-cost-backfill.ts";
import { dateAt, parseUsageQuery, type UsageFact } from "../src/usage/usage-store.ts";
import type { UsagePrice } from "../src/usage/usage-pricing.ts";
import { isolatedPgTestDatabase } from "./support/isolated-pg-test-database.ts";

const url = await isolatedPgTestDatabase(process.env.DATABASE_URL);
const price: UsagePrice = {
  id: "new-price",
  orgId: "cost-org",
  provider: "proxy",
  model: "new-model",
  rates: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  tiers: [],
  fastMultiplier: null,
  source: "administrator",
  sourceUrl: "",
  checkedAt: "",
  effectiveAt: Date.now(),
  updatedAt: Date.now(),
  updatedBy: "alice",
};
const input = { model: "proxy/new-model", start: "2026-10-05", end: "2026-10-05" };
function fact(id: string, patch: Partial<UsageFact> = {}): UsageFact {
  return {
    id,
    orgId: price.orgId,
    at: dateAt(input.start),
    kind: "model",
    principalId: "alice",
    principalName: "Alice",
    projectId: "p",
    projectName: "Project",
    unitId: "dept",
    unitName: "Department",
    unitPath: ["dept"],
    scopeId: "org:cost-org",
    source: "human",
    auth: "organization",
    requestId: id,
    state: "success",
    harness: "pi",
    model: input.model,
    provider: price.provider,
    pricingModel: price.model,
    pricingMode: "standard",
    calls: 1,
    input: 1_000_000,
    output: 100_000,
    cacheRead: 100_000,
    cacheWrite: 0,
    costUsd: null,
    costSource: "unknown",
    grain: "call",
    ...patch,
  };
}

test(
  "historical cost preview is read-only; confirmation retains original cost and updates coverage exactly once across instances",
  { skip: !url },
  async () => {
    const a = createPostgresUsageStore(url!),
      b = createPostgresUsageStore(url!);
    try {
      const records = [
        fact("eligible"),
        fact("sdk", { costUsd: 0, costSource: "sdk" }),
        fact("priced", { costUsd: 1, costSource: "estimate" }),
        fact("pending", { state: "pending" }),
        fact("tokens", { output: null }),
        fact("identity", { provider: undefined }),
        fact("conditions", { pricingMode: undefined }),
        fact("other-org", { orgId: "other-org" }),
        fact("other-model", { model: "other-model" }),
      ];
      for (const r of records) await a.put(r);
      await a.project(price.orgId);
      const query = parseUsageQuery(
        new URLSearchParams(`start=${input.start}&end=${input.end}&model=${input.model}`),
        price.orgId,
      );
      const before = await a.report(query);
      const preview = await a.previewCost(price.orgId, "alice", price, input);
      assert.equal(preview.unknown, 5);
      assert.equal(preview.eligible, 1);
      assert.equal(preview.known, 2);
      assert.equal(preview.pending, 1);
      assert.equal(preview.missingIdentity, 1);
      assert.equal(preview.missingConditions, 1);
      assert.equal(preview.missingTokensOrRates, 1);
      assert.equal(preview.costUsd, 3.02);
      assert.equal((await a.get(price.orgId, "eligible"))!.costUsd, null);
      assert.equal((await a.report(query)).total.costUsd, before.total.costUsd);
      const confirmed = await Promise.all([
        a.confirmCost(price.orgId, "alice", preview.id),
        b.confirmCost(price.orgId, "alice", preview.id),
      ]);
      assert.equal(confirmed[0].confirmedAt, confirmed[1].confirmedAt);
      const saved = (await a.get(price.orgId, "eligible"))!;
      assert.equal(saved.costUsd, 3.02);
      assert.equal(saved.price!.id, price.id);
      assert.equal(saved.costBackfill!.previousCostUsd, null);
      assert.equal(saved.costBackfill!.previousCostSource, "unknown");
      assert.equal(saved.costBackfill!.by, "alice");
      assert.equal(saved.at, records[0]!.at);
      assert.equal(saved.input, records[0]!.input);
      await a.project(price.orgId);
      await b.project(price.orgId);
      const after = await a.report(query);
      assert.equal(after.total.costUsd, before.total.costUsd + 3.02);
      assert.equal(after.total.knownCost, before.total.knownCost + 1);
      assert.equal(after.total.input, before.total.input);
      await a.put(records[0]!);
      await a.project(price.orgId);
      assert.equal((await a.get(price.orgId, "eligible"))!.costUsd, 3.02);
      assert.equal((await a.report(query)).total.costUsd, after.total.costUsd);
      assert.equal((await a.get(price.orgId, "sdk"))!.costUsd, 0);
      assert.equal((await a.get(price.orgId, "priced"))!.costUsd, 1);
      assert.equal((await a.get("other-org", "other-org"))!.costUsd, null);
      assert.equal(
        (
          await b.previewCost(
            price.orgId,
            "alice",
            { ...price, id: "later", rates: { ...price.rates, input: 100 } },
            input,
          )
        ).eligible,
        0,
      );
      assert.match(await a.export(query, false), /previousCostUsd/);
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  },
);

test(
  "historical cost confirmation rejects stale, expired, wrong actor and wrong organization previews atomically",
  { skip: !url },
  async () => {
    const a = createPostgresUsageStore(url!),
      b = createPostgresUsageStore(url!);
    const pool = new pg.Pool({ connectionString: url! });
    const p = { ...price, orgId: "failure-org" };
    const expected = (code: string) => (e: unknown) => e instanceof UsageCostPreviewError && e.code === code;
    try {
      const record = fact("failure", { orgId: p.orgId });
      await a.put(record);
      const preview = await a.previewCost(p.orgId, "alice", p, input);
      await assert.rejects(() => b.confirmCost("other-org", "alice", preview.id), expected("not_found"));
      await assert.rejects(() => b.confirmCost(p.orgId, "bob", preview.id), expected("not_found"));
      await assert.rejects(
        () => confirmUsageCost(pool, p.orgId, "alice", preview.id, preview.expiresAt),
        expected("expired"),
      );
      await b.put({ ...record, output: 200_000 });
      await assert.rejects(() => a.confirmCost(p.orgId, "alice", preview.id), expected("stale"));
      assert.equal((await a.get(p.orgId, record.id))!.costUsd, null);
      const fresh = await a.previewCost(p.orgId, "alice", p, input);
      const competing = await b.previewCost(
        p.orgId,
        "bob",
        { ...p, id: "another-version", rates: { ...p.rates, input: 4 } },
        input,
      );
      const outcome = await Promise.allSettled([
        a.confirmCost(p.orgId, "alice", fresh.id),
        b.confirmCost(p.orgId, "bob", competing.id),
      ]);
      assert.equal(outcome.filter((r) => r.status === "fulfilled").length, 1);
      const failed = outcome.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.ok(expected("stale")(failed.reason));
      for (const bad of [
        { ...input, start: "2026-02-30" },
        { ...input, end: "2026-01-01" },
        { ...input, model: "" },
      ])
        await assert.rejects(() => a.previewCost(p.orgId, "alice", p, bad), expected("invalid"));
      await assert.rejects(() => a.previewCost("other-org", "alice", p, input), expected("invalid"));
    } finally {
      await Promise.all([a.close(), b.close(), pool.end()]);
    }
  },
);

test("failed historical confirmation rolls back fact changes and remains retryable", { skip: !url }, async () => {
  const store = createPostgresUsageStore(url!);
  const pool = new pg.Pool({ connectionString: url! });
  const p = { ...price, orgId: "rollback-org" };
  try {
    await store.put(fact("rollback", { orgId: p.orgId }));
    const preview = await store.previewCost(p.orgId, "alice", p, input);
    await pool.query(
      `ALTER TABLE usage_cost_previews ADD CONSTRAINT test_cost_failure CHECK(org_id <> 'rollback-org' OR preview->>'confirmedAt' IS NULL)`,
    );
    await assert.rejects(() => store.confirmCost(p.orgId, "alice", preview.id));
    assert.equal((await store.get(p.orgId, "rollback"))!.costUsd, null);
    await pool.query("ALTER TABLE usage_cost_previews DROP CONSTRAINT test_cost_failure");
    assert.ok((await store.confirmCost(p.orgId, "alice", preview.id)).confirmedAt);
  } finally {
    await Promise.all([store.close(), pool.end()]);
  }
});
