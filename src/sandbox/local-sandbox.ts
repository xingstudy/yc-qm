import { randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import { arch } from "node:os";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createLocalEgress, DEFAULT_LOCAL_EGRESS_IMAGE } from "./local-egress.ts";
import { localGuardName, localNetworkName } from "./local-resource-names.ts";
import { nonInteractiveShellPrefix, forceThroughProxyEnv } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecExport, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { spawnDockerExec, type DockerExec } from "./docker-exec.ts";
import { ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { shortHash } from "../util/crypto.ts";
import { killableScript, killScript } from "./exec-kill.ts";
import { execFailureDetail } from "./sandbox.ts";
import type {
  AgentComputerProfile,
  ExecOptions,
  ExecResult,
  ProvisionOptions,
  Sandbox,
  SandboxHandle,
  TeardownOptions,
} from "./sandbox.ts";
import { computeSandboxImageFingerprint } from "./sandbox-fingerprint.ts";
import { createMemorySandboxLifecycleStore, type SandboxLifecycleStore } from "./sandbox-lifecycle-store.ts";
import { createNoopAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";

const DEFAULT_LOCAL_SANDBOX_IMAGE = "qm-sandbox-local:latest";
const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const AGENT_PORT = 8080;
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const FINGERPRINT_LABEL = "qm.sandbox-fingerprint";
const BUILD_HINT = "run `npm run sandbox:local:build`";
const PREP_TIMEOUT_SEC = 30;
const LOCAL_BACKEND = "local-docker";
const LIFECYCLE_SCHEMA_VERSION = "v2";

export type { DockerExec };

export interface LocalSandboxOptions {
  image?: string;
  dockerBin?: string;
  egressProxyUrl?: string;
  egressImage?: string;
  cpus?: number;
  memoryMb?: number;
  coreContainer?: string;
  defaultTimeoutSec?: number;
  homeDir?: string;
  repoRoot?: string;
  dockerExec?: DockerExec;
  fetchImpl?: typeof fetch;
  lifecycleStore?: SandboxLifecycleStore;
  lifecycleMode?: "observe" | "enforce";
  lifecycleLeaseTtlMs?: number;
  lifecycleMigrationWaitMs?: number;
  lifecycleLegacyObserveMs?: number;
  advisoryLock?: AdvisoryLock;
  production?: boolean;
  holderId?: string;
  hasLiveWork?: (scopeId: string) => Promise<boolean>;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export { computeSandboxImageFingerprint } from "./sandbox-fingerprint.ts";

export const localContainerName = (scopeId: string): string => `qm-sbx-${localSlug(scopeId)}`;
export const localVolumeName = (scopeId: string): string => `qm-home-${localSlug(scopeId)}`;
const localScratchName = (key: string): string => `qm-scratch-${localSlug(key)}`;

function localSlug(id: string): string {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cleaned.slice(0, 40).replace(/-+$/, "") || "scope"}-${shortHash(id)}`;
}

export function createLocalSandbox(workspace: WorkspaceStore, opts: LocalSandboxOptions = {}): Sandbox {
  const image = opts.image ?? DEFAULT_LOCAL_SANDBOX_IMAGE;
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.dockerBin ?? "docker");
  const egress = opts.egressProxyUrl
    ? createLocalEgress(dexec, opts.egressProxyUrl, opts.egressImage ?? DEFAULT_LOCAL_EGRESS_IMAGE, configOrgId())
    : undefined;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const defaultTimeoutSec = opts.defaultTimeoutSec ?? 600;
  const homeDir = opts.homeDir ?? HOME_DIR;
  const workspaceDir = `${homeDir}/${WORKSPACE_BASENAME}`;
  const provisionQueue = createKeyedQueue<string>();
  const lifecycle = opts.lifecycleStore ?? createMemorySandboxLifecycleStore();
  const lifecycleMode = opts.lifecycleMode ?? "enforce";
  const lifecycleLeaseTtlMs = opts.lifecycleLeaseTtlMs ?? 15 * 60_000;
  const lifecycleMigrationWaitMs = opts.lifecycleMigrationWaitMs ?? 5 * 60_000;
  const lifecycleLegacyObserveMs = opts.lifecycleLegacyObserveMs ?? 10_000;
  const holderId = opts.holderId ?? randomUUID();
  const org = configOrgId();
  const advisoryLock = opts.advisoryLock ?? createNoopAdvisoryLock();

  const portByName = new Map<string, number>();
  const scopeByContainer = new Map<string, string>();
  const scratchByKey = new Map<string, string>();
  const activeByContainer = new Map<string, number>();
  const ownedLeaseIds = new Set<string>();
  let leaseHeartbeat: NodeJS.Timeout | undefined;

  let preflightDone: Promise<string> | undefined;
  let staleWarned = false;
  let smallSubnets = false;

  const lifecycleLockKey = (scope: string): string => `local-sandbox:${org}:${scope}`;

  function stopLeaseHeartbeatIfIdle(): void {
    if (ownedLeaseIds.size || !leaseHeartbeat) return;
    clearInterval(leaseHeartbeat);
    leaseHeartbeat = undefined;
  }

  function startLeaseHeartbeat(): void {
    if (leaseHeartbeat) return;
    leaseHeartbeat = setInterval(
      () => {
        const expiresAt = Date.now() + lifecycleLeaseTtlMs;
        for (const leaseId of ownedLeaseIds) {
          lifecycle
            .renewLease(leaseId, expiresAt)
            .then((renewed) => {
              if (!renewed) ownedLeaseIds.delete(leaseId);
              stopLeaseHeartbeatIfIdle();
            })
            .catch((error) =>
              opts.onError?.({
                category: "sandbox_lifecycle",
                code: "lease_heartbeat_failed",
                message: errMessage(error),
              }),
            );
        }
      },
      Math.max(1, Math.floor(lifecycleLeaseTtlMs / 3)),
    );
    leaseHeartbeat.unref();
  }

  async function acquireLifecycleLease(scope: string, name: string): Promise<string> {
    const lease = await lifecycle.acquireLease({
      orgId: org,
      backend: LOCAL_BACKEND,
      scopeId: scope,
      containerName: name,
      holder: holderId,
      expiresAt: Date.now() + lifecycleLeaseTtlMs,
    });
    ownedLeaseIds.add(lease.leaseId);
    startLeaseHeartbeat();
    return lease.leaseId;
  }

  async function releaseLifecycleLease(leaseId: string): Promise<void> {
    ownedLeaseIds.delete(leaseId);
    stopLeaseHeartbeatIfIdle();
    await lifecycle.releaseLease(leaseId);
  }

  async function preflight(): Promise<string> {
    preflightDone ??= (async () => {
      const version = await dexec(["version", "--format", "{{.Server.Version}}"], 15_000);
      if (version.code !== 0) {
        preflightDone = undefined;
        throw new Error("SANDBOX_BACKEND=local requires a running Docker daemon (is Docker Desktop running?)");
      }
      smallSubnets = Number.parseInt(version.stdout, 10) >= 29;
      const img = await dexec(["image", "inspect", "-f", "{{.Id}}", image]);
      if (img.code !== 0) {
        preflightDone = undefined;
        throw new Error(`local sandbox image ${image} not found — ${BUILD_HINT}`);
      }
      const imageId = img.stdout.trim();
      const label = await dexec([
        "image",
        "inspect",
        "-f",
        `{{if .Config.Labels}}{{index .Config.Labels "${FINGERPRINT_LABEL}"}}{{end}}`,
        image,
      ]);
      const labeled = label.code === 0 ? label.stdout.trim() : "";
      if (!staleWarned) {
        const want = await computeSandboxImageFingerprint(opts.repoRoot ?? process.cwd());
        if (want && labeled && labeled !== want) {
          staleWarned = true;
          console.warn(`[local-sandbox] sandbox image ${image} is stale — ${BUILD_HINT}`);
        }
      }
      return imageId;
    })();
    return preflightDone;
  }

  async function containerState(name: string): Promise<{
    running: boolean;
    imageId: string;
    egressLabel: string;
    generation: string;
    scope: string;
    finishedAt: string;
  } | null> {
    const r = await dexec([
      "inspect",
      "-f",
      '{{.State.Running}}|{{.Image}}|{{if .Config.Labels}}{{index .Config.Labels "qm.egress"}}{{end}}|{{if .Config.Labels}}{{index .Config.Labels "qm.sandbox-generation"}}{{end}}|{{if .Config.Labels}}{{index .Config.Labels "qm.scope"}}{{end}}|{{.State.FinishedAt}}',
      name,
    ]);
    if (r.code !== 0) return null;
    const [running = "", imageId = "", rawLabel = "", rawGeneration = "", rawScope = "", finishedAt = ""] = r.stdout
      .trim()
      .split("|");
    const clean = (value: string): string => (value === "<no value>" ? "" : value);
    return {
      running: running === "true",
      imageId,
      egressLabel: clean(rawLabel),
      generation: clean(rawGeneration),
      scope: clean(rawScope),
      finishedAt,
    };
  }

  async function desiredGeneration(imageId?: string): Promise<string> {
    const sandboxImageId = imageId ?? (await preflight());
    const egressImageId = egress ? await egress.imageId() : "none";
    return shortHash(
      JSON.stringify({
        schema: LIFECYCLE_SCHEMA_VERSION,
        sandboxImageId,
        egressImageId,
        egressLabel: egress?.label ?? "none",
        cpus: opts.cpus ?? null,
        memoryMb: opts.memoryMb ?? null,
        homeDir,
      }),
    );
  }

  async function resolvePort(name: string): Promise<number> {
    const cached = portByName.get(name);
    if (cached) return cached;
    const r = await dexec(["port", egress ? localGuardName(name) : name, `${AGENT_PORT}/tcp`]);
    const m = r.stdout
      .split("\n")[0]
      ?.trim()
      .match(/:(\d+)$/);
    if (r.code !== 0 || !m)
      throw new Error(`local sandbox ${name}: cannot resolve agent port: ${r.stderr.trim() || r.stdout.trim()}`);
    const port = Number(m[1]);
    portByName.set(name, port);
    return port;
  }

  async function daemon(
    name: string,
    path: string,
    body?: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ status: number; text: string }> {
    const base = opts.coreContainer
      ? `http://${egress ? localGuardName(name) : name}:${AGENT_PORT}${path}`
      : `http://127.0.0.1:${await resolvePort(name)}${path}`;
    const signals = [AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])];
    const res = await fetchImpl(base, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      signal: AbortSignal.any(signals),
    });
    return { status: res.status, text: await res.text() };
  }

  async function waitDaemon(name: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const res = await daemon(name, "/health", undefined, 3000);
        if (res.status === 200) return;
        lastErr = `http ${res.status}`;
      } catch (e) {
        lastErr = errMessage(e);
      }
      await sleep(300);
    }
    throw new Error(`local sandbox ${name}: exec daemon never became reachable: ${lastErr}`);
  }

  async function startContainer(name: string): Promise<void> {
    portByName.delete(name);
    if (egress) {
      if (!(await egress.ready(name)))
        throw new Error("Local network guard is unavailable; provision the sandbox again before running commands");
    } else {
      await releaseNetwork(name);
      const net = await ensureNetwork(name);
      await checkedDocker(["network", "connect", net, name]);
    }
    const r = await dexec(["start", name]);
    if (r.code !== 0) throw new Error(`docker start ${name} failed: ${r.stderr.trim()}`);
    await connectCore(await ensureNetwork(name));
    await waitDaemon(name);
  }

  async function ensureRunning(name: string): Promise<void> {
    await provisionQueue(name, async () => {
      const state = await containerState(name);
      if (!state) throw new Error(`local sandbox container ${name} is gone`);
      if (state.egressLabel !== (egress?.label ?? "") || (egress && !(await egress.ready(name))))
        throw new Error("Local sandbox network configuration changed; provision it again before running commands");
      if (!state.running) await startContainer(name);
    });
  }

  async function checkedDocker(args: string[], missing?: RegExp): Promise<void> {
    const r = await dexec(args);
    if (r.code !== 0 && !missing?.test(r.stderr))
      throw new Error(`docker ${args.join(" ")} failed: ${r.stderr.trim()}`);
  }

  async function removeGuard(name: string): Promise<void> {
    await checkedDocker(["rm", "-f", localGuardName(name)], /No such (?:container|object)/i);
  }

  async function releaseNetwork(name: string): Promise<void> {
    const net = localNetworkName(name);
    await checkedDocker(["network", "disconnect", "--force", net, name], /not found|No such network|not connected/i);
    await checkedDocker(["network", "rm", net], /not found|No such network/i);
  }

  async function execRaw(name: string, command: string, timeoutSec: number, signal?: AbortSignal): Promise<ExecResult> {
    const res = await daemon(name, "/exec", { cmd: command, timeoutSec }, (timeoutSec + 15) * 1000, signal);
    if (res.status !== 200) throw new Error(`local sandbox exec failed (${res.status}): ${res.text.slice(0, 300)}`);
    const j = JSON.parse(res.text) as { stdout: string; stderr: string; code: number; timedOut: boolean };
    return { stdout: j.stdout ?? "", stderr: j.stderr ?? "", code: j.code, timedOut: !!j.timedOut };
  }

  async function writeAbsBytes(name: string, absPath: string, data: Uint8Array): Promise<void> {
    const res = await daemon(name, "/write", { path: absPath, b64: Buffer.from(data).toString("base64") }, 120_000);
    if (res.status !== 200)
      throw new Error(`local sandbox write ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
  }

  async function readAbsBytes(name: string, absPath: string): Promise<Uint8Array | null> {
    const res = await daemon(name, "/read", { path: absPath }, 120_000);
    if (res.status === 404) return null;
    if (res.status !== 200)
      throw new Error(`local sandbox read ${absPath} failed (${res.status}): ${res.text.slice(0, 200)}`);
    return Buffer.from((JSON.parse(res.text) as { b64: string }).b64, "base64");
  }

  async function ensureNetwork(name: string): Promise<string> {
    const net = localNetworkName(name);
    if ((await dexec(["network", "inspect", net])).code !== 0) {
      const r = await dexec([
        "network",
        "create",
        "--label",
        "qm.sandbox=1",
        "--label",
        `qm.org=${configOrgId()}`,
        ...(smallSubnets ? ["--subnet", "0.0.0.0/29"] : []),
        net,
      ]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
    }
    return net;
  }

  async function connectCore(net: string): Promise<void> {
    if (!opts.coreContainer) return;
    const r = await dexec(["network", "connect", net, opts.coreContainer]);
    if (r.code !== 0 && !/already (?:exists|connected)/i.test(r.stderr)) {
      throw new Error(`docker network connect ${net} ${opts.coreContainer} failed: ${r.stderr.trim()}`);
    }
  }

  async function disconnectCore(net: string): Promise<void> {
    if (!opts.coreContainer) return;
    await dexec(["network", "disconnect", net, opts.coreContainer]).catch(
      swallowAs("local-sandbox: network disconnect", undefined),
    );
  }

  async function runContainer(
    name: string,
    scope: string | undefined,
    withVolume: boolean,
    generation: string,
  ): Promise<void> {
    const net = await ensureNetwork(name);
    if (egress) {
      try {
        await egress.create(name, net, generation);
      } catch (error) {
        await checkedDocker(["network", "rm", net], /not found|No such network/i);
        throw error;
      }
    }
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "qm.sandbox=1",
      ...(scope ? ["--label", `qm.scope=${scope}`] : []),
      "--label",
      `qm.org=${org}`,
      "--label",
      `qm.environment=${opts.production ? "production" : "development"}`,
      "--label",
      "agent_env=dev",
      "--label",
      `qm.sandbox-generation=${generation}`,
      ...(egress
        ? [
            "--label",
            `qm.egress=${egress.label}`,
            "--cap-drop=NET_RAW",
            "--cap-drop=NET_ADMIN",
            "--security-opt=no-new-privileges:true",
          ]
        : []),
      "--network",
      egress ? `container:${localGuardName(name)}` : net,
      ...(withVolume && scope ? ["-v", `${localVolumeName(scope)}:${homeDir}`] : []),
      ...(!egress
        ? [
            ...(opts.coreContainer ? [] : ["-p", `127.0.0.1:0:${AGENT_PORT}`]),
            "--add-host=host.docker.internal:host-gateway",
          ]
        : []),
      ...(opts.cpus ? ["--cpus", String(opts.cpus)] : []),
      ...(opts.memoryMb ? ["--memory", `${opts.memoryMb}m`] : []),
      image,
    ];
    const r = await dexec(args, 120_000);
    if (r.code !== 0) {
      await egress?.remove(name);
      throw new Error(`docker run ${name} failed: ${r.stderr.trim()}`);
    }
    portByName.delete(name);
    await connectCore(net);
    await waitDaemon(name);
  }

  async function removeCompute(name: string): Promise<void> {
    await checkedDocker(["rm", "-f", name], /No such container/i);
    await removeGuard(name);
    await disconnectCore(localNetworkName(name));
    await checkedDocker(["network", "rm", localNetworkName(name)], /not found|No such network/i);
    portByName.delete(name);
  }

  async function ensureContainer(scope: string): Promise<{ name: string; coldStart: boolean; leaseId: string }> {
    const name = localContainerName(scope);
    const deadline = Date.now() + lifecycleMigrationWaitMs;
    for (;;) {
      const result = await provisionQueue(name, () =>
        advisoryLock.withLock(
          lifecycleLockKey(scope),
          async (): Promise<{ wait: true } | { wait: false; coldStart: boolean; leaseId: string }> => {
            const imageId = await preflight();
            const generation = await desiredGeneration(imageId);
            scopeByContainer.set(name, scope);
            const state = await containerState(name);
            const networkMatches =
              state?.egressLabel === (egress?.label ?? "") && (!egress || !!(await egress.ready(name)));
            const actualCompatible = !!state && state.imageId === imageId && networkMatches;
            const observedGeneration = state?.generation || (actualCompatible ? generation : undefined);
            const observed = await lifecycle.observe({
              orgId: org,
              backend: LOCAL_BACKEND,
              scopeId: scope,
              containerName: name,
              ...(observedGeneration ? { currentGeneration: observedGeneration } : {}),
              desiredGeneration: generation,
              running: state?.running ?? false,
              now: Date.now(),
            });
            const generationMatches = actualCompatible && (!state!.generation || state!.generation === generation);
            if (generationMatches) {
              if (!state!.running) await startContainer(name);
              else await connectCore(await ensureNetwork(name));
              await lifecycle.mark(org, LOCAL_BACKEND, scope, {
                currentGeneration: generation,
                desiredGeneration: generation,
                state: "ready",
                parkedAt: undefined,
                migrationToken: undefined,
                migrationExpiresAt: undefined,
                lastError: undefined,
              });
              const leaseId = await acquireLifecycleLease(scope, name);
              activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
              return { wait: false, coldStart: false, leaseId };
            }
            if (state?.running && lifecycleMode === "observe") {
              await lifecycle.mark(org, LOCAL_BACKEND, scope, {
                state: "observing",
                desiredGeneration: generation,
              });
              throw new Error(`Local sandbox ${name} needs migration, but lifecycle mode is observe`);
            }
            const active = await lifecycle.activeLeases(org, LOCAL_BACKEND, name, Date.now());
            const liveWork = (await opts.hasLiveWork?.(scope)) ?? false;
            const legacyWaiting =
              !!state && !state.generation && Date.now() - observed.firstObservedAt < lifecycleLegacyObserveMs;
            if ((activeByContainer.get(name) ?? 0) > 0 || active.length > 0 || liveWork || legacyWaiting) {
              await lifecycle.mark(org, LOCAL_BACKEND, scope, { state: "draining", desiredGeneration: generation });
              return { wait: true };
            }
            const token = randomUUID();
            if (
              !(await lifecycle.tryClaimMigration(org, LOCAL_BACKEND, scope, token, Date.now(), Date.now() + 120_000))
            ) {
              return { wait: true };
            }
            try {
              if (state) await removeCompute(name);
              else await removeGuard(name);
              const volume = localVolumeName(scope);
              const hadVolume = (await dexec(["volume", "inspect", volume])).code === 0;
              if (!hadVolume) {
                const created = await dexec(["volume", "create", volume]);
                if (created.code !== 0)
                  throw new Error(`docker volume create ${volume} failed: ${created.stderr.trim()}`);
              }
              await runContainer(name, scope, true, generation);
              await lifecycle.mark(org, LOCAL_BACKEND, scope, {
                currentGeneration: generation,
                desiredGeneration: generation,
                state: "ready",
                parkedAt: undefined,
                migrationToken: undefined,
                migrationExpiresAt: undefined,
                lastError: undefined,
              });
              const leaseId = await acquireLifecycleLease(scope, name);
              activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
              return { wait: false, coldStart: !hadVolume, leaseId };
            } catch (error) {
              opts.onError?.({
                category: "sandbox_migration",
                code: "migration_failed",
                message: errMessage(error),
                scopeLabel: scope,
              });
              await lifecycle.mark(org, LOCAL_BACKEND, scope, {
                state: "error",
                migrationToken: undefined,
                migrationExpiresAt: undefined,
                lastError: errMessage(error).slice(0, 1000),
              });
              throw error;
            }
          },
        ),
      );
      if (!result.wait) return { name, coldStart: result.coldStart, leaseId: result.leaseId };
      if (Date.now() >= deadline) throw new Error(`Local sandbox ${name} is still draining active work for migration`);
      await sleep(250);
    }
  }

  async function ensureScratch(
    key: string,
  ): Promise<{ name: string; coldStart: boolean; leaseId: string; scopeId: string }> {
    const name = localScratchName(key);
    const scratchScope = `scratch:${shortHash(key)}`;
    const deadline = Date.now() + lifecycleMigrationWaitMs;
    for (;;) {
      const result = await provisionQueue(name, () =>
        advisoryLock.withLock(lifecycleLockKey(scratchScope), async () => {
          const imageId = await preflight();
          const generation = await desiredGeneration(imageId);
          scratchByKey.set(key, name);
          const state = await containerState(name);
          const networkMatches =
            state?.egressLabel === (egress?.label ?? "") && (!egress || !!(await egress.ready(name)));
          const compatible =
            !!state &&
            state.imageId === imageId &&
            networkMatches &&
            (!state.generation || state.generation === generation);
          const observedGeneration = state?.generation || (compatible ? generation : undefined);
          const observed = await lifecycle.observe({
            orgId: org,
            backend: LOCAL_BACKEND,
            scopeId: scratchScope,
            containerName: name,
            ...(observedGeneration ? { currentGeneration: observedGeneration } : {}),
            desiredGeneration: generation,
            running: state?.running ?? false,
            now: Date.now(),
          });
          if (compatible) {
            if (!state.running) await startContainer(name);
            else await connectCore(await ensureNetwork(name));
            await lifecycle.mark(org, LOCAL_BACKEND, scratchScope, {
              currentGeneration: generation,
              desiredGeneration: generation,
              state: "ready",
              parkedAt: undefined,
              migrationToken: undefined,
              migrationExpiresAt: undefined,
              lastError: undefined,
            });
            const leaseId = await acquireLifecycleLease(scratchScope, name);
            activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
            return { wait: false as const, coldStart: false, leaseId };
          }
          if (state?.running && lifecycleMode === "observe") {
            await lifecycle.mark(org, LOCAL_BACKEND, scratchScope, {
              state: "observing",
              desiredGeneration: generation,
            });
            throw new Error(`Local scratch sandbox ${name} needs migration, but lifecycle mode is observe`);
          }
          const active = await lifecycle.activeLeases(org, LOCAL_BACKEND, name, Date.now());
          const legacyWaiting =
            !!state && !state.generation && Date.now() - observed.firstObservedAt < lifecycleLegacyObserveMs;
          if ((activeByContainer.get(name) ?? 0) > 0 || active.length > 0 || legacyWaiting) {
            await lifecycle.mark(org, LOCAL_BACKEND, scratchScope, { state: "draining" });
            return { wait: true as const };
          }
          const token = randomUUID();
          if (
            !(await lifecycle.tryClaimMigration(
              org,
              LOCAL_BACKEND,
              scratchScope,
              token,
              Date.now(),
              Date.now() + 120_000,
            ))
          ) {
            return { wait: true as const };
          }
          try {
            if (state) await removeCompute(name);
            else await removeGuard(name);
            await runContainer(name, scratchScope, false, generation);
            await lifecycle.mark(org, LOCAL_BACKEND, scratchScope, {
              currentGeneration: generation,
              desiredGeneration: generation,
              state: "ready",
              parkedAt: undefined,
              migrationToken: undefined,
              migrationExpiresAt: undefined,
              lastError: undefined,
            });
            const leaseId = await acquireLifecycleLease(scratchScope, name);
            activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
            return { wait: false as const, coldStart: true, leaseId };
          } catch (error) {
            opts.onError?.({
              category: "sandbox_migration",
              code: "migration_failed",
              message: errMessage(error),
              scopeLabel: scratchScope,
            });
            await lifecycle.mark(org, LOCAL_BACKEND, scratchScope, {
              state: "error",
              migrationToken: undefined,
              migrationExpiresAt: undefined,
              lastError: errMessage(error).slice(0, 1000),
            });
            throw error;
          }
        }),
      );
      if (!result.wait) return { name, coldStart: result.coldStart, leaseId: result.leaseId, scopeId: scratchScope };
      if (Date.now() >= deadline) throw new Error(`Local scratch sandbox ${name} is still draining active work`);
      await sleep(250);
    }
  }

  const profile: AgentComputerProfile = {
    backend: "local-docker",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: egress ? "domain" : "none",
    spec: {
      os: `Ubuntu 26.04 LTS, glibc — local Docker container on a ${arch()} host`,
      runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)"],
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3", "gh", "aws (CLI v2)"],
      notInstalled: ["gcloud", "kubectl", "flyctl", "glab"],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      homeDir,
      workdir: workspaceDir,
    },
  };

  async function renewHandleLease(handle: SandboxHandle): Promise<void> {
    if (!handle.lifecycleLeaseId) return;
    const renewed = await lifecycle.renewLease(handle.lifecycleLeaseId, Date.now() + lifecycleLeaseTtlMs);
    if (renewed) return;
    const lifecycleScope = handle.lifecycleScopeId ?? handle.scopeId;
    if (!lifecycleScope) throw new Error(`Local sandbox ${handle.id} lost its lifecycle lease`);
    await provisionQueue(handle.id, () =>
      advisoryLock.withLock(lifecycleLockKey(lifecycleScope), async () => {
        const state = await containerState(handle.id);
        const imageId = await preflight();
        const generation = await desiredGeneration(imageId);
        if (
          !state ||
          state.imageId !== imageId ||
          state.generation !== generation ||
          state.egressLabel !== (egress?.label ?? "")
        ) {
          throw new Error(`Local sandbox ${handle.id} changed generation; provision it again before running commands`);
        }
        handle.lifecycleLeaseId = await acquireLifecycleLease(lifecycleScope, handle.id);
        activeByContainer.set(handle.id, (activeByContainer.get(handle.id) ?? 0) + 1);
      }),
    );
  }

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await renewHandleLease(handle);
      await ensureRunning(handle.id);
      return execRaw(handle.id, command, timeoutSec);
    },
  };
  const procSessions = createExecProcessSessions(procIo);

  const execFileOps = createExecFileOps({
    label: "local",
    exec: (id, script, t) => execRaw(id, script, t),
    writeInline: (id, abs, data) => writeAbsBytes(id, abs, data),
  });

  const execExport = createExecExport({
    label: "local",
    exec: (id, script, t) => execRaw(id, script, t),
    readAbsBytes,
    defaultHomeDir: homeDir,
    ephemeralCredentialPrefixes: ephemeralCredLinkPaths().map(({ rel }) => rel),
  });

  const sandbox: Sandbox = {
    profile,
    startProcess: procSessions.startProcess,
    readProcess: procSessions.readProcess,
    writeStdin: procSessions.writeStdin,
    signalProcess: procSessions.signalProcess,
    listProcesses: procSessions.listProcesses,
    ...execFileOps,

    async provision(layers: WorkspaceLayer[], provOpts?: ProvisionOptions): Promise<SandboxHandle> {
      const scratch = provOpts?.scratch;
      const writable = layers.find((l) => l.mode === "rw") ?? layers[0];
      const scope = writable?.scopeId ?? "default";
      const body: { name: string; coldStart: boolean; leaseId?: string; scopeId?: string } = scratch
        ? await ensureScratch(scratch.key)
        : await ensureContainer(scope);
      const name = body.name;

      const proxyUrl = egress ? await egress.ready(name) : undefined;
      if (egress && !proxyUrl) {
        await sandbox.teardown({
          id: name,
          rootDir: workspaceDir,
          scopeId: scope,
          lifecycleScopeId: body.scopeId ?? scope,
          ...(scratch ? { scratch: true } : {}),
          ...(body.leaseId ? { lifecycleLeaseId: body.leaseId } : {}),
        });
        throw new Error("Local network guard became unavailable during provision");
      }
      const env = {
        ...provOpts?.env,
        ...(proxyUrl
          ? {
              ...forceThroughProxyEnv(proxyUrl, provOpts?.egressToken ?? "unavailable"),
              NODE_USE_ENV_PROXY: "1",
              ALL_PROXY: "",
              all_proxy: "",
            }
          : {}),
      };
      const handle: SandboxHandle = {
        id: name,
        rootDir: workspaceDir,
        homeDir,
        coldStart: body.coldStart,
        ...(scratch ? { scratch: true } : {}),
        ...(env ? { env } : {}),
        scopeId: scope,
        lifecycleScopeId: body.scopeId ?? scope,
        ...(body.leaseId ? { lifecycleLeaseId: body.leaseId } : {}),
      };

      try {
        const prep = await execRaw(
          name,
          `mkdir -p ${shq(workspaceDir)} && ${ephemeralCredLinkScript(homeDir)}`,
          PREP_TIMEOUT_SEC,
        );
        if (prep.code !== 0)
          throw new Error(
            `local sandbox provision prep failed: ${execFailureDetail(prep, PREP_TIMEOUT_SEC).slice(0, 200)}`,
          );

        await materializeRoLayers(
          workspace,
          layers,
          handle,
          {
            readFile: (h, rel) => sandbox.readFile(h, rel),
            writeFileBytes: (h, rel, data) => sandbox.writeFileBytes(h, rel, data),
            exec: (script, t) => execRaw(name, script, t),
          },
          { manifest: RO_LAYERS_MANIFEST, tar: RO_LAYERS_TAR, label: "local" },
        );

        return handle;
      } catch (err) {
        await sandbox.teardown(handle).catch(swallowAs("local-sandbox: teardown after failed provision", undefined));
        throw err;
      }
    },

    async run(handle, command, execOpts?: ExecOptions): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
      await renewHandleLease(handle);
      await ensureRunning(handle.id);
      const exports = Object.entries(handle.env ?? {})
        .map(([k, v]) => `export ${k}=${shq(v)}`)
        .join("; ");
      const script = `${nonInteractiveShellPrefix()}${exports ? exports + "; " : ""}cd ${handle.rootDir} 2>/dev/null; ${command}`;
      const signal = execOpts?.signal;
      if (!signal) return execRaw(handle.id, script, timeoutSec);
      const killUid = randomUUID();
      const fireKill = () => {
        execRaw(handle.id, killScript(killUid), 15).catch(swallowAs("local-sandbox: kill in-flight exec", undefined));
      };
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        signal.throwIfAborted();
        return await execRaw(handle.id, killableScript(script, killUid), timeoutSec, signal);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },

    async writeFileBytes(handle, relPath, data): Promise<void> {
      await writeAbsBytes(handle.id, posixJoin(handle.rootDir, relPath), data);
    },
    async writeFile(handle, relPath, data): Promise<void> {
      await sandbox.writeFileBytes(handle, relPath, Buffer.from(data, "utf8"));
    },
    async readFileBytes(handle, relPath): Promise<Uint8Array | null> {
      return readAbsBytes(handle.id, posixJoin(handle.rootDir, relPath));
    },
    async readFile(handle, relPath): Promise<string | null> {
      const bytes = await sandbox.readFileBytes(handle, relPath);
      return bytes === null ? null : Buffer.from(bytes).toString("utf8");
    },

    exportFiles: execExport.exportFiles,

    async computerStatus(scopeId) {
      const name = localContainerName(scopeId);
      const state = await containerState(name);
      const lifecycleState = await lifecycle.get(org, LOCAL_BACKEND, scopeId);
      const listed = lifecycleState
        ? `${lifecycleState.state}; current=${lifecycleState.currentGeneration ?? "unknown"}; desired=${lifecycleState.desiredGeneration}`
        : undefined;
      if (!state) {
        return {
          machine: name,
          ...(listed ? { listed } : {}),
          provisioned: false,
          guestResponsive: false,
        };
      }
      if (!state.running) {
        return {
          lifecycleState: "paused",
          machine: name,
          ...(listed ? { listed } : {}),
          provisioned: true,
          guestResponsive: false,
        };
      }
      try {
        const health = await daemon(name, "/health", undefined, 3000);
        return {
          lifecycleState: "running",
          machine: name,
          ...(listed ? { listed } : {}),
          provisioned: true,
          guestResponsive: health.status === 200,
          ...(health.status === 200 ? {} : { probeError: `health returned HTTP ${health.status}` }),
        };
      } catch (error) {
        return {
          lifecycleState: "running",
          machine: name,
          ...(listed ? { listed } : {}),
          provisioned: true,
          guestResponsive: false,
          probeError: errMessage(error),
        };
      }
    },

    async destroyScope(scopeId: string): Promise<void> {
      const name = localContainerName(scopeId);
      return provisionQueue(name, () =>
        advisoryLock.withLock(lifecycleLockKey(scopeId), async () => {
          const network = localNetworkName(name);
          const remove = async (args: string[]) => {
            const result = await dexec(args);
            if (
              result.code !== 0 &&
              !/no such (container|object|network|volume)|network .* not found/i.test(result.stderr)
            )
              throw new Error(`docker ${args.join(" ")}: ${result.stderr.trim()}`);
          };
          await remove(["rm", "-f", name]);
          await removeGuard(name);
          if (opts.coreContainer) {
            const result = await dexec(["network", "disconnect", "-f", network, opts.coreContainer]);
            if (
              result.code !== 0 &&
              !/no such (network|container|object)|is not connected|network .* not found/i.test(result.stderr)
            )
              throw new Error(`docker network disconnect ${network}: ${result.stderr.trim()}`);
          }
          await remove(["network", "rm", network]);
          await remove(["volume", "rm", localVolumeName(scopeId)]);
          activeByContainer.delete(name);
          scopeByContainer.delete(name);
          portByName.delete(name);
          await lifecycle.delete(org, LOCAL_BACKEND, scopeId);
        }),
      );
    },

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      const lifecycleScope = handle.lifecycleScopeId ?? handle.scopeId;
      return provisionQueue(handle.id, () =>
        advisoryLock.withLock(lifecycleLockKey(lifecycleScope ?? handle.id), async () => {
          if (handle.lifecycleLeaseId) await releaseLifecycleLease(handle.lifecycleLeaseId);
          const remaining = (activeByContainer.get(handle.id) ?? 1) - 1;
          if (remaining > 0) {
            activeByContainer.set(handle.id, remaining);
            return;
          }
          activeByContainer.delete(handle.id);
          if (lifecycleScope) {
            const active = await lifecycle.activeLeases(org, LOCAL_BACKEND, handle.id, Date.now());
            if (active.length > 0) return;
          }

          if (handle.scratch) {
            for (const [k, name] of scratchByKey) if (name === handle.id) scratchByKey.delete(k);
            await checkedDocker(["rm", "-f", handle.id], /No such container/i);
            await removeGuard(handle.id);
            await disconnectCore(localNetworkName(handle.id));
            await checkedDocker(["network", "rm", localNetworkName(handle.id)], /not found|No such network/i);
            portByName.delete(handle.id);
            if (lifecycleScope) await lifecycle.delete(org, LOCAL_BACKEND, lifecycleScope);
            return;
          }

          if (tdOpts?.keepWarm) {
            if (lifecycleScope)
              await lifecycle.mark(org, LOCAL_BACKEND, lifecycleScope, {
                state: "ready",
                lastActiveAt: Date.now(),
              });
            return;
          }

          if (tdOpts?.destroy) {
            await checkedDocker(["rm", "-f", handle.id], /No such container/i);
            await removeGuard(handle.id);
            await disconnectCore(localNetworkName(handle.id));
            await checkedDocker(["network", "rm", localNetworkName(handle.id)], /not found|No such network/i);
            const scope = scopeByContainer.get(handle.id);
            if (scope) await checkedDocker(["volume", "rm", localVolumeName(scope)], /no such volume/i);
            scopeByContainer.delete(handle.id);
            portByName.delete(handle.id);
            if (lifecycleScope) await lifecycle.delete(org, LOCAL_BACKEND, lifecycleScope);
            return;
          }

          const r = await dexec(["stop", "-t", "2", handle.id], 60_000);
          if (r.code !== 0)
            opts.onError?.({
              category: "sandbox_park",
              code: "docker_stop_failed",
              message: r.stderr.trim(),
              ...(scopeByContainer.get(handle.id) ? { scopeLabel: scopeByContainer.get(handle.id)! } : {}),
            });
          if (r.code === 0 && !egress) await releaseNetwork(handle.id);
          if (r.code === 0 && lifecycleScope)
            await lifecycle.mark(org, LOCAL_BACKEND, lifecycleScope, {
              state: "parked",
              parkedAt: Date.now(),
              lastActiveAt: Date.now(),
            });
          portByName.delete(handle.id);
        }),
      );
    },

    async reapDeepIdle(idleMs, devIdleMs): Promise<{ reaped: number }> {
      if (!(idleMs > 0)) return { reaped: 0 };
      const effectiveIdleMs = opts.production ? idleMs : (devIdleMs ?? idleMs);
      const imageId = await preflight();
      const generation = await desiredGeneration(imageId);
      const listed = await dexec([
        "ps",
        "-a",
        "--filter",
        "label=qm.sandbox=1",
        "--filter",
        `label=qm.org=${configOrgId()}`,
        "--format",
        "{{.Names}}",
      ]);
      if (listed.code !== 0) throw new Error(`docker ps failed: ${listed.stderr.trim()}`);
      let reaped = 0;
      for (const name of listed.stdout.trim().split(/\s+/).filter(Boolean)) {
        await provisionQueue(name, async () => {
          if ((activeByContainer.get(name) ?? 0) > 0) return;
          let container = await containerState(name);
          if (!container) return;
          const scope = container.scope || scopeByContainer.get(name);
          if (!scope) return;
          await advisoryLock.withLock(lifecycleLockKey(scope), async () => {
            container = await containerState(name);
            if (!container || (activeByContainer.get(name) ?? 0) > 0) return;
            scopeByContainer.set(name, scope);
            const observed = await lifecycle.observe({
              orgId: org,
              backend: LOCAL_BACKEND,
              scopeId: scope,
              containerName: name,
              ...(container.generation ? { currentGeneration: container.generation } : {}),
              desiredGeneration: generation,
              running: container.running,
              now: Date.now(),
            });
            const active = await lifecycle.activeLeases(org, LOCAL_BACKEND, name, Date.now());
            const liveWork = (await opts.hasLiveWork?.(scope)) ?? false;
            if (active.length || liveWork) return;
            if (!container.generation && Date.now() - observed.firstObservedAt < lifecycleLegacyObserveMs) {
              await lifecycle.mark(org, LOCAL_BACKEND, scope, { state: "observing" });
              return;
            }
            const staleGeneration = container.generation !== generation || container.imageId !== imageId;
            if (lifecycleMode !== "enforce") {
              let state: "observing" | "ready" | "parked" = "parked";
              if (staleGeneration) state = "observing";
              else if (container.running) state = "ready";
              await lifecycle.mark(org, LOCAL_BACKEND, scope, {
                state,
                desiredGeneration: generation,
              });
              return;
            }
            if (container.running) {
              const stopped = await dexec(["stop", "-t", "2", name], 60_000);
              if (stopped.code !== 0) {
                opts.onError?.({
                  category: "sandbox_park",
                  code: "docker_stop_failed",
                  message: stopped.stderr.trim(),
                  scopeLabel: scope,
                });
                return;
              }
              const parkedAt = Date.now();
              await lifecycle.mark(org, LOCAL_BACKEND, scope, { state: "parked", parkedAt, lastActiveAt: parkedAt });
              container = (await containerState(name)) ?? {
                ...container,
                running: false,
                finishedAt: new Date().toISOString(),
              };
            }
            const stoppedAt = Date.parse(container.finishedAt);
            if (
              !staleGeneration &&
              (!Number.isFinite(stoppedAt) || stoppedAt <= 0 || stoppedAt > Date.now() - effectiveIdleMs)
            )
              return;
            try {
              await removeCompute(name);
              await lifecycle.mark(org, LOCAL_BACKEND, scope, {
                currentGeneration: undefined,
                desiredGeneration: generation,
                state: "parked",
                parkedAt: Date.now(),
                migrationToken: undefined,
                migrationExpiresAt: undefined,
                lastError: undefined,
              });
              reaped++;
            } catch (error) {
              opts.onError?.({
                category: "sandbox_reap",
                code: "compute_cleanup_failed",
                message: errMessage(error),
                scopeLabel: scope,
              });
              await lifecycle.mark(org, LOCAL_BACKEND, scope, {
                state: "error",
                lastError: errMessage(error).slice(0, 1000),
              });
            }
          });
        });
      }
      if (lifecycleMode === "enforce") {
        for (const row of await lifecycle.list(org, LOCAL_BACKEND)) {
          if (!row.currentGeneration && row.state === "parked") continue;
          await provisionQueue(row.containerName, () =>
            advisoryLock.withLock(lifecycleLockKey(row.scopeId), async () => {
              if ((activeByContainer.get(row.containerName) ?? 0) > 0) return;
              if (await containerState(row.containerName)) return;
              const active = await lifecycle.activeLeases(org, LOCAL_BACKEND, row.containerName, Date.now());
              const liveWork = (await opts.hasLiveWork?.(row.scopeId)) ?? false;
              if (active.length || liveWork) return;
              try {
                await removeGuard(row.containerName);
                await disconnectCore(localNetworkName(row.containerName));
                await checkedDocker(
                  ["network", "rm", localNetworkName(row.containerName)],
                  /not found|No such network/i,
                );
                await lifecycle.mark(org, LOCAL_BACKEND, row.scopeId, {
                  currentGeneration: undefined,
                  desiredGeneration: generation,
                  state: "parked",
                  parkedAt: Date.now(),
                  migrationToken: undefined,
                  migrationExpiresAt: undefined,
                  lastError: undefined,
                });
                reaped++;
              } catch (error) {
                opts.onError?.({
                  category: "sandbox_reap",
                  code: "orphan_cleanup_failed",
                  message: errMessage(error),
                  scopeLabel: row.scopeId,
                });
                await lifecycle.mark(org, LOCAL_BACKEND, row.scopeId, {
                  state: "error",
                  lastError: errMessage(error).slice(0, 1000),
                });
              }
            }),
          );
        }
      }
      return { reaped };
    },

    async close(): Promise<void> {
      if (leaseHeartbeat) {
        clearInterval(leaseHeartbeat);
        leaseHeartbeat = undefined;
      }
      const leaseIds = [...ownedLeaseIds];
      ownedLeaseIds.clear();
      await Promise.allSettled(leaseIds.map((leaseId) => lifecycle.releaseLease(leaseId)));
    },
  };

  return sandbox;
}
