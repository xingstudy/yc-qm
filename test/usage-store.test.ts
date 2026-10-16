import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { createPostgresUsageStore } from "../src/usage/postgres-usage-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { createUsageService } from "../src/usage/usage-service.ts";
import {
  csvCell,
  dateAt,
  factMetrics,
  parseUsageQuery,
  previousQuery,
  usageDay,
  type UsageFact,
} from "../src/usage/usage-store.ts";
import { scopeId } from "../src/types.ts";
import { isolatedPgTestDatabase } from "./support/isolated-pg-test-database.ts";

const url = await isolatedPgTestDatabase(process.env.DATABASE_URL);

test(
  "dimension trends select stable top objects and respect shared filters, coverage and natural periods",
  { skip: !url },
  async () => {
    const store = createPostgresUsageStore(url!);
    try {
      for (let i = 0; i < 7; i++) {
        await store.put(
          usageFact(`panel-${i}`, {
            orgId: "panel-org",
            principalId: `user-${i}`,
            principalName: `User ${i}`,
            projectId: `p-${i}`,
            model: `model-${i}`,
            input: i * 100,
            output: 0,
            cacheRead: 0,
            costUsd: i === 6 ? null : i / 100,
          }),
        );
        await store.put(
          usageFact(`panel-next-${i}`, {
            orgId: "panel-org",
            at: dateAt("2026-10-06"),
            principalId: `user-${i}`,
            principalName: `User ${i}`,
            projectId: `p-${i}`,
            model: `model-${i}`,
            input: i * 200,
            output: 0,
            cacheRead: 0,
            costUsd: i === 6 ? null : i / 100,
          }),
        );
      }
      await store.put(usageFact("other-org", { orgId: "other-panel-org", input: 1_000_000 }));
      await store.project("panel-org");
      await store.project("other-panel-org");
      const query = parseUsageQuery(new URLSearchParams("start=2026-10-05&end=2026-10-07&dimension=user"), "panel-org");
      const trend = await store.trends!(query, "tokens");
      assert.equal(trend.length, 5);
      assert.equal(trend[0]!.id, "user-6");
      assert.deepEqual(
        trend[0]!.series.map((p) => p.period),
        ["2026-10-05", "2026-10-06"],
      );
      assert.equal(trend[0]!.series[0]!.metrics.knownCost, 0);
      assert.equal(trend[0]!.metrics.input, 1800);
      const cost = await store.trends!(query, "costUsd");
      assert.equal(cost[0]!.id, "user-5");
      const filtered = await store.trends!({ ...query, projects: ["p-1"], departments: ["company"] }, "tokens");
      assert.equal(filtered.length, 1);
      assert.equal(filtered[0]!.id, "user-1");
      const weekly = await store.trends!({ ...query, dimension: "model", granularity: "week" }, "tokens");
      assert.equal(weekly[0]!.id, "model-6");
      assert.equal(weekly[0]!.series.length, 1);
      assert.equal(weekly[0]!.series[0]!.period, "2026-10-05");
      assert.deepEqual(await store.trends!({ ...query, users: ["absent"] }, "activeUsers"), []);
    } finally {
      await store.close();
    }
  },
);

function usageFact(id: string, patch: Partial<UsageFact> = {}): UsageFact {
  return {
    id,
    orgId: "acme",
    at: dateAt("2026-10-05"),
    kind: "model",
    principalId: "alice",
    principalName: "Alice",
    projectId: "p1",
    projectName: "Project One",
    unitId: "engineering",
    unitName: "Engineering",
    unitPath: ["engineering", "company"],
    unitAncestors: [
      { id: "engineering", name: "Engineering" },
      { id: "company", name: "Company" },
    ],
    scopeId: "group:web-project-p1",
    source: "human",
    auth: "organization",
    requestId: "r1",
    state: "success",
    harness: "pi",
    model: "test-model",
    calls: 1,
    input: 100,
    output: 20,
    cacheRead: 10,
    cacheWrite: 0,
    costUsd: 0.02,
    costSource: "estimate",
    grain: "call",
    ...patch,
  };
}

