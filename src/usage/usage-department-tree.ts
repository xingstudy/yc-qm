import { createHash } from "node:crypto";
import { emptyMetrics, METRIC_KEYS, type UsageMetrics, type UsageObjectStatus } from "./usage-store.ts";
import type { DepartmentUnit } from "./usage-departments.ts";
import { departmentSnapshot } from "./usage-departments.ts";

const ORGANIZATION_TOTAL = "__usage_organization__";

export interface UsageDepartmentNode {
  key: string;
  parentKey: string | null;
  id: string;
  name: string;
  path: string[];
  pathNames: string[];
  depth: number;
  historical: boolean;
  status?: UsageObjectStatus;
  metrics: UsageMetrics;
  directMetrics: UsageMetrics;
  series: Array<{ period: string; metrics: UsageMetrics }>;
  directSeries: Array<{ period: string; metrics: UsageMetrics }>;
}

export interface DepartmentAggregateRow {
  dims: Record<string, unknown>;
  metrics: UsageMetrics;
  period?: string;
}

interface Aggregate {
  node: UsageDepartmentNode;
  users: Set<string>;
  directUsers: Set<string>;
  periods: Map<string, { metrics: UsageMetrics; users: Set<string> }>;
  directPeriods: Map<string, { metrics: UsageMetrics; users: Set<string> }>;
}

