#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalSandbox, localContainerName, localVolumeName } from "../src/sandbox/local-sandbox.ts";
import { localNetworkName } from "../src/sandbox/local-resource-names.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { scopeId } from "../src/types.ts";

const log = (...a: unknown[]) => console.log("[local-smoke]", ...a);

if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) {
  log("docker is not available — skipping the local sandbox smoke");
  process.exit(0);
}

async function main(): Promise<void> {
  const ws = createLocalWorkspaceStore(mkdtempSync(join(tmpdir(), "local-smoke-ws-")));
  const sandbox = createLocalSandbox(ws, {});
  const scope = scopeId("personal", `smoke-${Date.now()}`);
  const layers = [{ scopeId: scope, mountPath: "", mode: "rw" as const }];

  try {
    log("provision #1 (fresh container + volume)...");
    const h1 = await sandbox.provision(layers);
    log("container", h1.id, "coldStart", h1.coldStart);
    assert.equal(h1.coldStart, true, "first ever provision should be cold");

    log("exec over the daemon...");
    const echo = await sandbox.run(h1, "echo hello-from-local-docker");
    assert.equal(echo.code, 0);
    assert.equal(echo.stdout.trim(), "hello-from-local-docker");
    const uname = await sandbox.run(h1, "uname -m; node --version; whoami");
    log("guest:", uname.stdout.trim().replace(/\n/g, " | "));

    const marker = `persist-${Date.now()}`;
    await sandbox.writeFile(h1, "notes/marker.txt", marker);
    assert.equal(await sandbox.readFile(h1, "notes/marker.txt"), marker);
    log("wrote marker", marker);

    const createdAt = (n: string) => spawnSync("docker", ["inspect", "-f", "{{.Created}}", n]).stdout.toString().trim();
    const created1 = createdAt(h1.id);

    log("teardown #1 (park: docker stop)...");
    await sandbox.teardown(h1);

    log("provision #2 (should docker-start the same container, warm)...");
    const h2 = await sandbox.provision(layers);
    assert.equal(h2.id, h1.id, "warm restart reuses the same container");
    assert.equal(h2.coldStart, false, "restarted container is not cold");
    assert.equal(createdAt(h2.id), created1, "the container body was reused, not recreated");
    assert.equal(await sandbox.readFile(h2, "notes/marker.txt"), marker, "file present after restart");
    log("warm restart OK, marker intact");

    assert.equal((await sandbox.run(h2, "printf retained > /tmp/network-repair-marker")).code, 0);
    assert.equal(spawnSync("docker", ["stop", h2.id]).status, 0);
    assert.equal(spawnSync("docker", ["network", "rm", localNetworkName(h2.id)]).status, 0);
    log("recovering from manually deleted network...");
    assert.equal((await sandbox.run(h2, "cat /tmp/network-repair-marker")).stdout, "retained");
    assert.equal(createdAt(h2.id), created1);
    assert.equal(await sandbox.readFile(h2, "notes/marker.txt"), marker);

    assert.equal(spawnSync("docker", ["stop", h2.id]).status, 0);
    assert.equal(spawnSync("docker", ["network", "rm", localNetworkName(h2.id)]).status, 0);
    assert.equal(spawnSync("docker", ["network", "create", localNetworkName(h2.id)]).status, 0);
    log("recovering from a replacement network with the same name...");
    assert.equal((await sandbox.run(h2, "cat /tmp/network-repair-marker")).stdout, "retained");
    assert.equal(createdAt(h2.id), created1);

    log("scratch box...");
    const hs = await sandbox.provision(layers, { scratch: { key: `smoke-${Date.now()}` } });
    assert.equal(hs.scratch, true);
    assert.equal((await sandbox.run(hs, "echo scratch-ok")).stdout.trim(), "scratch-ok");
    await sandbox.teardown(hs);
    log("scratch OK");

    log("teardown #2 (destroy: container + volume)...");
    await sandbox.teardown(h2, { destroy: true });

    log("\n=== ALL LIVE ASSERTIONS PASSED ===");
  } finally {
    spawnSync("docker", ["rm", "-f", localContainerName(scope)], { stdio: "ignore" });
    spawnSync("docker", ["network", "rm", localNetworkName(localContainerName(scope))], { stdio: "ignore" });
    spawnSync("docker", ["volume", "rm", localVolumeName(scope)], { stdio: "ignore" });
    log("cleanup done");
  }
}

main().catch((e) => {
  console.error("[local-smoke] FAILED:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(1);
});
