import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readBody, PayloadTooLargeError, serveEmojiFavicon } from "../../chassis/src/http.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import type { AuthConfig } from "./config.ts";
import { validEmail } from "./config.ts";
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
import {
  confirmSignInPage,
  emailFormPage,
  handoffCompletePage,
  handoffWaitingPage,
  linkSentPage,
  problemPage,
  wecomLoginPage,
  CONFIRM_PAGE_CSP,
  HANDOFF_PAGE_CSP,
  PAGE_CSP,
  WECOM_LOGIN_PAGE_CSP,
  WECOM_LOGIN_SCRIPT,
} from "./pages.ts";
import { qrSvg } from "./qr.ts";
import type { DirectorySourceClient } from "../../chassis/src/directory-source-client.ts";
import type { PortalLoginTransactions } from "../../chassis/src/portal-login-transactions.ts";

const MAX_FORM_BYTES = 8 * 1024;
const ID_TOKEN_TTL_S = 300;
const MAX_INFLIGHT_SENDS = 32;
const DIRECTORY_PROFILE_STATE_RE = /^[0-9a-f]{64}$/;
const WECOM_JSSDK = readFileSync(new URL(import.meta.resolve("@wecom/jssdk/dist/wecom.global.prod.js")), "utf8");

export interface AuthDeps {
  cfg: AuthConfig;
  signingKey: SigningKey;
  signer: TokenSigner;
  claims: ClaimStore;
  mailer: Mailer;
  brandName?: () => string;
  directorySources?: DirectorySourceClient;
  directoryContinuations?: PortalLoginTransactions;
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

function emailIdentity(email: string): AuthIdentity {
  return { principal: email, email, emailVerified: true };
}

function clientIpOf(req: IncomingMessage): string {
  const forwarded = req.headers["x-qm-client-ip"];
  const declared = typeof forwarded === "string" ? forwarded.trim() : "";
  return declared || req.socket.remoteAddress || "unknown";
}

function directoryContinuationBucket(secret: string, clientIp: string): string {
  return createHmac("sha256", secret).update(`directory-profile|${clientIp}`, "utf8").digest("base64url");
}

function handoffResultState(secret: string, continuationState: string): string {
  return createHmac("sha256", secret).update(`directory-handoff-result|${continuationState}`, "utf8").digest("hex");
}

function isWeComClient(req: IncomingMessage): boolean {
  const agent = req.headers["user-agent"];
  return typeof agent === "string" && /wxwork/i.test(agent);
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

function sendJavaScript(res: ServerResponse, body: string): void {
  res.writeHead(200, noStore({ "content-type": "text/javascript; charset=utf-8" }));
  res.end(body);
}

function wecomLoginParams(authorizeUrl: string): {
  appId: string;
  agentId: string;
  redirectUri: string;
  state: string;
} | null {
  try {
    const url = new URL(authorizeUrl);
    if (url.origin !== "https://open.work.weixin.qq.com" || url.pathname !== "/wwopen/sso/qrConnect") return null;
    const appId = url.searchParams.get("appid") ?? "";
    const agentId = url.searchParams.get("agentid") ?? "";
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!appId || !agentId || !redirectUri || !state) return null;
    return { appId, agentId, redirectUri, state };
  } catch {
    return null;
  }
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
  const now = deps.now ?? Date.now;
  const notify = deps.onBackgroundTask ?? ((task: Promise<void>) => void task.catch(() => undefined));
  const formAction = `${cfg.publicPath}/authorize`;
  const directoryLoginAction = `${cfg.publicPath}/directory/login`;
  const linkTtlMinutes = Math.max(1, Math.round(cfg.linkTtlS / 60));
  const wecomWebLoginEnabled = new URL(cfg.issuer).protocol === "https:";
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

  const continuationUnavailable = (res: ServerResponse, status: string): void =>
    status === "client_limited" || status === "global_limited"
      ? problem(
          res,
          429,
          "Too many sign-ins right now",
          "Enterprise sign-in is busy. Wait a moment and start again from the sign-in page.",
        )
      : problem(res, 503, "Enterprise sign-in failed", "The sign-in service is temporarily unavailable.");

  const signInUrl = ((): string | undefined => {
    try {
      return new URL("/auth/login", cfg.redirectUri).toString();
    } catch {
      return undefined;
    }
  })();

  const sameRelyingParty = (candidate: string): boolean => {
    try {
      const target = new URL(candidate);
      const expected = new URL(cfg.redirectUri);
      return target.origin === expected.origin && target.pathname === expected.pathname;
    } catch {
      return false;
    }
  };

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

  const directoryButtons = async (requestToken: string) => {
    if (!deps.directorySources) return [];
    try {
      const options = await deps.directorySources.loginOptions("catalog");
      return options.map((option) => ({
        label: option.displayName,
        url: `${directoryLoginAction}?request=${encodeURIComponent(requestToken)}&source=${encodeURIComponent(option.sourceId)}`,
      }));
    } catch {
      return [];
    }
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
    const directoryLoginOptions = await directoryButtons(sealed.token);
    return sendHtml(
      res,
      200,
      emailFormPage({
        brandName: brandName(),
        action: formAction,
        requestToken: sealed.token,
        directoryLoginOptions,
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
          directoryLoginOptions: await directoryButtons(sealed.token),
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

  async function directoryLogin(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): Promise<void> {
    if (!deps.directorySources)
      return problem(
        res,
        404,
        "Enterprise sign-in isn't available",
        "Ask your administrator to configure an identity source.",
      );
    const state = params.get("request") ?? "";
    const opened = await signer.openRequestEnvelope(state, now());
    if (!opened) {
      return problem(
        res,
        400,
        "This sign-in page expired",
        "Sign-in pages are only valid for a short while. Start again from the page you were trying to reach.",
      );
    }
    const sourceId = params.get("source") ?? "";
    if (!sourceId || sourceId.length > 200) {
      return problem(res, 400, "This sign-in source isn't valid", "Start again from the sign-in page.");
    }
    if (!(await claimOnce(claims, `directory-request:${opened.jti}`, opened.expiresAtMs))) {
      return problem(res, 400, "This enterprise sign-in no longer works", "Start again from the sign-in page.");
    }
    const at = now();
    const ipAllowed = await withinRateLimit(claims, {
      secret: cfg.tokenSecret,
      kind: "directory-login-ip",
      value: clientIpOf(req),
      limit: 10,
      windowS: 60,
      nowMs: at,
    });
    if (!ipAllowed) {
      return problem(res, 429, "Too many enterprise sign-in attempts", "Wait a minute and start again.");
    }
    const sourceAllowed = await withinRateLimit(claims, {
      secret: cfg.tokenSecret,
      kind: "directory-login-source",
      value: sourceId,
      limit: 60,
      windowS: 60,
      nowMs: at,
    });
    if (!sourceAllowed) {
      return problem(res, 429, "Too many enterprise sign-in attempts", "Wait a minute and start again.");
    }
    const request = opened.claims;
    const selected = await signer.sealRequest({ ...request, directorySourceId: sourceId }, cfg.requestTtlS, now());
    let option;
    try {
      option = (await deps.directorySources.loginOptions(selected.token)).find(
        (candidate) => candidate.sourceId === sourceId,
      );
    } catch (error) {
      return problem(
        res,
        502,
        "Enterprise sign-in failed",
        "We couldn't load this identity source.",
        errMessage(error),
      );
    }
    if (!option) return problem(res, 404, "This sign-in source isn't available", "Ask your administrator to check it.");
    if (option.provider === "wecom" && wecomWebLoginEnabled && !isWeComClient(req)) {
      const login = wecomLoginParams(option.authorizeUrl);
      if (login) {
        return sendHtml(
          res,
          200,
          wecomLoginPage({
            brandName: brandName(),
            ...login,
            sdkUrl: `${cfg.publicPath}/wecom-jssdk.js`,
            initializerUrl: `${cfg.publicPath}/wecom-login.js`,
            fallbackUrl: option.authorizeUrl,
          }),
          WECOM_LOGIN_PAGE_CSP,
        );
      }
    }
    res.writeHead(302, noStore({ location: option.authorizeUrl }));
    res.end();
  }

  async function directoryCallback(req: IncomingMessage, res: ServerResponse, params: URLSearchParams): Promise<void> {
    if (!deps.directorySources)
      return problem(
        res,
        404,
        "Enterprise sign-in isn't available",
        "Ask your administrator to configure an identity source.",
      );
    const state = params.get("state") ?? "";
    let continuationClaim: { state: string; claimId: string } | null = null;
    let openedState;
    if (DIRECTORY_PROFILE_STATE_RE.test(state)) {
      if (!deps.directoryContinuations) {
        return problem(res, 503, "Enterprise sign-in failed", "The sign-in service is temporarily unavailable.");
      }
      const claimed = await deps.directoryContinuations.claim(state);
      if (claimed.status === "unavailable") {
        return problem(res, 503, "Enterprise sign-in failed", "The sign-in service is temporarily unavailable.");
      }
      if (claimed.status !== "claimed") {
        return problem(res, 400, "This enterprise sign-in no longer works", "Start again from the sign-in page.");
      }
      continuationClaim = { state, claimId: claimed.claimId };
      openedState = await signer.openRequestEnvelope(claimed.payload, now());
    } else {
      openedState = await signer.openRequestEnvelope(state, now());
    }
    const fail = async (status: number, heading: string, msg: string, detail?: string): Promise<void> => {
      if (continuationClaim && deps.directoryContinuations) {
        if (openedState?.claims.directoryHandoff) {
          await deps.directoryContinuations.publish(
            continuationClaim.state,
            continuationClaim.claimId,
            handoffResultState(cfg.tokenSecret, continuationClaim.state),
            JSON.stringify({ error: heading }),
            openedState.expiresAtMs,
            "failed",
          );
        } else {
          await deps.directoryContinuations.complete(continuationClaim.state, continuationClaim.claimId, "failed");
        }
      }
      problem(res, status, heading, msg, detail);
    };
    if (!openedState) {
      return fail(400, "This enterprise sign-in expired", "Start again from the page you were trying to reach.");
    }
    const request = openedState.claims;
    if (continuationClaim && !request.directoryProfileIdentity) {
      return fail(400, "This enterprise sign-in expired", "Start again from the page you were trying to reach.");
    }
    const directoryCode = params.get("code") ?? "";
    if (!directoryCode)
      return fail(400, "Enterprise sign-in was cancelled", "Start again when you're ready to sign in.");
    if (!request.directorySourceId) return fail(400, "This sign-in source is missing", "Start again.");
    if (
      !continuationClaim &&
      !(await claimOnce(claims, `directory-state:${openedState.jti}`, openedState.expiresAtMs))
    ) {
      return fail(400, "This enterprise sign-in no longer works", "Start again from the sign-in page.");
    }
    const at = now();
    const ipAllowed = await withinRateLimit(claims, {
      secret: cfg.tokenSecret,
      kind: "directory-callback-ip",
      value: clientIpOf(req),
      limit: 20,
      windowS: 60,
      nowMs: at,
    });
    if (!ipAllowed) {
      return fail(429, "Too many enterprise sign-in attempts", "Wait a minute and start again.");
    }
    const sourceAllowed = await withinRateLimit(claims, {
      secret: cfg.tokenSecret,
      kind: "directory-callback-source",
      value: request.directorySourceId,
      limit: 60,
      windowS: 60,
      nowMs: at,
    });
    if (!sourceAllowed) {
      return fail(429, "Too many enterprise sign-in attempts", "Wait a minute and start again.");
    }
    let identity: AuthIdentity;
    try {
      let externalIdentity;
      if (request.directoryProfileIdentity) {
        if (!deps.directorySources.resolveProfileAuthorizationCode) {
          throw new Error("directory profile authorization is unavailable");
        }
        externalIdentity = await deps.directorySources.resolveProfileAuthorizationCode(
          request.directorySourceId,
          directoryCode,
          request.directoryProfileIdentity,
        );
      } else {
        const resolved = await deps.directorySources.resolveCode(request.directorySourceId, directoryCode);
        externalIdentity = resolved.identity;
        if (resolved.authorizationRequired) {
          if (!deps.directorySources.profileAuthorizationUrl || !deps.directoryContinuations) {
            throw new Error("directory profile authorization is unavailable");
          }
          const inClient = isWeComClient(req);
          const continuation = await signer.sealRequest(
            {
              ...request,
              directoryProfileIdentity: {
                provider: externalIdentity.provider,
                externalTenantId: externalIdentity.externalTenantId,
                externalSubjectId: externalIdentity.externalSubjectId,
              },
              ...(inClient ? {} : { directoryHandoff: true as const }),
            },
            cfg.requestTtlS,
            now(),
          );
          const continuationState = randomBytes(32).toString("hex");
          const created = await deps.directoryContinuations.create(
            continuationState,
            continuation.token,
            continuation.expiresAtMs,
            directoryContinuationBucket(cfg.tokenSecret, clientIpOf(req)),
          );
          if (created !== "created") return continuationUnavailable(res, created);
          const { authorizeUrl, promptDelivered } = await deps.directorySources.profileAuthorizationUrl(
            request.directorySourceId,
            continuationState,
            inClient ? undefined : { externalSubjectId: externalIdentity.externalSubjectId, brandName: brandName() },
          );
          if (inClient) {
            res.writeHead(302, noStore({ location: authorizeUrl }));
            res.end();
            return;
          }
          const handoff = await signer.sealHandoff(
            { continuationState, authorizeUrl, promptDelivered },
            Math.max(1, Math.round((continuation.expiresAtMs - now()) / 1000)),
            now(),
          );
          const handoffUrl = new URL(`${cfg.publicPath}/directory/handoff`, cfg.issuer);
          handoffUrl.searchParams.set("h", handoff.token);
          res.writeHead(302, noStore({ location: handoffUrl.toString() }));
          res.end();
          return;
        }
      }
      identity = {
        principal: `directory:${externalIdentity.sourceId}:${externalIdentity.externalTenantId}:${externalIdentity.externalSubjectId}`,
        ...(externalIdentity.corporateEmail ? { email: externalIdentity.corporateEmail } : {}),
        emailVerified: externalIdentity.corporateEmailVerified === true,
        ...(externalIdentity.displayName ? { name: externalIdentity.displayName } : {}),
        externalIdentity,
      };
    } catch (e) {
      return fail(502, "Enterprise sign-in failed", "We couldn't verify your enterprise account.", errMessage(e));
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
    if (request.directoryHandoff && continuationClaim && deps.directoryContinuations) {
      const published = await deps.directoryContinuations.publish(
        continuationClaim.state,
        continuationClaim.claimId,
        handoffResultState(cfg.tokenSecret, continuationClaim.state),
        JSON.stringify({ destination: destination.toString() }),
        code.expiresAtMs,
        "succeeded",
      );
      if (published !== "published") {
        return problem(res, 503, "Enterprise sign-in failed", "The sign-in service is temporarily unavailable.");
      }
    } else if (continuationClaim && deps.directoryContinuations) {
      const completed = await deps.directoryContinuations.complete(
        continuationClaim.state,
        continuationClaim.claimId,
        "succeeded",
      );
      if (completed !== "completed") {
        return problem(res, 503, "Enterprise sign-in failed", "The sign-in service is temporarily unavailable.");
      }
    }
    if (request.directoryHandoff) {
      return sendHtml(res, 200, handoffCompletePage({ brandName: brandName() }));
    }
    res.writeHead(302, noStore({ location: destination.toString() }));
    res.end();
  }

  async function directoryHandoff(res: ServerResponse, params: URLSearchParams): Promise<void> {
    if (!deps.directoryContinuations) {
      return problem(res, 503, "Enterprise sign-in failed", "The sign-in service is temporarily unavailable.");
    }
    const opened = await signer.openHandoff(params.get("h") ?? "", now());
    if (!opened) {
      return problem(
        res,
        400,
        "This enterprise sign-in expired",
        "Approval takes a few minutes at most. Start again from the page you were trying to reach.",
      );
    }
    const claimed = await deps.directoryContinuations.claim(
      handoffResultState(cfg.tokenSecret, opened.continuationState),
    );
    if (claimed.status === "unavailable") {
      return problem(res, 503, "Enterprise sign-in failed", "The sign-in service is temporarily unavailable.");
    }
    if (claimed.status === "missing") {
      return sendHtml(
        res,
        200,
        handoffWaitingPage({
          brandName: brandName(),
          authorizeUrl: opened.authorizeUrl,
          qr: qrSvg(opened.authorizeUrl),
          promptDelivered: opened.promptDelivered,
        }),
        HANDOFF_PAGE_CSP,
      );
    }
    if (claimed.status !== "claimed") {
      return sendHtml(
        res,
        200,
        problemPage({
          brandName: brandName(),
          heading: "This sign-in is already finished",
          msg: "It was completed in another tab, or it expired before you approved it. Check your other tabs first.",
          ...(signInUrl ? { retryUrl: signInUrl } : {}),
        }),
      );
    }
    await deps.directoryContinuations.complete(
      handoffResultState(cfg.tokenSecret, opened.continuationState),
      claimed.claimId,
      "succeeded",
    );
    let parsed: { destination?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(claimed.payload) as { destination?: unknown; error?: unknown };
    } catch {
      return problem(res, 502, "Enterprise sign-in failed", "We couldn't finish signing you in.");
    }
    if (typeof parsed.destination !== "string" || !sameRelyingParty(parsed.destination)) {
      return problem(
        res,
        403,
        "Enterprise sign-in failed",
        typeof parsed.error === "string" && parsed.error ? parsed.error : "We couldn't finish signing you in.",
      );
    }
    res.writeHead(302, noStore({ location: parsed.destination }));
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
    if (!granted.externalIdentity && granted.email && !emailAllowed(cfg, granted.email))
      return sendJson(res, 400, { error: "invalid_grant" });

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
      ...(granted.externalIdentity ? { externalIdentity: granted.externalIdentity } : {}),
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
        ...(granted.externalIdentity ? { externalIdentity: granted.externalIdentity } : {}),
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
      ...(opened.externalIdentity ? { qm_external_identity: opened.externalIdentity } : {}),
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
        "qm_external_identity",
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
    if (method === "GET" && path === "/wecom-jssdk.js") return sendJavaScript(res, WECOM_JSSDK);
    if (method === "GET" && path === "/wecom-login.js") return sendJavaScript(res, WECOM_LOGIN_SCRIPT);
    if (method === "GET" && path === "/.well-known/jwks.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "public, max-age=300" });
      return void res.end(JSON.stringify({ keys: [signingKey.publicJwk] }));
    }
    if (method === "GET" && path === "/.well-known/openid-configuration") return discovery(res);
    if (method === "GET" && path === "/authorize") return authorizeForm(res, url.searchParams);
    if (method === "POST" && path === "/authorize") return authorizeSubmit(req, res);
    if (method === "GET" && path === "/verify") return confirmVerify(res);
    if (method === "POST" && path === "/verify") return verify(req, res);
    if (method === "GET" && (path === "/directory/login" || path === "/wecom/login"))
      return directoryLogin(req, res, url.searchParams);
    if (method === "GET" && (path === "/directory/callback" || path === "/wecom/callback"))
      return directoryCallback(req, res, url.searchParams);
    if (method === "GET" && path === "/directory/handoff") return directoryHandoff(res, url.searchParams);
    if (method === "POST" && path === "/token") return token(req, res);
    if ((method === "GET" || method === "POST") && path === "/userinfo") return userinfo(req, res);
    return sendJson(res, 404, { error: "not_found" });
  };
}
