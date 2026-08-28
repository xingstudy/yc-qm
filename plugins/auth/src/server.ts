import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, PayloadTooLargeError, serveEmojiFavicon } from "../../chassis/src/http.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import type { AuthConfig } from "./config.ts";
import { validEmail, weComLoginConfigured } from "./config.ts";
import { claimOnce, withinRateLimit, type ClaimStore } from "../../chassis/src/claims.ts";
import {
  mintIdToken,
  pkceMatches,
  safeEqual,
  subjectFor,
  TokenSigner,
  type AuthIdentity,
  type AuthRequest,
} from "./tokens.ts";
import { ID_TOKEN_ALG, type SigningKey } from "./keys.ts";
import { renderSignInEmail, type Mailer } from "./email.ts";
import { confirmSignInPage, emailFormPage, linkSentPage, problemPage, CONFIRM_PAGE_CSP, PAGE_CSP } from "./pages.ts";

const MAX_FORM_BYTES = 8 * 1024;
const ID_TOKEN_TTL_S = 300;
const MAX_INFLIGHT_SENDS = 32;
const WECOM_QRCONNECT_URL = "https://open.work.weixin.qq.com/wwopen/sso/qrConnect";
const WECOM_API_BASE_URL = "https://qyapi.weixin.qq.com";
const WECOM_API_TIMEOUT_MS = 8_000;

export interface AuthDeps {
  cfg: AuthConfig;
  signingKey: SigningKey;
  signer: TokenSigner;
  claims: ClaimStore;
  mailer: Mailer;
  brandName?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  onBackgroundTask?: (task: Promise<void>) => void;
}

function emailAllowed(cfg: AuthConfig, email: string): boolean {
  if (cfg.allowedEmails.includes(email)) return true;
  return Boolean(cfg.allowedEmailDomain) && email.endsWith(`@${cfg.allowedEmailDomain}`);
}

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

function nonBlankString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

function emailIdentity(email: string): AuthIdentity {
  return { principal: email, email, emailVerified: true };
}

async function weComJson(fetchImpl: typeof fetch, url: URL, label: string): Promise<Record<string, unknown>> {
  const r = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(WECOM_API_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`${label} failed (${r.status})`);
  const parsed = (await r.json().catch(() => null)) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`${label} returned JSON`);
  const data = parsed as Record<string, unknown>;
  const errcode = typeof data.errcode === "number" ? data.errcode : 0;
  if (errcode !== 0) {
    const errmsg = typeof data.errmsg === "string" ? data.errmsg : "";
    throw new Error(`${label} failed (${errcode}${errmsg ? `: ${errmsg}` : ""})`);
  }
  return data;
}

async function weComIdentityByCode(cfg: AuthConfig, code: string, fetchImpl: typeof fetch): Promise<AuthIdentity> {
  const tokenUrl = new URL(`${WECOM_API_BASE_URL}/cgi-bin/gettoken`);
  tokenUrl.searchParams.set("corpid", cfg.wecomLogin.corpId);
  tokenUrl.searchParams.set("corpsecret", cfg.wecomLogin.secret);
  const tokenData = await weComJson(fetchImpl, tokenUrl, "WeCom token exchange");
  const accessToken = typeof tokenData.access_token === "string" ? tokenData.access_token : "";
  if (!accessToken) throw new Error("WeCom token exchange returned no access token");

  const identityUrl = new URL(`${WECOM_API_BASE_URL}/cgi-bin/auth/getuserinfo`);
  identityUrl.searchParams.set("access_token", accessToken);
  identityUrl.searchParams.set("code", code);
  const identityData = await weComJson(fetchImpl, identityUrl, "WeCom identity lookup");
  const userId = nonBlankString(identityData.UserId) || nonBlankString(identityData.userid);
  if (!userId) throw new Error("WeCom identity lookup returned no user id");

  const userUrl = new URL(`${WECOM_API_BASE_URL}/cgi-bin/user/get`);
  userUrl.searchParams.set("access_token", accessToken);
  userUrl.searchParams.set("userid", userId);
  const userData = await weComJson(fetchImpl, userUrl, "WeCom user lookup");
  const rawEmail = nonBlankString(userData.email) || nonBlankString(userData.biz_mail);
  const email = normalizeEmail(rawEmail);
  const rawName = nonBlankString(userData.name) || nonBlankString(userData.alias) || userId;
  const name = rawName.trim().slice(0, 200);
  if (validEmail(email)) return { principal: email, email, emailVerified: true, ...(name ? { name } : {}) };
  return {
    principal: `wecom:${cfg.wecomLogin.corpId}:${userId}`,
    emailVerified: false,
    ...(name ? { name } : {}),
  };
}

