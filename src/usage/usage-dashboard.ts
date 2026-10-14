import type { UsageDimension } from "./usage-store.ts";

export interface UsagePanel {
  id: string;
  dimension: UsageDimension | "total";
  metric: "tokens" | "costUsd" | "calls" | "requests" | "activeUsers";
  visual: "line" | "area" | "bars";
  width: "half" | "full";
}

export function validateUsagePanels(value: unknown): UsagePanel[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error("最多配置 8 个面板");
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(item.id) ||
      ids.has(item.id) ||
      !["total", "user", "project", "department", "model", "source", "auth"].includes(item.dimension) ||
      !["tokens", "costUsd", "calls", "requests", "activeUsers"].includes(item.metric) ||
      !["line", "area", "bars"].includes(item.visual) ||
      !["half", "full"].includes(item.width) ||
      (item.dimension === "total" && item.visual === "bars")
    )
      throw new Error("面板配置无效");
    ids.add(item.id);
    return { id: item.id, dimension: item.dimension, metric: item.metric, visual: item.visual, width: item.width };
  });
}
