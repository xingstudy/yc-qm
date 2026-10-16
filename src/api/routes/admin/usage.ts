import { parseUsageQuery } from "../../../usage/usage-store.ts";
import { UsagePriceValidationError } from "../../../usage/usage-pricing.ts";
import { UsageCostPreviewError } from "../../../usage/usage-cost-backfill.ts";
import { sendJson } from "../../http.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";
import type { ApiCtx } from "../route.ts";
import { validateUsagePanels } from "../../../usage/usage-dashboard.ts";
import { storeUiState, uiStateId } from "../../../surfaces/ui-state.ts";

export async function adminUsage(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.usage)
    return sendJson(ctx.res, 503, { error: "usage_unavailable", message: "Usage requires PostgreSQL." });
  let query;
  try {
    query = parseUsageQuery(ctx.url.searchParams, scope.slice(4));
  } catch (error) {
    return sendJson(ctx.res, 400, {
      error: "invalid_usage_query",
      message: error instanceof Error ? error.message : "Invalid query",
    });
  }
  const mode = ctx.params?.mode;
  if (mode === "panels") {
    let panels;
    try {
      panels = validateUsagePanels(
        ctx.url.searchParams.getAll("panel").map((key, index) => {
          if (key.split(":").length !== 2) throw new Error("面板查询无效");
          const [dimension, metric] = key.split(":");
          return { id: `query-${index}`, dimension, metric, visual: "line", width: "half" };
        }),
      );
    } catch (error) {
      return sendJson(ctx.res, 400, { error: "invalid_panels", message: (error as Error).message });
    }
    if (!ctx.deps.usage.trends) return sendJson(ctx.res, 503, { error: "usage_unavailable" });
    audit(ctx.deps, { principalId: actor.id, action: "usage.read", resource: "usage-panels", scopeLabel: scope });
    try {
      const keys = [...new Set(panels.filter((p) => p.dimension !== "total").map((p) => `${p.dimension}:${p.metric}`))];
      const values = [];
      for (const key of keys) {
        const panel = panels.find((p) => `${p.dimension}:${p.metric}` === key)!;
        values.push([
          key,
          await ctx.deps.usage.trends({ ...query, dimension: panel.dimension as typeof query.dimension }, panel.metric),
        ]);
      }
      return sendJson(ctx.res, 200, { panels: Object.fromEntries(values) });
    } catch {
      return sendJson(ctx.res, 503, { error: "usage_unavailable", message: "维度趋势暂时不可用，请重试。" });
    }
  }
  audit(ctx.deps, {
    principalId: actor.id,
    action: mode === "export" ? "usage.export" : "usage.read",
    resource: "usage",
    scopeLabel: scope,
  });
  try {
    if (mode === "facets") return sendJson(ctx.res, 200, await ctx.deps.usage.facets(query.orgId));
    if (mode === "details") return sendJson(ctx.res, 200, await ctx.deps.usage.details(query));
    if (mode === "export") {
      const csv = await ctx.deps.usage.export(query, ctx.url.searchParams.get("type") === "summary");
      ctx.res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="usage.csv"',
        "cache-control": "no-store",
      });
      ctx.res.end(csv);
      return;
    }
    return sendJson(ctx.res, 200, await ctx.deps.usage.report(query));
  } catch (error) {
    if (error instanceof Error && error.message === "export_too_large")
      return sendJson(ctx.res, 413, { error: "export_too_large", message: "请缩小日期范围，单次导出最多 100000 条。" });
    return sendJson(ctx.res, 503, {
      error: "usage_unavailable",
      message: "Usage data is temporarily unavailable; statistics were not replaced with zero.",
    });
  }
}

export async function adminUsageLayout(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  if (!ctx.deps.uiState) return sendJson(ctx.res, 503, { error: "layout_unavailable" });
  const id = uiStateId(JSON.stringify([scope, actor.id]), "usage-dashboard");
  if (ctx.method === "GET") {
    try {
      const record = await ctx.deps.uiState.get(id);
      if (!record) return sendJson(ctx.res, 200, { value: null, updatedAt: 0 });
      const value = record.value as { panels?: unknown } | null;
      const panels = validateUsagePanels(value?.panels);
      return sendJson(ctx.res, 200, { value: { panels }, updatedAt: record.updatedAt });
    } catch {
      return sendJson(ctx.res, 503, { error: "layout_unavailable" });
    }
  }
  let panels;
  const body = ctx.body as { panels?: unknown; expectedUpdatedAt?: unknown } | null;
  try {
    if (!body || !Number.isSafeInteger(body.expectedUpdatedAt) || Number(body.expectedUpdatedAt) < 0)
      throw new Error("布局版本无效，请重新加载");
    panels = validateUsagePanels(body.panels);
  } catch (error) {
    return sendJson(ctx.res, 400, { error: "invalid_layout", message: (error as Error).message });
  }
  try {
    const updatedAt = Math.max(Date.now(), Number(body.expectedUpdatedAt) + 1);
    const result = await storeUiState(
      ctx.deps.uiState,
      id,
      { value: { panels }, updatedAt },
      Number(body.expectedUpdatedAt),
    );
    if (!result.ok)
      return sendJson(ctx.res, 409, { error: "layout_conflict", message: "布局已在其他页面更新，请重新加载布局。" });
    audit(ctx.deps, {
      principalId: actor.id,
      action: "usage.layout.update",
      resource: "usage-dashboard",
      scopeLabel: scope,
    });
    return sendJson(ctx.res, 200, { value: { panels }, updatedAt });
  } catch {
    return sendJson(ctx.res, 503, { error: "layout_unavailable", message: "布局未保存，请稍后重试。" });
  }
}

