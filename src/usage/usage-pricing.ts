import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { UsageFact } from "./usage-store.ts";
export class UsagePriceValidationError extends Error {}

const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type UsageRates = Record<(typeof RATE_KEYS)[number], number | null> & { cacheWrite1h?: number | null };
export interface UsagePrice {
  id: string;
  orgId: string;
  provider: string;
  model: string;
  rates: UsageRates;
  tiers: Array<UsageRates & { inputTokensAbove: number }>;
  fastMultiplier: number | null;
  source: "official" | "administrator";
  sourceUrl: string;
  checkedAt: string;
  effectiveAt: number;
  updatedAt: number;
  updatedBy: string;
}

const checkedAt = "2026-10-14";
const effectiveAt = Date.parse("2026-10-14T00:00:00+08:00");
const openaiUrl = "https://developers.openai.com/api/docs/pricing";
const claudeUrl = "https://platform.claude.com/docs/en/about-claude/pricing";
const rate = (input: number, output: number, cacheRead: number, cacheWrite: number): UsageRates => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});
const defaults: Array<Omit<UsagePrice, "orgId">> = [];
function official(
  provider: string,
  model: string,
  rates: UsageRates,
  fastMultiplier: number | null,
  tiers: UsagePrice["tiers"] = [],
) {
  defaults.push({
    id: `official:${checkedAt}:${provider}:${model}`,
    provider,
    model,
    rates,
    tiers,
    fastMultiplier,
    source: "official",
    sourceUrl: provider === "openai" ? openaiUrl : claudeUrl,
    checkedAt,
    effectiveAt,
    updatedAt: effectiveAt,
    updatedBy: "official-defaults",
  });
}
for (const [model, rates, long] of [
  ["gpt-6-astra", rate(10, 50, 1, 12.5), rate(20, 75, 2, 25)],
  ["gpt-6.1-sol", rate(2, 10, 0.1, 2.5), rate(4, 15, 0.2, 5)],
  ["gpt-6-luna", rate(0.1, 0.5, 0.01, 0.125), rate(0.2, 0.75, 0.02, 0.25)],
  ["gpt-5.6-sol", rate(4, 20, 0.4, 5), rate(8, 30, 0.8, 10)],
  ["gpt-5.6-terra", rate(2, 12, 0.2, 2.5), rate(4, 18, 0.4, 5)],
  ["gpt-5.6-luna", rate(0.2, 1.2, 0.02, 0.25), rate(0.4, 1.8, 0.04, 0.5)],
] as const)
  official("openai", model, rates, 2, [{ ...long, inputTokensAbove: 272_000 }]);
for (const [model, input, output, cached, fast] of [
  ["claude-fable-5-1", 10, 50, 0.25, null],
  ["claude-fable-5", 10, 50, 1, null],
  ["claude-opus-5-5", 4, 20, 0.2, 2],
  ["claude-opus-5", 5, 25, 0.5, 2],
  ["claude-opus-4-8", 5, 25, 0.5, 2],
  ["claude-sonnet-5-5", 2, 10, 0.1, null],
  ["claude-sonnet-5", 2, 10, 0.2, null],
  ["claude-haiku-4-5", 1, 5, 0.1, null],
] as const)
  official("anthropic", model, { ...rate(input, output, cached, input * 1.25), cacheWrite1h: input * 2 }, fast);

function parseRates(value: unknown): UsageRates {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsagePriceValidationError("请输入单价");
  const raw = value as Record<string, unknown>;
  const result = {} as UsageRates;
  for (const key of [...RATE_KEYS, "cacheWrite1h"] as const) {
    const v = raw[key];
    if (v == null || v === "") result[key] = null;
    else if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1_000_000)
      throw new UsagePriceValidationError("单价必须为有限非负数，空值表示未知");
    else result[key] = v;
  }
  return result;
}

export function estimateUsage(fact: UsageFact, price: UsagePrice): number | null {
  if (fact.input === null || fact.output === null || fact.cacheRead === null || fact.cacheWrite === null) return null;
  const context = fact.input + fact.cacheRead + fact.cacheWrite;
  if (fact.grain !== "call" && price.tiers.some((tier) => context > tier.inputTokensAbove)) return null;
  const rates = [...price.tiers].reverse().find((tier) => context > tier.inputTokensAbove) ?? price.rates;
  const factor = fact.pricingMode === "fast" ? price.fastMultiplier : 1;
  if (factor === null) return null;
  let total = 0;
  for (const key of RATE_KEYS) {
    let count = fact[key]!;
    if (key === "cacheWrite" && price.provider === "anthropic" && count > 0) {
      if (fact.cacheWrite1h == null || fact.cacheWrite1h > count) return null;
      const long = fact.cacheWrite1h;
      if (long && rates.cacheWrite1h == null) return null;
      total += long * (rates.cacheWrite1h ?? 0);
      count -= long;
    }
    if (count > 0 && rates[key] === null) return null;
    total += count * (rates[key] ?? 0);
  }
  return (total * factor) / 1_000_000;
}

