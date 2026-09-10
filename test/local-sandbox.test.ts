import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSandbox, localContainerName, localVolumeName } from "../src/sandbox/local-sandbox.ts";
import { localNetworkName } from "../src/sandbox/local-resource-names.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { sleep } from "../src/util/async.ts";
import { scopeId } from "../src/types.ts";
import { installFakeDocker, type FakeDocker } from "./support/fake-docker.ts";

const tmp = mkdtempSync(join(tmpdir(), "local-sbx-"));
const guestHome = join(tmp, "home");
let daemon: ChildProcess;
let daemonPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

before(async () => {
  daemonPort = await freePort();
  daemon = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(daemonPort), HOME: guestHome },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/health`);
      if (res.status === 200) return;
    } catch {
      if (Date.now() > deadline) throw new Error("test daemon never became reachable");
    }
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

function makeSandbox(fake: FakeDocker, opts: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  return createLocalSandbox(createLocalWorkspaceStore(dir), {
    dockerExec: fake.dockerExec,
    homeDir: guestHome,
    repoRoot: tmp,
    ...opts,
  });
}
const rw = (scope: string) => [{ scopeId: scope, mountPath: "", mode: "rw" as const }];

test("profile declares the local Docker substrate honestly", () => {
  const sb = makeSandbox(installFakeDocker(daemonPort));
  assert.equal(sb.profile.backend, "local-docker");
  assert.equal(sb.profile.writablePersistence, "resident_disk");
  assert.equal(sb.profile.processSessions, true);
  assert.equal(supportsProcessSessions(sb), true);
});

test("a stopped Docker daemon fails provision with the actionable message", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.daemonDown = true;
  const sb = makeSandbox(fake);
  await assert.rejects(
    sb.provision(rw(scopeId("personal", "U0"))),
    /requires a running Docker daemon \(is Docker Desktop running\?\)/,
  );
});

test("a missing sandbox image fails provision with the build hint", async () => {
  const fake = installFakeDocker(daemonPort);
  fake.imageMissing = true;
  const sb = makeSandbox(fake);
  await assert.rejects(sb.provision(rw(scopeId("personal", "U0"))), /not found — run `npm run sandbox:local:build`/);
});

test("cold provision creates volume + container, run() execs over the daemon, bytes round-trip", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U1");
  const h = await sb.provision(rw(scope));
  assert.equal(h.id, localContainerName(scope));
  assert.equal(h.rootDir, `${guestHome}/workspace`);
  assert.equal(h.homeDir, guestHome);
  assert.equal(h.coldStart, true);
  assert.equal(fake.runCount, 1);
  assert.equal(fake.volumes.has(localVolumeName(scope)), true);
  const c = fake.containers.get(h.id)!;
  assert.equal(c.labels["qm.sandbox"], "1");
  assert.equal(c.labels["qm.scope"], scope);
  assert.equal(c.labels["qm.org"], "default-org");
  assert.equal(c.labels["agent_env"], "dev");
  assert.equal(c.volume, localVolumeName(scope));

  const r = await sb.run(h, "echo hello");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "hello");

  const payload = Uint8Array.from([0, 1, 2, 250, 251, 252]);
  await sb.writeFileBytes(h, "bin/blob.dat", payload);
  assert.deepEqual(Uint8Array.from((await sb.readFileBytes(h, "bin/blob.dat"))!), payload);
  assert.equal(await sb.readFileBytes(h, "bin/missing.dat"), null);
});

test("teardown parks the container and the next provision restarts it warm", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U2"));
  const h1 = await sb.provision(layers);
  await sb.teardown(h1);
  assert.equal(fake.containers.get(h1.id)!.running, false);
  assert.equal(fake.networks.has(localNetworkName(h1.id)), false);

  const h2 = await sb.provision(layers);
  assert.equal(h2.id, h1.id, "same container reused");
  assert.equal(h2.coldStart, false);
  assert.equal(fake.runCount, 1, "no new container run");
  assert.equal(fake.containers.get(h1.id)!.running, true, "restarted");
});

test("a manually deleted network heals without replacing the container or home", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "network-repair"));
  const handle = await sb.provision(layers);
  await sb.writeFile(handle, "preserved.txt", "keep me");
  fake.containers.get(handle.id)!.running = false;
  fake.networks.delete(localNetworkName(handle.id));
  const restored = await sb.provision(layers);
  assert.equal(fake.runCount, 1);
  assert.equal(restored.coldStart, false);
  assert.equal(await sb.readFile(restored, "preserved.txt"), "keep me");
  assert.equal(fake.volumes.has(localVolumeName(layers[0]!.scopeId)), true);
  assert.equal(fake.networks.has(localNetworkName(handle.id)), true);
});

test("running a parked handle reconnects its network", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const handle = await sb.provision(rw(scopeId("personal", "parked-run")));
  await sb.teardown(handle);
  assert.equal(fake.networks.size, 0);
  assert.equal((await sb.run(handle, "echo resumed")).stdout.trim(), "resumed");
  assert.equal(fake.runCount, 1);
});

test("deep idle reaping releases only old stopped owned networks and preserves containers and volumes", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const handles = [];
  for (const id of ["old", "recent", "running", "foreign"]) {
    const h = await sb.provision(rw(scopeId("personal", id)));
    await sb.teardown(h, { keepWarm: true });
    const c = fake.containers.get(h.id)!;
    c.running = id === "running";
    c.finishedAt = new Date(Date.now() - (id === "recent" ? 0 : 100_000)).toISOString();
    if (id === "foreign") c.labels["qm.org"] = "other";
    handles.push(h);
  }
  const fresh = makeSandbox(fake);
  assert.deepEqual(await fresh.reapDeepIdle!(10_000), { reaped: 1 });
  assert.equal(fake.networks.has(localNetworkName(handles[0]!.id)), false);
  assert.equal(fake.containers.size, 4);
  assert.equal(fake.volumes.size, 4);
  assert.equal(fake.networks.size, 3);
  assert.deepEqual(await fresh.reapDeepIdle!(10_000), { reaped: 0 });
});

test("Docker 29 networks request small dynamically allocated subnets", async () => {
  const fake = installFakeDocker(daemonPort);
  const calls: string[][] = [];
  const sb = makeSandbox(fake, {
    dockerExec: async (args: string[]) => {
      calls.push(args);
      return fake.dockerExec(args);
    },
  });
  await sb.provision(rw(scopeId("personal", "small-network")));
  const create = calls.find((args) => args[0] === "network" && args[1] === "create")!;
  assert.ok(create.includes("0.0.0.0/29"));
  assert.ok(create.includes("qm.org=default-org"));
});

test("older Docker engines retain supported automatic allocation", async () => {
  const fake = installFakeDocker(daemonPort);
  const calls: string[][] = [];
  const sb = makeSandbox(fake, {
    dockerExec: async (args: string[]) => {
      calls.push(args);
      if (args[0] === "version") return { code: 0, stdout: "27.4.0\n", stderr: "" };
      return fake.dockerExec(args);
    },
  });
  await sb.provision(rw(scopeId("personal", "older-network")));
  assert.ok(!calls.find((args) => args[0] === "network" && args[1] === "create")!.includes("--subnet"));
});

test("network cleanup failures are surfaced without deleting the container or home", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake, {
    dockerExec: async (args: string[]) => {
      if (args[0] === "network" && args[1] === "rm")
        return { code: 1, stdout: "", stderr: "network has active endpoints" };
      return fake.dockerExec(args);
    },
  });
  const scope = scopeId("personal", "cleanup-failure");
  const h = await sb.provision(rw(scope));
  await assert.rejects(sb.teardown(h), /network has active endpoints/);
  assert.ok(fake.containers.has(h.id));
  assert.ok(fake.volumes.has(localVolumeName(scope)));
});

test("a stale-image container is recreated while its home volume survives", async () => {
  const fake = installFakeDocker(daemonPort);
  const layers = rw(scopeId("personal", "U3"));
  const h1 = await makeSandbox(fake).provision(layers);
  const volume = fake.containers.get(h1.id)!.volume!;

  fake.imageId = "sha256:image-v2";
  const h2 = await makeSandbox(fake).provision(layers);
  assert.equal(h2.id, h1.id);
  assert.equal(fake.runCount, 2, "container recreated on the new image");
  assert.equal(fake.containers.get(h2.id)!.imageId, "sha256:image-v2");
  assert.equal(fake.volumes.has(volume), true, "volume survived the recreate");
  assert.equal(h2.coldStart, false, "existing volume means a warm home");
});

test("a scratch box has no volume and is removed on teardown", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U4")), { scratch: { key: "k1" } });
  assert.equal(h.scratch, true);
  assert.equal(h.coldStart, true);
  assert.equal(fake.containers.get(h.id)!.volume, undefined);
  await sb.teardown(h);
  assert.equal(fake.containers.has(h.id), false, "scratch container destroyed");
});

test("teardown destroy removes both the container and its volume", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U5");
  const h = await sb.provision(rw(scope));
  await sb.teardown(h, { destroy: true });
  assert.equal(fake.containers.has(h.id), false);
  assert.equal(fake.volumes.has(localVolumeName(scope)), false);
});

test("concurrent provisions for one scope run a single container", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U6"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  assert.equal(a.id, b.id);
  assert.equal(fake.runCount, 1);
});

test("refcounted teardown: the container parks only after the last concurrent user releases", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const layers = rw(scopeId("personal", "U7"));
  const [a, b] = await Promise.all([sb.provision(layers), sb.provision(layers)]);
  await sb.teardown(a);
  assert.equal(fake.containers.get(a.id)!.running, true, "still held by the sibling");
  await sb.teardown(b);
  assert.equal(fake.containers.get(b.id)!.running, false, "parked after the last release");
});

test("process sessions: start, read output, signal to exit", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  assert.ok(supportsProcessSessions(sb));
  const h = await sb.provision(rw(scopeId("personal", "U8")));
  const { processId } = await sb.startProcess!(h, "echo started; sleep 30");
  let out = "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !out.includes("started")) {
    const r = await sb.readProcess!(h, processId, { waitMs: 200 });
    out += r.chunks;
  }
  assert.match(out, /started/);
  await sb.signalProcess!(h, processId, "TERM");
  let status = (await sb.readProcess!(h, processId, {})).status;
  const exitDeadline = Date.now() + 10_000;
  while (status.state !== "exited" && Date.now() < exitDeadline) {
    await sleep(200);
    status = (await sb.readProcess!(h, processId, {})).status;
  }
  assert.equal(status.state, "exited");
});

test("an aborted run returns control promptly", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw(scopeId("personal", "U9")));
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 150);
  const startedAt = Date.now();
  await sb.run(h, "sleep 30", { signal: ctl.signal }).catch(() => {});
  assert.ok(Date.now() - startedAt < 5_000, "run returned promptly after abort");
});

test("read-only layers materialize into the workspace once per content fingerprint", async () => {
  const fake = installFakeDocker(daemonPort);
  const dir = mkdtempSync(join(tmpdir(), "local-ws-"));
  const workspace = createLocalWorkspaceStore(dir);
  const shared = scopeId("org", "default-org");
  await workspace.write(shared, "guide.md", "shared doc");
  const sb = createLocalSandbox(workspace, { dockerExec: fake.dockerExec, homeDir: guestHome, repoRoot: tmp });
  const h = await sb.provision([
    { scopeId: scopeId("personal", "U10"), mountPath: "", mode: "rw" as const },
    { scopeId: shared, mountPath: "shared", mode: "ro" as const },
  ]);
  assert.equal(await sb.readFile(h, "shared/guide.md"), "shared doc");
});

test("each container runs on its own network; destroy removes it", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scopeA = scopeId("personal", "U20");
  const scopeB = scopeId("personal", "U21");
  const ha = await sb.provision(rw(scopeA));
  const hb = await sb.provision(rw(scopeB));
  const netA = localNetworkName(ha.id);
  const netB = localNetworkName(hb.id);
  assert.notEqual(netA, netB);
  assert.equal(fake.networks.has(netA), true);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(ha, { destroy: true });
  assert.equal(fake.networks.has(netA), false);
  assert.equal(fake.networks.has(netB), true);
  await sb.teardown(hb);
});

test("concurrent teardown and provision for one scope serialize (no stop of a fresh user)", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake);
  const scope = scopeId("personal", "U22");
  const h1 = await sb.provision(rw(scope));
  const [, h2] = await Promise.all([sb.teardown(h1), sb.provision(rw(scope))]);
  assert.equal(fake.containers.get(h2.id)!.running, true);
  const r = await sb.run(h2, "echo alive");
  assert.equal(r.stdout.trim(), "alive");
  await sb.teardown(h2);
  assert.equal(fake.containers.get(h2.id)!.running, false);
});

test("enforced sandboxes join a ready guard and pass signed proxy settings to commands", async () => {
  const fake = installFakeDocker(daemonPort);
  const calls: string[][] = [];
  const sb = makeSandbox(fake, {
    egressProxyUrl: "http://host.docker.internal:48080",
    dockerExec: async (args: string[]) => {
      calls.push(args);
      return fake.dockerExec(args);
    },
  });
  assert.equal(sb.profile.egressEnforcement, "domain");
  const handle = await sb.provision(rw(scopeId("personal", "guarded")), {
    egressToken: "signed-token",
    env: { HTTPS_PROXY: "http://untrusted", ALL_PROXY: "socks5://untrusted" },
  });
  const guard = fake.containers.get(`${handle.id}-egress`)!;
  assert.ok(guard.running);
  assert.equal(fake.containers.get(handle.id)!.network, `container:${guard.name}`);
  const launches = calls.filter((call) => call[0] === "run");
  assert.ok(launches[0]!.includes(guard.name));
  assert.ok(launches[1]!.includes("--cap-drop=NET_RAW"));
  assert.ok(launches[1]!.includes("--cap-drop=NET_ADMIN"));
  assert.ok(!launches[1]!.includes("-p"));
  assert.equal(handle.env?.HTTPS_PROXY, "http://x:signed-token@172.17.0.1:48080");
  assert.equal(handle.env?.ALL_PROXY, "");
  assert.equal(handle.env?.NODE_USE_ENV_PROXY, "1");
  const output = await sb.run(handle, 'printf "%s" "$https_proxy"');
  assert.equal(output.stdout, handle.env?.https_proxy);
  await sb.teardown(handle);
  assert.ok(guard.running);
  const resumed = await sb.provision(rw(scopeId("personal", "guarded")), { egressToken: "next-token" });
  assert.equal(fake.runCount, 2);
  assert.equal(resumed.env?.HTTP_PROXY, "http://x:next-token@172.17.0.1:48080");
  await sb.teardown(resumed, { destroy: true });
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.networks.size, 0);
  assert.equal(fake.volumes.size, 0);
});

test("maintenance provisions without a token retain isolation and cannot receive open proxy credentials", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake, { egressProxyUrl: "http://host.docker.internal:48080" });
  const handle = await sb.provision(rw(scopeId("personal", "guard-maintenance")));
  assert.equal(handle.env?.HTTP_PROXY, "http://x:unavailable@172.17.0.1:48080");
  assert.equal((await sb.run(handle, "echo local-maintenance")).stdout.trim(), "local-maintenance");
  await sb.teardown(handle, { destroy: true });
});

test("enabling enforcement requires stopping an old running sandbox, preserves its home and supports disabling later", async () => {
  const fake = installFakeDocker(daemonPort);
  const layers = rw(scopeId("personal", "guard-migration"));
  const open = makeSandbox(fake);
  const original = await open.provision(layers);
  await open.writeFile(original, "guard-preserved.txt", "keep");
  const guarded = makeSandbox(fake, { egressProxyUrl: "http://host.docker.internal:48080" });
  await assert.rejects(guarded.provision(layers), /Drain active turns/);
  await open.teardown(original);
  const migrated = await guarded.provision(layers, { egressToken: "token" });
  assert.equal(migrated.coldStart, false);
  assert.equal(await guarded.readFile(migrated, "guard-preserved.txt"), "keep");
  await guarded.teardown(migrated);
  const restored = await open.provision(layers);
  assert.equal(restored.coldStart, false);
  assert.ok(!fake.containers.has(`${restored.id}-egress`));
  assert.equal(await open.readFile(restored, "guard-preserved.txt"), "keep");
  await open.teardown(restored, { destroy: true });
});

test("guard loss fails closed for existing handles and recovers stopped sandboxes without deleting data", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake, { egressProxyUrl: "http://host.docker.internal:48080" });
  const layers = rw(scopeId("personal", "guard-loss"));
  const handle = await sb.provision(layers, { egressToken: "token" });
  fake.containers.get(`${handle.id}-egress`)!.running = false;
  await assert.rejects(sb.run(handle, "echo unsafe"), /network configuration changed/);
  await sb.teardown(handle);
  const recovered = await sb.provision(layers, { egressToken: "token" });
  assert.equal(recovered.coldStart, false);
  assert.ok(fake.containers.get(`${handle.id}-egress`)!.running);
  await sb.teardown(recovered, { destroy: true });
});

test("guarded scratch teardown and deep idle reap remove guards while retaining resident home volumes", async () => {
  const fake = installFakeDocker(daemonPort);
  const sb = makeSandbox(fake, { egressProxyUrl: "http://host.docker.internal:48080" });
  const scratch = await sb.provision([], { scratch: { key: "guard-scratch" }, egressToken: "token" });
  await sb.teardown(scratch);
  assert.equal(fake.containers.size, 0);
  const handle = await sb.provision(rw(scopeId("personal", "guard-idle")), { egressToken: "token" });
  await sb.teardown(handle);
  fake.containers.get(handle.id)!.finishedAt = new Date(Date.now() - 100_000).toISOString();
  const fresh = makeSandbox(fake, { egressProxyUrl: "http://host.docker.internal:48080" });
  assert.deepEqual(await fresh.reapDeepIdle!(1000), { reaped: 1 });
  assert.equal(fake.containers.size, 0);
  assert.equal(fake.networks.size, 0);
  assert.equal(fake.volumes.size, 1);
});
