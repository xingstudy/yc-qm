import { randomUUID } from "node:crypto";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { createSweeper, type Sweeper } from "../util/sweeper.ts";
import { errMessage } from "../util/errors.ts";
import type { DirectoryProviderRegistry } from "./provider.ts";
import type { DirectorySourceService } from "./directory-source-service.ts";
import type { DirectorySourceStore } from "./directory-source-store.ts";
import type { DirectoryRunMutation } from "./directory-source-store.ts";
import type {
  DirectorySyncKind,
  DirectorySyncRun,
  NormalizedDirectoryMember,
  NormalizedDirectoryUnit,
} from "./types.ts";
import { EMPTY_SYNC_COUNTS } from "./types.ts";
import type { DirectoryMetricSample } from "../admin/metrics-sink.ts";

export interface DirectorySyncEngine {
  request(input: {
    sourceId: string;
    kind: DirectorySyncKind;
    targetExternalSubjectId?: string;
    idempotencyKey?: string;
  }): Promise<DirectorySyncRun>;
  get(sourceId: string, runId: string): Promise<DirectorySyncRun | null>;
  list(sourceId: string, limit?: number): Promise<DirectorySyncRun[]>;
  sweep(): Promise<void>;
  start(): void;
  stop(): void;
}

const MAX_MEMBERS_PER_SYNC = 100_000;
const RUN_LEASE_MS = 5 * 60_000;

function cleanError(error: unknown): { code: string; message: string } {
  const raw = errMessage(error) || "directory_sync_failed";
  const safe = raw.replace(/[?&](?:access_token|corpsecret|secret|code)=[^&\s]*/gi, "").slice(0, 300);
  const code = /^[a-z0-9_:-]+$/i.test(safe) ? safe.split(":")[0]!.toLowerCase() : "directory_sync_failed";
  return { code, message: safe || "directory_sync_failed" };
}

