import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { errMessage } from "../util/errors.ts";

export function localEgressProxyUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname === "localhost" ||
    url.hostname.startsWith("127.") ||
    url.hostname.includes(":")
  ) {
    throw new Error(
      "LOCAL_SANDBOX_EGRESS_PROXY_URL must be an HTTP proxy host with an optional port, outside sandbox loopback (IPv4)",
    );
  }
  return url;
}

export function networkGuardRules(address: string, port: number): string[][] {
  if (isIP(address) !== 4 || address.startsWith("127.") || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid local egress proxy destination");
  return [
    ["iptables", "-P", "OUTPUT", "DROP"],
    ["ip6tables", "-P", "OUTPUT", "DROP"],
    ["iptables", "-F", "OUTPUT"],
    ["ip6tables", "-F", "OUTPUT"],
    ["iptables", "-A", "OUTPUT", "-d", "127.0.0.11/32", "-j", "DROP"],
    ["iptables", "-A", "OUTPUT", "-d", "127.0.0.1/32", "-j", "ACCEPT"],
    ["ip6tables", "-A", "OUTPUT", "-d", "::1/128", "-j", "ACCEPT"],
    ["iptables", "-A", "OUTPUT", "-m", "conntrack", "--ctstate", "ESTABLISHED", "--ctdir", "REPLY", "-j", "ACCEPT"],
    ["iptables", "-A", "OUTPUT", "-d", address, "-p", "tcp", "--dport", String(port), "-j", "ACCEPT"],
  ];
}

async function main(): Promise<void> {
  const proxy = localEgressProxyUrl(process.argv[2] ?? "");
  const { address } = await lookup(proxy.hostname, { family: 4 });
  for (const [bin, ...args] of networkGuardRules(address, Number(proxy.port || 80))) {
    execFileSync(bin!, ["-w", "5", ...args], { stdio: "inherit" });
  }
  proxy.hostname = address;
  writeFileSync("/tmp/qm-egress-ready", proxy.origin);
  setInterval(() => {}, 60_000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(errMessage(error));
    process.exit(1);
  });
}
