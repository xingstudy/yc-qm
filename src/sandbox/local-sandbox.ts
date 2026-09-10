import { randomUUID } from "node:crypto";
import { orgId as configOrgId } from "../config.ts";
import { arch } from "node:os";
import type { WorkspaceLayer } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs, errMessage } from "../util/errors.ts";
import { shq } from "../util/shell.ts";
import { createLocalEgress, DEFAULT_LOCAL_EGRESS_IMAGE, localGuardName } from "./local-egress.ts";
import { nonInteractiveShellPrefix, forceThroughProxyEnv } from "./sandbox-env.ts";
import { createExecProcessSessions, type ExecProcessIo } from "./exec-process-session.ts";
import { materializeRoLayers } from "./ro-layers.ts";
import { createExecBackup, createExecFileOps, posixJoin } from "./exec-file-ops.ts";
import { spawnDockerExec, type DockerExec } from "./docker-exec.ts";
import { ephemeralCredLinkScript } from "../credentials/resident-paths.ts";
import { ephemeralCredLinkPaths } from "../credentials/resident-paths.ts";
import { shortHash } from "../util/crypto.ts";
import { killableScript, killScript } from "./exec-kill.ts";
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

const DEFAULT_LOCAL_SANDBOX_IMAGE = "qm-sandbox-local:latest";
const HOME_DIR = "/root";
const WORKSPACE_BASENAME = "workspace";
const AGENT_PORT = 8080;
const RO_LAYERS_TAR = ".ro-layers.tar";
const RO_LAYERS_MANIFEST = ".ro-layers.manifest";
const FINGERPRINT_LABEL = "qm.sandbox-fingerprint";
const BUILD_HINT = "run `npm run sandbox:local:build`";

export type { DockerExec };

export interface LocalSandboxOptions {
  image?: string;
  dockerBin?: string;
  egressProxyUrl?: string;
  egressImage?: string;
  cpus?: number;
  memoryMb?: number;
  defaultTimeoutSec?: number;
  homeDir?: string;
  repoRoot?: string;
  dockerExec?: DockerExec;
  fetchImpl?: typeof fetch;
  onError?: (e: { category: string; code: string; message: string; scopeLabel?: string }) => void;
}

export { computeSandboxImageFingerprint } from "./sandbox-fingerprint.ts";

