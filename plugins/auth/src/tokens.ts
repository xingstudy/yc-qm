import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { ID_TOKEN_ALG, type SigningKey } from "./keys.ts";

export type TokenPurpose = "request" | "link" | "code" | "access";

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scope: string;
}

export interface LinkClaims extends AuthRequest {
  email: string;
}

export interface AuthIdentity {
  principal: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
}

export interface CodeClaims extends AuthIdentity {
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
}

export interface AccessClaims extends AuthIdentity {
  sub: string;
}

export interface SealedToken {
  token: string;
  jti: string;
  expiresAtMs: number;
}

const audienceFor = (purpose: TokenPurpose): string => `qm-auth:${purpose}`;

export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}

export function pkceMatches(codeVerifier: string, codeChallenge: string): boolean {
  if (codeVerifier.length < 43 || codeVerifier.length > 128 || !/^[A-Za-z0-9\-._~]+$/.test(codeVerifier)) return false;
  return safeEqual(createHash("sha256").update(codeVerifier).digest("base64url"), codeChallenge);
}

export function subjectFor(issuer: string, principal: string): string {
  return createHash("sha256").update(`${issuer}\n${principal}`, "utf8").digest("base64url");
}

export class TokenSigner {
  private readonly keys = new Map<TokenPurpose, Uint8Array>();
  private readonly secret: string;
  private readonly issuer: string;

  constructor(secret: string, issuer: string) {
    this.secret = secret;
    this.issuer = issuer;
  }

  private keyFor(purpose: TokenPurpose): Uint8Array {
    const cached = this.keys.get(purpose);
    if (cached) return cached;
    const derived = new Uint8Array(createHmac("sha256", this.secret).update(`qm-auth.${purpose}.v1`).digest());
    this.keys.set(purpose, derived);
    return derived;
  }

  async seal(
    purpose: TokenPurpose,
    claims: Record<string, unknown>,
    ttlS: number,
    nowMs = Date.now(),
  ): Promise<SealedToken> {
    const jti = randomBytes(18).toString("base64url");
    const issuedAt = Math.floor(nowMs / 1000);
    const expiresAt = issuedAt + ttlS;
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(this.issuer)
      .setAudience(audienceFor(purpose))
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .setJti(jti)
      .sign(this.keyFor(purpose));
    return { token, jti, expiresAtMs: expiresAt * 1000 };
  }

  async open(purpose: TokenPurpose, token: string, nowMs = Date.now()): Promise<JWTPayload | null> {
    try {
      const { payload } = await jwtVerify(token, this.keyFor(purpose), {
        issuer: this.issuer,
        audience: audienceFor(purpose),
        algorithms: ["HS256"],
        requiredClaims: ["jti", "iat", "exp"],
        currentDate: new Date(nowMs),
        clockTolerance: 5,
      });
      return payload;
    } catch {
      return null;
    }
  }

  async sealRequest(request: AuthRequest, ttlS: number, nowMs?: number): Promise<SealedToken> {
    return this.seal("request", requestClaims(request), ttlS, nowMs);
  }

  async openRequest(token: string, nowMs?: number): Promise<AuthRequest | null> {
    const payload = await this.open("request", token, nowMs);
    return payload ? readRequest(payload) : null;
  }

  async sealLink(claims: LinkClaims, ttlS: number, nowMs?: number): Promise<SealedToken> {
    return this.seal("link", { ...requestClaims(claims), em: claims.email }, ttlS, nowMs);
  }

  async openLink(
    token: string,
    nowMs?: number,
  ): Promise<{ claims: LinkClaims; jti: string; expiresAtMs: number } | null> {
    const payload = await this.open("link", token, nowMs);
    const request = payload ? readRequest(payload) : null;
    const email = payload?.em;
    if (!payload || !request || typeof email !== "string" || !email) return null;
    return { claims: { ...request, email }, jti: String(payload.jti), expiresAtMs: Number(payload.exp) * 1000 };
  }

  async sealCode(claims: CodeClaims, ttlS: number, nowMs?: number): Promise<SealedToken> {
    return this.seal(
      "code",
      {
        cid: claims.clientId,
        ru: claims.redirectUri,
        no: claims.nonce,
        cc: claims.codeChallenge,
        pr: claims.principal,
        ev: claims.emailVerified,
        ...(claims.email ? { em: claims.email } : {}),
        ...(claims.name ? { nm: claims.name } : {}),
      },
      ttlS,
      nowMs,
    );
  }

