import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import {
  departmentSnapshot,
  resolveUsageDepartment,
  AMBIGUOUS_DEPARTMENT,
  type DepartmentUnit,
} from "../src/usage/usage-departments.ts";
import { buildDepartmentTree } from "../src/usage/usage-department-tree.ts";
import { createPostgresUsageStore } from "../src/usage/postgres-usage-store.ts";
import { confirmUsageDepartment, UsageDepartmentPreviewError } from "../src/usage/usage-department-backfill.ts";
import { dateAt, emptyMetrics, factMetrics, parseUsageQuery, type UsageFact } from "../src/usage/usage-store.ts";
import { isolatedPgTestDatabase } from "./support/isolated-pg-test-database.ts";

const units: DepartmentUnit[] = [
  { id: "root", name: "Organization", parentId: null, kind: "organization", status: "active" },
  { id: "a", name: "A", parentId: "root", kind: "department", status: "active" },
  { id: "b", name: "B", parentId: "root", kind: "department", status: "active" },
  { id: "team", name: "Team", parentId: "a", kind: "team", status: "active" },
  { id: "archived", name: "Archived", parentId: "a", kind: "department", status: "archived" },
];
function fact(id: string, patch: Partial<UsageFact> = {}): UsageFact {
  return {
    orgId: "departments",
    id,
    at: dateAt("2026-10-05"),
    kind: "model",
    principalId: "alice",
    principalName: "Alice",
    projectId: "",
    projectName: "",
    unitId: "",
    unitName: "未分配",
    unitPath: [],
    scopeId: "",
    requestId: id,
    source: "human",
    auth: "organization",
    model: "model",
    harness: "pi",
    state: "success",
    calls: 1,
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0.1,
    costSource: "sdk",
    grain: "call",
    ...patch,
  };
}

test("usage attribution respects explicit primary, sole membership, ambiguity and eligible nodes without changing memberships", () => {
  const members = [{ unitId: "a" }, { unitId: "team", isPrimary: true }, { unitId: "archived" }];
  const copy = structuredClone(members);
  assert.equal(resolveUsageDepartment(units, members).unitId, "team");
  assert.deepEqual(members, copy);
  assert.equal(
    resolveUsageDepartment(units, [{ unitId: "a" }, { unitId: "root", isPrimary: true }, { unitId: "archived" }])
      .unitAttribution,
    "single",
  );
  assert.equal(resolveUsageDepartment(units, [{ unitId: "a" }, { unitId: "b" }]).unitId, AMBIGUOUS_DEPARTMENT);
  assert.equal(
    resolveUsageDepartment(units, [{ unitId: "root" }, { unitId: "archived", isPrimary: true }]).unitAttribution,
    "unassigned",
  );
  assert.deepEqual(departmentSnapshot(units, "team").unitPath, ["team", "a", "root"]);
  assert.throws(
    () =>
      departmentSnapshot(
        units.map((unit) => (unit.id === "a" ? { ...unit, parentId: "team" } : unit)),
        "team",
      ),
    /hierarchy/,
  );
  assert.throws(() => departmentSnapshot(units, "root"), /invalid_department/);
});

