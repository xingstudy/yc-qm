import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mock, test } from "node:test";

interface UiStateRecord {
  value: unknown;
  updatedAt: number;
}

interface Delivery {
  id: string;
  destination: { type: string; target: string; editRef?: string };
  text: string;
  idempotencyKey: string;
  createdAt: number;
}

const uiState = new Map<string, UiStateRecord>();
const coreTurns: unknown[] = [];
const ackedDeliveries: string[] = [];
const ackedDeliveryKeys: string[] = [];
const weixinStatuses: Array<Record<string, unknown>> = [];
const weixinVerifyCodes: string[] = [];
const weixinUpdates: Array<Record<string, unknown>> = [];
const weixinSent: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
const imDeliveries: Delivery[] = [];
const coreTurnResponses: Array<Record<string, unknown>> = [];
const coreRunResponses = new Map<string, Array<Record<string, unknown>>>();
const coreRunIdentityHeaders: string[] = [];
let weixinQrRequests = 0;
let weixinStatusRequests = 0;
let weixinStatusDelayMs = 0;
let coreTurnDelayMs = 0;
let coreTurnDropResponse = false;
let coreTurnRejectBeforeRequest = false;
let ackByKeyFailures = 0;
let imProgressReadDelayMs = 0;
let uiStateWriteConflicts = 0;
const wecomReplies: Array<{ reqId: string; streamId: string; content: string; finish: boolean }> = [];
const wecomSent: Array<{ target: string; content: string }> = [];
const wecomReplyFailures = new Set<string>();

class MockWeComClient extends EventEmitter {
  connect(): void {
    queueMicrotask(() => this.emit("authenticated"));
  }

  disconnect(): void {
    this.emit("disconnected", "test");
  }

  async replyStream(
    frame: { headers: { req_id: string } },
    streamId: string,
    content: string,
    finish = false,
  ): Promise<Record<string, never>> {
    if (finish && wecomReplyFailures.delete(frame.headers.req_id)) throw new Error("reply stream failed");
    wecomReplies.push({ reqId: frame.headers.req_id, streamId, content, finish });
    return {};
  }

  async replyStreamNonBlocking(
    frame: { headers: { req_id: string } },
    streamId: string,
    content: string,
    finish = false,
  ): Promise<Record<string, never>> {
    return this.replyStream(frame, streamId, content, finish);
  }

  async sendMessage(target: string, body: { markdown: { content: string } }): Promise<Record<string, never>> {
    wecomSent.push({ target, content: body.markdown.content });
    return {};
  }
}

const wecomClients: MockWeComClient[] = [];
mock.module("@wecom/aibot-node-sdk", {
  namedExports: {
    WSClient: class extends MockWeComClient {
      constructor() {
        super();
        wecomClients.push(this);
      }
    },
  },
});

