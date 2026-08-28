import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { computeUsers } from "../src/admin/users.ts";
import { adminImBindingsByPrincipal, parseAdminImBindings } from "../src/admin/im-bindings.ts";
import type { TurnRequest } from "../src/types.ts";
import { uiStateId } from "../src/surfaces/ui-state.ts";
import { testConfig } from "./support/test-config.ts";

test("computeUsers dedupes participants, credits in-window turns, and joins admin status", () => {
  const participants = [
    { sessionId: "s1", principalId: "U1", validFrom: 100, validTo: null },
    { sessionId: "s2", principalId: "U1", validFrom: 200, validTo: null },
    { sessionId: "s1", principalId: "U2", validFrom: 100, validTo: null },
  ];
  const turns = [
    { principalId: "U1", sessionId: "s1", day: 0, turns: 2, firstAt: 150, lastAt: 160 },
    { principalId: "U2", sessionId: "s1", day: 0, turns: 2, firstAt: 150, lastAt: 160 },
    { principalId: "U1", sessionId: "s2", day: 0, turns: 1, firstAt: 250, lastAt: 250 },
  ];
  const grants = [{ principalId: "U2", scopeId: "org:default-org", role: "org_admin" as const }];
  const rows = computeUsers({ participants, turns, grants });
  const byId: Record<string, any> = Object.fromEntries(rows.map((r) => [r.principalId, r]));

  assert.equal(byId.U1.sessionCount, 2);
  assert.equal(byId.U1.turnCount, 3);
  assert.equal(byId.U1.lastSeenAt, 250);
  assert.deepEqual(byId.U1.admin, { isAdmin: false });
  assert.equal(byId.U2.admin.role, "org_admin");
  assert.equal(rows[0]!.principalId, "U2");
});

test("computeUsers sums a window's turn rollup and takes its latest timestamp", () => {
  const rows = computeUsers({
    participants: [{ sessionId: "s1", principalId: "U1", validFrom: 100, validTo: 200 }],
    turns: [{ principalId: "U1", sessionId: "s1", day: 0, turns: 2, firstAt: 100, lastAt: 199 }],
    grants: [],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.turnCount, 2, "the window's two in-window turns");
  assert.equal(rows[0]!.lastSeenAt, 199);
});

test("computeUsers includes a grant-holder who has never participated", () => {
  const rows = computeUsers({
    participants: [],
    turns: [],
    grants: [{ principalId: "ghost-admin", scopeId: "org:default-org", role: "org_admin" as const }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.principalId, "ghost-admin");
  assert.equal(rows[0]!.sessionCount, 0);
  assert.equal(rows[0]!.lastSeenAt, null);
  assert.equal(rows[0]!.admin.isAdmin, true);
});

test("computeUsers includes a principal that only has an IM binding", () => {
  const rows = computeUsers({ participants: [], turns: [], grants: [], principalIds: ["im-only"] });
  assert.deepEqual(rows, [
    {
      principalId: "im-only",
      sessionCount: 0,
      turnCount: 0,
      lastSeenAt: null,
      admin: { isAdmin: false },
    },
  ]);
});

test("admin IM summaries expose binding metadata without resource credentials", () => {
  const value = {
    bindings: {
      wechat: {
        provider: "wechat",
        status: "connected",
        botName: "微信 Bot",
        externalDisplayName: "微信用户",
        connectedAt: 123,
      },
    },
    resources: {
      wechat: { resourceId: "wx-bot-1", externalUserId: "wx-user-1", encryptedSecret: "v2.secret" },
    },
  };
  assert.deepEqual(parseAdminImBindings(value), [
    {
      provider: "wechat",
      status: "connected",
      botName: "微信 Bot",
      externalDisplayName: "微信用户",
      externalTenantId: null,
      externalTenantName: null,
      connectedAt: 123,
    },
  ]);
  assert.deepEqual(
    adminImBindingsByPrincipal([["U1#im-bindings", { value, updatedAt: 1 }]]).get("U1"),
    parseAdminImBindings(value),
  );
  assert.deepEqual(
    parseAdminImBindings({
      bindings: { feishu: { provider: "feishu", status: "connected", botName: "飞书 Bot", connectedAt: 456 } },
      resources: { feishu: { resourceId: "cli_1", encryptedSecret: "v2.secret" } },
    }),
    [
      {
        provider: "feishu",
        status: "connected",
        botName: "飞书 Bot",
        externalDisplayName: null,
        externalTenantId: null,
        externalTenantName: null,
        connectedAt: 456,
      },
    ],
  );
  assert.deepEqual(
    parseAdminImBindings({
      bindings: {
        wechat: {
          provider: "wechat",
          status: "pending",
          botName: "旧微信 Bot",
          qrPayload: "https://invalid.example/qr",
        },
      },
    }),
    [],
  );
});

test("admin IM summaries include official authorization states", () => {
  const now = Date.now();
  const parsed = parseAdminImBindings({
    bindings: {
      feishu: {
        provider: "feishu",
        status: "pending",
        qrPayload: "https://open.feishu.cn/device/qr",
        authorizationState: "waiting",
        updatedAt: now,
      },
      "work-wechat": {
        provider: "work-wechat",
        status: "pending",
        authorizationState: "waiting",
        updatedAt: now,
      },
    },
  });
  assert.deepEqual(
    parsed.map((binding) => [binding.provider, binding.status]),
    [
      ["feishu", "pending"],
      ["work-wechat", "pending"],
    ],
  );
});

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-users-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    memory: built.memory,
    auditLog: built.auditLog,
    uiState: built.uiState,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function turnAsActiveUser(s: ReturnType<typeof start>, request: TurnRequest) {
  await s.built.organization.provisionPlayground(request.actor.externalId);
  return s.built.app.turn(request);
}

test("/v1/admin/users: org_admin sees the roster + grants; a non-admin is denied; audited", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello",
    };
    assert.equal((await turnAsActiveUser(s, dm)).status, "ok");

    const r = await fetch(`${s.base}/v1/admin/users`, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.ok(
      d.users.some((u: { principalId: string }) => u.principalId === "U1"),
      "the DM participant appears",
    );
    assert.ok(
      Array.isArray(d.grants) && d.grants.some((g: { principalId: string }) => g.principalId === "admin-alice"),
      "authoritative grants present",
    );

    const denied = await fetch(`${s.base}/v1/admin/users`, { headers: { "x-admin-actor": "user-uma@default-org" } });
    assert.equal(denied.status, 403);

    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "users.read"));
  } finally {
    await s.close();
  }
});

