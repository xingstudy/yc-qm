import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "test-signing-secret".repeat(3);
const PATH = "/v1/internal/auth/users/login";

function start(overrides: Partial<Config> = {}): { built: BuiltApp; base: string; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "org-login-")),
      ...overrides,
    }),
  );
  const server = createServer(built.app, { signingSecret: SECRET, organization: built.organization });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { built, base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function sign(method: string, pathWithQuery: string, body: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${pathWithQuery}\n${body}`),
  };
}

function login(base: string, body: Record<string, unknown>): Promise<Response> {
  const raw = JSON.stringify(body);
  return fetch(`${base}${PATH}`, { method: "POST", headers: sign("POST", PATH, raw), body: raw });
}

const loginBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  principalId: "U-alice",
  issuer: "https://issuer.example",
  subject: "sub-1",
  email: "Alice@Example.COM",
  emailVerified: true,
  displayName: "Alice",
  ...overrides,
});

test("unsigned login request is rejected 401", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(loginBody()),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("unknown user auto-joins under domain_auto_join, then logs in via the bound identity", async () => {
  const srv = start();
  try {
    const first = await login(srv.base, loginBody());
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), {
      status: "ok",
      user: { principalId: "U-alice", status: "active", sessionVersion: 1, displayName: "Alice" },
    });
    const second = await login(srv.base, loginBody({ principalId: "U-other", displayName: "Alice Again" }));
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), {
      status: "ok",
      user: { principalId: "U-alice", status: "active", sessionVersion: 1, displayName: "Alice Again" },
    });
  } finally {
    await srv.close();
  }
});

test("unverified email is denied email_unverified", async () => {
  const srv = start();
  try {
    const res = await login(srv.base, loginBody({ subject: "sub-unverified", emailVerified: false }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "denied", reason: "email_unverified" });
  } finally {
    await srv.close();
  }
});

test("missing or invalid fields are rejected 400", async () => {
  const srv = start();
  try {
    const bad: Array<Record<string, unknown>> = [
      loginBody({ principalId: undefined }),
      loginBody({ issuer: undefined }),
      loginBody({ subject: undefined }),
      loginBody({ principalId: "  " }),
      loginBody({ principalId: 42 }),
      loginBody({ emailVerified: "yes" }),
    ];
    for (const body of bad) {
      const res = await login(srv.base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  } finally {
    await srv.close();
  }
});

test("system:-prefixed principal ids cannot acquire human accounts", async () => {
  const srv = start();
  try {
    const res = await login(srv.base, loginBody({ principalId: "system:plugin-skills" }));
    assert.equal(res.status, 400);
  } finally {
    await srv.close();
  }
});

test("unknown user is denied not_invited under invite_only admission", async () => {
  const srv = start({ orgAdmission: "invite_only" });
  try {
    const res = await login(srv.base, loginBody());
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "denied", reason: "not_invited" });
  } finally {
    await srv.close();
  }
});
