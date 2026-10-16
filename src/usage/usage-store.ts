import { createHash } from "node:crypto";
import type { UsagePrice } from "./usage-pricing.ts";
import type { UsageCostPreview } from "./usage-cost-backfill.ts";

export type UsageSource = "human" | "automation" | "system" | "history";
export type UsageState = "pending" | "success" | "failed" | "cancelled" | "unknown";
export type UsageDimension = "user" | "project" | "department" | "model" | "source" | "auth";
export type UsageObjectStatus = "active" | "suspended" | "deprovisioned" | "archived" | "deleted" | "unknown";
export type UsageLifecycle = Record<"user" | "project" | "department", Record<string, UsageObjectStatus>>;
export type UsageLifecycleReader = (orgId: string) => Promise<UsageLifecycle>;

export interface UsageIdentity {
  orgId: string;
  principalId: string;
  principalName: string;
  projectId: string;
  projectName: string;
  unitId: string;
  unitName: string;
  unitPath: string[];
  unitAncestors?: Array<{ id: string; name: string }>;
  scopeId: string;
  source: UsageSource;
  auth: "organization" | "personal" | "subscription" | "unknown";
  requestId: string;
  runId?: string;
  attempt?: number;
}

export interface UsageFact extends UsageIdentity {
  projectDisplayName?: string;
  provider?: string;
  pricingModel?: string;
  pricingMode?: "standard" | "fast";
  costBackfill?: {
    previewId: string;
    at: number;
    by: string;
    previousCostUsd: number | null;
    previousCostSource: UsageFact["costSource"];
    previousPrice?: UsagePrice;
  };
  price?: UsagePrice;
  cacheWrite1h?: number;
  id: string;
  at: number;
  kind: "request" | "model";
  model: string;
  harness: string;
  state: UsageState;
  calls: number | null;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  costUsd: number | null;
  costSource: "sdk" | "estimate" | "unknown";
  grain: "call" | "turn" | "history";
  principalStatus?: UsageObjectStatus;
  projectStatus?: UsageObjectStatus;
  unitStatus?: UsageObjectStatus;
}

export const METRIC_KEYS = [
  "requests",
  "success",
  "failed",
  "cancelled",
  "pending",
  "calls",
  "unknownCalls",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "samples",
  "knownTokens",
  "costUsd",
  "knownCost",
] as const;
export type UsageMetrics = Record<(typeof METRIC_KEYS)[number], number> & { activeUsers: number };

export interface UsageQuery {
  rankBy?: "requests" | "calls" | "tokens" | "costUsd";
  orgId: string;
  start: string;
  end: string;
  granularity: "day" | "week" | "month";
  dimension: UsageDimension;
  users: string[];
  projects: string[];
  departments: string[];
  models: string[];
  sources: string[];
  auth: string[];
  limit: number;
  offset: number;
}

interface UsageStatus {
  durable: boolean;
  pending: number;
  unresolved: number;
  updatedAt: number | null;
  firstAt: number | null;
  historical: number;
}

interface UsageReport {
  query: UsageQuery;
  total: UsageMetrics;
  previous: UsageMetrics;
  series: Array<{ period: string; metrics: UsageMetrics }>;
  breakdown: Array<{ id: string; name: string; metrics: UsageMetrics; status?: UsageObjectStatus }>;
  status: UsageStatus;
}

interface UsageTrend {
  id: string;
  name: string;
  status?: UsageObjectStatus;
  metrics: UsageMetrics;
  series: Array<{ period: string; metrics: UsageMetrics }>;
}

export interface UsageStore {
  put(fact: UsageFact, insertOnly?: boolean): Promise<void>;
  get(orgId: string, id: string): Promise<UsageFact | null>;
  project(orgId: string, limit?: number): Promise<number>;
  backfill(orgId: string, limit?: number): Promise<number>;
  previewCost(
    orgId: string,
    actorId: string,
    price: UsagePrice,
    input: { model: string; start: string; end: string },
  ): Promise<UsageCostPreview>;
  confirmCost(orgId: string, actorId: string, previewId: string): Promise<UsageCostPreview>;
  report(query: UsageQuery): Promise<UsageReport>;
  trends?(
    query: UsageQuery,
    metric: "tokens" | "costUsd" | "calls" | "requests" | "activeUsers",
  ): Promise<UsageTrend[]>;
  details(query: UsageQuery): Promise<{ records: UsageFact[]; total: number }>;
  facets(
    orgId: string,
  ): Promise<Record<UsageDimension, Array<{ id: string; name: string; status?: UsageObjectStatus }>>>;
  setLifecycleReader?(reader: UsageLifecycleReader): void;
  setDirectoryReader?(
    reader: (
      orgId: string,
    ) => Promise<Partial<Record<UsageDimension, Array<{ id: string; name: string; status?: UsageObjectStatus }>>>>,
  ): void;
  export(query: UsageQuery, summary: boolean): Promise<string>;
  close(): Promise<void>;
}