export function buildDepartmentTree(
  rows: DepartmentAggregateRow[],
  directory: DepartmentUnit[] = [],
  showEmpty = false,
) {
  const nodes = new Map<string, Aggregate>();
  const branches = new Map<string, Aggregate[]>();
  const departments = new Map<string, Aggregate>();
  const current = new Map(directory.map((unit) => [unit.id, unit]));
  const make = (
    key: string,
    id: string,
    name: string,
    path: string[],
    parentKey: string | null,
    depth: number,
  ): Aggregate => ({
    node: {
      key,
      id,
      name,
      path,
      pathNames: [],
      parentKey,
      depth,
      historical: false,
      status: current.get(id)?.status as UsageObjectStatus | undefined,
      metrics: emptyMetrics(),
      directMetrics: emptyMetrics(),
      series: [],
      directSeries: [],
    },
    users: new Set(),
    directUsers: new Set(),
    periods: new Map(),
    directPeriods: new Map(),
  });
  const root = make(ORGANIZATION_TOTAL, ORGANIZATION_TOTAL, "组织总计", [], null, 0);
  nodes.set(root.node.key, root);
  const add = (aggregate: Aggregate, row: DepartmentAggregateRow, direct: boolean) => {
    const principal = String(row.dims.principalId ?? "");
    for (const key of METRIC_KEYS) {
      aggregate.node.metrics[key] += row.metrics[key];
      if (direct) aggregate.node.directMetrics[key] += row.metrics[key];
    }
    if (row.metrics.requests > 0 && principal) {
      aggregate.users.add(principal);
      if (direct) aggregate.directUsers.add(principal);
    }
    if (row.period) {
      const period = aggregate.periods.get(row.period) ?? { metrics: emptyMetrics(), users: new Set<string>() };
      for (const key of METRIC_KEYS) period.metrics[key] += row.metrics[key];
      if (row.metrics.requests > 0 && principal) period.users.add(principal);
      aggregate.periods.set(row.period, period);
      if (direct) {
        const directPeriod = aggregate.directPeriods.get(row.period) ?? {
          metrics: emptyMetrics(),
          users: new Set<string>(),
        };
        for (const key of METRIC_KEYS) directPeriod.metrics[key] += row.metrics[key];
        if (row.metrics.requests > 0 && principal) directPeriod.users.add(principal);
        aggregate.directPeriods.set(row.period, directPeriod);
      }
    }
  };
  const pathFor = (dims: Record<string, unknown>) => {
    const id = String(dims.unitId ?? "");
    const ancestors = (Array.isArray(dims.unitAncestors) ? dims.unitAncestors : []) as Array<{
      id: string;
      name: string;
    }>;
    const ids = Array.isArray(dims.unitPath) ? dims.unitPath.map(String) : [];
    const path = (ids.length ? ids : [id])
      .map((ancestorId) => ({
        id: ancestorId,
        name:
          ancestors.find((ancestor) => ancestor.id === ancestorId)?.name ??
          (ancestorId === id ? String(dims.unitName || (id ? id : "未分配")) : ancestorId),
      }))
      .reverse();
    return path.filter((unit) => current.get(unit.id)?.kind !== "organization");
  };
  const ensurePath = (path: Array<{ id: string; name: string }>) => {
    if (path.length > 1000 || new Set(path.map((unit) => unit.id)).size !== path.length)
      throw new Error("invalid_department_hierarchy");
    const pathKey = JSON.stringify(path);
    const cached = branches.get(pathKey);
    if (cached) return cached;
    const result: Aggregate[] = [];
    for (let index = 0; index < path.length; index++) {
      const branch = path.slice(0, index + 1);
      const key = createHash("sha256").update(JSON.stringify(branch)).digest("hex");
      const leaf = path[index]!;
      let aggregate = nodes.get(key);
      if (!aggregate) {
        if (nodes.size >= 100000) throw new Error("export_too_large");
        aggregate = make(
          key,
          leaf.id,
          leaf.name,
          branch.map((unit) => unit.id),
          result.at(-1)?.node.key ?? root.node.key,
          index + 1,
        );
        nodes.set(key, aggregate);
        aggregate.node.pathNames = branch.map((unit) => unit.name);
      }
      const live = current.get(leaf.id);
      const liveParent = current.get(live?.parentId ?? "")?.kind === "organization" ? null : (live?.parentId ?? null);
      if (
        directory.length &&
        leaf.id &&
        !leaf.id.startsWith("__") &&
        (!live || live.status !== "active" || live.name !== leaf.name || liveParent !== (path[index - 1]?.id ?? null))
      )
        aggregate.node.historical = true;
      result.push(aggregate);
    }
    branches.set(pathKey, result);
    return result;
  };
  for (const row of rows) {
    add(root, row, false);
    const branch = ensurePath(pathFor(row.dims));
    const seen = new Set<string>();
    for (let index = 0; index < branch.length; index++) {
      const aggregate = branch[index]!;
      const direct = index === branch.length - 1;
      add(aggregate, row, direct);
      if (!seen.has(aggregate.node.id)) {
        const flat =
          departments.get(aggregate.node.id) ??
          make(aggregate.node.id, aggregate.node.id, aggregate.node.name, [], null, 0);
        add(flat, row, direct);
        departments.set(aggregate.node.id, flat);
        seen.add(aggregate.node.id);
      }
    }
  }
  if (showEmpty) {
    for (const unit of directory.filter(
      (item) => item.status === "active" && ["department", "team"].includes(item.kind),
    )) {
      const snapshot = departmentSnapshot(directory, unit.id);
      for (const aggregate of ensurePath(pathFor(snapshot as unknown as Record<string, unknown>)))
        if (!departments.has(aggregate.node.id))
          departments.set(
            aggregate.node.id,
            make(aggregate.node.id, aggregate.node.id, aggregate.node.name, [], null, 0),
          );
    }
  }
  const finish = (aggregate: Aggregate) => {
    aggregate.node.metrics.activeUsers = aggregate.users.size;
    aggregate.node.directMetrics.activeUsers = aggregate.directUsers.size;
    aggregate.node.series = [...aggregate.periods]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, value]) => ({
        period,
        metrics: { ...value.metrics, activeUsers: value.users.size },
      }));
    aggregate.node.directSeries = [...aggregate.directPeriods]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([period, value]) => ({
        period,
        metrics: { ...value.metrics, activeUsers: value.users.size },
      }));
    return aggregate.node;
  };
  const children = new Map<string | null, UsageDepartmentNode[]>();
  for (const aggregate of nodes.values()) {
    const node = finish(aggregate);
    const list = children.get(node.parentKey) ?? [];
    list.push(node);
    children.set(node.parentKey, list);
  }
  const ordered: UsageDepartmentNode[] = [];
  const visit = (parent: string | null) => {
    for (const node of (children.get(parent) ?? []).sort(
      (a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key),
    )) {
      ordered.push(node);
      visit(node.key);
    }
  };
  visit(null);
  return { tree: ordered, departments: [...departments.values()].map(finish) };
}