test("department trees preserve moved and renamed branches, distinct humans, unknown coverage and independent organization totals", () => {
  const before = departmentSnapshot(units, "team");
  const moved = units.map((unit) => (unit.id === "team" ? { ...unit, parentId: "b", name: "Renamed" } : unit));
  const after = departmentSnapshot(moved, "team");
  const records = [
    fact("old", before),
    fact("new", { ...after, costUsd: null, input: null }),
    fact("r1", { ...before, kind: "request" }),
    fact("r2", { ...after, kind: "request" }),
    fact("r3", { ...after, kind: "request", principalId: "bob" }),
    fact("system", { ...after, kind: "request", principalId: "system", source: "system" }),
    fact("unknown", { unitId: "__historical_unknown__", unitName: "历史归属未知" }),
    fact("ambiguous", { unitId: AMBIGUOUS_DEPARTMENT, unitName: "归属待确认" }),
    fact("unassigned"),
  ];
  const rows = records.map((f, i) => ({
    dims: { ...f },
    metrics: factMetrics(f),
    period: i % 2 ? "2026-10-06" : "2026-10-05",
  }));
  const tree = buildDepartmentTree(rows, moved);
  const total = tree.tree[0]!;
  assert.equal(total.metrics.samples, 5);
  assert.equal(total.metrics.activeUsers, 2);
  assert.equal(total.metrics.knownCost, 4);
  const team = tree.departments.find((node) => node.id === "team")!;
  assert.equal(team.metrics.samples, 2);
  assert.equal(team.metrics.activeUsers, 2);
  assert.equal(team.metrics.knownTokens, 1);
  const branches = tree.tree.filter((node) => node.id === "team");
  assert.equal(branches.length, 2);
  assert.equal(branches.filter((node) => node.historical).length, 1);
  assert.deepEqual(branches.map((node) => node.pathNames).sort(), [
    ["A", "Team"],
    ["B", "Renamed"],
  ]);
  assert.equal(tree.departments.find((node) => node.id === "a")!.directMetrics.samples, 0);
  assert.equal(tree.tree.filter((node) => node.parentKey === total.key && node.id.startsWith("__")).length, 2);
  const empty = buildDepartmentTree([], moved, true);
  assert.equal(empty.tree.length, 4);
  assert.ok(empty.tree.every((node) => node.metrics.samples === 0));
  assert.equal(
    empty.departments.some((node) => node.id === "archived"),
    false,
  );
  assert.deepEqual(
    buildDepartmentTree([], moved).tree.map((node) => node.id),
    [total.id],
  );
});

