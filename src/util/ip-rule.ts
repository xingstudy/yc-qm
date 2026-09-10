import { BlockList, isIP } from "node:net";

function canonicalIp(value: string): string | null {
  const ip = value.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(ip);
  if (!family || ip.includes("%")) return null;
  return new URL(`http://${family === 6 ? `[${ip}]` : ip}`).hostname.replace(/^\[(.*)\]$/, "$1");
}

function parseIpRule(value: string): { rule: string; block: BlockList } | null {
  const block = new BlockList();
  const parts = value.trim().split(/\s*-\s*|\//);
  const address = canonicalIp(parts[0] ?? "");
  if (!address || parts.length > 2) return null;
  const family = isIP(address) === 4 ? "ipv4" : "ipv6";
  try {
    if (parts.length === 1) {
      block.addAddress(address, family);
      return { rule: address, block };
    }
    if (value.includes("/")) {
      if (!/^(0|[1-9]\d*)$/.test(parts[1]!)) return null;
      const prefix = Number(parts[1]);
      block.addSubnet(address, prefix, family);
      return { rule: `${address}/${prefix}`, block };
    }
    const end = canonicalIp(parts[1]!);
    if (!end || isIP(end) !== isIP(address)) return null;
    block.addRange(address, end, family);
    return { rule: `${address}-${end}`, block };
  } catch {
    return null;
  }
}

export function normalizeIpRule(value: string): string | null {
  return parseIpRule(value)?.rule ?? null;
}

export function ipMatchesRule(ip: string, rule: string): boolean {
  const address = canonicalIp(ip);
  if (!address) return false;
  return parseIpRule(rule)?.block.check(address, isIP(address) === 4 ? "ipv4" : "ipv6") ?? false;
}
