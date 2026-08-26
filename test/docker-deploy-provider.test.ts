import assert from "node:assert/strict";
import { test } from "node:test";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { scopeId } from "../src/types.ts";

test("Docker deployments use isolated networks and remove them on destroy", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "No such network" };
    if (args[0] === "inspect")
      return { code: 0, stdout: 'true [{"HostIp":"127.0.0.1","HostPort":"49152"}]', stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const first = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/one",
  });
  const second = await store.create({
    ownerScopeId: scopeId("personal", "U2"),
    createdBy: "U2",
    entrypoint: "node server.js",
    snapshotDir: "/snap/two",
  });
  const provider = createDockerDeployProvider({ dockerExec });

  await provider.apply(first, first.versions[0]!);
  await provider.apply(second, second.versions[0]!);
  await provider.destroy(first);

  const firstName = `agent-deploy-${first.id.slice(0, 12)}`;
  const secondName = `agent-deploy-${second.id.slice(0, 12)}`;
  assert.ok(calls.some((args) => args.join(" ") === `network create ${firstName}-net`));
  assert.ok(calls.some((args) => args.join(" ") === `network create ${secondName}-net`));
  const firstCreate = calls.findIndex((args) => args[0] === "create" && args.includes(firstName));
  const firstCopy = calls.findIndex((args) => args[0] === "cp" && args.includes(`${first.versions[0]!.snapshotDir}/.`));
  const firstStart = calls.findIndex((args) => args[0] === "start" && args.includes(firstName));
  assert.ok(firstCreate < firstCopy && firstCopy < firstStart);
  assert.ok(calls[firstCreate]!.includes(`127.0.0.1::8080`));
  assert.ok(!calls[firstCreate]!.includes("-v"));
  assert.ok(calls[firstCopy]!.includes(`${firstName}:/app`));
  assert.ok(calls.some((args) => args.join(" ").includes(`--name ${secondName} --network ${secondName}-net`)));
  assert.ok(calls.some((args) => args.join(" ") === `network rm ${firstName}-net`));
});

test("Docker provider migrates running deployments off the legacy shared network", async () => {
  const calls: string[][] = [];
  let containerName = "";
  let connectAttempts = 0;
  let targetAttached = false;
  let legacyAttached = true;
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    if (args.join(" ") === "network inspect --format {{range .Containers}}{{println .Name}}{{end}} agent-deploynet") {
      return { code: 0, stdout: legacyAttached ? `${containerName}\n` : "", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    if (args[0] === "network" && args[1] === "connect" && ++connectAttempts === 1) {
      return { code: 1, stdout: "", stderr: "transient" };
    }
    if (args[0] === "network" && args[1] === "connect") targetAttached = true;
    if (args[0] === "network" && args[1] === "disconnect") legacyAttached = false;
    if (args[0] === "inspect") {
      if (args[2]?.includes(".State.Running"))
        return { code: 0, stdout: 'true [{"HostIp":"127.0.0.1","HostPort":"49153"}]', stderr: "" };
      return {
        code: 0,
        stdout: JSON.stringify({
          ...(legacyAttached ? { "agent-deploynet": {} } : {}),
          ...(targetAttached ? { [`${containerName}-net`]: {} } : {}),
        }),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/legacy",
  });
  containerName = `agent-deploy-${deployment.id.slice(0, 12)}`;
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec });

  assert.deepEqual(await provider.resolveEndpoint!(running, running.versions[0]!), { host: "127.0.0.1", port: 49153 });
  assert.equal(connectAttempts, 2);
  assert.ok(calls.some((args) => args.join(" ") === `network connect ${containerName}-net ${containerName}`));
  assert.ok(calls.some((args) => args.join(" ") === `network disconnect agent-deploynet ${containerName}`));
});

test("constructing a Docker provider does not inspect or migrate unrelated deployments", async () => {
  const calls: string[][] = [];
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return { code: 0, stdout: "", stderr: "" };
  };

  createDockerDeployProvider({ dockerExec });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, []);
});

test("an unrelated legacy migration failure does not block a new deployment", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args.join(" ") === "network inspect --format {{range .Containers}}{{println .Name}}{{end}} agent-deploynet") {
      return { code: 0, stdout: "agent-deploy-broken\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      if (args[2]?.includes(".State.Running"))
        return { code: 0, stdout: 'true [{"HostIp":"127.0.0.1","HostPort":"49154"}]', stderr: "" };
      return { code: 1, stdout: "", stderr: "daemon unavailable" };
    }
    if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/new",
  });
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.doesNotReject(provider.apply(deployment, deployment.versions[0]!));
});

