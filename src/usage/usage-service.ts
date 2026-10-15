import { randomUUID } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type {
  Harness,
  HarnessLlmRequestRecord,
  HarnessModelUtilities,
  HarnessTurnInput,
  HarnessTurnResult,
} from "../harness/harness.ts";
import type { Orchestrator, OrchestratorInput } from "../core/orchestrator/types.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import { errMessage } from "../util/errors.ts";
import type { LlmCallUsage } from "../sessions/session-store.ts";
import type { UsageFact, UsageIdentity, UsageSource, UsageState, UsageStore } from "./usage-store.ts";

import { usageContext as context, type UsageContext } from "./usage-context.ts";
import { estimateUsage, type UsagePricingStore } from "./usage-pricing.ts";

export interface UsageService {
  store: UsageStore;
  task<T>(input: OrchestratorInput, fn: () => Promise<T>, scopeId: string): Promise<T>;
  system<T>(fn: () => Promise<T>): Promise<T>;
  begin(model: string, grain?: UsageFact["grain"], provider?: string): Promise<UsageFact>;
  finish(fact: UsageFact, patch: Partial<UsageFact>): Promise<void>;
  drain(): Promise<void>;
}

export function createUsageService(
  store: UsageStore,
  orgId: string,
  snapshot: (
    principalId: string,
    scopeId: string,
  ) => Promise<Pick<UsageIdentity, "principalName" | "projectId" | "projectName" | "unitId" | "unitName" | "unitPath">>,
  pricing?: { store: UsagePricingStore; model: (model: string) => { provider: string; id: string } | undefined },
): UsageService {
  const failedWrites = new Map<string, UsageFact>();
  const base = async (
    principalId: string,
    scopeId: string,
    source: UsageSource,
    requestId: string,
  ): Promise<UsageIdentity> => ({
    orgId,
    principalId,
    scopeId,
    source,
    requestId,
    auth: "unknown",
    ...(await snapshot(principalId, scopeId)),
  });
  const blank = (
    identity: UsageIdentity,
    id: string,
    kind: UsageFact["kind"],
    model = "",
    harness = "",
  ): UsageFact => ({
    ...identity,
    id,
    at: Date.now(),
    kind,
    model,
    harness,
    state: "pending",
    calls: null,
    input: null,
    output: null,
    cacheRead: null,
    cacheWrite: null,
    costUsd: null,
    costSource: "unknown",
    grain: "call",
  });
  const service: UsageService = {
    store,
    async task(input, fn, scopeId) {
      const requestId = input.runId ?? randomUUID();
      const id = `request:${requestId}`;
      const existing = await store.get(orgId, id);
      const identity =
        existing ??
        (await base(
          input.actor.id,
          scopeId,
          input.origin.kind === "human" || input.origin.kind === "direct" ? "human" : "automation",
          requestId,
        ));
      const fact = existing ?? blank(identity, id, "request");
      fact.runId = input.runId;
      fact.attempt = input.attempt;
      fact.state = "pending";
      try {
        await store.put(fact, !existing);
      } catch (error) {
        throw new NonRetryableTurnError(`Usage tracking unavailable; no model call was started: ${errMessage(error)}`);
      }
      return context.run({ service, identity: fact, model: "", harness: "" }, async () => {
        try {
          const result = await fn();
          const value = result as { status?: string; stopped?: boolean };
          let state: UsageState = "success";
          if (value.status === "pending_approval") state = "pending";
          if (value.status === "failed" || value.status === "refused") state = "failed";
          if (value.stopped) state = "cancelled";
          await service.finish(fact, { state });
          return result;
        } catch (error) {
          await service.finish(fact, { state: input.cancel?.aborted ? "cancelled" : "failed" });
          throw error;
        }
      });
    },
    async system(fn) {
      const parent = context.getStore();
      const identity = parent?.identity ?? (await base("", `org:${orgId}`, "system", randomUUID()));
      return context.run({ service, identity: { ...identity, source: "system" }, model: "", harness: "pi" }, fn);
    },
    async begin(model, grain = "call", provider) {
      const current = context.getStore();
      if (!current || current.service !== service) throw new Error("Missing usage context");
      const fact = blank(current.identity, randomUUID(), "model", model, current.harness || "pi");
      fact.grain = grain;
      try {
        let resolved = pricing?.model(model);
        if (provider) resolved = { provider, id: model };
        if (provider === "openai-codex") resolved = { provider: "openai", id: model.replace(/^codex\//, "") };
        if (resolved && pricing) {
          fact.provider = resolved.provider;
          fact.pricingModel = resolved.id;
          fact.pricingMode = current.pricingMode ?? "standard";
          const price = await pricing.store.resolve(orgId, resolved.provider, resolved.id, fact.at);
          if (price) fact.price = structuredClone(price);
        }
        await store.put(fact, true);
      } catch (error) {
        throw new NonRetryableTurnError(`Usage tracking unavailable; model dispatch blocked: ${errMessage(error)}`);
      }
      return fact;
    },
    async finish(fact, patch) {
      const next = { ...fact, ...patch };
      if (next.kind === "model" && next.price && next.costSource !== "sdk") {
        next.costUsd = estimateUsage(next, next.price);
        next.costSource = next.costUsd === null ? "unknown" : "estimate";
      }
      Object.assign(fact, next);
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await store.put(next);
          failedWrites.delete(fact.id);
          Object.assign(fact, next);
          return;
        } catch (error) {
          if (attempt === 2) console.error("[usage] measurement persistence pending:", fact.id, errMessage(error));
        }
      }
      if (failedWrites.size < 1000 || failedWrites.has(fact.id)) failedWrites.set(fact.id, next);
    },
    async drain() {
      for (const fact of failedWrites.values()) {
        await store.put(fact);
        failedWrites.delete(fact.id);
      }
      await store.backfill(orgId);
      await store.project(orgId);
    },
  };
  return service;
}