export function emptyMetrics(): UsageMetrics {
  return Object.fromEntries([...METRIC_KEYS, "activeUsers"].map((key) => [key, 0])) as UsageMetrics;
}

export function factMetrics(fact: UsageFact): UsageMetrics {
  const m = emptyMetrics();
  if (fact.kind === "request") {
    m.requests = fact.source === "human" ? 1 : 0;
    if (fact.source === "human" && fact.state !== "unknown") m[fact.state] = 1;
  } else {
    m.samples = 1;
    m.pending = fact.state === "pending" ? 1 : 0;
    m.calls = fact.calls ?? 0;
    m.unknownCalls = fact.calls === null ? 1 : 0;
    m.input = fact.input ?? 0;
    m.output = fact.output ?? 0;
    m.cacheRead = fact.cacheRead ?? 0;
    m.cacheWrite = fact.cacheWrite ?? 0;
    m.knownTokens = fact.input !== null && fact.output !== null ? 1 : 0;
    m.costUsd = fact.costUsd ?? 0;
    m.knownCost = fact.costUsd === null ? 0 : 1;
  }
  return m;
}

export function usageDay(at: number): string {
  return new Date(at + 8 * 3_600_000).toISOString().slice(0, 10);
}

export function dateAt(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("日期格式必须为 YYYY-MM-DD");
  const at = Date.parse(`${day}T00:00:00+08:00`);
  if (!Number.isFinite(at) || usageDay(at) !== day) throw new Error("日期无效");
  return at;
}

export function parseUsageQuery(params: URLSearchParams, orgId: string, now = Date.now()): UsageQuery {
  const today = usageDay(now);
  const start = params.get("start") ?? usageDay(now - 6 * 86_400_000);
  const end = params.get("end") ?? today;
  if (dateAt(start) > dateAt(end)) throw new Error("开始日期不能晚于结束日期");
  const granularity = params.get("granularity") ?? "day";
  if (!["day", "week", "month"].includes(granularity)) throw new Error("汇总粒度无效");
  const dimension = params.get("dimension") ?? "user";
  if (!["user", "project", "department", "model", "source", "auth"].includes(dimension))
    throw new Error("统计维度无效");
  const rankBy = params.get("rankBy") ?? "calls";
  if (!["requests", "calls", "tokens", "costUsd"].includes(rankBy)) throw new Error("排行指标无效");
  const list = (key: string) => {
    const values = [...new Set(params.getAll(key))];
    if (values.length > 100 || values.some((value) => value.length > 512)) throw new Error("筛选条件过多");
    return values;
  };
  const limit = Number(params.get("limit") ?? 50);
  const offset = Number(params.get("offset") ?? 0);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("分页参数无效");
  return {
    orgId,
    start,
    end,
    granularity: granularity as UsageQuery["granularity"],
    dimension: dimension as UsageDimension,
    rankBy: rankBy as UsageQuery["rankBy"],
    users: list("user"),
    projects: list("project"),
    departments: list("department"),
    models: list("model"),
    sources: list("source"),
    auth: list("auth"),
    limit,
    offset,
  };
}

export function previousQuery(query: UsageQuery): UsageQuery {
  const length = dateAt(query.end) - dateAt(query.start) + 86_400_000;
  return { ...query, start: usageDay(dateAt(query.start) - length), end: usageDay(dateAt(query.start) - 1) };
}

function factDimensions(fact: UsageFact): Record<string, unknown> {
  return {
    principalId: fact.principalId,
    principalName: fact.principalName,
    projectId: fact.projectId,
    projectName: fact.projectName,
    unitId: fact.unitId,
    unitName: fact.unitName,
    unitPath: fact.unitPath,
    unitAncestors: fact.unitAncestors ?? [],
    model: fact.model,
    source: fact.source,
    auth: fact.auth,
    kind: fact.kind,
  };
}

export function bucket(fact: UsageFact): { key: string; day: string; dimensions: Record<string, unknown> } {
  const day = usageDay(fact.at);
  const dimensions = factDimensions(fact);
  const key = createHash("sha256")
    .update(JSON.stringify([day, dimensions]))
    .digest("hex");
  return { key, day, dimensions };
}

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "未知" : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function validateFact(fact: UsageFact): void {
  if (!fact.id || !fact.orgId || !Number.isFinite(fact.at) || fact.at < 0) throw new Error("Invalid usage identity");
  for (const key of ["calls", "input", "output", "cacheRead", "cacheWrite", "costUsd"] as const)
    if (fact[key] !== null && (!Number.isFinite(fact[key]) || fact[key] < 0)) throw new Error(`Invalid usage ${key}`);
}
