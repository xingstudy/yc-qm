import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}

function digest(value: Record<string, unknown>): string {
  return createHash("sha256").update(stable(value)).digest("base64url");
}

export function mintPortalLoginProof(claims: Record<string, unknown>, secret: string, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      aud: "qm-core-login",
      digest: digest(claims),
      iat: issuedAt,
      exp: issuedAt + 60,
      jti: randomBytes(18).toString("base64url"),
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyPortalLoginProof(
  proof: string,
  claims: Record<string, unknown>,
  secret: string,
  nowMs: number,
): { jti: string; expiresAtMs: number } | null {
  const [payload, signature, extra] = proof.split(".");
  if (!payload || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const actual = Buffer.from(signature, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const now = Math.floor(nowMs / 1000);
  if (
    value.aud !== "qm-core-login" ||
    value.digest !== digest(claims) ||
    typeof value.iat !== "number" ||
    typeof value.exp !== "number" ||
    typeof value.jti !== "string" ||
    !value.jti ||
    value.iat > now + 5 ||
    value.exp <= now ||
    value.exp - value.iat !== 60
  ) {
    return null;
  }
  return { jti: value.jti, expiresAtMs: value.exp * 1000 };
}
