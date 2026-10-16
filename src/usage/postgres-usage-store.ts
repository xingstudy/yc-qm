import { createPgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { previewUsageCost, confirmUsageCost } from "./usage-cost-backfill.ts";
import { projectDisplayName } from "../../plugins/chassis/src/project-label.js";
import {
  bucket,
  csvCell,
  emptyMetrics,
  factMetrics,
  METRIC_KEYS,
  previousQuery,
  validateFact,
  type UsageFact,
  type UsageMetrics,
  type UsageQuery,
  type UsageStore,
  type UsageDimension,
  type UsageLifecycle,
  type UsageLifecycleReader,
  type UsageObjectStatus,
} from "./usage-store.ts";

const SELECT_METRICS =
  METRIC_KEYS.map((key) => `COALESCE(SUM((metrics->>'${key}')::numeric),0) AS "${key}"`).join(",") +
  `,COUNT(DISTINCT NULLIF(dims->>'principalId','')) FILTER (WHERE (metrics->>'requests')::numeric > 0) AS "activeUsers"`;
const ID_FIELDS = {
  user: "principalId",
  project: "projectId",
  department: "unitId",
  model: "model",
  source: "source",
  auth: "auth",
};
const NAME_FIELDS = {
  user: "principalName",
  project: "projectName",
  department: "unitName",
  model: "model",
  source: "source",
  auth: "auth",
};
const RANK_SQL = {
  tokens: ["input", "output", "cacheRead", "cacheWrite"]
    .map((key) => `COALESCE(SUM((metrics->>'${key}')::numeric),0)`)
    .join("+"),
  calls: '"calls"',
  requests: '"requests"',
  costUsd: '"costUsd"',
  activeUsers: '"activeUsers"',
};

function metrics(row: Record<string, unknown> | undefined): UsageMetrics {
  const value = emptyMetrics();
  for (const key of [...METRIC_KEYS, "activeUsers"] as const) value[key] = Number(row?.[key] ?? 0);
  return value;
}

function where(query: UsageQuery, facts = false): { sql: string; values: unknown[] } {
  const values: unknown[] = [query.orgId, query.start, query.end];
  const conditions = ["org_id=$1", "day >= $2", "day <= $3"];
  const d = facts ? "fact" : "dims";
  for (const [filter, field] of [
    [query.users, "principalId"],
    [query.projects, "projectId"],
    [query.models, "model"],
    [query.sources, "source"],
    [query.auth, "auth"],
  ] as const) {
    if (!filter.length) continue;
    values.push(filter);
    conditions.push(`${d}->>'${field}' = ANY($${values.length}::text[])`);
  }
  if (query.departments.length) {
    values.push(query.departments);
    conditions.push(
      `(${d}->>'unitId' = ANY($${values.length}::text[]) OR ${d}->'unitPath' ?| $${values.length}::text[])`,
    );
  }
  return { sql: conditions.join(" AND "), values };
}

export function createPostgresUsageStore(connectionString: string): UsageStore {
  let lifecycleReader: UsageLifecycleReader | undefined;
  let directoryReader: Parameters<NonNullable<UsageStore["setDirectoryReader"]>>[0] | undefined;
  const projectNames = async (orgId: string) =>
    new Map(((await directoryReader?.(orgId))?.project ?? []).map((project) => [project.id, project.name]));
  const displayProject = (id: string, historical: string, names: Map<string, string>): string => {
    if (id) return projectDisplayName(id, names.get(id) || historical, "名称未知项目");
    return !historical || historical === "无 Project" ? "非项目" : historical;
  };
  const lifecycleStatus = (
    states: UsageLifecycle | undefined,
    dimension: UsageDimension,
    id: string,
  ): UsageObjectStatus | undefined => {
    if (!states || !id || id === "__historical_unknown__" || !(dimension in states)) return undefined;
    return states[dimension as keyof UsageLifecycle][id] ?? (dimension === "user" ? "unknown" : "deleted");
  };
  const recordStatus = (
    fact: UsageFact,
    states: UsageLifecycle | undefined,
    names: Map<string, string>,
  ): UsageFact => ({
    ...fact,
    projectDisplayName: displayProject(fact.projectId, fact.projectName, names),
    principalStatus: lifecycleStatus(states, "user", fact.principalId),
    projectStatus: lifecycleStatus(states, "project", fact.projectId),
    unitStatus: lifecycleStatus(states, "department", fact.unitId),
  });
  const db = createPgPool(connectionString, [
    {
      id: "usage/ledger/0001",
      statements: [
        `CREATE TABLE IF NOT EXISTS usage_facts(org_id TEXT NOT NULL,id TEXT NOT NULL,day TEXT NOT NULL,
      fact JSONB NOT NULL,projected JSONB,dirty BOOLEAN NOT NULL DEFAULT TRUE,updated_at BIGINT NOT NULL,
      PRIMARY KEY(org_id,id))`,
        `CREATE INDEX IF NOT EXISTS usage_facts_dirty ON usage_facts(org_id,updated_at) WHERE dirty`,
        `CREATE INDEX IF NOT EXISTS usage_facts_day ON usage_facts(org_id,day,id)`,
        `CREATE INDEX IF NOT EXISTS usage_facts_user ON usage_facts(org_id,(fact->>'principalId'),day)`,
        `CREATE INDEX IF NOT EXISTS usage_facts_project ON usage_facts(org_id,(fact->>'projectId'),day)`,
        `CREATE TABLE IF NOT EXISTS usage_daily(org_id TEXT NOT NULL,bucket TEXT NOT NULL,day TEXT NOT NULL,
      dims JSONB NOT NULL,metrics JSONB NOT NULL,PRIMARY KEY(org_id,bucket))`,
        `CREATE INDEX IF NOT EXISTS usage_daily_day ON usage_daily(org_id,day)`,
        `CREATE INDEX IF NOT EXISTS usage_daily_user ON usage_daily(org_id,(dims->>'principalId'),day)`,
        `CREATE INDEX IF NOT EXISTS usage_daily_project ON usage_daily(org_id,(dims->>'projectId'),day)`,
        `CREATE INDEX IF NOT EXISTS usage_daily_units ON usage_daily USING GIN ((dims->'unitPath'))`,
        `CREATE TABLE IF NOT EXISTS usage_projection_state(org_id TEXT PRIMARY KEY,updated_at BIGINT NOT NULL)`,
      ],
    },
    {
      id: "usage/ledger/0002",
      statements: [
        `ALTER TABLE usage_projection_state ADD COLUMN IF NOT EXISTS unresolved BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS historical BIGINT NOT NULL DEFAULT 0,ADD COLUMN IF NOT EXISTS first_day TEXT`,
        `INSERT INTO usage_projection_state(org_id,updated_at,unresolved,historical,first_day)
      SELECT org_id,0,SUM((metrics->>'samples')::numeric-(metrics->>'knownTokens')::numeric),
        COALESCE(SUM((metrics->>'samples')::numeric) FILTER(WHERE dims->>'source'='history'),0),MIN(day)
      FROM usage_daily GROUP BY org_id ON CONFLICT(org_id) DO UPDATE SET
        unresolved=EXCLUDED.unresolved,historical=EXCLUDED.historical,first_day=EXCLUDED.first_day`,
      ],
    },
    {
      id: "usage/ledger/0003",
      statements: [
        `CREATE TABLE IF NOT EXISTS usage_cost_previews(org_id TEXT NOT NULL,id TEXT NOT NULL,preview JSONB NOT NULL,PRIMARY KEY(org_id,id))`,
        `CREATE INDEX IF NOT EXISTS usage_facts_model ON usage_facts(org_id,(fact->>'model'),day)`,
      ],
    },
  ]);
  const store: UsageStore = {
    async previewCost(orgId, actorId, price, input) {
      await db.q("SELECT 1");
      return previewUsageCost(await db.pool(), orgId, actorId, price, input);
    },
    async confirmCost(orgId, actorId, previewId) {
      await db.q("SELECT 1");
      return confirmUsageCost(await db.pool(), orgId, actorId, previewId);
    },
    setLifecycleReader(reader) {
      lifecycleReader = reader;
    },
    setDirectoryReader(reader) {
      directoryReader = reader;
    },
    async put(fact, insertOnly = false) {
      validateFact(fact);
      const b = bucket(fact);
      await db.q(
        `INSERT INTO usage_facts(org_id,id,day,fact,updated_at) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(org_id,id) ${
          insertOnly
            ? "DO NOTHING"
            : `DO UPDATE SET
          fact=EXCLUDED.fact || jsonb_build_object('at',usage_facts.fact->'at',
            'principalId',usage_facts.fact->'principalId','principalName',usage_facts.fact->'principalName',
            'projectId',usage_facts.fact->'projectId','projectName',usage_facts.fact->'projectName',
            'unitId',usage_facts.fact->'unitId','unitName',usage_facts.fact->'unitName','unitPath',usage_facts.fact->'unitPath',
            'unitAncestors',COALESCE(usage_facts.fact->'unitAncestors','[]'::jsonb),
            'scopeId',usage_facts.fact->'scopeId','source',usage_facts.fact->'source','requestId',usage_facts.fact->'requestId',
            'kind',usage_facts.fact->'kind') || CASE WHEN usage_facts.fact->'costBackfill' IS NOT NULL THEN
              jsonb_build_object('costBackfill',usage_facts.fact->'costBackfill') || CASE WHEN
                EXCLUDED.fact->>'costSource'='sdk' AND EXCLUDED.fact->>'costUsd' IS NOT NULL THEN '{}'::jsonb ELSE
                jsonb_build_object('costUsd',usage_facts.fact->'costUsd','costSource',usage_facts.fact->'costSource','price',usage_facts.fact->'price') END
              ELSE '{}'::jsonb END,dirty=TRUE,
          updated_at=EXCLUDED.updated_at WHERE
            (usage_facts.fact - ARRAY['at','principalId','principalName','projectId','projectName','unitId','unitName','unitPath','unitAncestors','scopeId','source','requestId','kind'])
            IS DISTINCT FROM
            (EXCLUDED.fact - ARRAY['at','principalId','principalName','projectId','projectName','unitId','unitName','unitPath','unitAncestors','scopeId','source','requestId','kind'])
            AND COALESCE((usage_facts.fact->>'attempt')::int,0) <= COALESCE((EXCLUDED.fact->>'attempt')::int,0)`
        }`,
        [fact.orgId, fact.id, b.day, JSON.stringify(fact), Date.now()],
      );
    },
    async get(orgId, id) {
      const rows = await db.q("SELECT fact FROM usage_facts WHERE org_id=$1 AND id=$2", [orgId, id]);
      return (rows[0]?.fact as UsageFact) ?? null;
    },
    async backfill(orgId, limit = 250) {
      const tables = await db.q(
        "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='session_llm_requests' AND column_name='usage_metered') AS ready",
      );
      if (!tables[0]?.ready) return 0;
      return withPgTransaction(await db.pool(), async (client) => {
        const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [
          "usage:history",
        ]);
        if (!lock.rows[0]?.acquired) return 0;
        const records = await client.query(
          `SELECT id,created_at,scope_label,model,usage_json FROM session_llm_requests
          WHERE NOT usage_metered ORDER BY created_at,id LIMIT $1 FOR UPDATE`,
          [limit],
        );
        const value = (input: unknown): number | null =>
          typeof input === "number" && Number.isFinite(input) && input >= 0 ? input : null;
        for (const row of records.rows) {
          let usage: Record<string, unknown>;
          try {
            usage = JSON.parse(row.usage_json ?? "{}") ?? {};
          } catch {
            usage = {};
          }
          const scopeId = String(row.scope_label);
          const projectId = scopeId.startsWith("group:web-project-") ? scopeId.slice(18) : "";
          const fact: UsageFact = {
            orgId,
            id: `history:llm:${row.id}`,
            at: Number(row.created_at),
            kind: "model",
            principalId: "__historical_unknown__",
            principalName: "历史归属未知",
            projectId,
            projectName: projectId || "无 Project",
            unitId: "__historical_unknown__",
            unitName: "历史归属未知",
            unitPath: [],
            scopeId,
            requestId: `history:${row.id}`,
            source: "history",
            auth: "unknown",
            model: String(row.model),
            harness: "unknown",
            state: "unknown",
            calls: null,
            input: value(usage.input),
            output: value(usage.output),
            cacheRead: value(usage.cacheRead),
            cacheWrite: value(usage.cacheWrite),
            costUsd: value(usage.costUsd),
            costSource: "unknown",
            grain: "history",
          };
          if (fact.costUsd === 0) fact.costUsd = null;
          validateFact(fact);
          await client.query(
            `INSERT INTO usage_facts(org_id,id,day,fact,updated_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [orgId, fact.id, bucket(fact).day, JSON.stringify(fact), Date.now()],
          );
          await client.query("UPDATE session_llm_requests SET usage_metered=TRUE WHERE id=$1", [row.id]);
        }
        return records.rows.length;
      });
    },
    async project(orgId, limit = 500) {
      await db.q("SELECT 1");
      return withPgTransaction(await db.pool(), async (client) => {
        const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired", [
          `usage:${orgId}`,
        ]);
        if (!lock.rows[0]?.acquired) return 0;
        const result = await client.query(
          "SELECT id,fact,projected FROM usage_facts WHERE org_id=$1 AND dirty ORDER BY updated_at,id LIMIT $2 FOR UPDATE",
          [orgId, limit],
        );
        const changes = new Map<string, { day: string; dimensions: Record<string, unknown>; delta: UsageMetrics }>();
        let unresolved = 0;
        let historical = 0;
        let firstDay: string | undefined;
        const change = (fact: UsageFact, sign: number) => {
          const b = bucket(fact);
          const row = changes.get(b.key) ?? { day: b.day, dimensions: b.dimensions, delta: emptyMetrics() };
          const m = factMetrics(fact);
          unresolved += sign * (m.samples - m.knownTokens);
          historical += fact.source === "history" ? sign * m.samples : 0;
          if (sign > 0 && (!firstDay || b.day < firstDay)) firstDay = b.day;
          for (const key of METRIC_KEYS) row.delta[key] += sign * m[key];
          changes.set(b.key, row);
        };
        for (const row of result.rows) {
          if (row.projected) change(row.projected as UsageFact, -1);
          change(row.fact as UsageFact, 1);
        }
        for (const [key, row] of changes) {
          const addition = METRIC_KEYS.map(
            (name) => `'${name}',(usage_daily.metrics->>'${name}')::numeric+(EXCLUDED.metrics->>'${name}')::numeric`,
          ).join(",");
          await client.query(
            `INSERT INTO usage_daily(org_id,bucket,day,dims,metrics) VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(org_id,bucket) DO UPDATE SET metrics=jsonb_build_object(${addition})`,
            [orgId, key, row.day, JSON.stringify(row.dimensions), JSON.stringify(row.delta)],
          );
        }
        if (result.rows.length) {
          await client.query(
            "UPDATE usage_facts SET projected=fact,dirty=FALSE WHERE org_id=$1 AND id=ANY($2::text[])",
            [orgId, result.rows.map((row) => row.id)],
          );
          await client.query(
            `INSERT INTO usage_projection_state(org_id,updated_at,unresolved,historical,first_day) VALUES($1,$2,$3,$4,$5)
              ON CONFLICT(org_id) DO UPDATE SET updated_at=EXCLUDED.updated_at,
                unresolved=usage_projection_state.unresolved+EXCLUDED.unresolved,
                historical=usage_projection_state.historical+EXCLUDED.historical,
                first_day=LEAST(usage_projection_state.first_day,EXCLUDED.first_day)`,
            [orgId, Date.now(), unresolved, historical, firstDay],
          );
        }
        return result.rows.length;
      });
    },
    async report(query) {
      await db.q("SELECT 1");
      const states = await lifecycleReader?.(query.orgId);
      const names = query.dimension === "project" ? await projectNames(query.orgId) : new Map<string, string>();
      return withPgTransaction(await db.pool(), async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const q = async (sql: string, values: unknown[]) => (await client.query(sql, values)).rows;
        const filter = where(query);
        const prev = where(previousQuery(query));
        const period =
          query.granularity === "day" ? "day" : `to_char(date_trunc('${query.granularity}',day::date),'YYYY-MM-DD')`;
        const field = ID_FIELDS[query.dimension];
        const label = NAME_FIELDS[query.dimension];
        const total = await q(`SELECT ${SELECT_METRICS} FROM usage_daily WHERE ${filter.sql}`, filter.values);
        const previous = await q(`SELECT ${SELECT_METRICS} FROM usage_daily WHERE ${prev.sql}`, prev.values);
        const series = await q(
          `SELECT ${period} AS period,${SELECT_METRICS} FROM usage_daily WHERE ${filter.sql} GROUP BY 1 ORDER BY 1`,
          filter.values,
        );
        const ranking = RANK_SQL[query.rankBy ?? "calls"];
        const breakdown = await q(
          `SELECT dims->>'${field}' AS id,MAX(dims->>'${label}') AS name,${SELECT_METRICS}
          FROM usage_daily WHERE ${filter.sql} GROUP BY 1 HAVING SUM((metrics->>'requests')::numeric)+SUM((metrics->>'samples')::numeric)>0
          ORDER BY ${ranking} DESC,id LIMIT 200`,
          filter.values,
        );
        const state = await q(
          `SELECT (SELECT COUNT(*) FROM usage_facts WHERE org_id=$1 AND dirty) AS pending,
          COALESCE(s.unresolved,0) AS unresolved,s.first_day,COALESCE(s.historical,0) AS historical,s.updated_at
          FROM (SELECT 1) placeholder LEFT JOIN usage_projection_state s ON s.org_id=$1`,
          [query.orgId],
        );
        const s = state[0];
        return {
          query,
          total: metrics(total[0]),
          previous: metrics(previous[0]),
          series: series.map((row) => ({ period: String(row.period), metrics: metrics(row) })),
          breakdown: breakdown.map((row) => ({
            id: String(row.id ?? ""),
            name:
              query.dimension === "project"
                ? displayProject(String(row.id ?? ""), String(row.name ?? ""), names)
                : String(row.name ?? ""),
            status: lifecycleStatus(states, query.dimension, String(row.id ?? "")),
            metrics: metrics(row),
          })),
          status: {
            durable: true,
            pending: Number(s?.pending ?? 0),
            unresolved: Number(s?.unresolved ?? 0),
            updatedAt: s?.updated_at == null ? null : Number(s.updated_at),
            firstAt: s?.first_day == null ? null : Date.parse(`${s.first_day}T00:00:00+08:00`),
            historical: Number(s?.historical ?? 0),
          },
        };
      });
    },
    async trends(query, metric) {
      await db.q("SELECT 1");
      const states = await lifecycleReader?.(query.orgId);
      const names = query.dimension === "project" ? await projectNames(query.orgId) : new Map<string, string>();
      return withPgTransaction(await db.pool(), async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const filter = where(query);
        const field = ID_FIELDS[query.dimension];
        const name = NAME_FIELDS[query.dimension];
        const period =
          query.granularity === "day" ? "day" : `to_char(date_trunc('${query.granularity}',day::date),'YYYY-MM-DD')`;
        const top = await client.query(
          `SELECT dims->>'${field}' AS id,MAX(dims->>'${name}') AS name,${SELECT_METRICS},COUNT(*) OVER() AS total
          FROM usage_daily WHERE ${filter.sql} GROUP BY 1
          HAVING SUM((metrics->>'requests')::numeric)+SUM((metrics->>'samples')::numeric)>0
          ORDER BY ${RANK_SQL[metric]} DESC,id LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`,
          [...filter.values, query.limit, query.offset],
        );
        if (!top.rows.length) {
          const count = await client.query(
            `SELECT COUNT(*) AS total FROM (SELECT dims->>'${field}' FROM usage_daily WHERE ${filter.sql}
            GROUP BY 1 HAVING SUM((metrics->>'requests')::numeric)+SUM((metrics->>'samples')::numeric)>0) objects`,
            filter.values,
          );
          return { items: [], total: Number(count.rows[0].total) };
        }
        const rows = await client.query(
          `SELECT dims->>'${field}' AS id,${period} AS period,${SELECT_METRICS}
          FROM usage_daily WHERE ${filter.sql} AND dims->>'${field}'=ANY($${filter.values.length + 1}::text[])
          GROUP BY 1,2 ORDER BY 2,1`,
          [...filter.values, top.rows.map((row) => row.id)],
        );
        return {
          total: Number(top.rows[0].total),
          items: top.rows.map((row) => ({
            id: String(row.id ?? ""),
            name:
              query.dimension === "project"
                ? displayProject(String(row.id ?? ""), String(row.name ?? ""), names)
                : String(row.name ?? ""),
            status: lifecycleStatus(states, query.dimension, String(row.id ?? "")),
            metrics: metrics(row),
            series: rows.rows
              .filter((point) => point.id === row.id)
              .map((point) => ({ period: String(point.period), metrics: metrics(point) })),
          })),
        };
      });
    },
    async details(query) {
      await db.q("SELECT 1");
      const states = await lifecycleReader?.(query.orgId);
      const names = await projectNames(query.orgId);
      return withPgTransaction(await db.pool(), async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const filter = where(query, true);
        const rows = await client.query(
          `SELECT fact FROM usage_facts WHERE ${filter.sql} ORDER BY (fact->>'at')::bigint DESC,id DESC LIMIT $${filter.values.length + 1} OFFSET $${filter.values.length + 2}`,
          [...filter.values, query.limit, query.offset],
        );
        const counts = await client.query(
          `SELECT COUNT(*) AS total FROM usage_facts WHERE ${filter.sql}`,
          filter.values,
        );
        return {
          records: rows.rows.map((row) => recordStatus(row.fact as UsageFact, states, names)),
          total: Number(counts.rows[0]?.total ?? 0),
        };
      });
    },
    async facets(orgId) {
      const states = await lifecycleReader?.(orgId);
      const directory = await directoryReader?.(orgId);
      const names = new Map((directory?.project ?? []).map((project) => [project.id, project.name]));
      const entries = await Promise.all(
        (Object.keys(ID_FIELDS) as UsageDimension[]).map(async (dimension) => {
          let sql = `SELECT dims->>'${ID_FIELDS[dimension]}' AS id,MAX(dims->>'${NAME_FIELDS[dimension]}') AS name
          FROM usage_daily WHERE org_id=$1 GROUP BY 1 ORDER BY 2 LIMIT 1000`;
          if (dimension === "department")
            sql = `SELECT id,MAX(name) AS name FROM (
          SELECT dims->>'unitId' AS id,dims->>'unitName' AS name FROM usage_daily WHERE org_id=$1
          UNION ALL SELECT ancestor->>'id',ancestor->>'name' FROM usage_daily,
            jsonb_array_elements(COALESCE(dims->'unitAncestors','[]'::jsonb)) ancestor WHERE org_id=$1
          ) units GROUP BY id ORDER BY name LIMIT 1000`;
          const rows = await db.q(sql, [orgId]);
          const items = new Map(
            rows.map((row) => [
              String(row.id ?? ""),
              {
                id: String(row.id ?? ""),
                name:
                  dimension === "project"
                    ? displayProject(String(row.id ?? ""), String(row.name ?? ""), names)
                    : String(row.name ?? ""),
                status: lifecycleStatus(states, dimension, String(row.id ?? "")),
              },
            ]),
          );
          for (const item of directory?.[dimension] ?? [])
            if (!items.has(item.id)) items.set(item.id, { ...item, status: item.status });
          return [dimension, [...items.values()].sort((a, b) => a.name.localeCompare(b.name))] as const;
        }),
      );
      return Object.fromEntries(entries) as Awaited<ReturnType<UsageStore["facets"]>>;
    },
    async export(query, summary) {
      await db.q("SELECT 1");
      const states = await lifecycleReader?.(query.orgId);
      const names = await projectNames(query.orgId);
      return withPgTransaction(await db.pool(), async (client) => {
        await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const filter = where(query, !summary);
        const rows: string[] = [];
        if (summary) {
          const field = ID_FIELDS[query.dimension];
          const name = NAME_FIELDS[query.dimension];
          const result = await client.query(
            `SELECT dims->>'${field}' AS id,MAX(dims->>'${name}') AS name,${SELECT_METRICS}
            FROM usage_daily WHERE ${filter.sql} GROUP BY 1
            HAVING SUM((metrics->>'requests')::numeric)+SUM((metrics->>'samples')::numeric)>0
            ORDER BY ${RANK_SQL[query.rankBy ?? "calls"]} DESC,id LIMIT 100001`,
            filter.values,
          );
          if (result.rows.length > 100000) throw new Error("export_too_large");
          rows.push(["维度", "名称", "currentStatus", ...METRIC_KEYS, "activeUsers"].map(csvCell).join(","));
          for (const item of result.rows)
            rows.push(
              [
                item.id,
                query.dimension === "project"
                  ? displayProject(String(item.id ?? ""), String(item.name ?? ""), names)
                  : item.name,
                lifecycleStatus(states, query.dimension, String(item.id ?? "")),
                ...METRIC_KEYS.map((key) => item[key]),
                item.activeUsers,
              ]
                .map(csvCell)
                .join(","),
            );
        } else {
          const result = await client.query(
            `SELECT fact FROM usage_facts WHERE ${filter.sql}
            ORDER BY (fact->>'at')::bigint DESC,id DESC LIMIT 100001`,
            filter.values,
          );
          if (result.rows.length > 100000) throw new Error("export_too_large");
          const columns = [
            "id",
            "at",
            "requestId",
            "runId",
            "attempt",
            "kind",
            "state",
            "principalId",
            "principalName",
            "projectId",
            "projectName",
            "unitId",
            "unitName",
            "unitPath",
            "source",
            "harness",
            "model",
            "auth",
            "calls",
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "costUsd",
            "costSource",
            "provider",
            "pricingModel",
            "pricingMode",
            "cacheWrite1h",
            "priceVersion",
            "priceSource",
            "costBackfill",
            "grain",
            "principalStatus",
            "projectStatus",
            "unitStatus",
            "projectDisplayName",
          ] as const;
          rows.push(columns.map(csvCell).join(","));
          for (const item of result.rows) {
            const fact = recordStatus(item.fact as UsageFact, states, names);
            rows.push(
              columns
                .map((key) => {
                  if (key === "priceVersion") return csvCell(fact.price?.id);
                  if (key === "priceSource") return csvCell(fact.price?.source);
                  if (key === "costBackfill")
                    return csvCell(fact.costBackfill ? JSON.stringify(fact.costBackfill) : null);
                  return csvCell(fact[key]);
                })
                .join(","),
            );
          }
        }
        return `\uFEFF${rows.join("\r\n")}\r\n`;
      });
    },
    close: () => db.close(),
  };
  return store;
}