test("/v1/admin/users includes IM-only users and exposes their active platforms in list and detail", async () => {
  const s = start();
  try {
    await s.built.uiState.put(uiStateId("im-only", "im-bindings"), {
      value: {
        bindings: {
          wechat: {
            provider: "wechat",
            status: "connected",
            botName: "微信 Bot",
            externalDisplayName: "微信用户",
            externalTenantId: "wwcorp",
            externalTenantName: "示例企业",
            connectedAt: 123,
          },
          feishu: {
            provider: "feishu",
            status: "pending",
            botName: "飞书 Bot",
            token: `f.${Math.floor(Date.now() / 1000).toString(36)}.nonce.signature`,
          },
        },
        resources: {
          wechat: {
            resourceId: "wx-bot-1",
            externalUserId: "wx-user-1",
            externalTenantId: "wwcorp",
            externalTenantName: "示例企业",
            encryptedSecret: "v2.secret",
          },
        },
      },
      updatedAt: 123,
    });
    const adminHeaders = { "x-admin-actor": "admin-alice@default-org" };
    const list = (await (await fetch(`${s.base}/v1/admin/users`, { headers: adminHeaders })).json()) as any;
    const user = list.users.find((candidate: { principalId: string }) => candidate.principalId === "im-only");
    assert.ok(user);
    assert.deepEqual(
      user.imBindings.map((binding: { provider: string; status: string }) => [binding.provider, binding.status]),
      [
        ["wechat", "connected"],
        ["feishu", "pending"],
      ],
    );
    assert.equal(JSON.stringify(user).includes("encryptedSecret"), false);

    const detail = (await (await fetch(`${s.base}/v1/admin/users/im-only`, { headers: adminHeaders })).json()) as any;
    assert.deepEqual(detail.imBindings, user.imBindings);
    assert.equal(JSON.stringify(detail).includes("v2.secret"), false);
  } finally {
    await s.close();
  }
});

test("/v1/admin/users/:principalId: per-user detail — stats, conversations, personal-scope artifacts; non-admin denied; audited", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hello",
    };
    assert.equal((await turnAsActiveUser(s, dm)).status, "ok");

    const r = await fetch(`${s.base}/v1/admin/users/U1`, { headers: { "x-admin-actor": "admin-alice@default-org" } });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.equal(d.principalId, "U1");
    assert.equal(d.scopeId, "personal:U1");
    assert.equal(d.stats.sessions, 1);
    assert.equal(d.stats.turns, 1);
    assert.equal(typeof d.stats.lastSeenAt, "number");
    assert.equal(d.conversations.length, 1, "the DM appears as a conversation");
    assert.equal(d.conversations[0].scopeId, "personal:U1");
    assert.equal(d.conversations[0].userTurns, 1);
    assert.deepEqual(d.files, []);
    assert.deepEqual(d.crons, []);
    assert.deepEqual(d.deployments, []);

    const denied = await fetch(`${s.base}/v1/admin/users/U1`, { headers: { "x-admin-actor": "user-uma@default-org" } });
    assert.equal(denied.status, 403);

    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "user.read"));
  } finally {
    await s.close();
  }
});

