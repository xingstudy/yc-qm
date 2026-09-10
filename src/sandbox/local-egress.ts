import type { DockerExec } from "./docker-exec.ts";
import { localEgressProxyUrl } from "./local-network-guard.ts";
import { sleep } from "../util/async.ts";
import { shortHash } from "../util/crypto.ts";
import { localGuardName } from "./local-resource-names.ts";

export const DEFAULT_LOCAL_EGRESS_IMAGE = "qm-egress-proxy:latest";

export function createLocalEgress(dexec: DockerExec, proxyUrl: string, image: string, org: string) {
  const proxy = localEgressProxyUrl(proxyUrl);
  const label = shortHash(`${proxy.origin}|${image}|v1`);
  let expectedImage: Promise<string> | undefined;
  function imageId(): Promise<string> {
    expectedImage ??= dexec(["image", "inspect", "--format", "{{.Id}}", image]).then((result) => {
      if (result.code !== 0) {
        expectedImage = undefined;
        throw new Error(`Local egress image ${image} is unavailable; build or pull it before provisioning sandboxes`);
      }
      return result.stdout.trim().split(/\s+/)[0]!;
    });
    return expectedImage;
  }
  const readyScript = "process.stdout.write(require('node:fs').readFileSync('/tmp/qm-egress-ready','utf8'))";

  async function ready(name: string): Promise<string | undefined> {
    const state = await dexec(["inspect", "-f", "{{.State.Running}} {{.Image}}", localGuardName(name)]);
    const [running, guardImage] = state.stdout.trim().split(/\s+/);
    if (state.code !== 0 || running !== "true" || guardImage !== (await imageId())) return undefined;
    const result = await dexec(["exec", localGuardName(name), "node", "-e", readyScript]);
    if (result.code !== 0) return undefined;
    try {
      return localEgressProxyUrl(result.stdout.trim()).origin;
    } catch {
      return undefined;
    }
  }

  async function remove(name: string): Promise<void> {
    const result = await dexec(["rm", "-f", localGuardName(name)]);
    if (result.code !== 0 && !/No such container/i.test(result.stderr))
      throw new Error(`Cannot remove local network guard: ${result.stderr.trim()}`);
  }

  async function create(name: string, network: string): Promise<void> {
    await imageId();
    await remove(name);
    const result = await dexec(
      [
        "run",
        "-d",
        "--name",
        localGuardName(name),
        "--label",
        "qm.egress-guard=1",
        "--label",
        `qm.org=${org}`,
        "--network",
        network,
        "-p",
        "127.0.0.1:0:8080",
        "--add-host=host.docker.internal:host-gateway",
        "--cap-drop=ALL",
        "--cap-add=NET_ADMIN",
        "--security-opt=no-new-privileges:true",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=1m",
        "--tmpfs",
        "/run:rw,noexec,nosuid,size=1m",
        "--entrypoint",
        "node",
        image,
        "/app/src/sandbox/local-network-guard.ts",
        proxy.origin,
      ],
      120_000,
    );
    if (result.code !== 0) throw new Error(`Cannot start local network guard: ${result.stderr.trim()}`);
    for (let attempt = 0; attempt < 40; attempt++) {
      if (await ready(name)) return;
      await sleep(100);
    }
    const logs = await dexec(["logs", "--tail", "10", localGuardName(name)]);
    await remove(name);
    throw new Error(
      `Local network guard failed to install outbound firewall; sandbox launch refused. Check the egress image and Docker NET_ADMIN support. ${(logs.stderr || logs.stdout).trim().slice(0, 500)}`,
    );
  }

  return { label, ready, remove, create };
}
