import type { ScopeId } from "../types.ts";
import { createTimestampedEventSink } from "./scoped-event-sink.ts";

export interface TurnMetricSample {
  ts: number;
  sessionId?: string;
  turnSeq?: number;
  runId?: string;
  ttftMs?: number;
  totalMs: number;
  intakePreambleMs?: number;
  dispatchMs?: number;
  ingressMs?: number;
  detectMs?: number;
  compactMs?: number;
  queueMs?: number;
  deliverMs?: number;
  slackInflightMs?: number;
  resumedFromSeq?: number;
  status: string;
  scopeLabel: ScopeId;
  provisioned?: boolean;
  coldStart?: boolean;
  modelCalls?: number;
  toolCalls?: number;
  provisionMs?: number;
  materializeMs?: number;
  credsMs?: number;
  layersMs?: number;
  compileMs?: number;
  recallMs?: number;
  leaseMs?: number;
  captureMs?: number;
  streamMs?: number;
  execMs?: number;
  cacheRead?: number;
  cacheWrite?: number;
  uncachedInput?: number;
}

export interface DirectoryMetricSample {
  ts: number;
  scopeLabel: ScopeId;
  name: "sync_result" | "login_result" | "duplicate_creation_blocked" | "email_resolution";
  provider: string;
  sourceId: string;
  result: string;
  reason?: string;
  value?: number;
  durationMs?: number;
}

export function cacheHitRatio(s: { cacheRead?: number; cacheWrite?: number; uncachedInput?: number }): number | null {
  const read = s.cacheRead;
  const write = s.cacheWrite;
  const uncached = s.uncachedInput;
  if (read === undefined && write === undefined && uncached === undefined) return null;
  const r = read ?? 0;
  const denom = r + (write ?? 0) + (uncached ?? 0);
  if (denom <= 0) return null;
  return r / denom;
}

export function isStablePrefixMiss(
  s: { cacheRead?: number; cacheWrite?: number; uncachedInput?: number },
  opts: { minWrite?: number; maxReadShare?: number } = {},
): boolean | null {
  const ratio = cacheHitRatio(s);
  if (ratio === null) return null;
  const minWrite = opts.minWrite ?? 1024;
  const maxReadShare = opts.maxReadShare ?? 0.1;
  const write = s.cacheWrite ?? 0;
  return write >= minWrite && ratio < maxReadShare;
}

interface TurnMetricPatch {
  deliverMs?: number;
  slackInflightMs?: number;
}

export interface MetricsSink {
  record(s: Omit<TurnMetricSample, "ts">): void;
  recordDirectory(s: Omit<DirectoryMetricSample, "ts">): void;
  updateByRunId(runId: string, patch: TurnMetricPatch): Promise<void>;
  list(opts?: { scopeId?: string; sessionId?: string; since?: number; limit?: number }): Promise<TurnMetricSample[]>;
  listDirectory(opts?: { scopeId?: string; since?: number; limit?: number }): Promise<DirectoryMetricSample[]>;
}

export function createMetricsSink(): MetricsSink {
  const sink = createTimestampedEventSink<TurnMetricSample>({
    max: 10000,
    defaultLimit: 5000,
    equalityFields: ["sessionId"],
  });
  const directory = createTimestampedEventSink<DirectoryMetricSample>({
    max: 10000,
    defaultLimit: 5000,
    equalityFields: [],
  });
  return {
    record: sink.record,
    recordDirectory: directory.record,
    updateByRunId: (runId, patch) => {
      for (let i = sink.all().length - 1; i >= 0; i--) {
        const row = sink.all()[i]!;
        if (row.runId !== runId) continue;
        if (patch.deliverMs !== undefined) row.deliverMs = patch.deliverMs;
        if (patch.slackInflightMs !== undefined) row.slackInflightMs = patch.slackInflightMs;
        break;
      }
      return Promise.resolve();
    },
    list: (opts = {}) => sink.list(opts),
    listDirectory: (opts = {}) => directory.list(opts),
  };
}