test(
  "Project display names resolve current directory across usage views without rewriting facts",
  { skip: !url },
  async () => {
    const store = createPostgresUsageStore(url!);
    const orgId = "project-name-org";
    let currentName = "Current Project";
    try {
      await store.put(usageFact("name-old", { orgId, projectName: "Old Project" }));
      await store.put(usageFact("name-id", { orgId, projectName: "p1" }));
      await store.put(usageFact("name-unknown", { orgId, projectId: "missing", projectName: "missing" }));
      await store.put(usageFact("name-foreign", { orgId: "foreign-name-org", projectName: "Foreign Project" }));
      await store.project(orgId);
      store.setDirectoryReader?.(async (requestedOrg) => {
        assert.equal(requestedOrg, orgId);
        return {
          project: [
            { id: "p1", name: currentName, status: "active" },
            { id: "unused", name: "Unused Project", status: "active" },
          ],
        };
      });
      const query = parseUsageQuery(new URLSearchParams("start=2026-10-05&end=2026-10-05&dimension=project"), orgId);
      for (const name of ["Current Project", "Renamed Project"]) {
        currentName = name;
        const report = await store.report(query);
        assert.equal(report.breakdown.find((row) => row.id === "p1")?.name, name);
        assert.equal(report.breakdown.filter((row) => row.id === "p1").length, 1);
        assert.equal(report.breakdown.find((row) => row.id === "missing")?.name, "名称未知 Project · missing");
        assert.equal((await store.trends!(query, "tokens")).find((row) => row.id === "p1")?.name, name);
        const facets = await store.facets(orgId);
        assert.equal(facets.project.find((row) => row.id === "p1")?.name, name);
        assert.ok(facets.project.some((row) => row.name === "Unused Project"));
        assert.ok(!facets.project.some((row) => row.name === "Foreign Project"));
        const details = await store.details({ ...query, projects: ["p1"] });
        assert.equal(details.records.length, 2);
        assert.ok(details.records.every((row) => row.projectDisplayName === name));
        assert.ok((await store.export({ ...query, projects: ["p1"] }, true)).includes(`"${name}"`));
        assert.ok((await store.export({ ...query, projects: ["p1"] }, false)).includes(`"${name}"`));
      }
      assert.equal((await store.get(orgId, "name-old"))?.projectName, "Old Project");
      assert.equal((await store.get(orgId, "name-id"))?.projectName, "p1");
      assert.equal((await store.get(orgId, "name-old"))?.costUsd, 0.02);
      store.setDirectoryReader?.(async () => {
        throw new Error("directory unavailable");
      });
      await assert.rejects(store.report(query), /directory unavailable/);
      await assert.rejects(store.details(query), /directory unavailable/);
    } finally {
      await store.close();
    }
  },
);

test("usage dates use inclusive Beijing days, strict calendars and independent grain", () => {
  assert.equal(usageDay(Date.parse("2026-10-04T16:00:00Z")), "2026-10-05");
  assert.throws(() => dateAt("2026-02-30"));
  assert.throws(() => parseUsageQuery(new URLSearchParams("start=2026-10-07&end=2026-10-01"), "acme"));
  const query = parseUsageQuery(
    new URLSearchParams(
      "start=2026-10-05&end=2026-10-11&granularity=month&user=alice&user=bob&user=alice&department=company",
    ),
    "acme",
  );
  assert.deepEqual(query.users, ["alice", "bob"]);
  assert.equal(query.granularity, "month");
  assert.equal(previousQuery(query).start, "2026-09-28");
  assert.equal(previousQuery(query).end, "2026-10-04");
  assert.equal(csvCell(' =HYPERLINK("bad")'), '"\' =HYPERLINK(""bad"")"');
  assert.equal(csvCell(null), '"未知"');
  assert.equal(factMetrics(usageFact("unknown", { input: null, costUsd: null, calls: null })).knownTokens, 0);
  assert.throws(() => parseUsageQuery(new URLSearchParams("rankBy=bad"), "acme"));
});

