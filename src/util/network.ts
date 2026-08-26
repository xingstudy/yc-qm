import { BlockList, isIP } from "node:net";

const PRIVATE_NETWORKS = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  PRIVATE_NETWORKS.addSubnet(network, prefix, "ipv4");

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["fc00::", 7],
  ["fec0::", 10],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const)
  PRIVATE_NETWORKS.addSubnet(network, prefix, "ipv6");

function normalizedIp(raw: string): string | null {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/%.*$/, "");
  const dottedMapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dottedMapped && isIP(dottedMapped[1]!) === 4) return dottedMapped[1]!;
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (mapped) {
    const high = Number.parseInt(mapped[1]!, 16);
    const low = Number.parseInt(mapped[2]!, 16);
    return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  return isIP(value) ? value : null;
}

function wellKnownNat64Ipv4(value: string): string | null {
  if (isIP(value) !== 6) return null;
  const compressed = value.includes("::");
  const [before = "", after = "", extra] = value.split("::");
  if (extra !== undefined) return null;
  const left = before ? before.split(":") : [];
  const right = after ? after.split(":") : [];
  const groups = compressed ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8 || groups[0] !== "64" || groups[1] !== "ff9b") return null;
  const tail = groups.slice(6);
  if (tail.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const bytes = tail.flatMap((group) => [
    Number.parseInt(group.slice(0, -2) || "0", 16),
    Number.parseInt(group.slice(-2), 16),
  ]);
  return bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes.join(".") : null;
}

export function isPrivateNetworkIp(raw: string): boolean {
  const value = normalizedIp(raw);
  if (!value) return false;
  const nat64 = wellKnownNat64Ipv4(value);
  if (nat64 && isPrivateNetworkIp(nat64)) return true;
  return PRIVATE_NETWORKS.check(value, isIP(value) === 4 ? "ipv4" : "ipv6");
}