const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const url = new URL(req.url ?? "", "http://core");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url.pathname === "/ilink/bot/get_bot_qrcode") {
      weixinQrRequests += 1;
      send(200, { qrcode: `qr-${weixinQrRequests}`, qrcode_img_content: `https://weixin.test/qr/${weixinQrRequests}` });
      return;
    }
    if (req.method === "GET" && url.pathname === "/ilink/bot/get_qrcode_status") {
      weixinStatusRequests += 1;
      const respond = (): void => {
        const verifyCode = url.searchParams.get("verify_code");
        if (verifyCode) weixinVerifyCodes.push(verifyCode);
        send(200, weixinStatuses.shift() ?? { status: "wait" });
      };
      if (weixinStatusDelayMs) {
        const delay = weixinStatusDelayMs;
        weixinStatusDelayMs = 0;
        setTimeout(respond, delay);
      } else {
        respond();
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/ilink/bot/getupdates") {
      send(200, weixinUpdates.shift() ?? { ret: 0, msgs: [], get_updates_buf: "" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/ilink/bot/sendmessage") {
      weixinSent.push({
        authorization: Array.isArray(req.headers.authorization)
          ? req.headers.authorization[0]
          : req.headers.authorization,
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      send(200, { ret: 0 });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/turns") {
      coreTurns.push(JSON.parse(raw));
      if (coreTurnDropResponse) {
        coreTurnDropResponse = false;
        res.destroy();
        return;
      }
      const response = coreTurnResponses.shift();
      const respond = (): void =>
        send(response ? 200 : 202, response ?? { status: "queued", runId: `run-${coreTurns.length}` });
      if (coreTurnDelayMs) {
        const delay = coreTurnDelayMs;
        coreTurnDelayMs = 0;
        setTimeout(respond, delay);
      } else {
        respond();
      }
      return;
    }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      const identity = req.headers["x-portal-identity"];
      if (typeof identity === "string") coreRunIdentityHeaders.push(identity);
      const runId = decodeURIComponent(runMatch[1]!);
      const snapshots = coreRunResponses.get(runId) ?? [];
      const snapshot = snapshots.length > 1 ? snapshots.shift() : snapshots[0];
      if (!snapshot) {
        send(404, { error: "not_found" });
        return;
      }
      send(200, snapshot);
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/deliveries") {
      const type = url.searchParams.get("type") ?? "";
      const targetPrefix = url.searchParams.get("targetPrefix") ?? "";
      send(200, {
        deliveries: imDeliveries.filter(
          (delivery) =>
            delivery.destination.type === type &&
            (!targetPrefix || delivery.destination.target.startsWith(targetPrefix)),
        ),
      });
      return;
    }
    const ackMatch = url.pathname.match(/^\/v1\/deliveries\/([^/]+)\/ack$/);
    if (req.method === "POST" && ackMatch) {
      const deliveryId = decodeURIComponent(ackMatch[1]!);
      ackedDeliveries.push(deliveryId);
      const deliveryIndex = imDeliveries.findIndex((delivery) => delivery.id === deliveryId);
      if (deliveryIndex >= 0) imDeliveries.splice(deliveryIndex, 1);
      send(200, { ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/deliveries/ack-by-key") {
      const body = JSON.parse(raw) as { idempotencyKey?: string };
      if (ackByKeyFailures > 0) {
        ackByKeyFailures -= 1;
        send(500, { error: "ack_failed" });
        return;
      }
      if (body.idempotencyKey) ackedDeliveryKeys.push(body.idempotencyKey);
      send(200, { ok: true });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/ui-state") {
      const key = `${url.searchParams.get("principalId") ?? ""}#${url.searchParams.get("key") ?? ""}`;
      const respond = (): void => send(200, uiState.get(key) ?? { value: null, updatedAt: 0 });
      if (key.includes("#im-progress-") && imProgressReadDelayMs) setTimeout(respond, imProgressReadDelayMs);
      else respond();
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/ui-state/entries") {
      const stateKey = url.searchParams.get("key") ?? "";
      const states = Array.from(uiState.entries()).flatMap(([id, record]) => {
        const suffix = `#${stateKey}`;
        return id.endsWith(suffix)
          ? [{ principalId: id.slice(0, -suffix.length), value: record.value, updatedAt: record.updatedAt }]
          : [];
      });
      send(200, { states });
      return;
    }
    if (req.method === "PUT" && url.pathname === "/v1/ui-state") {
      const body = raw
        ? (JSON.parse(raw) as {
            principalId?: string;
            key?: string;
            value?: unknown;
            updatedAt?: number;
            expectedUpdatedAt?: number;
          })
        : {};
      const id = `${body.principalId ?? ""}#${body.key ?? ""}`;
      const current = uiState.get(id)?.updatedAt ?? 0;
      if (body.expectedUpdatedAt !== undefined && body.expectedUpdatedAt !== current) {
        uiStateWriteConflicts += 1;
        send(200, { ok: false, updatedAt: current });
        return;
      }
      const updatedAt = body.updatedAt ?? Date.now();
      uiState.set(id, { value: body.value, updatedAt });
      send(200, { ok: true, updatedAt });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/v1/ui-state") {
      const body = raw ? (JSON.parse(raw) as { principalId?: string; key?: string; expectedUpdatedAt?: number }) : {};
      const id = `${body.principalId ?? ""}#${body.key ?? ""}`;
      const current = uiState.get(id)?.updatedAt ?? 0;
      if (body.expectedUpdatedAt !== current) {
        send(200, { ok: false, updatedAt: current });
        return;
      }
      uiState.delete(id);
      send(200, { ok: true, updatedAt: 0 });
      return;
    }
    send(200, { ok: true });
  });
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));

const coreBase = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.origin === coreBase && url.pathname === "/v1/turns" && coreTurnRejectBeforeRequest) {
    coreTurnRejectBeforeRequest = false;
    return Promise.reject(new TypeError("core unavailable"));
  }
  if (url.origin === "https://ilinkai.weixin.qq.com") {
    const target = new URL(`${url.pathname}${url.search}`, coreBase);
    return nativeFetch(target, init);
  }
  return nativeFetch(input, init);
}) as typeof fetch;

process.env.CORE_API_URL = coreBase;
process.env.NODE_ENV = "test";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "1";
process.env.WEB_UI_PUBLIC_URL = "http://web.test";
process.env.CONNECTOR_SECRET_KEY = "connector-secret-0123456789abcdef";
process.env.PORTAL_IDENTITY_SECRET = "portal-identity-test-secret";
delete process.env.CORE_SIGNING_SECRET;

