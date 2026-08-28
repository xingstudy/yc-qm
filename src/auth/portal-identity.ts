import { verifySignedPayload } from "./signed-token.ts";

export interface PortalIdentity {
  p: string;
  n?: string;
  imp?: string;
  isv?: number;
  sv?: number;
  exp: number;
}

export const PORTAL_IDENTITY_HEADER = "x-portal-identity";

export async function verifyPortalIdentity(
  token: string,
  secret: string,
  nowMs: number,
): Promise<PortalIdentity | null> {
  const claims = (await verifySignedPayload(token, secret)) as PortalIdentity | null;
  if (!claims || typeof claims.p !== "string" || !claims.p || typeof claims.exp !== "number") return null;
  if (claims.imp !== undefined && (typeof claims.imp !== "string" || !claims.imp)) return null;
  if (claims.isv !== undefined && (!Number.isInteger(claims.isv) || claims.isv < 0)) return null;
  if ((claims.imp === undefined) !== (claims.isv === undefined)) return null;
  if (claims.sv !== undefined && (!Number.isInteger(claims.sv) || claims.sv < 0)) return null;
  if (nowMs > claims.exp) return null;
  return claims;
}