const url = await isolatedPgTestDatabase(process.env.DATABASE_URL);
test(
  "department correction is scoped, revision checked, atomic, audited and idempotent with concurrent projection and retries",
  { skip: !url },
  async () => {
    const a = createPostgresUsageStore(url!),
      b = createPostgresUsageStore(url!);
    const pool = new pg.Pool({ connectionString: url! });
    const input = { start: "2026-10-05", end: "2026-10-05", reason: "Repair missing attribution" };
    const error = (code: string) => (e: unknown) => e instanceof UsageDepartmentPreviewError && e.code === code;
    const preview = () => a.previewDepartment!("departments", "admin", input);
    const query = parseUsageQuery(
      new URLSearchParams("start=2026-10-05&end=2026-10-05&dimension=department"),
      "departments",
    );
    try {
      await pool.query("CREATE TABLE org_units(org_id text,id text,name text,parent_id text,kind text,status text)");
      await pool.query("CREATE TABLE org_unit_members(org_id text,principal_id text,unit_id text,is_primary boolean)");
      for (const unit of units)
        await pool.query("INSERT INTO org_units VALUES($1,$2,$3,$4,$5,$6)", [
          "departments",
          unit.id,
          unit.name,
          unit.parentId,
          unit.kind,
          unit.status,
        ]);
      await pool.query(
        "INSERT INTO org_unit_members VALUES('departments','alice','team',false),('departments','bob','a',false),('departments','bob','b',false)",
      );
      a.setDirectoryReader!(async () => ({
        department: units.map((unit) => ({ ...unit, status: unit.status as "active" | "archived" })),
      }));
      const original = fact("eligible");
      for (const record of [
        original,
        fact("known", departmentSnapshot(units, "b")),
        fact("pending", { state: "pending" }),
        fact("unknown", { principalId: "__historical_unknown__" }),
        fact("ambiguous", { principalId: "bob" }),
        fact("other", { orgId: "other" }),
      ])
        await a.put(record);
      await a.project("departments");
      const before = (await a.report(query)).total;
      const p = await preview();
      assert.equal(p.eligible, 1);
      assert.equal(p.pending, 1);
      assert.equal(p.missingIdentity, 1);
      assert.equal(p.unresolved, 1);
      assert.equal((await a.get("departments", "eligible"))!.unitId, "");
      assert.equal(p.changes[0]!.basis, "single");
      await assert.rejects(b.confirmDepartment!("other", "admin", p.id), error("not_found"));
      await assert.rejects(b.confirmDepartment!("departments", "other", p.id), error("not_found"));
      await assert.rejects(confirmUsageDepartment(pool, "departments", "admin", p.id, p.expiresAt), error("expired"));
      await pool.query("UPDATE org_units SET name='Changed' WHERE id='a'");
      await assert.rejects(b.confirmDepartment!("departments", "admin", p.id), error("stale"));
      await pool.query("UPDATE org_units SET name='A' WHERE id='a'");
      await a.put(fact("eligible", { input: 200 }));
      await assert.rejects(b.confirmDepartment!("departments", "admin", p.id), error("stale"));
      await a.put(original);
      const current = await preview();
      await pool.query(
        "CREATE FUNCTION fail_department_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failed'; END $$",
      );
      await pool.query(
        "CREATE TRIGGER fail_audit BEFORE INSERT ON usage_department_changes FOR EACH ROW EXECUTE FUNCTION fail_department_audit()",
      );
      await assert.rejects(a.confirmDepartment!("departments", "admin", current.id), /audit failed/);
      assert.equal((await a.get("departments", "eligible"))!.unitId, "");
      await pool.query("DROP TRIGGER fail_audit ON usage_department_changes");
      const confirmations = await Promise.all([
        a.confirmDepartment!("departments", "admin", current.id),
        b.confirmDepartment!("departments", "admin", current.id),
        a.project("departments"),
      ]);
      assert.equal(confirmations[0].confirmedAt, confirmations[1].confirmedAt);
      await a.project("departments");
      const saved = (await a.get("departments", "eligible"))!;
      assert.equal(saved.unitId, "team");
      assert.equal(saved.unitAttribution, "correction");
      assert.equal(saved.costUsd, original.costUsd);
      assert.deepEqual((await a.report(query)).total, before);
      assert.equal((await pool.query("SELECT changes FROM usage_department_changes")).rows.length, 1);
      await a.put(fact("eligible", { input: 200, unitAttribution: "single" }));
      assert.equal((await a.get("departments", "eligible"))!.unitAttribution, "correction");
      await a.project("departments");
      assert.equal((await a.report(query)).total.samples, before.samples);
      const report = await a.report({ ...query, departments: ["a"] });
      assert.equal(report.total.samples, 1);
      assert.equal(report.departmentTree!.find((node) => node.id === "a")!.metrics.samples, 1);
      assert.equal((await a.details({ ...query, departments: ["a"], departmentScope: "direct" })).total, 0);
      const trends = await a.trends!({ ...query, departments: ["a"] }, "tokens");
      assert.equal(trends.items.find((node) => node.id === "a")!.metrics.input, 200);
      assert.match(await a.export(query, true), /含子部门/);
      assert.match(await a.export(query, false), /unitAttribution/);
      await assert.rejects(
        a.previewDepartment!("departments", "admin", { ...input, replace: true, unitId: "a" }),
        error("invalid"),
      );
      await assert.rejects(
        a.previewDepartment!("departments", "admin", { ...input, unitId: "archived" }),
        error("invalid"),
      );
      await assert.rejects(
        a.previewDepartment!("departments", "admin", { ...input, unitId: "root" }),
        error("invalid"),
      );
      await assert.rejects(a.previewDepartment!("departments", "admin", { ...input, reason: "" }), error("invalid"));
      const archivePreview = await a.previewDepartment!("departments", "admin", {
        ...input,
        recordIds: ["ambiguous"],
        unitId: "a",
      });
      await pool.query("UPDATE org_units SET status='archived' WHERE id='a'");
      await assert.rejects(a.confirmDepartment!("departments", "admin", archivePreview.id), error("stale"));
      await pool.query("UPDATE org_units SET status='active' WHERE id='a'");
      const overwrite = await a.previewDepartment!("departments", "admin", {
        ...input,
        replace: true,
        recordIds: ["known"],
        unitId: "a",
      });
      assert.equal(overwrite.overwritten, 1);
      await a.confirmDepartment!("departments", "admin", overwrite.id);
      assert.equal((await a.get("departments", "known"))!.unitId, "a");
      assert.equal((await a.get("other", "other"))!.unitId, "");
      assert.deepEqual((await a.report({ ...query, departments: ["not-a-unit"] })).total, emptyMetrics());
      await pool.query(
        "INSERT INTO usage_facts(org_id,id,day,fact,updated_at) SELECT 'limit-org','limit-'||n,'2026-10-05',$1::jsonb,0 FROM generate_series(1,10001) n",
        [JSON.stringify(original)],
      );
      await assert.rejects(a.previewDepartment!("limit-org", "admin", input), error("too_large"));
    } finally {
      await Promise.all([a.close(), b.close(), pool.end()]);
    }
  },
);