test(
  "usage ranking sorts by the selected metric before truncation and facets include unused directory objects",
  { skip: !url },
  async () => {
    const store = createPostgresUsageStore(url!);
    const orgId = "ranking-org";
    try {
      for (let i = 0; i < 205; i++)
        await store.put(
          usageFact(`rank:${i}`, {
            orgId,
            principalId: `user${i}`,
            principalName: `User ${i}`,
            calls: 205 - i,
            input: i === 204 ? 1_000_000 : 1,
            costUsd: i === 204 ? 100 : 0,
          }),
        );
      await store.project(orgId, 500);
      const query = parseUsageQuery(new URLSearchParams("start=2026-10-05&end=2026-10-05&rankBy=tokens"), orgId);
      assert.equal((await store.report(query)).breakdown[0]?.id, "user204");
      assert.equal((await store.report({ ...query, rankBy: "costUsd" })).breakdown[0]?.id, "user204");
      assert.equal((await store.report({ ...query, rankBy: "calls" })).breakdown[0]?.id, "user0");
      store.setDirectoryReader?.(async () => ({
        user: [{ id: "unused", name: "Unused user", status: "active" }],
        project: [{ id: "new-project", name: "New project", status: "active" }],
      }));
      const facets = await store.facets(orgId);
      assert.ok(facets.user.some((u) => u.id === "unused"));
      assert.ok(facets.project.some((p) => p.id === "new-project"));
      assert.equal((await store.report({ ...query, users: ["unused"] })).total.requests, 0);
    } finally {
      await store.close();
    }
  },
);

test(
  "usage projection is idempotent across instances, retains attribution and counts distinct humans",
  { skip: !url },
  async () => {
    const a = createPostgresUsageStore(url!);
    const b = createPostgresUsageStore(url!);
    const q = parseUsageQuery(new URLSearchParams("start=2026-10-05&end=2026-10-11&granularity=week"), "acme");
    try {
      const request = usageFact("request:r1", {
        kind: "request",
        calls: null,
        input: null,
        output: null,
        costUsd: null,
      });
      await Promise.all([a.put(request, true), b.put(request, true), a.put(usageFact("call:1"))]);
      await a.put(
        usageFact("request:r2", {
          kind: "request",
          requestId: "r2",
          at: dateAt("2026-10-06"),
          calls: null,
          input: null,
          output: null,
          costUsd: null,
        }),
      );
      await a.put(
        usageFact("request:r3", {
          kind: "request",
          principalId: "bob",
          principalName: "Bob",
          requestId: "r3",
          source: "automation",
        }),
      );
      await a.put(usageFact("auto:1", { principalId: "bob", principalName: "Bob", source: "automation" }));
      await a.put(usageFact("other", { orgId: "other-org", input: 9000 }));
      await Promise.all([a.project("acme"), b.project("acme")]);
      await b.project("acme");
      let report = await a.report(q);
      assert.equal(report.total.requests, 2);
      assert.equal(report.total.activeUsers, 1);
      assert.equal(report.total.calls, 2);
      assert.equal(report.total.input, 200);
      assert.ok(report.series[0]);
      assert.equal(report.series[0].period, "2026-10-05");
      assert.equal(report.series[0].metrics.activeUsers, 1);
      assert.equal((await a.facets("acme")).department.find((item) => item.id === "company")?.name, "Company");
      const parent = await a.report({ ...q, departments: ["company"], projects: ["p1"], users: ["alice"] });
      assert.equal(parent.total.input, 100);
      assert.equal(parent.total.requests, 2);
      await a.put(
        usageFact("call:1", {
          input: 150,
          costUsd: null,
          principalId: "moved",
          unitId: "new-unit",
          unitPath: ["new-unit"],
          at: dateAt("2026-10-12"),
        }),
      );
      await Promise.all([a.project("acme"), b.project("acme")]);
      report = await b.report(q);
      assert.equal(report.total.input, 250);
      assert.equal(report.total.knownCost, 1);
      assert.equal((await b.get("acme", "call:1"))?.principalId, "alice");
      assert.equal((await b.get("acme", "call:1"))?.unitId, "engineering");
      assert.equal((await b.get("acme", "call:1"))?.at, dateAt("2026-10-05"));
      await a.put({ ...request, state: "failed" });
      await a.project("acme");
      report = await b.report(q);
      assert.equal(report.total.requests, 2);
      assert.equal(report.total.failed, 1);
      assert.equal(report.total.success, 1);
      const details = await a.details({ ...q, limit: 2, offset: 0 });
      const next = await a.details({ ...q, limit: 2, offset: 2 });
      assert.equal(details.total, 5);
      assert.ok(!next.records.some((r) => details.records.some((first) => r.id === first.id)));
      const csv = await a.export({ ...q, users: ["alice"] }, false);
      assert.ok(csv.includes('"Engineering"'));
      assert.ok(!csv.includes('"Bob"'));
      a.setLifecycleReader?.(async () => ({
        user: { alice: "deprovisioned" },
        project: {},
        department: { engineering: "archived", company: "active" },
      }));
      assert.equal((await a.report(q)).breakdown.find((item) => item.id === "alice")?.status, "deprovisioned");
      assert.equal((await a.facets("acme")).project[0]?.status, "deleted");
      const historicalDetail = (await a.details({ ...q, users: ["alice"] })).records[0];
      assert.equal(historicalDetail?.principalName, "Alice");
      assert.equal(historicalDetail?.principalStatus, "deprovisioned");
      assert.equal(historicalDetail?.projectStatus, "deleted");
      assert.equal(historicalDetail?.unitStatus, "archived");
      assert.ok((await a.export({ ...q, users: ["alice"] }, false)).includes('"deprovisioned"'));
      await a.put(usageFact("call:1", { input: null, costUsd: null }));
      await a.project("acme");
      assert.equal((await a.report(q)).status.unresolved, 1);
      await a.put(usageFact("call:1", { input: 150, costUsd: null }));
      await a.project("acme");
      assert.equal((await a.report(q)).status.unresolved, 0);
      await a.close();
      const reopened = createPostgresUsageStore(url!);
      assert.equal((await reopened.report(q)).total.input, 250);
      assert.equal(await reopened.project("acme"), 0);
      await reopened.close();
    } finally {
      await a.close();
      await b.close();
    }
  },
);