const {
  handler,
  pollWeixinAccount,
  drainWeixinDeliveries,
  drainImSdkDeliveries,
  formatImRunProgress,
  syncImRunProgress,
} = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;

test.after(async () => {
  globalThis.fetch = nativeFetch;
  await Promise.all([
    new Promise<void>((resolve) => surface.close(() => resolve())),
    new Promise<void>((resolve) => core.close(() => resolve())),
  ]);
});

function headers(user = "alice"): Record<string, string> {
  return { cookie: `webuiuser=${user}`, "content-type": "application/json" };
}

test("IM progress includes visible thinking, tool activity, and partial replies", () => {
  const progress = formatImRunProgress({
    status: "running",
    partial: "阶段回复",
    activity: [
      { type: "thinking", payload: { thinking: "先检查配置" } },
      { type: "thinking", payload: { thinking: "secret", redacted: true } },
      { type: "tool_call", payload: { tool: "read", path: "/tmp/config" } },
      { type: "tool_result", payload: { tool: "read", ok: true } },
    ],
  });
  assert.match(progress.text, /思考中\n先检查配置/);
  assert.match(progress.text, /执行中: read/);
  assert.match(progress.text, /已完成: read/);
  assert.match(progress.text, /回复中\n阶段回复/);
  assert.doesNotMatch(progress.text, /secret/);
  assert.doesNotMatch(progress.text, /\/tmp\/config/);
});

test("legacy shared IM progress state is discarded instead of migrated", async () => {
  uiState.set("legacy-user#im-progress", { value: { runs: {} }, updatedAt: Date.now() });
  uiState.set("active-legacy-user#im-progress", {
    value: {
      runs: {
        active: {
          provider: "wechat",
          resourceId: "legacy-bot",
          runId: "legacy-run",
          target: "legacy-target",
          progressAllowed: true,
          createdAt: Date.now(),
        },
      },
    },
    updatedAt: Date.now(),
  });
  await syncImRunProgress();
  assert.equal(uiState.has("legacy-user#im-progress"), false);
  assert.equal(uiState.has("active-legacy-user#im-progress"), true);
});

async function startWechat(user: string): Promise<Response> {
  return fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ provider: "wechat" }),
  });
}

async function confirmWechat(user: string, botId: string, externalUserId: string): Promise<Response> {
  weixinStatuses.push({
    status: "confirmed",
    bot_token: `secret-${botId}`,
    ilink_bot_id: botId,
    ilink_user_id: externalUserId,
  });
  return fetch(`${base}/api/im-bindings/status?provider=wechat`, { headers: headers(user) });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met");
}

test("WeChat scan connects directly, persists encrypted credentials, and reuses the Bot", async () => {
  const start = await startWechat("alice");
  assert.equal(start.status, 200);
  const created = (await start.json()) as {
    binding: Record<string, unknown> & { status: string; qrPayload: string; setupMode: string };
  };
  assert.equal(created.binding.status, "pending");
  assert.equal(created.binding.setupMode, "wechat-qr");
  assert.equal(created.binding.qrPayload, "https://weixin.test/qr/1");

  weixinStatuses.push({ status: "need_verifycode" });
  const needsCode = await fetch(`${base}/api/im-bindings/status?provider=wechat`, { headers: headers() });
  assert.equal(
    ((await needsCode.json()) as { binding: { verificationRequired: boolean } }).binding.verificationRequired,
    true,
  );
  const verify = await fetch(`${base}/api/im-bindings/wechat/verify`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ code: "2468" }),
  });
  assert.equal(verify.status, 200);

  const connected = await confirmWechat("alice", "wx-bot-1", "wx-user-1");
  assert.equal(connected.status, 200);
  const connectedBody = (await connected.json()) as {
    binding: { status: string; externalUserId: string; resourceId: string };
  };
  assert.equal(connectedBody.binding.status, "connected");
  assert.equal(connectedBody.binding.externalUserId, "wx-user-1");
  assert.equal(connectedBody.binding.resourceId, "wx-bot-1");
  assert.deepEqual(weixinVerifyCodes, ["2468"]);

  const stored = uiState.get("alice#im-bindings")?.value as {
    resources: { wechat: { resourceId: string; encryptedSecret: string } };
  };
  assert.equal(stored.resources.wechat.resourceId, "wx-bot-1");
  assert.match(stored.resources.wechat.encryptedSecret, /^v2\./);
  assert.doesNotMatch(JSON.stringify(stored), /secret-wx-bot-1/);

  const remove = await fetch(`${base}/api/im-bindings/wechat`, { method: "DELETE", headers: headers() });
  assert.deepEqual(await remove.json(), { removed: true, reusable: true });
  const reuse = await startWechat("alice");
  assert.equal(((await reuse.json()) as { binding: { status: string } }).binding.status, "connected");
  assert.equal(weixinQrRequests, 1);
});

