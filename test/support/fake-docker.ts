import type { DockerExec } from "../../src/sandbox/local-sandbox.ts";

export interface FakeContainer {
  name: string;
  imageId: string;
  running: boolean;
  labels: Record<string, string>;
  volume?: string;
  network?: string;
  finishedAt?: string;
}

export interface FakeDocker {
  dockerExec: DockerExec;
  containers: Map<string, FakeContainer>;
  volumes: Set<string>;
  networks: Set<string>;
  runCount: number;
  daemonDown: boolean;
  imageMissing: boolean;
  imageId: string;
  imageFingerprint: string;
}

export function installFakeDocker(daemonPort: number): FakeDocker {
  const containers = new Map<string, FakeContainer>();
  const volumes = new Set<string>();
  const networks = new Set<string>();
  const self: FakeDocker = {
    containers,
    volumes,
    networks,
    runCount: 0,
    daemonDown: false,
    imageMissing: false,
    imageId: "sha256:image-v1",
    imageFingerprint: "",
    dockerExec: async (args) => exec(args),
  };

  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });

  function parseRun(args: string[]): FakeContainer {
    const c: FakeContainer = { name: "", imageId: self.imageId, running: true, labels: {} };
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--name") c.name = args[++i]!;
      else if (a === "--label") {
        const [k = "", v = ""] = args[++i]!.split("=");
        c.labels[k] = v;
      } else if (a === "-v") c.volume = args[++i]!.split(":")[0]!;
      else if (a === "--network") c.network = args[++i]!;
      else if (a === "-p" || a === "--cpus" || a === "--memory") i++;
    }
    return c;
  }

  function exec(args: string[]): { code: number; stdout: string; stderr: string } {
    const [cmd, ...rest] = args;
    if (self.daemonDown) return fail("Cannot connect to the Docker daemon");
    switch (cmd) {
      case "version":
        return ok("29.7.2");
      case "image": {
        if (self.imageMissing) return fail("Error: No such image");
        return ok(`${self.imageId} ${self.imageFingerprint}`);
      }
      case "inspect": {
        const name = rest[rest.length - 1]!;
        const c = containers.get(name);
        if (!c) return fail(`Error: No such object: ${name}`);
        if (rest.includes("{{.State.Running}}")) return ok(String(c.running));
        if (rest.includes("{{.State.Running}} {{.State.FinishedAt}}"))
          return ok(`${c.running} ${c.finishedAt ?? "0001-01-01T00:00:00Z"}`);
        return ok(`${c.running} ${c.imageId} ${c.labels["qm.egress"] ?? ""}`);
      }
      case "network": {
        const sub = rest[0];
        const name = sub === "create" ? rest[rest.length - 1]! : rest[1]!;
        if (sub === "connect" || sub === "disconnect") {
          const c = containers.get(rest[rest.length - 1]!);
          const net = rest[rest.length - 2]!;
          if (!c) return fail("No such container");
          if (sub === "connect") {
            if (!networks.has(net)) return fail(`network ${net} not found`);
            c.network = net;
          } else c.network = undefined;
          return ok();
        }
        if (sub === "inspect") return networks.has(name) ? ok(name) : fail(`Error: No such network: ${name}`);
        if (sub === "create") {
          if (networks.has(name)) return fail(`network with name ${name} already exists`);
          networks.add(name);
          return ok(name);
        }
        if (sub === "rm") return networks.delete(name) ? ok(name) : fail(`Error: No such network: ${name}`);
        return fail(`unknown network subcommand ${sub}`);
      }
      case "volume": {
        const [sub, name] = rest as [string, string];
        if (sub === "inspect") return volumes.has(name) ? ok(name) : fail(`Error: no such volume: ${name}`);
        if (sub === "create") {
          volumes.add(name);
          return ok(name);
        }
        if (sub === "rm") {
          const attached = [...containers.values()].some((c) => c.volume === name);
          if (attached) return fail(`volume is in use`);
          return volumes.delete(name) ? ok(name) : fail(`Error: no such volume: ${name}`);
        }
        return fail(`unknown volume subcommand ${sub}`);
      }
      case "run": {
        const c = parseRun(rest);
        if (self.imageMissing) return fail("Unable to find image");
        if (containers.has(c.name)) return fail(`Conflict. The container name "/${c.name}" is already in use`);
        containers.set(c.name, c);
        self.runCount++;
        return ok("deadbeef");
      }
      case "start": {
        const c = containers.get(rest[0]!);
        if (!c) return fail("Error: No such container");
        if (!c.network || (!networks.has(c.network) && !containers.get(c.network.replace(/^container:/, ""))?.running))
          return fail(`network ${c.network} not found`);
        c.running = true;
        return ok(rest[0]!);
      }
      case "exec":
        return containers.get(rest[0]!)?.running ? ok("http://172.17.0.1:48080") : fail("No such running container");
      case "stop": {
        const c = containers.get(rest[rest.length - 1]!);
        if (!c) return fail("Error: No such container");
        c.running = false;
        c.finishedAt = new Date().toISOString();
        return ok();
      }
      case "rm": {
        const name = rest[rest.length - 1]!;
        containers.delete(name);
        return ok(name);
      }
      case "port": {
        const c = containers.get(rest[0]!);
        if (!c || !c.running) return fail("Error: No such container or not running");
        return ok(`127.0.0.1:${daemonPort}`);
      }
      case "ps":
        return ok(
          [...containers.values()]
            .filter((c) => c.labels["qm.sandbox"] === "1" && c.labels["qm.org"] === "default-org")
            .map((c) => c.name)
            .join("\n"),
        );
      default:
        return fail(`fake docker: unsupported command ${cmd}`);
    }
  }

  return self;
}