test("/v1/admin/users/:principalId/onboarding: org_admin sets/resets state, reflected in detail; bad input + non-admin rejected; audited", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hi",
    };
    assert.equal((await turnAsActiveUser(s, dm)).status, "ok");
    const adminHdr = { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" };
    const detail = async () =>
      (await (await fetch(`${s.base}/v1/admin/users/U1`, { headers: adminHdr })).json()) as any;
    const setOb = (status: string, actor = "admin-alice@default-org") =>
      fetch(`${s.base}/v1/admin/users/U1/onboarding`, {
        method: "PUT",
        headers: { "x-admin-actor": actor, "content-type": "application/json" },
        body: JSON.stringify({ status }),
      });

    assert.equal((await detail()).onboarding, "not_started");

    assert.equal((await setOb("completed")).status, 200);
    assert.equal((await detail()).onboarding, "completed");

    assert.equal((await setOb("not_started")).status, 200);
    assert.equal((await detail()).onboarding, "not_started");

    assert.equal((await setOb("nope")).status, 400);
    assert.equal((await setOb("completed", "user-uma@default-org")).status, 403);

    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "user.onboarding.set"));
  } finally {
    await s.close();
  }
});

test("/v1/admin/users/:principalId/reset: deletes the user's personal sessions + clears onboarding; non-admin denied; audited", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:t1" },
      text: "hi",
    };
    assert.equal((await turnAsActiveUser(s, dm)).status, "ok");
    const adminHdr = { "x-admin-actor": "admin-alice@default-org" };
    const detail = async () =>
      (await (await fetch(`${s.base}/v1/admin/users/U1`, { headers: adminHdr })).json()) as any;

    await fetch(`${s.base}/v1/admin/users/U1/onboarding`, {
      method: "PUT",
      headers: { ...adminHdr, "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    let d = await detail();
    assert.equal(d.stats.sessions, 1, "one personal DM session before reset");
    assert.equal(d.onboarding, "completed");

    const denied = await fetch(`${s.base}/v1/admin/users/U1/reset`, {
      method: "POST",
      headers: { "x-admin-actor": "user-uma@default-org" },
    });
    assert.equal(denied.status, 403);

    const reset = await fetch(`${s.base}/v1/admin/users/U1/reset`, { method: "POST", headers: adminHdr });
    assert.equal(reset.status, 200);
    assert.equal(((await reset.json()) as any).deletedSessions, 1);

    d = await detail();
    assert.equal(d.stats.sessions, 0, "session wiped → user looks brand-new");
    assert.deepEqual(d.conversations, []);
    assert.equal(d.onboarding, "not_started", "onboarding marker cleared");

    assert.ok((await s.built.auditLog.events()).some((e) => e.action === "user.reset"));
  } finally {
    await s.close();
  }
});

test("/v1/admin/users/:principalId: a grant-holder with no sessions still resolves with admin status", async () => {
  const s = start();
  try {
    const d: any = await (
      await fetch(`${s.base}/v1/admin/users/${encodeURIComponent("admin-alice")}`, {
        headers: { "x-admin-actor": "admin-alice@default-org" },
      })
    ).json();
    assert.equal(d.principalId, "admin-alice");
    assert.equal(d.admin.isAdmin, true);
    assert.equal(d.stats.sessions, 0);
    assert.deepEqual(d.conversations, []);
  } finally {
    await s.close();
  }
});

test("/v1/admin/directory: org_admin resolves a name or id to candidates; empty query → []; non-admin denied", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-dir-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    memory: built.memory,
    auditLog: built.auditLog,
    directory: built.directory,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  try {
    await built.directory.replace([
      { principalId: "dana@example.com", displayName: "Dana Example", type: "internal" },
      { principalId: "jane@example.com", displayName: "Jane Doe", type: "internal" },
    ]);

    const r = await fetch(`${base}/v1/admin/directory?q=${encodeURIComponent("dana")}`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.equal(r.status, 200);
    const d: any = await r.json();
    assert.ok(
      d.members.some((m: any) => m.principalId === "dana@example.com" && m.displayName === "Dana Example"),
      "name prefix resolves the member",
    );
    assert.ok(!d.members.some((m: any) => m.principalId === "jane@example.com"), "non-matching member excluded");

    const empty = await fetch(`${base}/v1/admin/directory`, {
      headers: { "x-admin-actor": "admin-alice@default-org" },
    });
    assert.deepEqual(((await empty.json()) as any).members, [], "no query → no candidates");

    const denied = await fetch(`${base}/v1/admin/directory?q=dana`, {
      headers: { "x-admin-actor": "user-uma@default-org" },
    });
    assert.equal(denied.status, 403);
  } finally {
    await new Promise<void>((res) => server.close(() => res()));
  }
});

test("/v1/admin/users: a freshly promoted user shows as admin in the roster", async () => {
  const s = start();
  try {
    const dm: TurnRequest = {
      surface: "test",
      actor: { externalId: "U9" },
      conversation: { kind: "dm", threadRef: "dm:U9:t1" },
      text: "hi",
    };
    assert.equal((await turnAsActiveUser(s, dm)).status, "ok");
    await fetch(`${s.base}/v1/admin/grants`, {
      method: "POST",
      headers: { "x-admin-actor": "admin-alice@default-org", "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U9", role: "org_admin", scopeId: "org:default-org" }),
    });
    const d: any = await (
      await fetch(`${s.base}/v1/admin/users`, { headers: { "x-admin-actor": "admin-alice@default-org" } })
    ).json();
    const u9 = d.users.find((u: { principalId: string }) => u.principalId === "U9");
    assert.ok(u9 && u9.admin.role === "org_admin");
  } finally {
    await s.close();
  }
});