export async function adminUsagePricing(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const store = ctx.deps.usagePricing;
  if (!store) return sendJson(ctx.res, 503, { error: "pricing_unavailable" });
  const orgId = scope.slice(4);
  if (ctx.method === "GET") {
    try {
      return sendJson(ctx.res, 200, { versions: await store.versions(orgId) });
    } catch {
      return sendJson(ctx.res, 503, { error: "pricing_unavailable" });
    }
  }
  try {
    const price = await store.save(orgId, ctx.body, actor.id);
    audit(ctx.deps, {
      principalId: actor.id,
      action: "usage.price.update",
      resource: price.id,
      scopeLabel: scope,
      detail: JSON.stringify({
        provider: price.provider,
        model: price.model,
        effectiveAt: price.effectiveAt,
        rates: price.rates,
        tiers: price.tiers,
      }),
    });
    return sendJson(ctx.res, 200, { price });
  } catch (error) {
    if (!(error instanceof UsagePriceValidationError))
      return sendJson(ctx.res, 503, { error: "pricing_unavailable", message: "参考价格暂时无法保存，请稍后重试。" });
    return sendJson(ctx.res, 400, {
      error: "invalid_price",
      message: error instanceof Error ? error.message : "Invalid price",
    });
  }
}

export async function adminUsageCost(ctx: ApiCtx): Promise<void> {
  const scope = orgScope(ctx.deps);
  const actor = await authorizeAdmin(ctx, scope);
  if (!actor) return;
  const usage = ctx.deps.usage;
  const pricing = ctx.deps.usagePricing;
  if (!usage || !pricing) return sendJson(ctx.res, 503, { error: "usage_unavailable" });
  const orgId = scope.slice(4);
  try {
    const body = ctx.body as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new UsageCostPreviewError("invalid");
    const confirm = ctx.url.pathname.endsWith("cost-confirm");
    let preview;
    if (confirm) {
      if (typeof body.previewId !== "string" || body.previewId.length > 128) throw new UsageCostPreviewError("invalid");
      preview = await usage.confirmCost(orgId, actor.id, body.previewId);
    } else {
      if (typeof body.priceId !== "string") throw new UsageCostPreviewError("invalid");
      const price = (await pricing.versions(orgId)).find((p) => p.id === body.priceId);
      if (!price) throw new UsageCostPreviewError("invalid");
      preview = await usage.previewCost(orgId, actor.id, price, {
        model: body.model as string,
        start: body.start as string,
        end: body.end as string,
      });
    }
    audit(ctx.deps, {
      principalId: actor.id,
      action: confirm ? "usage.cost.backfill" : "usage.cost.preview",
      resource: preview.id,
      scopeLabel: scope,
      detail: JSON.stringify({
        priceId: preview.price.id,
        model: preview.model,
        start: preview.start,
        end: preview.end,
        eligible: preview.eligible,
        costUsd: preview.costUsd,
        confirmedAt: preview.confirmedAt,
      }),
    });
    return sendJson(ctx.res, 200, { preview });
  } catch (error) {
    if (!(error instanceof UsageCostPreviewError))
      return sendJson(ctx.res, 503, { error: "usage_unavailable", message: "历史补估暂时不可用，请稍后重试。" });
    const messages = {
      invalid: "请选择有效的模型、价格版本和历史日期范围。",
      too_large: "单次最多预览 10000 条未知费用记录，请缩小日期范围。",
      not_found: "未找到当前管理员的补估预览。",
      expired: "预览已超过 15 分钟，请重新预览。",
      stale: "预览中的使用量已发生变化，请重新预览。",
    };
    const status = { invalid: 400, too_large: 413, not_found: 404, expired: 409, stale: 409 };
    return sendJson(ctx.res, status[error.code], {
      error: `cost_preview_${error.code}`,
      message: messages[error.code],
    });
  }
}
