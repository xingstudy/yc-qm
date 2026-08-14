import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

const NAMESPACE = "authbroker:";
const MAX_IDS = 64;
const MAX_ID_LENGTH = 200;
const MAX_HORIZON_MS = 24 * 60 * 60 * 1000;
const PORTAL_LOGIN_MAX_HORIZON_MS = (2 * 60 * 60 + 5 * 60) * 1000;
const PORTAL_LOGIN_MAX_PAYLOAD_BYTES = 16 * 1024;
const PORTAL_LOGIN_STATE_RE = /^[0-9a-f]{64}$/;
const PORTAL_LOGIN_CLIENT_BUCKET_RE = /^[A-Za-z0-9_-]{43}$/;
const PORTAL_LOGIN_CLAIM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function claimBrokerNonce(ctx: ApiCtx): Promise<void> {
  const { res, deps, body } = ctx;
  if (!deps.replayDedupe?.durable) {
    return sendJson(res, 503, {
      error: "not_configured",
      message:
        "single-use claims need the Postgres-backed replay store; set DATABASE_URL so a restart cannot resurrect a spent sign-in link",
    });
  }
  const b = isObj(body) ? body : {};
  const ids: unknown[] = Array.isArray(b.ids) ? b.ids : [];
  if (
    ids.length === 0 ||
    ids.length > MAX_IDS ||
    !ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH)
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `ids must hold 1 to ${MAX_IDS} non-empty strings of at most ${MAX_ID_LENGTH} characters`,
    });
  }
  const now = Date.now();
  const expiresAtMs = b.expiresAtMs;
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now ||
    expiresAtMs > now + MAX_HORIZON_MS
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "expiresAtMs must be a future epoch-millisecond timestamp within 24 hours",
    });
  }
  for (const id of ids as string[]) {
    if (await deps.replayDedupe.claim(`${NAMESPACE}${id}`, expiresAtMs)) return sendJson(res, 200, { claimed: id });
  }
  return sendJson(res, 200, { claimed: null });
}

function portalLoginStore(ctx: ApiCtx) {
  return ctx.deps.portalLoginTransactions?.durable ? ctx.deps.portalLoginTransactions : null;
}

function portalLoginState(body: Record<string, unknown>): string | null {
  const state = body.state;
  return typeof state === "string" && PORTAL_LOGIN_STATE_RE.test(state) ? state : null;
}

function portalLoginExpiry(body: Record<string, unknown>): number | null {
  const expiresAtMs = body.expiresAtMs;
  const now = Date.now();
  if (
    typeof expiresAtMs !== "number" ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= now ||
    expiresAtMs > now + PORTAL_LOGIN_MAX_HORIZON_MS
  )
    return null;
  return expiresAtMs;
}

function portalLoginUnavailable(ctx: ApiCtx): void {
  sendJson(ctx.res, 503, {
    error: "not_configured",
    message: "portal login transactions need Postgres; set DATABASE_URL so a cross-browser sign-in survives restarts",
  });
}

async function createPortalLogin(ctx: ApiCtx): Promise<void> {
  const store = portalLoginStore(ctx);
  if (!store) return portalLoginUnavailable(ctx);
  const body = isObj(ctx.body) ? ctx.body : {};
  const state = portalLoginState(body);
  const expiresAtMs = portalLoginExpiry(body);
  const payload = body.payload;
  const clientBucket = body.clientBucket;
  if (
    !state ||
    !expiresAtMs ||
    typeof payload !== "string" ||
    Buffer.byteLength(payload) > PORTAL_LOGIN_MAX_PAYLOAD_BYTES ||
    typeof clientBucket !== "string" ||
    !PORTAL_LOGIN_CLIENT_BUCKET_RE.test(clientBucket)
  )
    return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid portal login transaction" });
  return sendJson(ctx.res, 200, { status: await store.create(state, payload, expiresAtMs, clientBucket) });
}

async function claimPortalLogin(ctx: ApiCtx): Promise<void> {
  const store = portalLoginStore(ctx);
  if (!store) return portalLoginUnavailable(ctx);
  const body = isObj(ctx.body) ? ctx.body : {};
  const state = portalLoginState(body);
  if (!state)
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "state must be 64 lowercase hexadecimal characters",
    });
  const claimed = await store.claim(state);
  return sendJson(ctx.res, 200, claimed);
}

async function completePortalLogin(ctx: ApiCtx): Promise<void> {
  const store = portalLoginStore(ctx);
  if (!store) return portalLoginUnavailable(ctx);
  const body = isObj(ctx.body) ? ctx.body : {};
  const state = portalLoginState(body);
  const claimId = body.claimId;
  const outcome = body.outcome;
  if (
    !state ||
    typeof claimId !== "string" ||
    !PORTAL_LOGIN_CLAIM_ID_RE.test(claimId) ||
    (outcome !== "succeeded" && outcome !== "failed")
  )
    return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid portal login completion" });
  return sendJson(ctx.res, 200, await store.complete(state, claimId, outcome));
}

export const authBrokerRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/auth/broker/claim", auth: "source", handle: claimBrokerNonce },
  { method: "POST", path: "/v1/auth/portal-login/create", auth: "source", handle: createPortalLogin },
  { method: "POST", path: "/v1/auth/portal-login/claim", auth: "source", handle: claimPortalLogin },
  { method: "POST", path: "/v1/auth/portal-login/complete", auth: "source", handle: completePortalLogin },
];