function clientIpOf(req: IncomingMessage): string {
  const forwarded = req.headers["x-qm-client-ip"];
  const declared = typeof forwarded === "string" ? forwarded.trim() : "";
  return declared || req.socket.remoteAddress || "unknown";
}

function noStore(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, noStore({ "content-type": "application/json" }));
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, html: string, csp = PAGE_CSP): void {
  res.writeHead(
    status,
    noStore({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": csp,
      "x-frame-options": "DENY",
      "x-robots-tag": "noindex, nofollow",
    }),
  );
  res.end(html);
}

function basicCredentials(header: string | undefined): { id: string; secret: string } | null {
  if (!header || !/^basic /i.test(header)) return null;
  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) return null;
  return { id: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}

function readAuthorizeRequest(
  cfg: AuthConfig,
  params: URLSearchParams,
): { request: AuthRequest } | { problem: string } {
  const clientId = params.get("client_id") ?? "";
  const redirectUri = params.get("redirect_uri") ?? "";
  if (!clientId || !safeEqual(clientId, cfg.clientId))
    return { problem: "This sign-in request is for an unknown application." };
  if (!redirectUri || !safeEqual(redirectUri, cfg.redirectUri))
    return { problem: "This sign-in request would return you to an address that is not registered." };
  if ((params.get("response_type") ?? "") !== "code")
    return { problem: "Only the authorization-code flow is supported." };
  if ((params.get("code_challenge_method") ?? "") !== "S256")
    return { problem: "This sign-in request must use PKCE with S256." };
  const codeChallenge = params.get("code_challenge") ?? "";
  if (!/^[A-Za-z0-9\-_]{43}$/.test(codeChallenge))
    return { problem: "This sign-in request carries a malformed PKCE challenge." };
  const state = params.get("state") ?? "";
  const nonce = params.get("nonce") ?? "";
  if (!state || state.length > 512) return { problem: "This sign-in request is missing its state." };
  if (!nonce || nonce.length > 512) return { problem: "This sign-in request is missing its nonce." };
  const scope = params.get("scope") ?? "openid";
  if (!scope.split(/\s+/).includes("openid")) return { problem: "This sign-in request must ask for the openid scope." };
  return { request: { clientId, redirectUri, state, nonce, codeChallenge, scope } };
}

