import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hostMatches,
  isHostDenied,
  egressDecision,
  parseEgressPolicy,
  privateNetworkAllowed,
} from "../src/resolution/egress-policy.ts";
import type { EgressPolicy } from "../src/types.ts";

test("hostMatches: exact + subdomain, not siblings or superstrings", () => {
  assert.equal(hostMatches("example.com", "example.com"), true);
  assert.equal(hostMatches("API.Example.com", "example.com"), true);
  assert.equal(hostMatches("a.b.example.com", "example.com"), true);
  assert.equal(hostMatches("notexample.com", "example.com"), false);
  assert.equal(hostMatches("example.com.evil.com", "example.com"), false);
});

test("hostMatches: tolerates *. / trailing dot, and a trailing-dot request host can't evade", () => {
  assert.equal(hostMatches("api.example.com", "*.example.com"), true);
  assert.equal(hostMatches("example.com", "example.com."), true);
  assert.equal(hostMatches("api.example.com.", "example.com"), true);
});

test("hostMatches: IDN folds to punycode (Unicode rule matches the punycode request host)", () => {
  const reqHost = new URL("https://pästebin.com").hostname;
  assert.notEqual(reqHost, "pästebin.com");
  assert.equal(hostMatches(reqHost, "pästebin.com"), true);
});

test("hostMatches: host-only — a rule's port / path / userinfo reduce to the bare host", () => {
  assert.equal(hostMatches("api.example.com", "example.com:443"), true);
  assert.equal(hostMatches("api.example.com", "example.com/v1"), true);
  assert.equal(hostMatches("api.example.com", "user@example.com"), true);
});

test("hostMatches: IPv6 literals compare equal across bracketed / bare / uncompressed forms", () => {
  assert.equal(hostMatches("[::1]", "::1"), true);
  assert.equal(hostMatches("::1", "[::1]"), true);
  assert.equal(hostMatches("[2001:db8::1]", "2001:0db8::1"), true);
  assert.equal(hostMatches("::1", "::2"), false);
});

test("hostMatches / isHostDenied: empty operands and empty denylist never match", () => {
  assert.equal(hostMatches("", "example.com"), false);
  assert.equal(hostMatches("example.com", ""), false);
  assert.equal(isHostDenied("example.com", undefined), false);
  assert.equal(isHostDenied("example.com", []), false);
  assert.equal(isHostDenied("api.example.com", ["example.com"]), true);
});

test("egressDecision: no policy ⇒ allow", () => {
  assert.deepEqual(egressDecision("anything.test", undefined), { allow: true, verdict: "ok" });
});

test("egressDecision: a deny wins, including over an allowlisted host", () => {
  const policy: EgressPolicy = { allowedHosts: ["example.com"], deniedHosts: ["api.example.com"] };
  assert.deepEqual(egressDecision("api.example.com", policy), { allow: false, verdict: "denied" });
  assert.deepEqual(egressDecision("www.example.com", policy), { allow: true, verdict: "ok" });
});

test("egressDecision: empty allowlist = pure denylist mode (allow anything not denied)", () => {
  const policy: EgressPolicy = { allowedHosts: [], deniedHosts: ["bad.test"] };
  assert.equal(egressDecision("anything.test", policy).allow, true);
  assert.deepEqual(egressDecision("x.bad.test", policy), { allow: false, verdict: "denied" });
});

test("egressDecision: a non-empty allowlist requires a match", () => {
  const policy: EgressPolicy = { allowedHosts: ["api.internal"], deniedHosts: [] };
  assert.equal(egressDecision("api.internal", policy).allow, true);
  assert.deepEqual(egressDecision("example.com", policy), { allow: false, verdict: "not_allowlisted" });
});

test("private network exceptions parse domains, IPv4/IPv6 addresses, subnets and inclusive ranges", () => {
  const entries = [
    "KIBANA.Example.COM.",
    "10.1.37.205",
    "10.1.37.0/24",
    "10.1.37.200 - 10.1.37.210",
    "[FD00:0::1]",
    "fd00::/64",
    "fd00::10-fd00::20",
  ];
  assert.deepEqual(
    parseEgressPolicy({ allowedHosts: [], privateNetworkAllowedHosts: entries, denyPrivateNetworks: false }),
    {
      policy: {
        allowedHosts: [],
        deniedHosts: [],
        privateNetworkAllowedHosts: [
          "kibana.example.com",
          "10.1.37.205",
          "10.1.37.0/24",
          "10.1.37.200-10.1.37.210",
          "fd00::1",
          "fd00::/64",
          "fd00::10-fd00::20",
        ],
      },
    },
  );
  assert.deepEqual(parseEgressPolicy({ privateNetworkAllowedHosts: [] }), {
    policy: { allowedHosts: [], deniedHosts: [] },
  });
});

test("invalid private network entries fail validation without broadening their meaning", () => {
  for (const entry of [
    "10.0.0.0/33",
    "fd00::/129",
    "10.0.0.0/-1",
    "10.0.0.0/1.5",
    "10.0.0.0/24/path",
    "10.0.0.20-10.0.0.10",
    "10.0.0.1-fd00::1",
    "999.1.1.1",
    "10.1",
    "0x0a0125cd",
    "[fd00::1]:443",
    "fd00::1%eth0",
    "https://kibana.example.com",
    "example.com/24",
    "*.example.com",
  ]) {
    assert.ok("error" in parseEgressPolicy({ privateNetworkAllowedHosts: [entry] }), entry);
  }
  for (const entries of ["10.0.0.0/8", [null], ["fd00::1", "[fd00:0::1]"], ["EXAMPLE.com", "example.com."]]) {
    assert.ok("error" in parseEgressPolicy({ privateNetworkAllowedHosts: entries }), JSON.stringify(entries));
  }
});

test("private IP rules match resolved addresses and boundaries without becoming hostname suffix grants", () => {
  const host = "kibana.example.com";
  for (const rule of ["10.1.37.205", "10.1.37.0/24", "10.1.37.200-10.1.37.210"]) {
    assert.equal(privateNetworkAllowed(host, "10.1.37.205", [rule]), true, rule);
    assert.equal(privateNetworkAllowed(host, "10.1.38.205", [rule]), false, rule);
    assert.equal(privateNetworkAllowed("evil.10.1.37.205", "10.9.9.9", [rule]), false, rule);
    assert.equal(privateNetworkAllowed(host, "::ffff:10.1.37.205", [rule]), true, rule);
  }
  for (const [address, allowed] of [
    ["10.1.37.199", false],
    ["10.1.37.200", true],
    ["10.1.37.210", true],
    ["10.1.37.211", false],
  ] as const) {
    assert.equal(privateNetworkAllowed(host, address, ["10.1.37.200-10.1.37.210"]), allowed, address);
  }
  assert.equal(privateNetworkAllowed(host, "fd00::1", ["fd00::/64"]), true);
  assert.equal(privateNetworkAllowed(host, "fd00:0:0:1::1", ["fd00::/64"]), false);
  assert.equal(privateNetworkAllowed(host, "fd00::20", ["fd00::10-fd00::20"]), true);
  assert.equal(privateNetworkAllowed(host, "fd00::21", ["fd00::10-fd00::20"]), false);
  assert.equal(privateNetworkAllowed("api.kibana.example.com", "10.1.37.205", [host]), true);
  assert.equal(privateNetworkAllowed("kibana.example.com.evil.test", "10.1.37.205", [host]), false);
});