test("concurrent WeChat status polling shares one provider request and skips unchanged writes", async () => {
  const user = "polling-user";
  const started = await startWechat(user);
  assert.equal(started.status, 200);
  const before = uiState.get(`${user}#im-bindings`)?.updatedAt;
  const requestsBefore = weixinStatusRequests;
  weixinStatuses.push({ status: "wait" });
  weixinStatusDelayMs = 50;
  const responses = await Promise.all([
    fetch(`${base}/api/im-bindings/status?provider=wechat`, { headers: headers(user) }),
    fetch(`${base}/api/im-bindings/status?provider=wechat`, { headers: headers(user) }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200],
  );
  assert.equal(weixinStatusRequests, requestsBefore + 1);
  assert.equal(uiState.get(`${user}#im-bindings`)?.updatedAt, before);
});

test("WeChat bridge forwards messages and sends deliveries through iLink", async () => {
  coreTurns.length = 0;
  coreRunResponses.set("run-1", [
    {
      status: "running",
      partial: "先给阶段回复",
      activity: [{ type: "thinking", payload: { thinking: "先检查微信状态" } }],
    },
    {
      status: "done",
      partial: "微信状态正常",
      activity: [{ type: "thinking", payload: { thinking: "先检查微信状态" } }],
    },
  ]);
  weixinUpdates.push({
    ret: 0,
    get_updates_buf: "cursor-2",
    msgs: [
      {
        message_id: 987,
        from_user_id: "wx-user-1",
        message_type: 1,
        context_token: "context-1",
        item_list: [{ type: 1, text_item: { text: "hello from wechat" } }],
      },
    ],
  });
  await pollWeixinAccount("alice", "wx-bot-1");
  const turn = coreTurns[0] as { surface: string; actor: { externalId: string }; text: string; deliveryTarget: string };
  assert.equal(turn.surface, "im:wechat");
  assert.equal(turn.actor.externalId, "alice");
  assert.equal(turn.text, "hello from wechat");
  assert.match(turn.deliveryTarget, /^im:wechat:[a-f0-9]{20}:wx-user-1$/);

  imDeliveries.push({
    id: "delivery-wechat",
    destination: { type: "im:wechat", target: turn.deliveryTarget },
    text: "reply to wechat",
    idempotencyKey: "run:run-1",
    createdAt: Date.now(),
  });
  await drainWeixinDeliveries();
  const progressText = weixinSent
    .map(({ body }) => JSON.stringify(body))
    .filter((text) => !text.includes('"run_id":"run-1"'))
    .join("\n");
  assert.match(progressText, /思考中/);
  assert.match(progressText, /先给阶段回复/);
  const identity = coreRunIdentityHeaders.at(-1) ?? "";
  assert.match(identity, /^[^.]+\.[^.]+$/);
  const claims = JSON.parse(Buffer.from(identity.split(".")[0]!, "base64url").toString("utf8")) as {
    p: string;
    exp: number;
  };
  assert.equal(claims.p, "alice");
  assert.ok(claims.exp > Date.now());
  const final = weixinSent.find(({ body }) => JSON.stringify(body).includes('"run_id":"run-1"'));
  assert.equal(final?.authorization, "Bearer secret-wx-bot-1");
  assert.match(JSON.stringify(final?.body), /reply to wechat/);
  assert.ok(ackedDeliveries.includes("delivery-wechat"));
});

test("WeCom starts an official direct scan flow", async () => {
  const response = await fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ provider: "work-wechat" }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { binding: Record<string, unknown> & { status: string; setupMode: string } };
  assert.equal(body.binding.status, "pending");
  assert.equal(body.binding.setupMode, "provision-qr");
  assert.equal(body.binding.quickSetupAvailable, true);
});

