import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";

const APP_PORT = 8080;
const LEGACY_NETWORK = "agent-deploynet";

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  dockerExec?: DockerExec;
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";

  const dexec = opts.dockerExec ?? spawnDockerExec(docker);

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const network = (d: Deployment) => `${name(d)}-net`;
  const ensureNetwork = async (net: string): Promise<string> => {
    if ((await dexec(["network", "inspect", net])).code !== 0) {
      const r = await dexec(["network", "create", net]);
      if (r.code !== 0 && !/already exists/i.test(r.stderr)) {
        throw new Error(`docker network create ${net} failed: ${r.stderr.trim()}`);
      }
    }
    return net;
  };

  const migrateContainer = async (container: string): Promise<boolean> => {
    const inspected = await dexec(["inspect", "--format", "{{json .NetworkSettings.Networks}}", container]);
    if (inspected.code !== 0) {
      if (/no such (?:object|container)|not found/i.test(inspected.stderr)) return false;
      throw new Error(`docker inspect ${container} failed: ${inspected.stderr.trim()}`);
    }
    let attached: Record<string, unknown>;
    try {
      attached = JSON.parse(inspected.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`docker inspect ${container} returned invalid network state`);
    }
    const target = `${container}-net`;
    await ensureNetwork(target);
    if (!(target in attached)) {
      const connected = await dexec(["network", "connect", target, container]);
      if (connected.code !== 0) throw new Error(`docker network connect ${target} failed: ${connected.stderr.trim()}`);
    }
    if (LEGACY_NETWORK in attached) {
      const disconnected = await dexec(["network", "disconnect", LEGACY_NETWORK, container]);
      if (disconnected.code !== 0)
        throw new Error(`docker network disconnect ${LEGACY_NETWORK} failed: ${disconnected.stderr.trim()}`);
    }
    return true;
  };
  const migrateTarget = async (container: string): Promise<boolean> => {
    try {
      return await migrateContainer(container);
    } catch {
      return migrateContainer(container);
    }
  };
  const cleanup = async (d: Deployment): Promise<void> => {
    await dexec(["rm", "-f", name(d)]);
    await dexec(["network", "rm", network(d)]);
  };
  const inspectEndpoint = async (d: Deployment): Promise<DeployEndpoint | null> => {
    const r = await dexec([
      "inspect",
      "--format",
      '{{json .State.Running}} {{json (index .NetworkSettings.Ports "8080/tcp")}}',
      name(d),
    ]);
    if (r.code !== 0) {
      if (/no such (?:object|container)|not found/i.test(r.stderr)) return null;
      throw new Error(`docker inspect ${name(d)} failed: ${r.stderr.trim()}`);
    }
    const separator = r.stdout.indexOf(" ");
    if (separator === -1) throw new Error(`docker inspect ${name(d)} returned invalid endpoint state`);
    let running: unknown;
    let bindings: unknown;
    try {
      running = JSON.parse(r.stdout.slice(0, separator));
      bindings = JSON.parse(r.stdout.slice(separator + 1));
    } catch {
      throw new Error(`docker inspect ${name(d)} returned invalid endpoint state`);
    }
    if (running !== true) return null;
    if (!Array.isArray(bindings)) throw new Error(`docker inspect ${name(d)} returned invalid endpoint state`);
    const binding = bindings.find(
      (value): value is { HostIp?: unknown; HostPort?: unknown } =>
        typeof value === "object" && value !== null && value.HostIp === "127.0.0.1",
    );
    const port = binding && typeof binding.HostPort === "string" ? Number(binding.HostPort) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`docker inspect ${name(d)} returned invalid endpoint state`);
    return { host: "127.0.0.1", port };
  };

  return {
    profile: { managedScaleToZero: false },

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const net = await ensureNetwork(network(d));
      await dexec(["rm", "-f", name(d)]);
      const envArgs = Object.entries(version.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const created = await dexec([
        "create",
        "--name",
        name(d),
        "--network",
        net,
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--pids-limit",
        "256",
        "-p",
        `127.0.0.1::${APP_PORT}`,
        "-w",
        "/app",
        "-e",
        `PORT=${APP_PORT}`,
        ...envArgs,
        image,
        "sh",
        "-c",
        version.entrypoint,
      ]);
      if (created.code !== 0) {
        await cleanup(d);
        throw new Error(`deploy create failed: ${created.stderr.trim()}`);
      }
      const copied = await dexec(["cp", `${version.snapshotDir}/.`, `${name(d)}:/app`]);
      if (copied.code !== 0) {
        await cleanup(d);
        throw new Error(`deploy copy failed: ${copied.stderr.trim()}`);
      }
      const started = await dexec(["start", name(d)]);
      if (started.code !== 0) {
        await cleanup(d);
        throw new Error(`deploy start failed: ${started.stderr.trim()}`);
      }
      try {
        const endpoint = await inspectEndpoint(d);
        if (!endpoint) throw new Error(`docker container ${name(d)} did not start`);
        return endpoint;
      } catch (error) {
        await cleanup(d);
        throw error;
      }
    },

    async logs(d: Deployment, opts: { tailLines: number }): Promise<string | null> {
      if (!(await migrateTarget(name(d)))) return null;
      const lines = Math.max(1, Math.min(2000, Math.floor(opts.tailLines)));
      const r = await dexec(["logs", "--tail", String(lines), name(d)]);
      if (r.code !== 0) return null;
      return `${r.stdout}${r.stderr}`;
    },

    async destroy(d: Deployment): Promise<void> {
      await dexec(["rm", "-f", name(d)]);
      await dexec(["network", "rm", network(d)]);
    },

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      if (!(await migrateTarget(name(d)))) return null;
      return inspectEndpoint(d);
    },
  };
}