export function createUsagePricingStore(
  backing: DurableMap<{ versions: UsagePrice[] }>,
  write: <T>(key: string, fn: () => Promise<T>) => Promise<T>,
  now = Date.now,
) {
  const keyFor = (orgId: string, provider: string, model: string) => JSON.stringify([orgId, provider, model]);
  const builtin = (orgId: string, provider: string, model: string) =>
    defaults.filter((p) => p.provider === provider && p.model === model).map((p) => ({ ...p, orgId }));
  return {
    async versions(orgId: string) {
      return [
        ...defaults.map((p) => ({ ...p, orgId })),
        ...(await backing.all()).flatMap((r) => r.versions).filter((p) => p.orgId === orgId),
      ].sort((a, b) => b.effectiveAt - a.effectiveAt || b.updatedAt - a.updatedAt);
    },
    async resolve(orgId: string, provider: string, model: string, at: number): Promise<UsagePrice | null> {
      const custom = (await backing.get(keyFor(orgId, provider, model)))?.versions
        .filter((p) => p.effectiveAt <= at)
        .reverse()
        .sort((a, b) => b.effectiveAt - a.effectiveAt || b.updatedAt - a.updatedAt)[0];
      return custom ?? builtin(orgId, provider, model).filter((p) => p.effectiveAt <= at)[0] ?? null;
    },
    async save(orgId: string, raw: unknown, updatedBy: string): Promise<UsagePrice> {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new UsagePriceValidationError("价格配置无效");
      const value = raw as Record<string, unknown>;
      const text = (key: string) => {
        const v = value[key];
        if (typeof v !== "string" || !v.trim() || v.length > 512 || /[\u0000-\u001f]/.test(v))
          throw new UsagePriceValidationError("供应商和模型 ID 无效");
        return v.trim();
      };
      const provider = text("provider"),
        model = text("model");
      if (!updatedBy.trim()) throw new UsagePriceValidationError("缺少操作者");
      return write(keyFor(orgId, provider, model), async () => {
        const at = now();
        const from = value.effectiveAt == null ? at : value.effectiveAt;
        if (typeof from !== "number" || !Number.isSafeInteger(from) || from < at)
          throw new UsagePriceValidationError("新价格不能追溯生效，请选择现在或未来时间");
        const base = builtin(orgId, provider, model)[0];
        if (value.restore === true && !base) throw new UsagePriceValidationError("此模型没有已核对的官方默认价");
        const rates = value.restore === true ? base!.rates : parseRates(value.rates);
        const tiers: UsagePrice["tiers"] = value.restore === true ? base!.tiers : [];
        if (value.restore !== true && value.tiers != null) {
          if (!Array.isArray(value.tiers) || value.tiers.length > 20)
            throw new UsagePriceValidationError("价格档位无效");
          for (const rawTier of value.tiers) {
            const tier = rawTier as Record<string, unknown>;
            const threshold = tier?.inputTokensAbove;
            if (
              typeof threshold !== "number" ||
              !Number.isSafeInteger(threshold) ||
              threshold <= (tiers.at(-1)?.inputTokensAbove ?? 0)
            )
              throw new UsagePriceValidationError("上下文阈值必须为递增正整数");
            tiers.push({ ...parseRates(tier), inputTokensAbove: threshold });
          }
        }
        const fast = value.restore === true ? base!.fastMultiplier : (value.fastMultiplier ?? null);
        if (fast !== null && (typeof fast !== "number" || !Number.isFinite(fast) || fast < 0 || fast > 100))
          throw new UsagePriceValidationError("快速模式倍率无效");
        const p: UsagePrice = {
          id: randomUUID(),
          orgId,
          provider,
          model,
          rates: structuredClone(rates),
          tiers: structuredClone(tiers),
          fastMultiplier: fast,
          source: value.restore === true ? "official" : "administrator",
          sourceUrl: value.restore === true ? base!.sourceUrl : "",
          checkedAt: value.restore === true ? base!.checkedAt : "",
          effectiveAt: from,
          updatedAt: at,
          updatedBy,
        };
        const key = keyFor(orgId, provider, model);
        const versions = (await backing.get(key))?.versions ?? [];
        if (versions.length >= 1000) throw new UsagePriceValidationError("该模型价格版本已达上限");
        await backing.put(key, { versions: [...versions, p] });
        return p;
      });
    },
  };
}

export type UsagePricingStore = ReturnType<typeof createUsagePricingStore>;