test("saved WeCom Bot credentials reconnect after unbind", async () => {
  const user = "wecom-reuse-user";
  const start = await fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ provider: "work-wechat" }),
  });
  assert.equal(start.status, 200);
  const credentials = await fetch(`${base}/api/im-bindings/work-wechat/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { botId: "wecom-reused-bot", secret: "wecom-reused-secret" } }),
  });
  assert.equal(credentials.status, 200);

  const remove = await fetch(`${base}/api/im-bindings/work-wechat`, { method: "DELETE", headers: headers(user) });
  assert.deepEqual(await remove.json(), { removed: true, reusable: true });

  const reuse = await fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ provider: "work-wechat" }),
  });
  assert.equal(reuse.status, 200);
  const body = (await reuse.json()) as { binding: { status: string; resourceId: string } };
  assert.equal(body.binding.status, "connected");
  assert.equal(body.binding.resourceId, "wecom-reused-bot");
});

test("WeCom matches concurrent replies to their original streams", async () => {
  const user = "wecom-user";
  const start = await fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ provider: "work-wechat" }),
  });
  assert.equal(start.status, 200);
  const credentials = await fetch(`${base}/api/im-bindings/work-wechat/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { botId: "wecom-bot", secret: "wecom-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const client = wecomClients.at(-1)!;
  const turnsBefore = coreTurns.length;
  client.emit("message.text", {
    headers: { req_id: "wecom-request" },
    body: {
      msgid: "wecom-message",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "hello from wecom" },
    },
  });
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  await waitFor(() => wecomReplies.some(({ reqId, finish }) => reqId === "wecom-request" && !finish));
  assert.equal(wecomReplies.at(-1)?.reqId, "wecom-request");
  assert.equal(wecomReplies.at(-1)?.content, "正在思考...");
  assert.equal(wecomReplies.at(-1)?.finish, false);
  const turn = coreTurns.at(-1) as { surface: string; deliveryTarget: string; text: string };
  assert.equal(turn.surface, "im:work-wechat");
  assert.equal(turn.text, "hello from wecom");
  imDeliveries.push({
    id: "delivery-wecom",
    destination: { type: "im:work-wechat", target: turn.deliveryTarget },
    text: "reply to wecom",
    idempotencyKey: `run:run-${coreTurns.length}`,
    createdAt: Date.now(),
  });
  await drainImSdkDeliveries("work-wechat");
  assert.equal(wecomReplies.at(-1)?.reqId, "wecom-request");
  assert.equal(wecomReplies.at(-1)?.content, "reply to wecom");
  assert.equal(wecomReplies.at(-1)?.finish, true);
  assert.equal(wecomSent.length, 0);
  assert.ok(ackedDeliveries.includes("delivery-wecom"));

  const progressStart = coreTurns.length;
  const progressRunId = `run-${progressStart + 1}`;
  coreRunResponses.set(progressRunId, [
    {
      status: "running",
      partial: "正在整理结果",
      activity: [
        { type: "thinking", payload: { thinking: "先检查企业微信状态" } },
        { type: "tool_call", payload: { tool: "read", path: "/tmp/wecom" } },
      ],
    },
    {
      status: "done",
      partial: "企业微信状态正常",
      activity: [
        { type: "thinking", payload: { thinking: "先检查企业微信状态" } },
        { type: "tool_call", payload: { tool: "read", path: "/tmp/wecom" } },
        { type: "tool_result", payload: { tool: "read", ok: true } },
      ],
    },
  ]);
  client.emit("message.text", {
    headers: { req_id: "wecom-request-progress" },
    body: {
      msgid: "wecom-message-progress",
      msgtype: "text",
      chattype: "group",
      chatid: "wecom-group-id",
      from: { userid: "wecom-user-id" },
      text: { content: "show progress" },
    },
  });
  await waitFor(() => coreTurns.length === progressStart + 1);
  await waitFor(() =>
    wecomReplies.some(
      ({ reqId, content, finish }) =>
        reqId === "wecom-request-progress" && !finish && content.includes("思考中\n先检查企业微信状态"),
    ),
  );
  await waitFor(() => {
    const value = uiState.get(`${user}#im-progress-work-wechat`)?.value as
      | { runs?: Record<string, { sentActivity?: number; partialLength?: number; partialHash?: string }> }
      | undefined;
    const cursor = Object.values(value?.runs ?? {})[0];
    return cursor?.sentActivity === 2 && cursor.partialLength === 6 && typeof cursor.partialHash === "string";
  });
  imDeliveries.push({
    id: "delivery-wecom-progress",
    destination: { type: "im:work-wechat", target: turn.deliveryTarget },
    text: "企业微信状态正常",
    idempotencyKey: `run:${progressRunId}`,
    createdAt: Date.now(),
  });
  await waitFor(() => ackedDeliveries.includes("delivery-wecom-progress"));
  const progressReply = wecomReplies.findLast(({ reqId, finish }) => reqId === "wecom-request-progress" && finish);
  assert.match(progressReply?.content ?? "", /思考中\n先检查企业微信状态/);
  assert.match(progressReply?.content ?? "", /已完成: read/);
  assert.match(progressReply?.content ?? "", /回复\n企业微信状态正常/);

  const concurrentStart = coreTurns.length;
  const conflictsBefore = uiStateWriteConflicts;
  imProgressReadDelayMs = 25;
  client.emit("message.text", {
    headers: { req_id: "wecom-request-a" },
    body: {
      msgid: "wecom-message-a",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "first concurrent message" },
    },
  });
  client.emit("message.text", {
    headers: { req_id: "wecom-request-b" },
    body: {
      msgid: "wecom-message-b",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "second concurrent message" },
    },
  });
  await waitFor(() => coreTurns.length === concurrentStart + 2);
  await waitFor(
    () =>
      wecomReplies.filter(
        ({ reqId, finish }) =>
          (reqId === "wecom-request-a" || reqId === "wecom-request-b") && finish === false,
      ).length === 2,
  );
  await waitFor(() => {
    const value = uiState.get(`${user}#im-progress-work-wechat`)?.value as
      | { runs?: Record<string, unknown> }
      | undefined;
    return Object.keys(value?.runs ?? {}).length === 0;
  });
  imProgressReadDelayMs = 0;
  assert.equal(uiStateWriteConflicts, conflictsBefore);
  const repliesBeforePush = wecomReplies.length;
  imDeliveries.push({
    id: "delivery-wecom-proactive",
    destination: { type: "im:work-wechat", target: turn.deliveryTarget },
    text: "proactive message",
    idempotencyKey: "cron:wecom-proactive",
    createdAt: Date.now(),
  });
  await drainImSdkDeliveries("work-wechat");
  assert.equal(wecomReplies.length, repliesBeforePush);
  assert.deepEqual(wecomSent.at(-1), { target: "wecom-user-id", content: "proactive message" });
  imDeliveries.push(
    {
      id: "delivery-wecom-b",
      destination: { type: "im:work-wechat", target: turn.deliveryTarget },
      text: "second concurrent reply",
      idempotencyKey: `run:run-${concurrentStart + 2}`,
      createdAt: Date.now(),
    },
    {
      id: "delivery-wecom-a",
      destination: { type: "im:work-wechat", target: turn.deliveryTarget },
      text: "first concurrent reply",
      idempotencyKey: `run:run-${concurrentStart + 1}`,
      createdAt: Date.now(),
    },
  );
  await drainImSdkDeliveries("work-wechat");
  assert.deepEqual(
    wecomReplies.slice(-2).map(({ reqId, content }) => ({ reqId, content })),
    [
      { reqId: "wecom-request-b", content: "second concurrent reply" },
      { reqId: "wecom-request-a", content: "first concurrent reply" },
    ],
  );
  assert.equal(wecomSent.length, 1);

  const longReplyStart = coreTurns.length;
  client.emit("message.text", {
    headers: { req_id: "wecom-request-long" },
    body: {
      msgid: "wecom-message-long",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "long reply" },
    },
  });
  await waitFor(() => coreTurns.length === longReplyStart + 1);
  imDeliveries.push({
    id: "delivery-wecom-long",
    destination: { type: "im:work-wechat", target: turn.deliveryTarget },
    text: "x".repeat(25_000),
    idempotencyKey: `run:run-${longReplyStart + 1}`,
    createdAt: Date.now(),
  });
  await drainImSdkDeliveries("work-wechat");
  const longReply = wecomReplies.at(-1)!;
  assert.equal(longReply.reqId, "wecom-request-long");
  assert.ok(Buffer.byteLength(longReply.content) <= 20_480);
  assert.match(longReply.content, /\[企业微信单条回复上限，内容已截断\]$/);

  const delayedStart = coreTurns.length;
  coreTurnDelayMs = 1_200;
  client.emit("message.text", {
    headers: { req_id: "wecom-request-delayed" },
    body: {
      msgid: "wecom-message-delayed",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "delayed mapping" },
    },
  });
  await waitFor(() => coreTurns.length === delayedStart + 1);
  imDeliveries.push({
    id: "delivery-wecom-delayed",
    destination: { type: "im:work-wechat", target: turn.deliveryTarget },
    text: "delayed mapping reply",
    idempotencyKey: `run:run-${delayedStart + 1}`,
    createdAt: Date.now(),
  });
  await drainImSdkDeliveries("work-wechat");
  assert.deepEqual(
    { reqId: wecomReplies.at(-1)?.reqId, content: wecomReplies.at(-1)?.content },
    { reqId: "wecom-request-delayed", content: "delayed mapping reply" },
  );

  const uncertainStart = coreTurns.length;
  const repliesBeforeUncertain = wecomReplies.length;
  coreTurnDropResponse = true;
  client.emit("message.text", {
    headers: { req_id: "wecom-request-uncertain" },
    body: {
      msgid: "wecom-message-uncertain",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "accepted without response" },
    },
  });
  await waitFor(() => coreTurns.length === uncertainStart + 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wecomReplies.length, repliesBeforeUncertain);
  const uncertainTurn = coreTurns.at(-1) as { deliveryTarget: string; deliveryEditRef: string };
  imDeliveries.push({
    id: "delivery-wecom-uncertain",
    destination: {
      type: "im:work-wechat",
      target: uncertainTurn.deliveryTarget,
      editRef: uncertainTurn.deliveryEditRef,
    },
    text: "accepted request reply",
    idempotencyKey: "run:run-uncertain",
    createdAt: Date.now(),
  });
  await drainImSdkDeliveries("work-wechat");
  assert.deepEqual(
    { reqId: wecomReplies.at(-1)?.reqId, content: wecomReplies.at(-1)?.content },
    { reqId: "wecom-request-uncertain", content: "accepted request reply" },
  );
  assert.ok(ackedDeliveries.includes("delivery-wecom-uncertain"));

  const unavailableStart = coreTurns.length;
  coreTurnRejectBeforeRequest = true;
  const unavailableFrame = {
    headers: { req_id: "wecom-request-unavailable" },
    body: {
      msgid: "wecom-message-unavailable",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "retry unavailable core" },
    },
  };
  client.emit("message.text", unavailableFrame);
  client.emit("message.text", unavailableFrame);
  await waitFor(() => coreTurns.length === unavailableStart + 1);
  const unavailableTurn = coreTurns.at(-1) as { deliveryTarget: string; deliveryEditRef: string };
  imDeliveries.push({
    id: "delivery-wecom-unavailable",
    destination: {
      type: "im:work-wechat",
      target: unavailableTurn.deliveryTarget,
      editRef: unavailableTurn.deliveryEditRef,
    },
    text: "retried unavailable reply",
    idempotencyKey: "run:run-unavailable",
    createdAt: Date.now(),
  });
  await drainImSdkDeliveries("work-wechat");
  assert.deepEqual(
    { reqId: wecomReplies.at(-1)?.reqId, content: wecomReplies.at(-1)?.content },
    { reqId: "wecom-request-unavailable", content: "retried unavailable reply" },
  );
  assert.ok(ackedDeliveries.includes("delivery-wecom-unavailable"));

  const retryStart = coreTurns.length;
  client.emit("message.text", {
    headers: { req_id: "wecom-request-retry" },
    body: {
      msgid: "wecom-message-retry",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "retry failed stream" },
    },
  });
  await waitFor(() => coreTurns.length === retryStart + 1);
  imDeliveries.push({
    id: "delivery-wecom-retry",
    destination: { type: "im:work-wechat", target: turn.deliveryTarget },
    text: "retried stream reply",
    idempotencyKey: `run:run-${retryStart + 1}`,
    createdAt: Date.now(),
  });
  wecomReplyFailures.add("wecom-request-retry");
  const sentBeforeRetry = wecomSent.length;
  ackByKeyFailures = 1;
  for (let attempt = 0; attempt < 150 && !ackedDeliveries.includes("delivery-wecom-retry"); attempt += 1) {
    await drainImSdkDeliveries("work-wechat").catch(() => undefined);
    if (!ackedDeliveries.includes("delivery-wecom-retry")) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(
    wecomReplies
      .filter(({ reqId, finish }) => reqId === "wecom-request-retry" && finish)
      .map(({ streamId, content }) => ({ streamId, content })),
    [{ streamId: wecomReplies.at(-1)?.streamId, content: "retried stream reply" }],
  );
  assert.equal(wecomSent.length, sentBeforeRetry);
  assert.ok(ackedDeliveries.includes("delivery-wecom-retry"));

  const completedStart = coreTurns.length;
  coreTurnResponses.push({ status: "ok", reply: "already completed reply", runId: "run-completed" });
  imDeliveries.push({
    id: "delivery-wecom-completed",
    destination: {
      type: "im:work-wechat",
      target: turn.deliveryTarget,
      editRef: JSON.stringify({
        kind: "wecom-stream",
        reqId: "wecom-request-original",
        streamId: "stream-original",
        expiresAt: Date.now() + 60_000,
      }),
    },
    text: "already completed reply",
    idempotencyKey: "run:run-completed",
    createdAt: Date.now(),
  });
  const sentBeforeCompleted = wecomSent.length;
  client.emit("message.text", {
    headers: { req_id: "wecom-request-completed" },
    body: {
      msgid: "wecom-message-completed",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "completed duplicate" },
    },
  });
  const completedDrain = drainImSdkDeliveries("work-wechat");
  await waitFor(() => coreTurns.length === completedStart + 1);
  await completedDrain;
  const completedReplies = wecomReplies.filter(
    ({ reqId, streamId, finish }) => reqId === "wecom-request-original" && streamId === "stream-original" && finish,
  );
  assert.equal(completedReplies.length, 1);
  assert.equal(wecomSent.length, sentBeforeCompleted);
  assert.ok(ackedDeliveryKeys.includes("run:run-completed"));
  assert.ok(ackedDeliveries.includes("delivery-wecom-completed"));

  const repliesBeforeExpired = wecomReplies.length;
  const sentBeforeExpired = wecomSent.length;
  imDeliveries.push({
    id: "delivery-wecom-expired",
    destination: {
      type: "im:work-wechat",
      target: turn.deliveryTarget,
      editRef: JSON.stringify({
        kind: "wecom-stream",
        reqId: "wecom-request-expired",
        streamId: "stream-expired",
        expiresAt: Date.now() - 1,
      }),
    },
    text: "expired stream fallback",
    idempotencyKey: "run:run-expired",
    createdAt: Date.now(),
  });
  for (let attempt = 0; attempt < 150 && !ackedDeliveries.includes("delivery-wecom-expired"); attempt += 1) {
    await drainImSdkDeliveries("work-wechat");
    if (!ackedDeliveries.includes("delivery-wecom-expired")) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(wecomReplies.length, repliesBeforeExpired);
  assert.deepEqual(wecomSent.at(-1), { target: "wecom-user-id", content: "expired stream fallback" });
  assert.equal(wecomSent.length, sentBeforeExpired + 1);
  assert.ok(ackedDeliveries.includes("delivery-wecom-expired"));

  const reconnect = await fetch(`${base}/api/im-bindings/work-wechat/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { botId: "wecom-bot", secret: "wecom-secret-rotated" } }),
  });
  assert.equal(reconnect.status, 200);
  const reconnectedClient = wecomClients.at(-1)!;
  assert.notEqual(reconnectedClient, client);
  const replayStart = coreTurns.length;
  const repliesBeforeReplay = wecomReplies.length;
  const sentBeforeReplay = wecomSent.length;
  coreTurnResponses.push({ status: "ok", reply: "already completed reply", runId: "run-completed" });
  reconnectedClient.emit("message.text", {
    headers: { req_id: "wecom-request-replayed" },
    body: {
      msgid: "wecom-message-completed",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "completed duplicate" },
    },
  });
  await waitFor(() => coreTurns.length === replayStart + 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(wecomReplies.length, repliesBeforeReplay);
  assert.equal(wecomSent.length, sentBeforeReplay);
});

test("one Bot resource cannot belong to two platform users", async () => {
  assert.equal((await startWechat("resource-owner")).status, 200);
  assert.equal((await confirmWechat("resource-owner", "shared-wx-bot", "wx-owner")).status, 200);
  assert.equal((await startWechat("resource-intruder")).status, 200);
  const conflict = await confirmWechat("resource-intruder", "shared-wx-bot", "wx-intruder");
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { error: string }).error, "resource_conflict");

  const ownerDelete = await fetch(`${base}/api/im-bindings/wechat?forget=1`, {
    method: "DELETE",
    headers: headers("resource-owner"),
  });
  assert.equal(ownerDelete.status, 200);
  const rebound = await confirmWechat("resource-intruder", "shared-wx-bot", "wx-intruder");
  assert.equal(rebound.status, 200);
});

test("forget removes saved credentials and the next binding creates a new QR", async () => {
  assert.equal((await startWechat("forget-user")).status, 200);
  assert.equal((await confirmWechat("forget-user", "forgotten-bot", "forgotten-user")).status, 200);
  const before = weixinQrRequests;
  const forget = await fetch(`${base}/api/im-bindings/wechat?forget=1`, {
    method: "DELETE",
    headers: headers("forget-user"),
  });
  assert.deepEqual(await forget.json(), { removed: true, reusable: false });
  assert.equal((await startWechat("forget-user")).status, 200);
  assert.equal(weixinQrRequests, before + 1);
});

test("credential binding rejects incomplete credentials", async () => {
  const response = await fetch(`${base}/api/im-bindings/dingtalk/credentials`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ credentials: { clientId: "ding-app" } }),
  });
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "bad_request");
});

test("binding start rejects unknown providers", async () => {
  const response = await fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ provider: "telegram" }),
  });
  assert.equal(response.status, 400);
});