export function createAuthHandler(deps: AuthDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const { cfg, signer, claims, mailer, signingKey } = deps;
  const brandName = deps.brandName ?? ((): string => cfg.brandName);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const notify = deps.onBackgroundTask ?? ((task: Promise<void>) => void task.catch(() => undefined));
  const formAction = `${cfg.publicPath}/authorize`;
  const weComLoginAction = `${cfg.publicPath}/wecom/login`;
  const weComEnabled = weComLoginConfigured(cfg);
  const linkTtlMinutes = Math.max(1, Math.round(cfg.linkTtlS / 60));
  let inFlightSends = 0;
  const background = (task: () => Promise<void>): void => {
    if (inFlightSends >= MAX_INFLIGHT_SENDS) {
      console.warn("[auth] sign-in link suppressed: too many deliveries already in flight");
      return;
    }
    inFlightSends++;
    notify(
      task().finally(() => {
        inFlightSends--;
      }),
    );
  };

  const problem = (res: ServerResponse, status: number, heading: string, msg: string, detail?: string): void =>
    sendHtml(res, status, problemPage({ brandName: brandName(), heading, msg, ...(detail ? { detail } : {}) }));

  const signInUrl = ((): string | undefined => {
    try {
      return new URL("/auth/login", cfg.redirectUri).toString();
    } catch {
      return undefined;
    }
  })();

  const staleLink = (res: ServerResponse): void =>
    sendHtml(
      res,
      400,
      problemPage({
        brandName: brandName(),
        heading: "This sign-in link no longer works",
        msg: "Sign-in links work once and expire quickly. Request a fresh one and open it right away.",
        ...(signInUrl ? { retryUrl: signInUrl } : {}),
      }),
    );

  const weComLoginUrl = (requestToken: string): string | undefined =>
    weComEnabled ? `${weComLoginAction}?request=${encodeURIComponent(requestToken)}` : undefined;

  const weComAuthorizeUrl = (state: string): string => {
    const u = new URL(WECOM_QRCONNECT_URL);
    u.searchParams.set("appid", cfg.wecomLogin.corpId);
    u.searchParams.set("agentid", cfg.wecomLogin.agentId);
    u.searchParams.set("redirect_uri", cfg.wecomLogin.redirectUri);
    u.searchParams.set("state", state);
    return u.toString();
  };

  async function authorizeForm(res: ServerResponse, params: URLSearchParams): Promise<void> {
    const parsed = readAuthorizeRequest(cfg, params);
    if ("problem" in parsed)
      return problem(
        res,
        400,
        "This sign-in link isn't valid",
        "Start again from the page you were trying to reach.",
        parsed.problem,
      );
    const sealed = await signer.sealRequest(parsed.request, cfg.requestTtlS, now());
    return sendHtml(
      res,
      200,
      emailFormPage({
        brandName: brandName(),
        action: formAction,
        requestToken: sealed.token,
        wecomLoginUrl: weComLoginUrl(sealed.token),
      }),
    );
  }

  async function sendLink(request: AuthRequest, email: string, ip: string): Promise<void> {
    const nowMs = now();
    const within = async (kind: string, value: string, limit: number): Promise<boolean> =>
      withinRateLimit(claims, { secret: cfg.tokenSecret, kind, value, limit, windowS: cfg.sendWindowS, nowMs });
    if (!emailAllowed(cfg, email)) {
      console.warn(`[auth] sign-in link suppressed: ${email} is not on the permitted list`);
      return;
    }
    if (!(await within("ip", ip, cfg.sendLimitPerIp))) {
      console.warn("[auth] sign-in link suppressed: per-address rate limit reached for the requesting client");
      return;
    }
    if (!(await within("mailbox", email, cfg.sendLimitPerEmail))) {
      console.warn("[auth] sign-in link suppressed: per-mailbox rate limit reached");
      return;
    }
    const sealed = await signer.sealLink({ ...request, email }, cfg.linkTtlS, nowMs);
    const link = `${cfg.issuer}/verify#token=${encodeURIComponent(sealed.token)}`;
    try {
      const receipt = await mailer.send(
        renderSignInEmail({ to: email, brandName: brandName(), link, ttlMinutes: linkTtlMinutes }),
      );
      console.log(`[auth] sign-in link sent to ${email} (${receipt})`);
    } catch (e) {
      console.error(`[auth] sign-in link to ${email} could not be delivered: ${errMessage(e)}`);
    }
  }

  async function authorizeSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch (e) {
      if (e instanceof PayloadTooLargeError)
        return problem(res, 413, "That didn't work", "The sign-in form sent more data than we accept.");
      throw e;
    }
    const form = new URLSearchParams(raw);
    const request = await signer.openRequest(form.get("request") ?? "", now());
    if (!request) {
      return problem(
        res,
        400,
        "This sign-in page expired",
        "Sign-in pages are only valid for a short while. Start again from the page you were trying to reach.",
      );
    }
    const email = normalizeEmail(form.get("email") ?? "");
    if (!validEmail(email)) {
      const sealed = await signer.sealRequest(request, cfg.requestTtlS, now());
      return sendHtml(
        res,
        400,
        emailFormPage({
          brandName: brandName(),
          action: formAction,
          requestToken: sealed.token,
          wecomLoginUrl: weComLoginUrl(sealed.token),
          problem: "That doesn't look like an email address.",
        }),
      );
    }
    if (!emailAllowed(cfg, email)) {
      return problem(res, 403, "This address can't sign in", "Your administrator has not allowed this email address.");
    }
    const ip = clientIpOf(req);
    sendHtml(res, 200, linkSentPage({ brandName: brandName(), email, ttlMinutes: linkTtlMinutes }));
    background(() => sendLink(request, email, ip));
  }

  function confirmVerify(res: ServerResponse): void {
    return sendHtml(
      res,
      200,
      confirmSignInPage({ brandName: brandName(), action: `${cfg.publicPath}/verify` }),
      CONFIRM_PAGE_CSP,
    );
  }

  async function verify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch {
      return problem(res, 413, "That didn't work", "The sign-in form sent more data than we accept.");
    }
    const form = new URLSearchParams(raw);
    const opened = await signer.openLink(form.get("token") ?? "", now());
    if (!opened) return staleLink(res);
    const { claims: link } = opened;
    if (!safeEqual(link.clientId, cfg.clientId) || !safeEqual(link.redirectUri, cfg.redirectUri)) {
      return problem(
        res,
        400,
        "This sign-in link no longer works",
        "The sign-in configuration changed after this link was sent. Start again.",
      );
    }
    if (!emailAllowed(cfg, link.email)) {
      return problem(res, 403, "This address can't sign in", "Your administrator has not allowed this email address.");
    }
    if (form.get("preview") === "1") return sendJson(res, 200, { email: link.email });
    if (!(await claimOnce(claims, `link:${opened.jti}`, opened.expiresAtMs))) return staleLink(res);
    const code = await signer.sealCode(
      {
        clientId: link.clientId,
        redirectUri: link.redirectUri,
        nonce: link.nonce,
        codeChallenge: link.codeChallenge,
        ...emailIdentity(link.email),
      },
      cfg.codeTtlS,
      now(),
    );
    const destination = new URL(link.redirectUri);
    destination.searchParams.set("code", code.token);
    destination.searchParams.set("state", link.state);
    res.writeHead(302, noStore({ location: destination.toString() }));
    res.end();
  }

  async function weComLogin(res: ServerResponse, params: URLSearchParams): Promise<void> {
    if (!weComEnabled)
      return problem(res, 404, "WeCom sign-in isn't available", "Ask your administrator to configure WeCom sign-in.");
    const state = params.get("request") ?? "";
    const request = await signer.openRequest(state, now());
    if (!request) {
      return problem(
        res,
        400,
        "This sign-in page expired",
        "Sign-in pages are only valid for a short while. Start again from the page you were trying to reach.",
      );
    }
    res.writeHead(302, noStore({ location: weComAuthorizeUrl(state) }));
    res.end();
  }

  async function weComCallback(res: ServerResponse, params: URLSearchParams): Promise<void> {
    if (!weComEnabled)
      return problem(res, 404, "WeCom sign-in isn't available", "Ask your administrator to configure WeCom sign-in.");
    const state = params.get("state") ?? "";
    const request = await signer.openRequest(state, now());
    if (!request) {
      return problem(res, 400, "This WeCom sign-in expired", "Start again from the page you were trying to reach.");
    }
    const weComCode = params.get("code") ?? "";
    if (!weComCode)
      return problem(res, 400, "WeCom sign-in was cancelled", "Start again when you're ready to sign in.");
    let identity: AuthIdentity;
    try {
      identity = await weComIdentityByCode(cfg, weComCode, fetchImpl);
    } catch (e) {
      return problem(res, 502, "WeCom sign-in failed", "We couldn't verify your WeCom account.", errMessage(e));
    }
    if (identity.email && !emailAllowed(cfg, identity.email)) {
      return problem(res, 403, "This address can't sign in", "Your administrator has not allowed this email address.");
    }
    const code = await signer.sealCode(
      {
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        nonce: request.nonce,
        codeChallenge: request.codeChallenge,
        ...identity,
      },
      cfg.codeTtlS,
      now(),
    );
    const destination = new URL(request.redirectUri);
    destination.searchParams.set("code", code.token);
    destination.searchParams.set("state", request.state);
    res.writeHead(302, noStore({ location: destination.toString() }));
    res.end();
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credentials = basicCredentials(req.headers.authorization);
    const idOk = credentials !== null && safeEqual(credentials.id, cfg.clientId);
    const secretOk = credentials !== null && safeEqual(credentials.secret, cfg.clientSecret);
    if (!idOk || !secretOk) {
      res.writeHead(401, noStore({ "content-type": "application/json", "www-authenticate": `Basic realm="qm-auth"` }));
      return void res.end(JSON.stringify({ error: "invalid_client" }));
    }
    let raw: string;
    try {
      raw = await readBody(req, MAX_FORM_BYTES);
    } catch {
      return sendJson(res, 400, { error: "invalid_request" });
    }
    const form = new URLSearchParams(raw);
    if (form.get("grant_type") !== "authorization_code") return sendJson(res, 400, { error: "unsupported_grant_type" });
    const opened = await signer.openCode(form.get("code") ?? "", now());
    if (!opened) return sendJson(res, 400, { error: "invalid_grant" });
    const { claims: granted } = opened;
    const redirectUri = form.get("redirect_uri") ?? "";
    if (
      !safeEqual(granted.clientId, cfg.clientId) ||
      !safeEqual(granted.redirectUri, redirectUri) ||
      !safeEqual(redirectUri, cfg.redirectUri)
    ) {
      return sendJson(res, 400, { error: "invalid_grant" });
    }
    if (!(await claimOnce(claims, `code:${opened.jti}`, opened.expiresAtMs)))
      return sendJson(res, 400, { error: "invalid_grant" });
    if (!pkceMatches(form.get("code_verifier") ?? "", granted.codeChallenge))
      return sendJson(res, 400, { error: "invalid_grant" });
    if (granted.email && !emailAllowed(cfg, granted.email)) return sendJson(res, 400, { error: "invalid_grant" });

    const nowMs = now();
    const sub = subjectFor(cfg.issuer, granted.principal);
    const idToken = await mintIdToken(signingKey, {
      issuer: cfg.issuer,
      clientId: cfg.clientId,
      sub,
      principal: granted.principal,
      ...(granted.email ? { email: granted.email } : {}),
      emailVerified: granted.emailVerified,
      ...(granted.name ? { name: granted.name } : {}),
      nonce: granted.nonce,
      ttlS: ID_TOKEN_TTL_S,
      nowMs,
    });
    const access = await signer.sealAccess(
      {
        sub,
        principal: granted.principal,
        ...(granted.email ? { email: granted.email } : {}),
        emailVerified: granted.emailVerified,
        ...(granted.name ? { name: granted.name } : {}),
      },
      cfg.accessTtlS,
      nowMs,
    );
    return sendJson(res, 200, {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: cfg.accessTtlS,
      id_token: idToken,
      scope: "openid email profile",
    });
  }

  async function userinfo(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const header = req.headers.authorization ?? "";
    if (!/^bearer /i.test(header)) {
      res.writeHead(401, noStore({ "content-type": "application/json", "www-authenticate": "Bearer" }));
      return void res.end(JSON.stringify({ error: "invalid_token" }));
    }
    const opened = await signer.openAccess(header.slice(7).trim(), now());
    if (!opened) {
      res.writeHead(
        401,
        noStore({ "content-type": "application/json", "www-authenticate": `Bearer error="invalid_token"` }),
      );
      return void res.end(JSON.stringify({ error: "invalid_token" }));
    }
    return sendJson(res, 200, {
      sub: opened.sub,
      qm_principal: opened.principal,
      qm_principal_verified: true,
      ...(opened.email ? { email: opened.email, email_verified: opened.emailVerified } : {}),
      ...(opened.name ? { name: opened.name } : {}),
    });
  }

  function discovery(res: ServerResponse): void {
    sendJson(res, 200, {
      issuer: cfg.issuer,
      authorization_endpoint: `${cfg.issuer}/authorize`,
      token_endpoint: `${cfg.issuer}/token`,
      userinfo_endpoint: `${cfg.issuer}/userinfo`,
      jwks_uri: `${cfg.issuer}/.well-known/jwks.json`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [ID_TOKEN_ALG],
      scopes_supported: ["openid", "email", "profile"],
      claims_supported: [
        "sub",
        "iss",
        "aud",
        "exp",
        "iat",
        "nonce",
        "azp",
        "email",
        "email_verified",
        "name",
        "qm_principal",
        "qm_principal_verified",
      ],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
    });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://auth.local");
    const path = url.pathname;

    if (method === "GET" && path === "/healthz") return sendJson(res, 200, { ok: true });
    if (method === "GET" && (path === "/favicon.ico" || path === "/favicon.svg")) {
      return serveEmojiFavicon(res, "✉️", "max-age=86400");
    }
    if (method === "GET" && path === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      return void res.end(JSON.stringify({ keys: [signingKey.publicJwk] }));
    }
    if (method === "GET" && path === "/.well-known/openid-configuration") return discovery(res);
    if (method === "GET" && path === "/authorize") return authorizeForm(res, url.searchParams);
    if (method === "POST" && path === "/authorize") return authorizeSubmit(req, res);
    if (method === "GET" && path === "/verify") return confirmVerify(res);
    if (method === "POST" && path === "/verify") return verify(req, res);
    if (method === "GET" && path === "/wecom/login") return weComLogin(res, url.searchParams);
    if (method === "GET" && path === "/wecom/callback") return weComCallback(res, url.searchParams);
    if (method === "POST" && path === "/token") return token(req, res);
    if ((method === "GET" || method === "POST") && path === "/userinfo") return userinfo(req, res);
    return sendJson(res, 404, { error: "not_found" });
  };
}