type MeasuredUsage = Omit<LlmCallUsage, "costUsd"> & { costUsd: number | null };
function measuredUsage(usage: MeasuredUsage | null | undefined, harness: string): Partial<UsageFact> {
  if (!usage) return {};
  const includedCache = harness === "codex";
  return {
    input: Math.max(0, usage.input - (includedCache ? usage.cacheRead : 0)),
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    costUsd: harness === "codex" || usage.costKnown === false ? null : usage.costUsd,
    costSource: costSource(harness, usage.costKnown === false ? null : usage.costUsd),
  };
}

function costSource(harness: string, cost: number | null): UsageFact["costSource"] {
  if (harness === "codex" || cost === null) return "unknown";
  return harness === "pi" ? "estimate" : "sdk";
}

export function measuredModelStream(
  model: {
    id: string;
    api: string;
    provider: string;
    cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  },
  start: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const current = context.getStore();
  if (!current || current.streamActive) return start();
  const stream = createAssistantMessageEventStream();
  void (async () => {
    let fact: UsageFact | undefined;
    try {
      fact = await current.service.begin(model.id, "call", model.provider);
      const inner = context.run({ ...current, streamActive: true }, start);
      for await (const event of inner) {
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          const usage = message.usage;
          const hasUsage =
            usage && ((message.stopReason !== "error" && message.stopReason !== "aborted") || usage.totalTokens > 0);
          let state: UsageState = event.type === "error" ? "failed" : "success";
          if (message.stopReason === "aborted") state = "cancelled";
          const subscription = String(model.provider).includes("codex");
          const priced = model.cost && Object.values(model.cost).some((value) => value > 0);
          await current.service.finish(fact, {
            state,
            calls: 1,
            ...(hasUsage ? measuredUsage({ ...usage, costUsd: usage.cost.total }, "pi") : {}),
            ...(hasUsage
              ? { cacheWrite1h: (usage as typeof usage & { cacheWrite1h?: number }).cacheWrite1h ?? 0 }
              : {}),
            ...(subscription ? { auth: "subscription", costUsd: null, costSource: "unknown" } : {}),
            ...(!priced ? { costUsd: null, costSource: "unknown" } : {}),
          });
        }
        stream.push(event);
      }
      stream.end(await inner.result());
    } catch (error) {
      if (fact) await current.service.finish(fact, { state: "failed" });
      const failed: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api as AssistantMessage["api"],
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        stopReason: "error",
        errorMessage: errMessage(error),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "error", reason: "error", error: failed });
      stream.end(failed);
    }
  })();
  return stream;
}

export async function measuredDirectCall<T>(
  model: string,
  fn: () => Promise<{ result: T; usage?: MeasuredUsage }>,
): Promise<T> {
  const current = context.getStore();
  if (!current) return (await fn()).result;
  const fact = await current.service.begin(model);
  try {
    const out = await fn();
    await current.service.finish(fact, { state: "success", calls: 1, ...measuredUsage(out.usage, "pi") });
    return out.result;
  } catch (error) {
    await current.service.finish(fact, { state: "failed", calls: 1 });
    throw error;
  }
}

