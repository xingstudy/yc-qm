import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "test-signing-secret".repeat(3);
let sourceNonce = 0;

function start(): { base: string; app: ReturnType<typeof buildApp>["app"]; close: () => Promise<void> } {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "claim-")) }));
  const server = createServer(built.app, { signingSecret: SECRET });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, app: built.app, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function sign(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

interface PendingDelivery {
  id: string;
  destination: { type: string; target: string; editRef?: string };
  text: string;
  idempotencyKey: string;
}

async function fetchPending(base: string, query: string): Promise<PendingDelivery[]> {
  const path = `/v1/deliveries?${query}`;
  const res = await fetch(`${base}${path}`, { headers: sign("GET", path, "") });
  assert.equal(res.status, 200);
  return ((await res.json()) as { deliveries?: PendingDelivery[] }).deliveries ?? [];
}

async function postDelivery(
  base: string,
  input: {
    destination?: { type: string; target: string; editRef?: string };
    text?: string;
    idempotencyKey?: string;
  },
): Promise<Response> {
  sourceNonce += 1;
  const path = `/v1/deliveries?_sourceAuthNonce=${sourceNonce}`;
  const body = JSON.stringify(input);
  return fetch(`${base}${path}`, { method: "POST", headers: sign("POST", path, body), body });
}

test("POST /v1/deliveries enqueues a source-auth delivery once", async () => {
  const srv = start();
  try {
    const first = await postDelivery(srv.base, {
      destination: { type: "im:wechat", target: "im:wechat:n:U1", editRef: "checkpoint" },
      text: "locator",
      idempotencyKey: "im-locate:one",
    });
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { queued: true });

    const duplicate = await postDelivery(srv.base, {
      destination: { type: "im:wechat", target: "im:wechat:n:U1", editRef: "checkpoint" },
      text: "locator",
      idempotencyKey: "im-locate:one",
    });
    assert.equal(duplicate.status, 202);

    const pending = await fetchPending(srv.base, "type=im%3Awechat");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.destination.target, "im:wechat:n:U1");
    assert.equal(pending[0]!.destination.editRef, "checkpoint");
    assert.equal(pending[0]!.text, "locator");
  } finally {
    await srv.close();
  }
});

test("POST /v1/deliveries rejects malformed source deliveries", async () => {
  const srv = start();
  try {
    const missingTarget = await postDelivery(srv.base, {
      destination: { type: "im:wechat", target: "" },
      text: "locator",
      idempotencyKey: "im-locate:bad",
    });
    assert.equal(missingTarget.status, 400);

    const missingText = await postDelivery(srv.base, {
      destination: { type: "im:wechat", target: "im:wechat:n:U1" },
      idempotencyKey: "im-locate:bad-text",
    });
    assert.equal(missingText.status, 400);
  } finally {
    await srv.close();
  }
});

test("two overlapping drain pollers with claimMs can't both receive the same delivery", async () => {
  const srv = start();
  try {
    await srv.app.enqueueDelivery({
      destination: { type: "group", target: "C1:171.001" },
      text: "reply enqueued mid-deploy",
      idempotencyKey: "post:sess-1:one",
    });
    const [oldTask, newTask] = await Promise.all([
      fetchPending(srv.base, "type=group&claimMs=15000"),
      fetchPending(srv.base, "type=group&claimMs=15000"),
    ]);
    assert.equal(oldTask.length + newTask.length, 1, "exactly one poller receives the row");
  } finally {
    await srv.close();
  }
});

test("a claim-less fetch stays claim-agnostic (the web-ui drain re-reads rows it left unacked)", async () => {
  const srv = start();
  try {
    await srv.app.enqueueDelivery({
      destination: { type: "web", target: "web:owner:thread" },
      text: "nudge",
      idempotencyKey: "post:sess-2:one",
    });
    assert.equal((await fetchPending(srv.base, "type=web")).length, 1);
    assert.equal((await fetchPending(srv.base, "type=web")).length, 1, "still visible on the next poll");
  } finally {
    await srv.close();
  }
});

test("an expired claim re-surfaces the row to a later poll (drainer died mid-post)", async () => {
  const srv = start();
  try {
    const abandonedClaimTtlMs = 1_000;
    await srv.app.enqueueDelivery({
      destination: { type: "group", target: "C2" },
      text: "claimed then abandoned",
      idempotencyKey: "post:sess-3:one",
    });
    assert.equal((await fetchPending(srv.base, `type=group&claimMs=${abandonedClaimTtlMs}`)).length, 1);
    assert.equal(
      (await fetchPending(srv.base, `type=group&claimMs=${abandonedClaimTtlMs}`)).length,
      0,
      "claimed rows are invisible before the TTL",
    );
    await new Promise((r) => setTimeout(r, abandonedClaimTtlMs + 100));
    assert.equal((await fetchPending(srv.base, "type=group&claimMs=15000")).length, 1, "the abandoned row comes back");
  } finally {
    await srv.close();
  }
});