test("a transient target inspection failure does not report the deployment missing", async () => {
  const dockerExec: DockerExec = async (args) => {
    if (args.join(" ") === "network inspect --format {{range .Containers}}{{println .Name}}{{end}} agent-deploynet") {
      return { code: 1, stdout: "", stderr: "No such network" };
    }
    if (args[0] === "inspect") return { code: 1, stdout: "", stderr: "daemon unavailable" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/running",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({ dockerExec });

  await assert.rejects(provider.resolveEndpoint!(running, running.versions[0]!), /daemon unavailable/);
});

test("Docker provider returns null for stopped or missing containers and rejects invalid endpoint state", async () => {
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/state",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  const provider = createDockerDeployProvider({
    dockerExec: async (args) => {
      if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "inspect" && args[2]?.includes(".NetworkSettings.Networks"))
        return { code: 0, stdout: "{}", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: "false null", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.equal(await provider.resolveEndpoint!(running, running.versions[0]!), null);

  const missing = createDockerDeployProvider({
    dockerExec: async (args) =>
      args[0] === "inspect"
        ? { code: 1, stdout: "", stderr: "No such container" }
        : { code: 0, stdout: "", stderr: "" },
  });
  assert.equal(await missing.resolveEndpoint!(running, running.versions[0]!), null);

  const malformed = createDockerDeployProvider({
    dockerExec: async (args) => {
      if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "inspect" && args[2]?.includes(".NetworkSettings.Networks"))
        return { code: 0, stdout: "{}", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: "true []", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(malformed.resolveEndpoint!(running, running.versions[0]!), /invalid endpoint state/);

  const ipv6Only = createDockerDeployProvider({
    dockerExec: async (args) => {
      if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "inspect" && args[2]?.includes(".NetworkSettings.Networks"))
        return { code: 0, stdout: "{}", stderr: "" };
      if (args[0] === "inspect") return { code: 0, stdout: 'true [{"HostIp":"::1","HostPort":"49155"}]', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(ipv6Only.resolveEndpoint!(running, running.versions[0]!), /invalid endpoint state/);

  const unavailable = createDockerDeployProvider({
    dockerExec: async (args) => {
      if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "inspect" && args[2]?.includes(".NetworkSettings.Networks"))
        return { code: 0, stdout: "{}", stderr: "" };
      return { code: 1, stdout: "", stderr: "daemon unavailable" };
    },
  });
  await assert.rejects(unavailable.resolveEndpoint!(running, running.versions[0]!), /daemon unavailable/);
});

test("Docker provider resolves the daemon's current published port", async () => {
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir: "/snap/ports",
  });
  await store.setEndpoint(deployment.id, { host: "127.0.0.1", port: 9200 });
  const running = (await store.get(deployment.id))!;
  let port = 49156;
  const provider = createDockerDeployProvider({
    dockerExec: async (args) => {
      if (args[0] === "network" && args[1] === "inspect") return { code: 0, stdout: "", stderr: "" };
      if (args[0] === "inspect" && args[2]?.includes(".NetworkSettings.Networks"))
        return { code: 0, stdout: "{}", stderr: "" };
      if (args[0] === "inspect")
        return { code: 0, stdout: `true [{"HostIp":"127.0.0.1","HostPort":"${port++}"}]`, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(await provider.resolveEndpoint!(running, running.versions[0]!), { host: "127.0.0.1", port: 49156 });
  assert.deepEqual(await provider.resolveEndpoint!(running, running.versions[0]!), { host: "127.0.0.1", port: 49157 });
});

test("Docker provider cleans up after create, copy, start, and inspect failures", async () => {
  for (const failed of ["create", "cp", "start", "inspect"]) {
    const calls: string[][] = [];
    const store = createDeployStore();
    const deployment = await store.create({
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      entrypoint: "node server.js",
      snapshotDir: "/snap/failure",
    });
    const provider = createDockerDeployProvider({
      dockerExec: async (args) => {
        calls.push(args);
        if (args[0] === "network" && args[1] === "inspect") return { code: 1, stdout: "", stderr: "missing" };
        if (args[0] === failed) return { code: 1, stdout: "", stderr: `${failed} failed` };
        return { code: 0, stdout: 'true [{"HostIp":"127.0.0.1","HostPort":"49155"}]', stderr: "" };
      },
    });
    await assert.rejects(provider.apply(deployment, deployment.versions[0]!));
    const container = `agent-deploy-${deployment.id.slice(0, 12)}`;
    assert.ok(calls.some((args) => args.join(" ") === `rm -f ${container}`));
    assert.ok(calls.some((args) => args.join(" ") === `network rm ${container}-net`));
  }
});