export const localContainerName = (scopeId: string): string => `qm-sbx-${localSlug(scopeId)}`;
export const localVolumeName = (scopeId: string): string => `qm-home-${localSlug(scopeId)}`;
export const localNetworkName = (containerName: string): string =>
  `qm-net-${containerName.replace(/^qm-(sbx|scratch)-/, "")}`;
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

  const portByName = new Map<string, number>();
  const scopeByContainer = new Map<string, string>();
  const scratchByKey = new Map<string, string>();
  const activeByContainer = new Map<string, number>();

  let preflightDone: Promise<string> | undefined;
  let staleWarned = false;
  let smallSubnets = false;

  async function preflight(): Promise<string> {
    preflightDone ??= (async () => {
      const version = await dexec(["version", "--format", "{{.Server.Version}}"], 15_000);
      if (version.code !== 0) {
        preflightDone = undefined;
        throw new Error("SANDBOX_BACKEND=local requires a running Docker daemon (is Docker Desktop running?)");
      }
      smallSubnets = Number.parseInt(version.stdout, 10) >= 29;
      const img = await dexec([
        "image",
        "inspect",
        "-f",
        `{{.Id}} {{if .Config.Labels}}{{index .Config.Labels "${FINGERPRINT_LABEL}"}}{{end}}`,
        image,
      ]);
      if (img.code !== 0) {
        preflightDone = undefined;
        throw new Error(`local sandbox image ${image} not found — ${BUILD_HINT}`);
      }
      const [imageId = "", labeled = ""] = img.stdout.trim().split(/\s+/);
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

  async function containerState(
    name: string,
  ): Promise<{ running: boolean; imageId: string; egressLabel: string } | null> {
    const r = await dexec([
      "inspect",
      "-f",
      '{{.State.Running}} {{.Image}} {{if .Config.Labels}}{{index .Config.Labels "qm.egress"}}{{end}}',
      name,
    ]);
    if (r.code !== 0) return null;
    const [running = "", imageId = "", rawLabel = ""] = r.stdout.trim().split(/\s+/);
    return { running: running === "true", imageId, egressLabel: rawLabel === "<no value>" ? "" : rawLabel };
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
    const port = await resolvePort(name);
    const signals = [AbortSignal.timeout(timeoutMs ?? 30_000), ...(signal ? [signal] : [])];
    const res = await fetchImpl(`http://127.0.0.1:${port}${path}`, {
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
    await checkedDocker(["rm", "-f", localGuardName(name)], /No such container/i);
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

  async function runContainer(name: string, scope: string | undefined, withVolume: boolean): Promise<void> {
    const net = await ensureNetwork(name);
    if (egress) {
      try {
        await egress.create(name, net);
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
      `qm.org=${configOrgId()}`,
      "--label",
      "agent_env=dev",
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
      ...(!egress ? ["-p", `127.0.0.1:0:${AGENT_PORT}`, "--add-host=host.docker.internal:host-gateway"] : []),
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
    await waitDaemon(name);
  }

  async function ensureContainer(scope: string): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(localContainerName(scope), async () => {
      const imageId = await preflight();
      const name = localContainerName(scope);
      scopeByContainer.set(name, scope);
      const state = await containerState(name);
      const networkMatches = state?.egressLabel === (egress?.label ?? "") && (!egress || !!(await egress.ready(name)));
      if (state && !networkMatches && state.running)
        throw new Error(
          `Local sandbox ${name} needs a network configuration change. Drain active turns and stop this container, then retry; its home volume is preserved.`,
        );
      if (state && state.imageId === imageId && networkMatches) {
        if (!state.running) await startContainer(name);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      if (state) await checkedDocker(["rm", "-f", name]);
      await removeGuard(name);
      const volume = localVolumeName(scope);
      const hadVolume = (await dexec(["volume", "inspect", volume])).code === 0;
      if (!hadVolume) {
        const created = await dexec(["volume", "create", volume]);
        if (created.code !== 0) throw new Error(`docker volume create ${volume} failed: ${created.stderr.trim()}`);
      }
      await runContainer(name, scope, true);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: !hadVolume };
    });
  }

  async function ensureScratch(key: string): Promise<{ name: string; coldStart: boolean }> {
    return provisionQueue(localScratchName(key), async () => {
      await preflight();
      const name = localScratchName(key);
      scratchByKey.set(key, name);
      const state = await containerState(name);
      const networkMatches = state?.egressLabel === (egress?.label ?? "") && (!egress || !!(await egress.ready(name)));
      if (state && !networkMatches && state.running)
        throw new Error(
          `Local scratch sandbox ${name} needs a network configuration change; stop it after active turns finish and retry`,
        );
      if (state && networkMatches) {
        if (!state.running) await startContainer(name);
        activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
        return { name, coldStart: false };
      }
      if (state) await checkedDocker(["rm", "-f", name]);
      await removeGuard(name);
      await runContainer(name, undefined, false);
      activeByContainer.set(name, (activeByContainer.get(name) ?? 0) + 1);
      return { name, coldStart: true };
    });
  }

  const profile: AgentComputerProfile = {
    backend: "local-docker",
    writablePersistence: "resident_disk",
    processSessions: true,
    egressEnforcement: egress ? "domain" : "none",
    spec: {
      os: `Ubuntu 26.04 LTS, glibc — local Docker container on a ${arch()} host (dev only)`,
      runtimes: ["Node 24", "Python 3 (venv on PATH — `pip install` just works)"],
      tools: ["git", "curl", "wget", "jq", "unzip", "gnupg", "python3", "gh", "aws (CLI v2)"],
      notInstalled: ["gcloud", "kubectl", "flyctl", "glab"],
      ...(opts.cpus ? { cpus: opts.cpus } : {}),
      ...(opts.memoryMb ? { memoryMb: opts.memoryMb } : {}),
      homeDir,
      workdir: workspaceDir,
    },
  };

  const procIo: ExecProcessIo = {
    async run(handle, command, execOpts): Promise<ExecResult> {
      const timeoutSec = execOpts?.timeoutMs ? Math.ceil(execOpts.timeoutMs / 1000) : defaultTimeoutSec;
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

  const execBackup = createExecBackup({
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
      const body = scratch ? await ensureScratch(scratch.key) : await ensureContainer(scope);
      const name = body.name;

      const proxyUrl = egress ? await egress.ready(name) : undefined;
      if (egress && !proxyUrl) {
        await sandbox.teardown({ id: name, rootDir: workspaceDir });
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
      };

      try {
        const prep = await execRaw(name, `mkdir -p ${shq(workspaceDir)} && ${ephemeralCredLinkScript(homeDir)}`, 30);
        if (prep.code !== 0) throw new Error(`local sandbox provision prep failed: ${prep.stderr.slice(0, 200)}`);

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
      if (signal.aborted) fireKill();
      const onAbort = () => fireKill();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
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

    backupComputer: execBackup.backupComputer,

    async teardown(handle, tdOpts?: TeardownOptions): Promise<void> {
      return provisionQueue(handle.id, async () => {
        const remaining = (activeByContainer.get(handle.id) ?? 1) - 1;
        if (remaining > 0) {
          activeByContainer.set(handle.id, remaining);
          return;
        }
        activeByContainer.delete(handle.id);

        if (handle.scratch) {
          for (const [k, name] of scratchByKey) if (name === handle.id) scratchByKey.delete(k);
          await checkedDocker(["rm", "-f", handle.id], /No such container/i);
          await removeGuard(handle.id);
          await checkedDocker(["network", "rm", localNetworkName(handle.id)], /not found|No such network/i);
          portByName.delete(handle.id);
          return;
        }

        if (tdOpts?.keepWarm) return;

        if (tdOpts?.destroy) {
          await checkedDocker(["rm", "-f", handle.id], /No such container/i);
          await removeGuard(handle.id);
          await checkedDocker(["network", "rm", localNetworkName(handle.id)], /not found|No such network/i);
          const scope = scopeByContainer.get(handle.id);
          if (scope) await checkedDocker(["volume", "rm", localVolumeName(scope)], /no such volume/i);
          scopeByContainer.delete(handle.id);
          portByName.delete(handle.id);
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
        portByName.delete(handle.id);
      });
    },

    async reapDeepIdle(idleMs): Promise<{ reaped: number }> {
      if (!(idleMs > 0)) return { reaped: 0 };
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
          const state = await dexec(["inspect", "-f", "{{.State.Running}} {{.State.FinishedAt}}", name]);
          if (state.code !== 0) return;
          const [running, finished] = state.stdout.trim().split(/\s+/);
          const stoppedAt = Date.parse(finished ?? "");
          if (running !== "false" || !Number.isFinite(stoppedAt) || stoppedAt <= 0 || stoppedAt > Date.now() - idleMs)
            return;
          if ((await dexec(["network", "inspect", localNetworkName(name)])).code !== 0) return;
          const container = await containerState(name);
          if (container?.egressLabel) {
            await checkedDocker(["rm", "-f", name]);
            await removeGuard(name);
            await checkedDocker(["network", "rm", localNetworkName(name)], /not found|No such network/i);
          } else await releaseNetwork(name);
          reaped++;
        });
      }
      return { reaped };
    },
  };

  return sandbox;
}