  async openCode(
    token: string,
    nowMs?: number,
  ): Promise<{ claims: CodeClaims; jti: string; expiresAtMs: number } | null> {
    const payload = await this.open("code", token, nowMs);
    if (!payload) return null;
    const { cid, ru, no, cc, pr, em, ev, nm } = payload as Record<string, unknown>;
    if ([cid, ru, no, cc, pr].some((value) => typeof value !== "string" || !value)) return null;
    if (em !== undefined && (typeof em !== "string" || !em)) return null;
    if (typeof ev !== "boolean") return null;
    if (nm !== undefined && (typeof nm !== "string" || !nm)) return null;
    return {
      claims: {
        clientId: cid as string,
        redirectUri: ru as string,
        nonce: no as string,
        codeChallenge: cc as string,
        principal: pr as string,
        emailVerified: ev,
        ...(em ? { email: em as string } : {}),
        ...(nm ? { name: nm as string } : {}),
      },
      jti: String(payload.jti),
      expiresAtMs: Number(payload.exp) * 1000,
    };
  }

  async sealAccess(claims: AccessClaims, ttlS: number, nowMs?: number): Promise<SealedToken> {
    return this.seal(
      "access",
      {
        sub: claims.sub,
        pr: claims.principal,
        ev: claims.emailVerified,
        ...(claims.email ? { em: claims.email } : {}),
        ...(claims.name ? { nm: claims.name } : {}),
      },
      ttlS,
      nowMs,
    );
  }

  async openAccess(token: string, nowMs?: number): Promise<AccessClaims | null> {
    const payload = await this.open("access", token, nowMs);
    if (!payload || typeof payload.sub !== "string") return null;
    const claimedPrincipal = typeof payload.pr === "string" && payload.pr ? payload.pr : "";
    const fallbackEmail = typeof payload.em === "string" && payload.em ? payload.em : "";
    const principal = claimedPrincipal || fallbackEmail;
    if (!principal) return null;
    const email = typeof payload.em === "string" && payload.em ? payload.em : undefined;
    const name = typeof payload.nm === "string" && payload.nm ? payload.nm : undefined;
    return {
      sub: payload.sub,
      principal,
      emailVerified: payload.ev === true || Boolean(email),
      ...(email ? { email } : {}),
      ...(name ? { name } : {}),
    };
  }
}

function requestClaims(request: AuthRequest): Record<string, unknown> {
  return {
    cid: request.clientId,
    ru: request.redirectUri,
    st: request.state,
    no: request.nonce,
    cc: request.codeChallenge,
    sc: request.scope,
  };
}

function readRequest(payload: JWTPayload): AuthRequest | null {
  const { cid, ru, st, no, cc, sc } = payload as Record<string, unknown>;
  if ([cid, ru, st, no, cc, sc].some((value) => typeof value !== "string" || !value)) return null;
  return {
    clientId: cid as string,
    redirectUri: ru as string,
    state: st as string,
    nonce: no as string,
    codeChallenge: cc as string,
    scope: sc as string,
  };
}

export async function mintIdToken(
  key: SigningKey,
  args: {
    issuer: string;
    clientId: string;
    sub: string;
    principal: string;
    email?: string;
    emailVerified: boolean;
    name?: string;
    nonce: string;
    ttlS: number;
    nowMs?: number;
  },
): Promise<string> {
  const issuedAt = Math.floor((args.nowMs ?? Date.now()) / 1000);
  return new SignJWT({
    nonce: args.nonce,
    azp: args.clientId,
    qm_principal: args.principal,
    qm_principal_verified: true,
    ...(args.email ? { email: args.email, email_verified: args.emailVerified } : {}),
    ...(args.name ? { name: args.name } : {}),
  })
    .setProtectedHeader({ alg: ID_TOKEN_ALG, kid: key.kid, typ: "JWT" })
    .setIssuer(args.issuer)
    .setSubject(args.sub)
    .setAudience(args.clientId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + args.ttlS)
    .sign(key.privateKey);
}
