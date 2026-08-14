import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createMemoryReplayDedupe, type ReplayDedupe } from "../src/auth/replay-dedupe.ts";
import {
  createMemoryPortalLoginTransactionStore,
  type PortalLoginTransactionStore,
} from "../src/auth/portal-login-transactions.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "auth-broker-claim-test-secret".repeat(2);
const CLAIM_PATH = "/v1/auth/broker/claim";
const PORTAL_LOGIN_CREATE_PATH = "/v1/auth/portal-login/create";
const PORTAL_LOGIN_CLAIM_PATH = "/v1/auth/portal-login/claim";
const PORTAL_LOGIN_COMPLETE_PATH = "/v1/auth/portal-login/complete";
const PORTAL_LOGIN_CLIENT_BUCKET = "c".repeat(43);
let portalLoginNonce = 0;

function durableStub(): ReplayDedupe {
  const held = new Map<string, number>();
  return {
    durable: true,
    async claim(eventId, expiresAtMs) {
      if ((held.get(eventId) ?? 0) > Date.now()) return false;
      held.set(eventId, expiresAtMs);
      return true;
    },
  };
}

function durablePortalLoginStore(): PortalLoginTransactionStore {
  const store = createMemoryPortalLoginTransactionStore();
  return { ...store, durable: true };
}

function start(
  replayDedupe: ReplayDedupe = durableStub(),
  portalLoginTransactions: PortalLoginTransactionStore = durablePortalLoginStore(),
): {
  base: string;
  dedupe: ReplayDedupe;
  close: () => Promise<void>;
} {
  const built: BuiltApp = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "auth-broker-claim-")), orgId: "acme" }),
  );
  const server = createServer(built.app, { signingSecret: SECRET, replayDedupe, portalLoginTransactions });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    dedupe: replayDedupe,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function portalLogin(
  base: string,
  path: string,
  body: unknown,
  sign = true,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  const signedPath = `${path}?_sourceAuthNonce=${++portalLoginNonce}`;
  if (sign) {
    headers["x-timestamp"] = String(ts);
    headers["x-signature"] = signRequest(SECRET, ts, `POST\n${signedPath}\n${raw}`);
  }
  const res = await fetch(`${base}${signedPath}`, { method: "POST", headers, body: raw });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function claim(
  base: string,
  body: unknown,
  sign = true,
): Promise<{ status: number; json: { claimed?: unknown; error?: unknown } }> {
  const raw = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sign) {
    headers["x-timestamp"] = String(ts);
    headers["x-signature"] = signRequest(SECRET, ts, `POST\n${CLAIM_PATH}\n${raw}`);
  }
  const res = await fetch(`${base}${CLAIM_PATH}`, { method: "POST", headers, body: raw });
  return { status: res.status, json: (await res.json()) as { claimed?: unknown; error?: unknown } };
}

const soon = (): number => Date.now() + 60_000;

test("the broker claim route hands out each id exactly once", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const first = await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() });
  assert.equal(first.status, 200);
  assert.equal(first.json.claimed, "link:abc");
  assert.deepEqual((await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() })).json, { claimed: null });
});

test("a batch claims the first free slot and reports exhaustion", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const slots = ["rate:e:h:1:0", "rate:e:h:1:1", "rate:e:h:1:2"];
  assert.equal((await claim(srv.base, { ids: slots, expiresAtMs: soon() })).json.claimed, "rate:e:h:1:0");
  assert.equal((await claim(srv.base, { ids: slots, expiresAtMs: soon() })).json.claimed, "rate:e:h:1:1");
  assert.equal((await claim(srv.base, { ids: slots, expiresAtMs: soon() })).json.claimed, "rate:e:h:1:2");
  assert.equal((await claim(srv.base, { ids: slots, expiresAtMs: soon() })).json.claimed, null);
});

test("broker ids live in their own namespace and cannot poison another subsystem's nonces", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  assert.equal(
    (await claim(srv.base, { ids: ["oauth:shared-nonce"], expiresAtMs: soon() })).json.claimed,
    "oauth:shared-nonce",
  );
  assert.equal(
    await srv.dedupe.claim("oauth:shared-nonce", soon()),
    true,
    "the OAuth callback path must still be able to claim the unprefixed id",
  );
});

test("the claim route refuses to answer from a per-process replay store", async (t) => {
  const srv = start(createMemoryReplayDedupe());
  t.after(() => srv.close());
  const response = await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() });
  assert.equal(response.status, 503, "a RAM-only dedupe cannot make a sign-in link single-use across instances");
  assert.equal(response.json.error, "not_configured");
});

test("the claim route refuses unsigned callers", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const unsigned = await claim(srv.base, { ids: ["link:abc"], expiresAtMs: soon() }, false);
  assert.equal(unsigned.status, 401);
});