export function createDirectorySyncEngine(options: {
  orgId: string;
  store: DirectorySourceStore;
  sources: DirectorySourceService;
  providers: DirectoryProviderRegistry;
  leaderLease: LeaderLease;
  now?: () => number;
  instanceId?: string;
  onBackgroundTask?: (task: Promise<void>) => void;
  reconcileStaleSource?: (sourceId: string) => Promise<unknown>;
  sweepIntervalMs?: number;
  onMetric?: (sample: Omit<DirectoryMetricSample, "ts" | "scopeLabel">) => void;
}): DirectorySyncEngine {
  const { orgId, store, sources, providers, leaderLease } = options;
  const now = options.now ?? Date.now;
  const instanceId = options.instanceId ?? randomUUID();
  const background = options.onBackgroundTask ?? ((task: Promise<void>) => void task.catch(() => undefined));
  let stopped = false;

  const execute = async (run: DirectorySyncRun): Promise<void> => {
    if (stopped) return;
    const executionStartedAt = now();
    let metricProvider = "unknown";
    const held = await leaderLease.hold(`directory-sync:${orgId}:${run.sourceId}`, async (lost) => {
      const current = await store.getRun(orgId, run.sourceId, run.id);
      if (!current || current.status !== "running") return;
      const claimAt = now();
      const active = await store.claimRun(orgId, run.sourceId, run.id, instanceId, claimAt, claimAt + RUN_LEASE_MS);
      if (!active) return;
      const renewal = createSweeper(
        async () => {
          const at = now();
          await store.renewRun(orgId, active.sourceId, active.id, instanceId, at, at + RUN_LEASE_MS);
        },
        Math.floor(RUN_LEASE_MS / 3),
        { label: `directory-sync-run:${active.id}` },
      );
      renewal.start();
      try {
        const configured = await sources.configuration(run.sourceId);
        if (!configured || configured.source.status !== "active") {
          throw new Error("directory_sync_source_disabled");
        }
        const adapter = providers.get(configured.source.provider);
        if (!adapter) throw new Error("directory_sync_provider_unavailable");
        metricProvider = configured.source.provider;
        let mutation: DirectoryRunMutation;
        if (active.kind === "targeted") {
          if (!configured.source.capabilities.targetedLookup) {
            throw new Error("directory_sync_targeted_unsupported");
          }
          const externalSubjectId = active.targetExternalSubjectId;
          if (!externalSubjectId) throw new Error("directory_sync_target_missing");
          const member = await Promise.race([
            adapter.targetedLookup(configured.config, { orgId, sourceId: active.sourceId, externalSubjectId }),
            lost.then(() => {
              throw new Error("directory_sync_lease_lost");
            }),
          ]);
          mutation = { kind: "targeted", externalSubjectId, member };
        } else {
          if (!configured.source.capabilities.fullSync) throw new Error("directory_sync_full_unsupported");
          if (active.kind !== "preview" && !configured.source.syncEnabled) {
            throw new Error("directory_sync_source_disabled");
          }
          if (active.kind !== "preview" && configured.source.previewConfirmedRevision !== configured.source.revision) {
            throw new Error("directory_source_preview_required");
          }
          const members: NormalizedDirectoryMember[] = [];
          for await (const member of adapter.fullSync(configured.config, { orgId, sourceId: active.sourceId })) {
            members.push(member);
            if (members.length > MAX_MEMBERS_PER_SYNC) throw new Error("directory_sync_member_limit_exceeded");
          }
          const units: NormalizedDirectoryUnit[] = [];
          if (configured.source.mode === "managed_directory") {
            if (!configured.source.capabilities.organizationUnits || !adapter.organizationUnits) {
              throw new Error("directory_sync_units_unsupported");
            }
            for await (const unit of adapter.organizationUnits(configured.config, {
              orgId,
              sourceId: active.sourceId,
            })) {
              units.push(unit);
            }
          }
          mutation = { kind: "full", members, units, preview: active.kind === "preview" };
        }
        const completedAt = now();
        const completed = await store.finishRun(
          {
            ...active,
            status: "succeeded",
            errorCode: null,
            errorMessage: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt,
            updatedAt: completedAt,
          },
          instanceId,
          mutation,
        );
        if (!completed) return;
        if (completed.status !== "succeeded") {
          options.onMetric?.({
            name: "sync_result",
            provider: metricProvider,
            sourceId: active.sourceId,
            result: "failed",
            reason: completed.errorCode ?? "directory_sync_source_changed",
            durationMs: Math.max(0, completedAt - executionStartedAt),
          });
          return;
        }
        if (active.kind === "preview") {
          await sources.confirmPreview(active.sourceId, active.sourceRevision);
        } else if (mutation.kind === "full" && options.reconcileStaleSource) {
          const currentSource = await sources.get(active.sourceId);
          if (
            currentSource?.reconciliationStatus === "stale" &&
            currentSource.memberSnapshotRevision !== configured.source.memberSnapshotRevision
          ) {
            background(Promise.resolve(options.reconcileStaleSource(active.sourceId)).then(() => undefined));
          }
        }
        options.onMetric?.({
          name: "sync_result",
          provider: metricProvider,
          sourceId: active.sourceId,
          result: "succeeded",
          reason: active.kind,
          value: completed.counts.observed,
          durationMs: Math.max(0, completedAt - executionStartedAt),
        });
      } catch (error) {
        const failedAt = now();
        const clean = cleanError(error);
        const completed = await store.finishRun(
          {
            ...active,
            status: "failed",
            errorCode: clean.code,
            errorMessage: clean.message,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: failedAt,
            updatedAt: failedAt,
          },
          instanceId,
        );
        if (!completed) return;
        options.onMetric?.({
          name: "sync_result",
          provider: metricProvider,
          sourceId: active.sourceId,
          result: "failed",
          reason: clean.code,
          durationMs: Math.max(0, failedAt - executionStartedAt),
        });
      } finally {
        renewal.stop();
      }
    });
    if (held === null) return;
  };

  const sweeper: Sweeper = createSweeper(
    async () => {
      await engine.sweep();
    },
    options.sweepIntervalMs ?? 60_000,
    { label: "directory-sync", immediate: true },
  );

  const engine: DirectorySyncEngine = {
    async request(input) {
      await sources.ready;
      const source = await sources.get(input.sourceId);
      if (!source) throw new Error("directory_sync_source_not_found");
      if (source.status !== "active") throw new Error("directory_sync_source_disabled");
      if (input.kind === "targeted" && !source.capabilities.targetedLookup) {
        throw new Error("directory_sync_targeted_unsupported");
      }
      if (input.kind !== "targeted" && !source.capabilities.fullSync) {
        throw new Error("directory_sync_full_unsupported");
      }
      if (input.kind !== "preview" && input.kind !== "targeted" && !source.syncEnabled) {
        throw new Error("directory_sync_source_disabled");
      }
      if (
        input.kind !== "preview" &&
        input.kind !== "targeted" &&
        source.previewConfirmedRevision !== source.revision
      ) {
        throw new Error("directory_source_preview_required");
      }
      if (input.kind === "targeted" && !input.targetExternalSubjectId?.trim()) {
        throw new Error("directory_sync_target_missing");
      }
      const at = now();
      const idempotencyKey =
        input.idempotencyKey?.trim() ||
        (input.kind === "scheduled"
          ? `scheduled:${Math.floor(at / (source.scheduleMinutes * 60_000))}`
          : `${input.kind}:${randomUUID()}`);
      const run = await store.createRun({
        id: randomUUID(),
        orgId,
        sourceId: source.id,
        sourceRevision: source.revision,
        kind: input.kind,
        status: "running",
        idempotencyKey,
        targetExternalSubjectId: input.targetExternalSubjectId?.trim() || null,
        counts: { ...EMPTY_SYNC_COUNTS },
        errorCode: null,
        errorMessage: null,
        leaseOwner: null,
        leaseExpiresAt: at + RUN_LEASE_MS,
        createdAt: at,
        startedAt: null,
        completedAt: null,
        updatedAt: at,
      });
      background(execute(run));
      return run;
    },
    get: (sourceId, runId) => store.getRun(orgId, sourceId, runId),
    list: (sourceId, limit) => store.listRuns(orgId, sourceId, limit),
    async sweep() {
      if (stopped) return;
      await sources.ready;
      const at = now();
      for (const source of await sources.list()) {
        const running = await store.findRunningRun(orgId, source.id);
        if (running) {
          if ((running.leaseExpiresAt ?? 0) <= at) background(execute(running));
          continue;
        }
        if (source.status === "active" && source.reconciliationStatus === "stale" && options.reconcileStaleSource) {
          background(Promise.resolve(options.reconcileStaleSource(source.id)).then(() => undefined));
        }
        if (
          source.status !== "active" ||
          !source.syncEnabled ||
          !source.capabilities.fullSync ||
          source.previewConfirmedRevision !== source.revision
        ) {
          continue;
        }
        const latest = await store.latestSucceededAt(orgId, source.id);
        if (latest !== null && latest + source.scheduleMinutes * 60_000 > at) continue;
        await engine.request({ sourceId: source.id, kind: "scheduled" });
      }
    },
    start() {
      stopped = false;
      sweeper.start();
    },
    stop() {
      stopped = true;
      sweeper.stop();
    },
  };
  return engine;
}