test(
  "legacy backfill is bounded, durable, repeatable, excludes realtime and survives source deletion",
  { skip: !url },
  async () => {
    const sessions = createPostgresSessionStore(url!);
    const usage = createPostgresUsageStore(url!);
    const pool = new pg.Pool({ connectionString: url });
    const scope = scopeId("personal", "legacy");
    const session = await sessions.getOrCreateByThread("legacy-usage", "dm", scope);
    const rec = {
      turnSeq: null,
      step: 0,
      model: "historical-model",
      scopeLabel: scope,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, costUsd: 0 },
    };
    try {
      for (let i = 0; i < 3; i++)
        await sessions.recordLlmRequest(session.id, { ...rec, step: i, promptEnvelope: { secret: "DO NOT STORE" } });
      assert.equal(await usage.backfill("legacy-org", 2), 2);
      assert.equal(await usage.backfill("legacy-org", 2), 1);
      assert.equal(await usage.backfill("legacy-org", 2), 0);
      const service = createUsageService(usage, "legacy-org", async () => ({
        principalName: "",
        projectId: "",
        projectName: "",
        unitId: "",
        unitName: "",
        unitPath: [],
      }));
      await service.system(() => sessions.recordLlmRequest(session.id, { ...rec, step: 3 }));
      assert.equal(await usage.backfill("legacy-org"), 0);
      await sessions.recordLlmRequest(session.id, { ...rec, step: 4 });
      assert.equal(await usage.backfill("legacy-org"), 1);
      await usage.project("legacy-org");
      const q = parseUsageQuery(new URLSearchParams(), "legacy-org");
      assert.equal((await usage.report(q)).total.input, 40);
      assert.equal((await usage.report(q)).total.calls, 0);
      assert.equal((await usage.report(q)).total.unknownCalls, 4);
      assert.equal((await usage.report(q)).total.knownCost, 0);
      assert.equal((await usage.report(q)).status.historical, 4);
      const rows = await usage.details(q);
      assert.ok(rows.records.every((r) => r.unitId === "__historical_unknown__"));
      assert.ok(!JSON.stringify(rows).includes("DO NOT STORE"));
      await pool.query("DELETE FROM session_llm_requests WHERE session_id=$1", [session.id]);
      await pool.query("DELETE FROM sessions WHERE id=$1", [session.id]);
      assert.equal((await usage.details(q)).total, 4);
    } finally {
      await usage.close();
      await pool.end();
    }
  },
);