export function instrumentUsageHarness(harness: Harness, service: UsageService): void {
  const run = harness.turns.runTurn.bind(harness.turns);
  harness.turns.runTurn = async (input: HarnessTurnInput) => {
    const parent = context.getStore();
    if (!parent) return service.system(() => harness.turns.runTurn(input));
    let auth: UsageIdentity["auth"] = "organization";
    if (input.providerKeys && Object.keys(input.providerKeys).length) auth = "personal";
    if (input.codexAuth || input.claudeOauthToken) auth = "subscription";
    const identity = { ...parent.identity, auth } as UsageIdentity;
    const current: UsageContext = {
      ...parent,
      identity,
      harness: harness.profile.id,
      model: input.runtime?.modelId ?? "",
      pricingMode: input.runtime?.fastMode ? "fast" : "standard",
    };
    return context.run(current, async () => {
      const request = await service.store.get(identity.orgId, `request:${identity.requestId}`);
      if (request) await service.finish(request, { model: current.model, harness: current.harness, auth });
      return run(input);
    });
  };
}

export async function measuredHarnessTurn(
  harness: string,
  input: HarnessTurnInput,
  run: (input: HarnessTurnInput) => Promise<HarnessTurnResult>,
): Promise<HarnessTurnResult> {
  const parent = context.getStore();
  if (!parent || parent.native) return run(input);
  const current: UsageContext = {
    ...parent,
    harness,
    model: input.runtime?.modelId ?? parent.model,
    pricingMode: input.runtime?.fastMode ? "fast" : "standard",
  };
  return context.run(current, async () => {
    const service = current.service;
    const fact = await service.begin(current.model, "turn");
    current.native = fact;
    const captures = new Map<string, HarnessLlmRequestRecord>();
    const patch = (): Partial<UsageFact> => {
      const usage = [...captures.values()].map((rec) => rec.usage);
      if (!usage.length || usage.some((item) => !item)) return {};
      const total: LlmCallUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
      for (const item of usage)
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "costUsd"] as const)
          total[key] += item![key];
      total.costKnown = !usage.some((item) => item?.costKnown === false);
      return {
        ...measuredUsage(total, harness),
        ...([...captures.values()].some((rec) => rec.model !== current.model)
          ? { price: undefined, provider: undefined, pricingModel: undefined }
          : {}),
      };
    };
    const record = input.recordLlmRequest;
    try {
      const result = await run({
        ...input,
        recordLlmRequest: async (rec, signal) => {
          captures.set(`${rec.turnSeq}:${rec.step}:${rec.model}`, rec);
          await service.finish(fact, patch());
          await record?.(rec, signal);
        },
      });
      await service.finish(fact, {
        ...patch(),
        calls: result.modelCalls ?? null,
        state: result.stopped ? "cancelled" : "success",
      });
      return result;
    } catch (error) {
      await service.finish(fact, { ...patch(), state: input.cancel?.aborted ? "cancelled" : "failed" });
      throw error;
    }
  });
}

export function instrumentUsageModels(models: HarnessModelUtilities, service: UsageService): void {
  const wrap = <K extends keyof HarnessModelUtilities>(key: K) => {
    if (key === "contextTokenBudget") return;
    const fn = models[key];
    if (typeof fn !== "function") return;
    const replacement = (...args: unknown[]) =>
      service.system(() => Reflect.apply(fn, models, args) as Promise<unknown>);
    Object.assign(models, { [key]: replacement });
  };
  for (const key of Object.keys(models) as Array<keyof HarnessModelUtilities>) wrap(key);
}

export function instrumentUsageOrchestrator(
  orchestrator: Orchestrator,
  service: UsageService,
  scopeFor: (input: OrchestratorInput) => string,
): void {
  const handle = orchestrator.handleTurn.bind(orchestrator);
  orchestrator.handleTurn = (input) => service.task(input, () => handle(input), scopeFor(input));
  const steer = orchestrator.screenSecuritySteer.bind(orchestrator);
  orchestrator.screenSecuritySteer = (input) => service.system(() => steer(input));
  const title = orchestrator.regenerateTitle.bind(orchestrator);
  orchestrator.regenerateTitle = (...args) => service.system(() => title(...args));
}
