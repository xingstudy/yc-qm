import assert from "node:assert/strict";
import test from "node:test";
import { localEgressProxyUrl, networkGuardRules } from "../src/sandbox/local-network-guard.ts";
import { createLocalEgress } from "../src/sandbox/local-egress.ts";

test("local proxy accepts a host gateway but rejects credentials, paths, non-HTTP and loopback", () => {
  assert.equal(localEgressProxyUrl("http://host.docker.internal:48080").origin, "http://host.docker.internal:48080");
  for (const value of [
    "https://proxy",
    "http://localhost:80",
    "http://127.1:80",
    "http://[::1]",
    "http://x:secret@proxy",
    "http://proxy/path",
    "http://proxy/?x=1",
    "http://proxy/#hash",
  ])
    assert.throws(() => localEgressProxyUrl(value));
});

test("network guard denies both families before allowing only proxy, local services and replies", () => {
  const rules = networkGuardRules("172.17.0.1", 48080).map((args) => args.join(" "));
  assert.deepEqual(rules.slice(0, 2), ["iptables -P OUTPUT DROP", "ip6tables -P OUTPUT DROP"]);
  assert.ok(rules.includes("iptables -A OUTPUT -d 127.0.0.11/32 -j DROP"));
  assert.ok(rules.includes("iptables -A OUTPUT -d 172.17.0.1 -p tcp --dport 48080 -j ACCEPT"));
  assert.ok(rules.some((rule) => rule.includes("--ctstate ESTABLISHED --ctdir REPLY")));
  assert.ok(rules.every((rule) => !rule.includes("RELATED") && !rule.includes("--dport 53")));
  assert.throws(() => networkGuardRules("127.0.0.1", 48080));
  assert.throws(() => networkGuardRules("172.17.0.1", 0));
});

test("guard creation failures do not silently launch a sandbox with open networking", async () => {
  const calls: string[][] = [];
  const guard = createLocalEgress(
    async (args) => {
      calls.push(args);
      return args[0] === "run"
        ? { code: 1, stdout: "", stderr: "NET_ADMIN unavailable" }
        : { code: 0, stdout: "", stderr: "" };
    },
    "http://host.docker.internal:48080",
    "proxy:verified",
    "qa",
  );
  await assert.rejects(guard.create("qa-sandbox", "qa-network"), /NET_ADMIN unavailable/);
  const run = calls.find((call) => call[0] === "run")!;
  assert.ok(run.includes("--cap-drop=ALL"));
  assert.ok(run.includes("--cap-add=NET_ADMIN"));
  assert.ok(run.includes("--read-only"));
  assert.ok(!run.some((arg) => arg.includes("SECRET")));
});

test("a restarted core refuses a guard built from an older image at the same tag", async () => {
  const guard = createLocalEgress(
    async (args) => ({
      code: 0,
      stderr: "",
      stdout: args[0] === "image" ? "sha256:new-image" : "true sha256:old-image",
    }),
    "http://host.docker.internal:48080",
    "proxy:latest",
    "qa",
  );
  assert.equal(await guard.ready("qa-sandbox"), undefined);
});