test("the claim route validates its input", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const cases: unknown[] = [
    { ids: [], expiresAtMs: soon() },
    { ids: ["ok"], expiresAtMs: Date.now() - 1000 },
    { ids: ["ok"], expiresAtMs: Date.now() + 48 * 60 * 60 * 1000 },
    { ids: ["ok"] },
    { ids: ["ok"], expiresAtMs: "soon" },
    { ids: "ok", expiresAtMs: soon() },
    { ids: [""], expiresAtMs: soon() },
    { ids: [42], expiresAtMs: soon() },
    { ids: ["x".repeat(201)], expiresAtMs: soon() },
    { ids: Array.from({ length: 65 }, (_, i) => `slot-${i}`), expiresAtMs: soon() },
  ];
  for (const body of cases) {
    const response = await claim(srv.base, body);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(response.json.error, "bad_request");
  }
});

test("portal login transactions are durable source-auth records with one claimant", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const state = "a".repeat(64);
  const payload = JSON.stringify({ nonce: "n", verifier: "v", returnTo: "/" });
  const expiresAtMs = Date.now() + 60_000;
  const createBody = { state, payload, expiresAtMs, clientBucket: PORTAL_LOGIN_CLIENT_BUCKET };
  assert.deepEqual((await portalLogin(srv.base, PORTAL_LOGIN_CREATE_PATH, createBody)).json, { status: "created" });
  assert.deepEqual((await portalLogin(srv.base, PORTAL_LOGIN_CREATE_PATH, createBody)).json, { status: "conflict" });
  const claimed = await portalLogin(srv.base, PORTAL_LOGIN_CLAIM_PATH, { state });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.json.status, "claimed");
  assert.equal(claimed.json.payload, payload);
  const claimId = claimed.json.claimId;
  assert.equal(typeof claimId, "string");
  assert.deepEqual((await portalLogin(srv.base, PORTAL_LOGIN_CLAIM_PATH, { state })).json, { status: "used" });
  assert.deepEqual(
    (await portalLogin(srv.base, PORTAL_LOGIN_COMPLETE_PATH, { state, claimId, outcome: "succeeded" })).json,
    { status: "completed" },
  );
  assert.deepEqual(
    (await portalLogin(srv.base, PORTAL_LOGIN_COMPLETE_PATH, { state, claimId, outcome: "failed" })).json,
    { status: "mismatch" },
  );
});

test("portal login routes reject non-durable stores and malformed input", async (t) => {
  const srv = start(durableStub(), createMemoryPortalLoginTransactionStore());
  t.after(() => srv.close());
  const state = "b".repeat(64);
  assert.equal(
    (
      await portalLogin(srv.base, PORTAL_LOGIN_CREATE_PATH, {
        state,
        payload: "{}",
        expiresAtMs: Date.now() + 60_000,
        clientBucket: PORTAL_LOGIN_CLIENT_BUCKET,
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await portalLogin(
        srv.base,
        PORTAL_LOGIN_CREATE_PATH,
        { state, payload: "{}", expiresAtMs: Date.now() + 60_000, clientBucket: PORTAL_LOGIN_CLIENT_BUCKET },
        false,
      )
    ).status,
    401,
  );
});

test("portal login routes validate state, expiry, payload, and completion input", async (t) => {
  const srv = start();
  t.after(() => srv.close());
  const expiresAtMs = Date.now() + 60_000;
  assert.equal(
    (
      await portalLogin(srv.base, PORTAL_LOGIN_CREATE_PATH, {
        state: "bad",
        payload: "{}",
        expiresAtMs,
        clientBucket: PORTAL_LOGIN_CLIENT_BUCKET,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await portalLogin(srv.base, PORTAL_LOGIN_CREATE_PATH, {
        state: "c".repeat(64),
        expiresAtMs,
        clientBucket: PORTAL_LOGIN_CLIENT_BUCKET,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await portalLogin(srv.base, PORTAL_LOGIN_CREATE_PATH, {
        state: "d".repeat(64),
        payload: "{}",
        expiresAtMs: Date.now() + 3 * 60 * 60_000,
        clientBucket: PORTAL_LOGIN_CLIENT_BUCKET,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await portalLogin(srv.base, PORTAL_LOGIN_CREATE_PATH, {
        state: "e".repeat(64),
        payload: "x".repeat(20_000),
        expiresAtMs,
        clientBucket: PORTAL_LOGIN_CLIENT_BUCKET,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await portalLogin(srv.base, PORTAL_LOGIN_CREATE_PATH, {
        state: "f".repeat(64),
        payload: "{}",
        expiresAtMs,
        clientBucket: "raw-client-ip",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await portalLogin(srv.base, PORTAL_LOGIN_COMPLETE_PATH, {
        state: "9".repeat(64),
        claimId: "bad",
        outcome: "done",
      })
    ).status,
    400,
  );
});
