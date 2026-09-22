import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
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
const coreBlobs = new Map<string, Buffer>();
const ackedDeliveries: string[] = [];
const ackedDeliveryKeys: string[] = [];
const releasedDeliveryClaims: string[] = [];
const weixinStatuses: Array<Record<string, unknown>> = [];
const weixinVerifyCodes: string[] = [];
const weixinUpdates: Array<Record<string, unknown>> = [];
const weixinSent: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
const imDeliveries: Delivery[] = [];
const coreTurnResponses: Array<Record<string, unknown>> = [];
const coreRunResponses = new Map<string, Array<Record<string, unknown>>>();
const coreActiveRuns = new Map<string, string>();
const coreSignals: Array<{ runId: string; body: Record<string, unknown> }> = [];
const coreWithdrawals: string[] = [];
const coreSignalResponses: Array<{
  status: number;
  body: Record<string, unknown>;
  nextActiveRunId?: string;
}> = [];
const coreRunRequests: string[] = [];
const coreRunIdentityHeaders: string[] = [];
const coreActiveRunRequests: Array<{ threadRef: string; identity?: string }> = [];
let weixinQrRequests = 0;
let weixinStatusRequests = 0;
let weixinStatusDelayMs = 0;
let coreTurnDelayMs = 0;
let coreTurnDropResponse = false;
let coreTurnRejectBeforeRequest = false;
let coreRunRejectBeforeRequest = false;
let ackByKeyFailures = 0;
let imProgressReadDelayMs = 0;
let uiStateWriteConflicts = 0;
let weixinSendFailures = 0;
let wecomSendFailures = 0;
const forcedUiStateConflicts = new Map<string, number>();
const larkDispatchers: MockLarkEventDispatcher[] = [];
const larkSent: Array<{ receiveIdType: string; receiveId: string; text: string; uuid?: string }> = [];
const larkResources = new Map<string, Buffer>();
const larkSubMessages = new Map<string, Array<Record<string, unknown>>>();
const qqBots: MockQQBot[] = [];
const qqSent: Array<{ target: { scope: string; targetId: string }; text: string }> = [];
const dingtalkClients: MockDingTalkClient[] = [];
const dingtalkSent: Array<{ token: string; text: string }> = [];
const wecomReplies: Array<{ reqId: string; streamId: string; content: string; finish: boolean }> = [];
const wecomSent: Array<{ target: string; content: string }> = [];
const wecomWelcomes: Array<{ reqId: string; content: string }> = [];
const wecomReplyFailures = new Set<string>();
const wecomDownloads = new Map<string, { buffer: Buffer; filename: string }>();
const remoteMedia = new Map<string, { body: Buffer; contentType: string }>();
const dingtalkDownloadUrls = new Map<string, string>();

class MockLarkEventDispatcher {
  handlers: Record<string, (data: unknown) => unknown> = {};

  constructor(_config: unknown = {}) {}

  register(handlers: Record<string, (data: unknown) => unknown>): this {
    this.handlers = { ...this.handlers, ...handlers };
    return this;
  }
}

class MockLarkWsClient {
  private readonly options: { onReady?: () => void };

  constructor(options: { onReady?: () => void }) {
    this.options = options;
  }

  async start(input: { eventDispatcher: MockLarkEventDispatcher }): Promise<void> {
    larkDispatchers.push(input.eventDispatcher);
    queueMicrotask(() => this.options.onReady?.());
  }

  close(): void {}
}

class MockLarkClient {
  readonly im = {
    v1: {
      message: {
        get: async (request: {
          path: { message_id: string };
        }): Promise<{ data: { items: Array<Record<string, unknown>> } }> => ({
          data: { items: larkSubMessages.get(request.path.message_id) ?? [] },
        }),
      },
      messageResource: {
        get: async (request: {
          path: { message_id: string; file_key: string };
        }): Promise<{ getReadableStream: () => Readable; headers: Record<string, string> }> => {
          const bytes = larkResources.get(`${request.path.message_id}:${request.path.file_key}`);
          if (!bytes) throw new Error("missing mocked Lark resource");
          return { getReadableStream: () => Readable.from(bytes), headers: {} };
        },
      },
    },
    message: {
      create: async (request: {
        params: { receive_id_type: string };
        data: { receive_id: string; content: string; uuid?: string };
      }): Promise<{ code: number }> => {
        const content = JSON.parse(request.data.content) as { text?: unknown };
        larkSent.push({
          receiveIdType: request.params.receive_id_type,
          receiveId: request.data.receive_id,
          text: typeof content.text === "string" ? content.text : "",
          ...(typeof request.data.uuid === "string" ? { uuid: request.data.uuid } : {}),
        });
        return { code: 0 };
      },
    },
  };

  constructor(_options: unknown) {}
}

class MockQQBot extends EventEmitter {
  constructor(_options: unknown) {
    super();
    qqBots.push(this);
  }

  async start(): Promise<void> {
    queueMicrotask(() => this.emit("ready"));
  }

  stop(): void {}

  async sendText(target: { scope: string; targetId: string }, text: string): Promise<void> {
    qqSent.push({ target, text });
  }
}

const DINGTALK_TOPIC_ROBOT = "/v1.0/im/bot/messages/get";
const DINGTALK_STREAM_CLIENT_EXPORT = ["D", "W", "Client"].join("");

class MockDingTalkClient {
  connected = false;
  accessToken = "ding-token";
  readonly callbacks = new Map<string, (frame: { headers: { messageId: string }; data: string }) => void>();

  constructor(_options: unknown) {
    dingtalkClients.push(this);
  }

  registerCallbackListener(
    eventId: string,
    callback: (frame: { headers: { messageId: string }; data: string }) => void,
  ): this {
    this.callbacks.set(eventId, callback);
    return this;
  }

  async getAccessToken(): Promise<string> {
    return this.accessToken;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  socketCallBackResponse(_messageId: string, _result: unknown): void {}
}

class MockWeComClient extends EventEmitter {
  isConnected = false;

  connect(): void {
    queueMicrotask(() => {
      this.isConnected = true;
      this.emit("authenticated");
    });
  }

  disconnect(): void {
    this.isConnected = false;
    this.emit("disconnected", "test");
  }

  simulateNetworkDisconnect(): void {
    this.isConnected = false;
    this.emit("disconnected", "network");
    queueMicrotask(() => {
      this.isConnected = true;
      this.emit("authenticated");
    });
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
    if (!this.isConnected) throw new Error("WebSocket not connected, unable to send data");
    if (wecomSendFailures > 0) {
      wecomSendFailures -= 1;
      throw new Error("wecom proactive send failed");
    }
    wecomSent.push({ target, content: body.markdown.content });
    return {};
  }

  async replyWelcome(
    frame: { headers: { req_id: string } },
    body: { text: { content: string } },
  ): Promise<Record<string, never>> {
    wecomWelcomes.push({ reqId: frame.headers.req_id, content: body.text.content });
    return {};
  }

  async downloadFile(url: string): Promise<{ buffer: Buffer; filename: string }> {
    const downloaded = wecomDownloads.get(url);
    if (!downloaded) throw new Error("missing mocked WeCom resource");
    return downloaded;
  }
}

const wecomClients: MockWeComClient[] = [];
mock.module("@wecom/aibot-node-sdk", {
  namedExports: {
    generateReqId: (prefix: string) => `${prefix}_${Date.now()}_${randomBytes(4).toString("hex")}`,
    WSClient: class extends MockWeComClient {
      constructor() {
        super();
        wecomClients.push(this);
      }
    },
  },
});

mock.module("@larksuiteoapi/node-sdk", {
  namedExports: {
    defaultHttpInstance: { defaults: {} },
    Client: MockLarkClient,
    EventDispatcher: MockLarkEventDispatcher,
    WSClient: MockLarkWsClient,
    normalize: async (
      data: {
        sender: { sender_id: { open_id?: string } };
        message: {
          message_id: string;
          chat_id: string;
          chat_type: "p2p" | "group";
          message_type: string;
          content: string;
        };
      },
      options?: { fetchSubMessages?: (messageId: string) => Promise<Array<Record<string, unknown>>> },
    ) => {
      const content = JSON.parse(data.message.content || "{}") as Record<string, unknown>;
      const resources: Array<{ type: string; fileKey: string; fileName?: string }> = [];
      const text: string[] = [];
      if (data.message.message_type === "text" && typeof content.text === "string") text.push(content.text);
      if (data.message.message_type === "post") {
        const localized = Object.values(content).find(
          (value): value is { title?: string; content?: Array<Array<Record<string, unknown>>> } =>
            typeof value === "object" && value !== null,
        );
        if (localized?.title) text.push(localized.title);
        for (const row of localized?.content ?? []) {
          for (const item of row) {
            if (item.tag === "text" && typeof item.text === "string") text.push(item.text);
            if (item.tag === "img" && typeof item.image_key === "string")
              resources.push({ type: "image", fileKey: item.image_key });
          }
        }
      }
      if (data.message.message_type === "interactive") text.push("[interactive card]");
      if (data.message.message_type === "merge_forward") {
        const items = (await options?.fetchSubMessages?.(data.message.message_id)) ?? [];
        text.push(
          ...items.map((item) => {
            const body = item.body as { content?: string } | undefined;
            const parsed = JSON.parse(body?.content || "{}") as { text?: unknown };
            return typeof parsed.text === "string" ? parsed.text : `[${String(item.msg_type ?? "message")}]`;
          }),
        );
      }
      const fileKey = typeof content.file_key === "string" ? content.file_key : undefined;
      const imageKey = typeof content.image_key === "string" ? content.image_key : undefined;
      if (imageKey) resources.push({ type: "image", fileKey: imageKey });
      if (fileKey) {
        let type = "file";
        if (data.message.message_type === "audio") type = "audio";
        else if (data.message.message_type === "media") type = "video";
        resources.push({
          type,
          fileKey,
          ...(typeof content.file_name === "string" ? { fileName: content.file_name } : {}),
        });
      }
      return {
        messageId: data.message.message_id,
        chatId: data.message.chat_id,
        chatType: data.message.chat_type,
        senderId: data.sender.sender_id.open_id ?? "",
        content: text.join("\n"),
        rawContentType: data.message.message_type,
        resources,
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: Date.now(),
      };
    },
    registerApp: async (options: {
      onQRCodeReady?: (input: { url: string }) => void;
    }): Promise<{ client_id: string; client_secret: string; user_info: { open_id: string } }> => {
      options.onQRCodeReady?.({ url: "https://feishu.test/qr" });
      return { client_id: "feishu-qr-app", client_secret: "feishu-qr-secret", user_info: { open_id: "feishu-open" } };
    },
  },
});

mock.module("@tencent-connect/qqbot-nodejs", {
  namedExports: {
    QQBot: MockQQBot,
  },
});

mock.module("@tencent-connect/qqbot-connector", {
  namedExports: {
    startQrConnect: (options: { onQrDisplayed?: (url: string) => void }): (() => void) => {
      queueMicrotask(() => options.onQrDisplayed?.("https://qq.test/qr"));
      return () => undefined;
    },
  },
});

mock.module("dingtalk-stream", {
  namedExports: {
    [DINGTALK_STREAM_CLIENT_EXPORT]: MockDingTalkClient,
    TOPIC_ROBOT: DINGTALK_TOPIC_ROBOT,
  },
});

const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  const rawChunks: Buffer[] = [];
  req.on("data", (chunk) => {
    raw += chunk;
    rawChunks.push(Buffer.from(chunk));
  });
  req.on("end", () => {
    const url = new URL(req.url ?? "", "http://core");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && url.pathname === "/v1/internal/auth/session") {
      send(200, { principalId: "alice", sessionVersion: 1 });
      return;
    }
    if (req.method === "GET" && /^\/v1\/internal\/auth\/users\/[^/]+\/session-version$/.test(url.pathname)) {
      send(200, { sessionVersion: 1 });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/blobs") {
      const blobId = `blob-${coreBlobs.size + 1}`;
      coreBlobs.set(blobId, Buffer.concat(rawChunks));
      send(200, { blobId, sizeBytes: coreBlobs.get(blobId)?.byteLength ?? 0 });
      return;
    }
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
      if (weixinSendFailures > 0) {
        weixinSendFailures -= 1;
        send(200, { ret: -2, errmsg: "prepare failed" });
        return;
      }
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
    if (req.method === "GET" && url.pathname === "/v1/runs") {
      const identity = req.headers["x-portal-identity"];
      const threadRef = url.searchParams.get("threadRef") ?? "";
      coreActiveRunRequests.push({ threadRef, ...(typeof identity === "string" ? { identity } : {}) });
      send(200, { runId: coreActiveRuns.get(threadRef) ?? null });
      return;
    }
    const signalMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/signal$/);
    if (req.method === "POST" && signalMatch) {
      const body = JSON.parse(raw) as Record<string, unknown>;
      coreSignals.push({
        runId: decodeURIComponent(signalMatch[1]!),
        body,
      });
      const response = coreSignalResponses.shift();
      if (response?.nextActiveRunId) {
        const request = body.request as { conversation?: { threadRef?: unknown } } | undefined;
        if (typeof request?.conversation?.threadRef === "string")
          coreActiveRuns.set(request.conversation.threadRef, response.nextActiveRunId);
      }
      send(response?.status ?? 200, response?.body ?? { accepted: true });
      return;
    }
    const withdrawMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)\/withdraw$/);
    if (req.method === "POST" && withdrawMatch) {
      coreWithdrawals.push(decodeURIComponent(withdrawMatch[1]!));
      send(200, { withdrawn: true });
      return;
    }
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)$/);
    if (req.method === "GET" && runMatch) {
      coreRunRequests.push(decodeURIComponent(runMatch[1]!));
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
    if (req.method === "POST" && url.pathname === "/v1/deliveries") {
      const body = JSON.parse(raw) as {
        destination?: Delivery["destination"];
        text?: string;
        idempotencyKey?: string;
      };
      if (!body.destination || typeof body.text !== "string" || !body.idempotencyKey) {
        send(400, { error: "bad_request" });
        return;
      }
      imDeliveries.push({
        id: `im-delivery-${imDeliveries.length + 1}`,
        destination: body.destination,
        text: body.text,
        idempotencyKey: body.idempotencyKey,
        createdAt: Date.now(),
      });
      send(202, { queued: true });
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
    const releaseMatch = url.pathname.match(/^\/v1\/deliveries\/([^/]+)\/release$/);
    if (req.method === "POST" && releaseMatch) {
      releasedDeliveryClaims.push(decodeURIComponent(releaseMatch[1]!));
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
    if (req.method === "POST" && url.pathname === "/ding-reply") {
      const body = JSON.parse(raw) as { text?: { content?: unknown } };
      dingtalkSent.push({
        token:
          typeof req.headers["x-acs-dingtalk-access-token"] === "string"
            ? req.headers["x-acs-dingtalk-access-token"]
            : "",
        text: typeof body.text?.content === "string" ? body.text.content : "",
      });
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
      const forced = forcedUiStateConflicts.get(id) ?? 0;
      if (forced > 0) {
        forcedUiStateConflicts.set(id, forced - 1);
        uiStateWriteConflicts += 1;
        send(200, { ok: false, updatedAt: current });
        return;
      }
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
  if (url.origin === coreBase && url.pathname.startsWith("/v1/runs/") && coreRunRejectBeforeRequest) {
    coreRunRejectBeforeRequest = false;
    return Promise.reject(new TypeError("run unavailable"));
  }
  if (url.origin === "https://ilinkai.weixin.qq.com") {
    const target = new URL(`${url.pathname}${url.search}`, coreBase);
    return nativeFetch(target, init);
  }
  if (url.origin === "https://api.dingtalk.com" && url.pathname === "/v1.0/robot/messageFiles/download") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { downloadCode?: string };
    const downloadUrl = body.downloadCode ? dingtalkDownloadUrls.get(body.downloadCode) : undefined;
    return Promise.resolve(
      new Response(JSON.stringify(downloadUrl ? { downloadUrl } : {}), {
        status: downloadUrl ? 200 : 404,
        headers: { "content-type": "application/json" },
      }),
    );
  }
  const media = remoteMedia.get(url.toString());
  if (media) {
    return Promise.resolve(
      new Response(new Uint8Array(media.body).buffer, {
        status: 200,
        headers: { "content-type": media.contentType, "content-length": String(media.body.byteLength) },
      }),
    );
  }
  return nativeFetch(input, init);
}) as typeof fetch;

process.env.CORE_API_URL = coreBase;
process.env.NODE_ENV = "test";
process.env.ALLOW_UNSIGNED_TEST_IDENTITY = "1";
process.env.WEB_UI_PUBLIC_URL = "http://web.test";
const legacyImCredentialsKey = createHash("sha256")
  .update("web-ui-im-resource-v2\0connector-secret-0123456789abcdef")
  .digest();
process.env.WEB_UI_IM_CREDENTIALS_KEY = legacyImCredentialsKey.toString("hex");
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

function legacyEncryptImSecret(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", legacyImCredentialsKey, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [
    "v2",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function legacyDecryptImSecret(sealed: string): unknown {
  const [, ivRaw, tagRaw, encryptedRaw] = sealed.split(".");
  const decipher = createDecipheriv("aes-256-gcm", legacyImCredentialsKey, Buffer.from(ivRaw!, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw!, "base64url"));
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(encryptedRaw!, "base64url")), decipher.final()]).toString("utf8"),
  ) as unknown;
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

test("disabled Chat Channels are reported to the UI and reject binding routes", async () => {
  process.env.WEB_UI_CHAT_CHANNELS_ENABLED = "0";
  try {
    const me = await fetch(`${base}/me`, { headers: headers() });
    assert.equal(me.status, 200);
    assert.equal(((await me.json()) as { chatChannelsEnabled?: boolean }).chatChannelsEnabled, false);
    const bindings = await fetch(`${base}/api/im-bindings`, { headers: headers() });
    assert.equal(bindings.status, 404);
  } finally {
    delete process.env.WEB_UI_CHAT_CHANNELS_ENABLED;
  }
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

async function waitFor(predicate: () => boolean, attempts = 150): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met");
}

function assertActiveRunIdentity(threadRef: string, user: string): void {
  const identity = coreActiveRunRequests.findLast((request) => request.threadRef === threadRef)?.identity;
  assert.ok(identity);
  const claims = JSON.parse(Buffer.from(identity.split(".")[0]!, "base64url").toString("utf8")) as { p?: unknown };
  assert.equal(claims.p, user);
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
    binding: { status: string; externalUserId: string; resourceId: string; locatorAvailable: boolean };
  };
  assert.equal(connectedBody.binding.status, "connected");
  assert.equal(connectedBody.binding.externalUserId, "wx-user-1");
  assert.equal(connectedBody.binding.resourceId, "wx-bot-1");
  assert.equal(connectedBody.binding.locatorAvailable, false);
  assert.deepEqual(weixinVerifyCodes, ["2468"]);

  const earlyLocate = await fetch(`${base}/api/im-bindings/wechat/locate`, { method: "POST", headers: headers() });
  assert.equal(earlyLocate.status, 409);
  assert.equal(((await earlyLocate.json()) as { error: string }).error, "target_unavailable");

  weixinUpdates.push({
    ret: 0,
    get_updates_buf: "cursor-locator",
    msgs: [
      {
        message_id: 2468,
        from_user_id: "wx-user-1",
        message_type: 1,
        context_token: "context-locator",
        item_list: [{ type: 1, text_item: { text: "open locator" } }],
      },
    ],
  });
  await pollWeixinAccount("alice", "wx-bot-1");
  const ready = await fetch(`${base}/api/im-bindings/status?provider=wechat`, { headers: headers() });
  assert.equal(((await ready.json()) as { binding: { locatorAvailable: boolean } }).binding.locatorAvailable, true);

  const locate = await fetch(`${base}/api/im-bindings/wechat/locate`, { method: "POST", headers: headers() });
  assert.equal(locate.status, 200);
  assert.equal(((await locate.json()) as { queued: boolean }).queued, true);
  await waitFor(() => JSON.stringify(weixinSent.at(-1)?.body ?? {}).includes("以后可以直接在这里向我提问"));

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

test("expired WeChat update sessions are forgotten before the bridge polls again", async () => {
  const user = "wechat-expired-session";
  await startWechat(user);
  await confirmWechat(user, "wx-bot-expired", "wx-user-expired");
  const turnsBefore = coreTurns.length;
  weixinUpdates.push({ ret: -14, errmsg: "session timeout" });

  await pollWeixinAccount(user, "wx-bot-expired");

  const stored = uiState.get(`${user}#im-bindings`)?.value as
    { bindings?: { wechat?: unknown }; resources?: { wechat?: unknown } } | undefined;
  assert.equal(coreTurns.length, turnsBefore);
  assert.equal(stored?.bindings?.wechat, undefined);
  assert.equal(stored?.resources?.wechat, undefined);

  const restart = await startWechat(user);
  const body = (await restart.json()) as { binding: { status: string; resourceId?: string } };
  assert.equal(restart.status, 200);
  assert.equal(body.binding.status, "pending");
  assert.equal(body.binding.resourceId, undefined);
});

test("WeChat bridge forwards messages and sends deliveries through iLink", async () => {
  coreTurns.length = 0;
  coreRunResponses.set("run-1", [
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
  const turn = coreTurns[0] as {
    surface: string;
    actor: { externalId: string };
    conversation: { threadRef: string };
    text: string;
    deliveryTarget: string;
  };
  assert.equal(turn.surface, "im:wechat");
  assert.equal(turn.actor.externalId, "alice");
  assert.equal(turn.text, "hello from wechat");
  assert.match(turn.deliveryTarget, /^im:wechat:[a-f0-9]{20}:wx-user-1$/);
  assertActiveRunIdentity(turn.conversation.threadRef, "alice");
  uiState.set("alice#im-progress-wechat", {
    value: {
      runs: {
        "wechat:run-1": {
          provider: "wechat",
          resourceId: "wx-bot-1",
          runId: "run-1",
          target: "wx-user-1",
          progressAllowed: true,
          terminal: true,
          createdAt: Date.now(),
        },
      },
    },
    updatedAt: Date.now(),
  });

  imDeliveries.push({
    id: "delivery-wechat",
    destination: { type: "im:wechat", target: turn.deliveryTarget },
    text: "reply to wechat",
    idempotencyKey: "run:run-1",
    createdAt: Date.now(),
  });
  await drainWeixinDeliveries();
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
  const finalBody = JSON.stringify(final?.body);
  assert.match(finalBody, /思考中\\n先检查微信状态/);
  assert.match(finalBody, /回复\\nreply to wechat/);
  assert.ok(ackedDeliveries.includes("delivery-wechat"));
});

test("IM progress coalesces rapid snapshots instead of sending every poll", async () => {
  const runId = "run-throttled-progress";
  coreTurnResponses.push({ status: "queued", runId });
  coreRunResponses.set(runId, [
    { status: "running", partial: "第一段", activity: [{ type: "tool_call", payload: { tool: "read" } }] },
    {
      status: "running",
      partial: "第一段第二段",
      activity: [
        { type: "tool_call", payload: { tool: "read" } },
        { type: "tool_result", payload: { tool: "read", ok: true } },
      ],
    },
    {
      status: "done",
      partial: "第一段第二段",
      activity: [
        { type: "tool_call", payload: { tool: "read" } },
        { type: "tool_result", payload: { tool: "read", ok: true } },
      ],
    },
  ]);
  const sentBefore = weixinSent.length;
  weixinUpdates.push({
    ret: 0,
    get_updates_buf: "cursor-throttled-progress",
    msgs: [
      {
        message_id: 988,
        from_user_id: "wx-user-1",
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "coalesce progress" } }],
      },
    ],
  });

  await pollWeixinAccount("alice", "wx-bot-1");
  await waitFor(() => {
    const value = uiState.get("alice#im-progress-wechat")?.value as
      { runs?: Record<string, { terminal?: boolean }> } | undefined;
    return value?.runs?.[`wechat:${runId}`]?.terminal === true;
  }, 350);
  const progressMessages = weixinSent.slice(sentBefore).filter(({ body }) => {
    const message = body.msg as { client_id?: unknown } | undefined;
    return typeof message?.client_id === "string" && message.client_id.startsWith("qm-progress-");
  });
  assert.equal(progressMessages.length, 1);
});

test("WeChat locator send failures are acknowledged after one attempt", async () => {
  const user = "wechat-locator-fail";
  await startWechat(user);
  await confirmWechat(user, "wx-bot-locator-fail", "wx-user-locator-fail");
  const turnStart = coreTurns.length;
  weixinUpdates.push({
    ret: 0,
    get_updates_buf: "cursor-locator-fail",
    msgs: [
      {
        message_id: 1357,
        from_user_id: "wx-user-locator-fail",
        message_type: 1,
        context_token: "context-locator-fail",
        item_list: [{ type: 1, text_item: { text: "ready" } }],
      },
    ],
  });
  await pollWeixinAccount(user, "wx-bot-locator-fail");
  const turn = coreTurns[turnStart] as { deliveryTarget: string };
  imDeliveries.push({
    id: "delivery-wechat-locator-fail",
    destination: { type: "im:wechat", target: turn.deliveryTarget },
    text: "locator",
    idempotencyKey: "im-locate:wechat:failed",
    createdAt: Date.now(),
  });
  weixinSendFailures = 1;

  await drainWeixinDeliveries();

  assert.ok(ackedDeliveries.includes("delivery-wechat-locator-fail"));
  assert.equal(
    imDeliveries.some((delivery) => delivery.id === "delivery-wechat-locator-fail"),
    false,
  );
});

test("Feishu locator requires a real direct conversation before sending", async () => {
  const user = "feishu-locate-user";
  const credentials = await fetch(`${base}/api/im-bindings/feishu/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { appId: "feishu-app", appSecret: "feishu-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const connected = (await credentials.json()) as {
    binding: { status: string; locatorAvailable: boolean; locatorUnavailableReason: string };
  };
  assert.equal(connected.binding.status, "connected");
  assert.equal(connected.binding.locatorAvailable, false);
  assert.match(connected.binding.locatorUnavailableReason, /飞书里给 Bot 发送一条消息/);

  const earlyLocate = await fetch(`${base}/api/im-bindings/feishu/locate`, { method: "POST", headers: headers(user) });
  assert.equal(earlyLocate.status, 409);

  const turnsBefore = coreTurns.length;
  const handler = larkDispatchers.at(-1)?.handlers["im.message.receive_v1"];
  if (!handler) throw new Error("missing Feishu event handler");
  await handler({
    sender: { sender_id: { open_id: "feishu-open-id" } },
    message: {
      message_id: "feishu-message",
      chat_id: "feishu-chat-id",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "hello from feishu" }),
    },
  });
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  await waitFor(() => {
    const stored = uiState.get(`${user}#im-bindings`)?.value as
      { resources?: { feishu?: { externalChatId?: string } } } | undefined;
    return stored?.resources?.feishu?.externalChatId === "feishu-chat-id";
  });
  const ready = await fetch(`${base}/api/im-bindings/status?provider=feishu`, { headers: headers(user) });
  assert.equal(((await ready.json()) as { binding: { locatorAvailable: boolean } }).binding.locatorAvailable, true);

  const locate = await fetch(`${base}/api/im-bindings/feishu/locate`, { method: "POST", headers: headers(user) });
  assert.equal(locate.status, 200);
  assert.deepEqual(await locate.json(), { queued: false, sent: true, message: "定位消息已发送，请打开飞书查看" });
  assert.deepEqual(larkSent.at(-1), {
    receiveIdType: "chat_id",
    receiveId: "feishu-chat-id",
    text: "你好，我是你的专属 飞书 Bot。以后可以直接在这里向我提问。",
  });

  const firstTurn = coreTurns.at(-1) as { conversation: { threadRef: string } };
  coreActiveRuns.set(firstTurn.conversation.threadRef, "feishu-live-run");
  coreRunResponses.set("feishu-live-run", [{ status: "done" }]);
  const signalsBefore = coreSignals.length;
  await handler({
    sender: { sender_id: { open_id: "feishu-open-id" } },
    message: {
      message_id: "feishu-auto-steer-message",
      chat_id: "feishu-chat-id",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "改成只输出三条结论" }),
    },
  });
  await waitFor(() => coreSignals.length === signalsBefore + 1);
  const steeredTurn = coreTurns.at(-1) as { text: string; idempotencyKey: string };
  assert.equal(steeredTurn.text, "改成只输出三条结论");
  assert.match(steeredTurn.idempotencyKey, /feishu-auto-steer-message$/);
  const steerSignal = coreSignals.at(-1);
  assert.ok(steerSignal);
  assert.equal(steerSignal.runId, "feishu-live-run");
  assert.equal(steerSignal.body.text, "改成只输出三条结论");
  assert.equal((steerSignal.body.request as { text?: string }).text, "改成只输出三条结论");
  assertActiveRunIdentity(firstTurn.conversation.threadRef, user);

  const replayRunId = "feishu-replayed-steer-run";
  coreRunResponses.set(replayRunId, [{ status: "running" }, { status: "done" }]);
  coreSignalResponses.push({
    status: 409,
    body: { accepted: false, reason: "terminal", replayed: true },
    nextActiveRunId: replayRunId,
  });
  await handler({
    sender: { sender_id: { open_id: "feishu-open-id" } },
    message: {
      message_id: "feishu-replayed-steer-message",
      chat_id: "feishu-chat-id",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "任务结束瞬间仍要继续" }),
    },
  });
  await waitFor(() => coreRunRequests.includes(replayRunId), 350);

  const withdrawalsBefore = coreWithdrawals.length;
  const sendsBeforeFailedSteer = larkSent.length;
  coreSignalResponses.push({ status: 409, body: { accepted: false, reason: "account_changed" } });
  await handler({
    sender: { sender_id: { open_id: "feishu-open-id" } },
    message: {
      message_id: "feishu-rejected-steer-message",
      chat_id: "feishu-chat-id",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "/steer 失败时不要变成独立任务" }),
    },
  });
  await waitFor(() => coreWithdrawals.length === withdrawalsBefore + 1);
  assert.equal(coreWithdrawals.at(-1), (coreSignals.at(-1)?.body.queuedRunId as string | undefined) ?? "");
  await waitFor(() => larkSent.slice(sendsBeforeFailedSteer).some(({ text }) => /未能调整正在运行的任务/.test(text)));

  const turnsBeforeNew = coreTurns.length;
  const signalsBeforeNew = coreSignals.length;
  await handler({
    sender: { sender_id: { open_id: "feishu-open-id" } },
    message: {
      message_id: "feishu-new-message",
      chat_id: "feishu-chat-id",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "/new 另起一个市场调研任务" }),
    },
  });
  await waitFor(() => coreTurns.length === turnsBeforeNew + 1);
  assert.equal(coreSignals.length, signalsBeforeNew);
  assert.equal((coreTurns.at(-1) as { text: string }).text, "另起一个市场调研任务");

  coreActiveRuns.delete(firstTurn.conversation.threadRef);
  const turnsBeforeRefusal = coreTurns.length;
  const sendsBeforeRefusal = larkSent.length;
  await handler({
    sender: { sender_id: { open_id: "feishu-open-id" } },
    message: {
      message_id: "feishu-steer-idle",
      chat_id: "feishu-chat-id",
      chat_type: "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "/steer 没有任务时不要新开" }),
    },
  });
  await waitFor(() => larkSent.slice(sendsBeforeRefusal).some(({ text }) => /当前没有正在运行的任务/.test(text)));
  assert.equal(coreTurns.length, turnsBeforeRefusal);
  assert.ok(larkSent.slice(sendsBeforeRefusal).some(({ text }) => /当前没有正在运行的任务/.test(text)));
});

test("QQ locator requires a real direct conversation before sending", async () => {
  const user = "qq-locate-user";
  const credentials = await fetch(`${base}/api/im-bindings/qq/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { appId: "qq-app", appSecret: "qq-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const connected = (await credentials.json()) as {
    binding: { status: string; locatorAvailable: boolean; locatorUnavailableReason: string };
  };
  assert.equal(connected.binding.status, "connected");
  assert.equal(connected.binding.locatorAvailable, false);
  assert.match(connected.binding.locatorUnavailableReason, /QQ 里给 Bot 发送一条消息/);

  const earlyLocate = await fetch(`${base}/api/im-bindings/qq/locate`, { method: "POST", headers: headers(user) });
  assert.equal(earlyLocate.status, 409);

  const turnsBefore = coreTurns.length;
  const bot = qqBots.at(-1);
  if (!bot) throw new Error("missing QQ bot");
  bot.emit(
    "message",
    {},
    {
      content: "hello from qq",
      kind: "c2c",
      senderId: "qq-user-id",
      senderName: "QQ User",
      messageId: "qq-message",
      replyTarget: { scope: "c2c", targetId: "qq-user-id" },
    },
  );
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  const turn = coreTurns.at(-1) as { conversation: { threadRef: string } };
  assertActiveRunIdentity(turn.conversation.threadRef, user);
  await waitFor(() => {
    const stored = uiState.get(`${user}#im-bindings`)?.value as
      { resources?: { qq?: { externalChatId?: string } } } | undefined;
    return stored?.resources?.qq?.externalChatId === "c2c|qq-user-id";
  });
  const ready = await fetch(`${base}/api/im-bindings/status?provider=qq`, { headers: headers(user) });
  assert.equal(((await ready.json()) as { binding: { locatorAvailable: boolean } }).binding.locatorAvailable, true);

  const locate = await fetch(`${base}/api/im-bindings/qq/locate`, { method: "POST", headers: headers(user) });
  assert.equal(locate.status, 200);
  assert.deepEqual(await locate.json(), { queued: false, sent: true, message: "定位消息已发送，请打开QQ查看" });
  assert.deepEqual(qqSent.at(-1), {
    target: { scope: "c2c", targetId: "qq-user-id" },
    text: "你好，我是你的专属 QQ Bot。以后可以直接在这里向我提问。",
  });
});

test("DingTalk locator requires a real conversation webhook before sending", async () => {
  const user = "dingtalk-locate-user";
  const credentials = await fetch(`${base}/api/im-bindings/dingtalk/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { clientId: "ding-app", clientSecret: "ding-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const connected = (await credentials.json()) as {
    binding: { status: string; locatorAvailable: boolean; locatorUnavailableReason: string };
  };
  assert.equal(connected.binding.status, "connected");
  assert.equal(connected.binding.locatorAvailable, false);
  assert.match(connected.binding.locatorUnavailableReason, /钉钉里给 Bot 发送一条消息/);

  const earlyLocate = await fetch(`${base}/api/im-bindings/dingtalk/locate`, {
    method: "POST",
    headers: headers(user),
  });
  assert.equal(earlyLocate.status, 409);

  const turnsBefore = coreTurns.length;
  const client = dingtalkClients.at(-1);
  const callback = client?.callbacks.get(DINGTALK_TOPIC_ROBOT);
  if (!client || !callback) throw new Error("missing DingTalk callback");
  callback({
    headers: { messageId: "ding-frame" },
    data: JSON.stringify({
      msgtype: "text",
      text: { content: "hello from dingtalk" },
      senderStaffId: "ding-user-id",
      senderId: "ding-open-id",
      senderNick: "Ding User",
      conversationId: "ding-conversation-id",
      conversationType: "1",
      msgId: "ding-message",
      sessionWebhook: `${coreBase}/ding-reply`,
    }),
  });
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  const turn = coreTurns.at(-1) as { conversation: { threadRef: string } };
  assertActiveRunIdentity(turn.conversation.threadRef, user);
  await waitFor(() => {
    const stored = uiState.get(`${user}#im-bindings`)?.value as
      { resources?: { dingtalk?: { externalChatId?: string } } } | undefined;
    return stored?.resources?.dingtalk?.externalChatId === "ding-conversation-id";
  });
  const ready = await fetch(`${base}/api/im-bindings/status?provider=dingtalk`, { headers: headers(user) });
  assert.equal(((await ready.json()) as { binding: { locatorAvailable: boolean } }).binding.locatorAvailable, true);

  client.accessToken = "ding-token-refreshed";
  const locate = await fetch(`${base}/api/im-bindings/dingtalk/locate`, { method: "POST", headers: headers(user) });
  assert.equal(locate.status, 200);
  assert.deepEqual(await locate.json(), { queued: false, sent: true, message: "定位消息已发送，请打开钉钉查看" });
  assert.deepEqual(dingtalkSent.at(-1), {
    token: "ding-token-refreshed",
    text: "你好，我是你的专属 QM 钉钉机器人。以后可以直接在这里向我提问。",
  });
});

test("WeChat sends encrypted image messages to Core as attachments", async () => {
  const user = "wechat-media-user";
  assert.equal((await startWechat(user)).status, 200);
  assert.equal((await confirmWechat(user, "wx-media-bot", "wx-media-user-id")).status, 200);
  const plain = Buffer.from("wechat-image-bytes");
  const key = Buffer.from("0123456789abcdef");
  const cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mediaUrl = "https://novac2c.cdn.weixin.qq.com/c2c/test-image";
  remoteMedia.set(mediaUrl, { body: encrypted, contentType: "application/octet-stream" });
  weixinUpdates.push({
    ret: 0,
    get_updates_buf: "wechat-media-cursor",
    msgs: [
      {
        message_id: "wechat-media-message",
        from_user_id: "wx-media-user-id",
        message_type: 1,
        item_list: [
          { type: 1, text_item: { text: "请分析这张图" } },
          {
            msg_id: "wechat-image-item",
            image_item: {
              media: { url: mediaUrl },
              aes_key: Buffer.from(key.toString("hex")).toString("base64"),
            },
          },
        ],
        context_token: "wechat-media-context",
      },
    ],
  });
  const turnsBefore = coreTurns.length;
  await pollWeixinAccount(user, "wx-media-bot");
  assert.equal(coreTurns.length, turnsBefore + 1);
  const turn = coreTurns.at(-1) as { text: string; attachments: Array<{ blobId: string; mimetype: string }> };
  assert.match(turn.text, /请分析这张图/);
  assert.match(turn.text, /图片/);
  assert.equal(turn.attachments[0]?.mimetype, "image/jpeg");
  assert.deepEqual(coreBlobs.get(turn.attachments[0]!.blobId), plain);
});

test("WeChat accepts every observed media item shape without relying on type", async () => {
  const user = "wechat-all-media-user";
  assert.equal((await startWechat(user)).status, 200);
  assert.equal((await confirmWechat(user, "wx-all-media-bot", "wx-all-media-user-id")).status, 200);
  const key = Buffer.from("fedcba9876543210");
  const encrypt = (value: string): Buffer => {
    const cipher = createCipheriv("aes-128-ecb", key, null);
    return Buffer.concat([cipher.update(Buffer.from(value)), cipher.final()]);
  };
  const voiceUrl = "https://novac2c.cdn.weixin.qq.com/c2c/test-voice";
  const fileUrl = "https://novac2c.cdn.weixin.qq.com/c2c/test-file";
  const videoUrl = "https://novac2c.cdn.weixin.qq.com/c2c/test-video";
  remoteMedia.set(voiceUrl, { body: encrypt("wechat-voice"), contentType: "application/octet-stream" });
  remoteMedia.set(fileUrl, { body: encrypt("wechat-file"), contentType: "application/octet-stream" });
  remoteMedia.set(videoUrl, { body: encrypt("wechat-video"), contentType: "application/octet-stream" });
  weixinUpdates.push({
    ret: 0,
    get_updates_buf: "wechat-all-media-cursor",
    msgs: [
      {
        message_id: "wechat-all-media-message",
        from_user_id: "wx-all-media-user-id",
        message_type: 1,
        item_list: [
          {
            voice_item: {
              text: "微信语音转写",
              encode_type: 7,
              aes_key: key.toString("base64"),
              media: { download_url: voiceUrl },
            },
          },
          {
            file_item: {
              file_name: "报告.pdf",
              file_size: 11,
              aeskey: key.toString("hex"),
              media: { full_url: fileUrl },
            },
          },
          {
            video_item: {
              aes_key: key.toString("base64"),
              media: { url: videoUrl },
            },
          },
        ],
        context_token: "wechat-all-media-context",
      },
    ],
  });
  const turnsBefore = coreTurns.length;
  await pollWeixinAccount(user, "wx-all-media-bot");
  assert.equal(coreTurns.length, turnsBefore + 1);
  const turn = coreTurns.at(-1) as { text: string; attachments: Array<{ blobId: string }> };
  assert.match(turn.text, /微信语音转写/);
  assert.match(turn.text, /报告\.pdf/);
  assert.match(turn.text, /视频/);
  assert.deepEqual(
    turn.attachments.map(({ blobId }) => coreBlobs.get(blobId)?.toString()),
    ["wechat-voice", "wechat-file", "wechat-video"],
  );
});

test("Feishu sends rich posts and every embedded image to Core", async () => {
  const user = "feishu-media-user";
  const credentials = await fetch(`${base}/api/im-bindings/feishu/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { appId: "feishu-media-app", appSecret: "feishu-media-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const handler = larkDispatchers.at(-1)?.handlers["im.message.receive_v1"];
  if (!handler) throw new Error("missing Feishu event handler");
  larkResources.set("feishu-media-message:image-key-1", Buffer.from("feishu-image-1"));
  larkResources.set("feishu-media-message:image-key-2", Buffer.from("feishu-image-2"));
  const turnsBefore = coreTurns.length;
  await handler({
    sender: { sender_id: { open_id: "feishu-media-open-id" } },
    message: {
      message_id: "feishu-media-message",
      chat_id: "feishu-media-chat",
      chat_type: "p2p",
      message_type: "post",
      content: JSON.stringify({
        zh_cn: {
          title: "现场照片",
          content: [
            [{ tag: "text", text: "请同时查看两张图片" }],
            [
              { tag: "img", image_key: "image-key-1" },
              { tag: "img", image_key: "image-key-2" },
            ],
          ],
        },
      }),
    },
  });
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  const turn = coreTurns.at(-1) as { text: string; attachments: Array<{ blobId: string }> };
  assert.match(turn.text, /现场照片/);
  assert.equal(turn.attachments.length, 2);
  assert.deepEqual(
    turn.attachments.map(({ blobId }) => coreBlobs.get(blobId)?.toString()),
    ["feishu-image-1", "feishu-image-2"],
  );
});

test("IM media limits download attempts, not only successful attachments", async () => {
  const user = "feishu-media-limit-user";
  const credentials = await fetch(`${base}/api/im-bindings/feishu/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { appId: "feishu-limit-app", appSecret: "feishu-limit-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const handler = larkDispatchers.at(-1)?.handlers["im.message.receive_v1"];
  if (!handler) throw new Error("missing Feishu event handler");
  for (let index = 2; index <= 12; index += 1)
    larkResources.set(`feishu-limit-message:image-key-${index}`, Buffer.from(`image-${index}`));
  const turnsBefore = coreTurns.length;
  await handler({
    sender: { sender_id: { open_id: "feishu-limit-open-id" } },
    message: {
      message_id: "feishu-limit-message",
      chat_id: "feishu-limit-chat",
      chat_type: "p2p",
      message_type: "post",
      content: JSON.stringify({
        zh_cn: {
          content: [Array.from({ length: 12 }, (_, index) => ({ tag: "img", image_key: `image-key-${index + 1}` }))],
        },
      }),
    },
  });
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  const turn = coreTurns.at(-1) as { text: string; attachments: Array<{ blobId: string }> };
  assert.equal(turn.attachments.length, 9);
  assert.match(turn.text, /读取失败/);
  assert.equal(turn.text.match(/最多处理 10 个附件/g)?.length, 2);
});

test("Feishu keeps card images and merged-forward media from their source messages", async () => {
  const user = "feishu-nested-media-user";
  const credentials = await fetch(`${base}/api/im-bindings/feishu/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { appId: "feishu-nested-app", appSecret: "feishu-nested-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const handler = larkDispatchers.at(-1)?.handlers["im.message.receive_v1"];
  if (!handler) throw new Error("missing Feishu event handler");
  larkSubMessages.set("feishu-forward-message", [
    {
      message_id: "feishu-forward-image",
      msg_type: "image",
      body: { content: JSON.stringify({ image_key: "forward-image-key" }) },
    },
    {
      message_id: "feishu-forward-file",
      msg_type: "file",
      body: { content: JSON.stringify({ file_key: "forward-file-key", file_name: "forward.pdf" }) },
    },
  ]);
  larkResources.set("feishu-forward-image:forward-image-key", Buffer.from("feishu-forward-image"));
  larkResources.set("feishu-forward-file:forward-file-key", Buffer.from("feishu-forward-file"));
  const turnsBefore = coreTurns.length;
  await handler({
    sender: { sender_id: { open_id: "feishu-nested-open-id" } },
    message: {
      message_id: "feishu-forward-message",
      chat_id: "feishu-nested-chat",
      chat_type: "p2p",
      message_type: "merge_forward",
      content: "{}",
    },
  });
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  const forwarded = coreTurns.at(-1) as { attachments: Array<{ blobId: string }> };
  assert.deepEqual(
    forwarded.attachments.map(({ blobId }) => coreBlobs.get(blobId)?.toString()),
    ["feishu-forward-image", "feishu-forward-file"],
  );

  larkResources.set("feishu-card-message:card-image-key", Buffer.from("feishu-card-image"));
  await handler({
    sender: { sender_id: { open_id: "feishu-nested-open-id" } },
    message: {
      message_id: "feishu-card-message",
      chat_id: "feishu-nested-chat",
      chat_type: "p2p",
      message_type: "interactive",
      content: JSON.stringify({ elements: [{ tag: "img", image_key: "card-image-key" }] }),
    },
  });
  await waitFor(() => coreTurns.length === turnsBefore + 2);
  const card = coreTurns.at(-1) as { attachments: Array<{ blobId: string }> };
  assert.equal(coreBlobs.get(card.attachments[0]!.blobId)?.toString(), "feishu-card-image");
});

test("QQ sends image, voice, video, file, and quoted media to Core", async () => {
  const user = "qq-media-user";
  const credentials = await fetch(`${base}/api/im-bindings/qq/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { appId: "qq-media-app", appSecret: "qq-media-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const bot = qqBots.at(-1);
  if (!bot) throw new Error("missing QQ bot");
  const imageUrl = "https://multimedia.nt.qq.com.cn/media/image";
  const voiceUrl = "https://multimedia.nt.qq.com.cn/media/voice.wav";
  const videoUrl = "https://multimedia.nt.qq.com.cn/media/video";
  const fileUrl = "https://multimedia.nt.qq.com.cn/media/file";
  const quotedUrl = "https://multimedia.nt.qq.com.cn/media/quoted";
  remoteMedia.set(imageUrl, { body: Buffer.from("qq-image"), contentType: "image/png" });
  remoteMedia.set(voiceUrl, { body: Buffer.from("qq-voice"), contentType: "audio/wav" });
  remoteMedia.set(videoUrl, { body: Buffer.from("qq-video"), contentType: "video/mp4" });
  remoteMedia.set(fileUrl, { body: Buffer.from("qq-file"), contentType: "application/pdf" });
  remoteMedia.set(quotedUrl, { body: Buffer.from("qq-quoted"), contentType: "image/jpeg" });
  const turnsBefore = coreTurns.length;
  bot.emit(
    "message",
    {},
    {
      content: "",
      kind: "c2c",
      senderId: "qq-media-id",
      messageId: "qq-media-message",
      replyTarget: { scope: "c2c", targetId: "qq-media-id" },
      refMsgIdx: "quoted-1",
      msgElements: [
        {
          content: "之前发的图片",
          attachments: [{ content_type: "image/jpeg", url: quotedUrl, filename: "quoted.jpg" }],
        },
      ],
      attachments: [
        { content_type: "image/png", url: imageUrl, filename: "photo.png" },
        {
          content_type: "audio/silk",
          url: "https://multimedia.nt.qq.com.cn/media/voice.silk",
          voice_wav_url: voiceUrl,
          asr_refer_text: "明天下午提醒我",
        },
        { content_type: "video/mp4", url: videoUrl, filename: "clip.mp4" },
        { content_type: "application/pdf", url: fileUrl, filename: "report.pdf" },
      ],
    },
  );
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  const turn = coreTurns.at(-1) as { text: string; attachments: Array<{ blobId: string; mimetype: string }> };
  assert.match(turn.text, /之前发的图片/);
  assert.match(turn.text, /语音转写：明天下午提醒我/);
  assert.deepEqual(
    turn.attachments.map(({ mimetype }) => mimetype),
    ["image/png", "audio/wav", "video/mp4", "application/pdf", "image/jpeg"],
  );
  assert.deepEqual(
    turn.attachments.map(({ blobId }) => coreBlobs.get(blobId)?.toString()),
    ["qq-image", "qq-voice", "qq-video", "qq-file", "qq-quoted"],
  );
});

test("DingTalk sends rich text and all embedded pictures to Core", async () => {
  const user = "dingtalk-media-user";
  const credentials = await fetch(`${base}/api/im-bindings/dingtalk/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { clientId: "ding-media-app", clientSecret: "ding-media-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const client = dingtalkClients.at(-1);
  const callback = client?.callbacks.get(DINGTALK_TOPIC_ROBOT);
  if (!client || !callback) throw new Error("missing DingTalk callback");
  const firstUrl = "https://bucket.oss-cn-hangzhou.aliyuncs.com/ding-image-1";
  const secondUrl = "https://bucket.oss-cn-hangzhou.aliyuncs.com/ding-image-2";
  dingtalkDownloadUrls.set("ding-code-1", firstUrl);
  dingtalkDownloadUrls.set("ding-code-2", secondUrl);
  remoteMedia.set(firstUrl, { body: Buffer.from("ding-image-1"), contentType: "image/jpeg" });
  remoteMedia.set(secondUrl, { body: Buffer.from("ding-image-2"), contentType: "image/jpeg" });
  const turnsBefore = coreTurns.length;
  callback({
    headers: { messageId: "ding-media-frame" },
    data: JSON.stringify({
      msgtype: "richText",
      content: {
        richText: [
          { text: "两张现场图片" },
          { type: "picture", downloadCode: "ding-code-1" },
          { type: "picture", downloadCode: "ding-code-2" },
        ],
      },
      senderId: "ding-media-user-id",
      conversationId: "ding-media-conversation",
      conversationType: "1",
      msgId: "ding-media-message",
      robotCode: "ding-media-app",
      sessionWebhook: `${coreBase}/ding-reply`,
    }),
  });
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  const turn = coreTurns.at(-1) as { text: string; attachments: Array<{ blobId: string }> };
  assert.match(turn.text, /两张现场图片/);
  assert.equal(turn.attachments.length, 2);
  assert.deepEqual(
    turn.attachments.map(({ blobId }) => coreBlobs.get(blobId)?.toString()),
    ["ding-image-1", "ding-image-2"],
  );
});

test("DingTalk sends every official standalone media message type to Core", async () => {
  const user = "dingtalk-all-media-user";
  const credentials = await fetch(`${base}/api/im-bindings/dingtalk/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { clientId: "ding-all-app", clientSecret: "ding-all-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const client = dingtalkClients.at(-1);
  const callback = client?.callbacks.get(DINGTALK_TOPIC_ROBOT);
  if (!client || !callback) throw new Error("missing DingTalk callback");
  const cases = [
    { msgtype: "picture", code: "ding-picture-code", name: undefined, bytes: "ding-picture" },
    { msgtype: "audio", code: "ding-audio-code", name: undefined, bytes: "ding-audio" },
    { msgtype: "video", code: "ding-video-code", name: undefined, bytes: "ding-video" },
    { msgtype: "file", code: "ding-file-code", name: "报告.pdf", bytes: "ding-file" },
  ] as const;
  const turnsBefore = coreTurns.length;
  for (const [index, item] of cases.entries()) {
    const url = `https://bucket.oss-cn-hangzhou.aliyuncs.com/${item.code}`;
    dingtalkDownloadUrls.set(item.code, url);
    remoteMedia.set(url, { body: Buffer.from(item.bytes), contentType: "application/octet-stream" });
    callback({
      headers: { messageId: `ding-all-frame-${index}` },
      data: JSON.stringify({
        msgtype: item.msgtype,
        content: {
          downloadCode: item.code,
          ...(item.name ? { fileName: item.name } : {}),
          ...(item.msgtype === "audio" ? { recognition: "钉钉语音转写" } : {}),
        },
        senderId: "ding-all-user-id",
        conversationId: "ding-all-conversation",
        conversationType: "1",
        msgId: `ding-all-message-${index}`,
        robotCode: "ding-all-app",
        sessionWebhook: `${coreBase}/ding-reply`,
      }),
    });
  }
  await waitFor(() => coreTurns.length === turnsBefore + cases.length);
  const turns = coreTurns.slice(-cases.length) as Array<{ text: string; attachments: Array<{ blobId: string }> }>;
  assert.match(turns[1]!.text, /钉钉语音转写/);
  assert.match(turns[3]!.text, /报告\.pdf/);
  assert.deepEqual(
    turns.map((turn) => coreBlobs.get(turn.attachments[0]!.blobId)?.toString()),
    cases.map((item) => item.bytes),
  );
});

test("WeCom sends mixed text and images to Core", async () => {
  const user = "wecom-media-user";
  const credentials = await fetch(`${base}/api/im-bindings/work-wechat/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { botId: "wecom-media-bot", secret: "wecom-media-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const client = wecomClients.at(-1)!;
  const mediaUrl = "https://wecom.test/media/image";
  wecomDownloads.set(mediaUrl, { buffer: Buffer.from("wecom-image"), filename: "wecom-photo.jpg" });
  const turnsBefore = coreTurns.length;
  client.emit("message.mixed", {
    headers: { req_id: "wecom-media-request" },
    body: {
      msgid: "wecom-media-message",
      msgtype: "mixed",
      chattype: "single",
      from: { userid: "wecom-media-id" },
      mixed: {
        msg_item: [
          { msgtype: "text", text: { content: "分析这张截图" } },
          { msgtype: "image", image: { url: mediaUrl, aeskey: "mock-key" } },
        ],
      },
    },
  });
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  const turn = coreTurns.at(-1) as { text: string; attachments: Array<{ blobId: string; mimetype: string }> };
  assert.match(turn.text, /分析这张截图/);
  assert.equal(turn.attachments[0]?.mimetype, "image/jpeg");
  assert.equal(coreBlobs.get(turn.attachments[0]!.blobId)?.toString(), "wecom-image");
});

test("WeCom forwards the official voice transcription content to Core", async () => {
  const user = "wecom-voice-user";
  const credentials = await fetch(`${base}/api/im-bindings/work-wechat/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { botId: "wecom-voice-bot", secret: "wecom-voice-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const client = wecomClients.at(-1)!;
  const turnsBefore = coreTurns.length;
  client.emit("message.voice", {
    headers: { req_id: "_hBeUc_qTN-ccH6EH5-mqQAA" },
    body: {
      msgid: "7ed9b0cde461622fc8cf2823795346e9",
      aibotid: "aibZ78yn9sOvGLOgqEJAoPeUWK7DtuC74Oc",
      chattype: "single",
      from: { userid: "FuSheng" },
      msgtype: "voice",
      response_url: "https://qyapi.weixin.qq.com/cgi-bin/aibot/response?response_code=test",
      voice: { content: "你好，你好。" },
    },
  });
  await waitFor(() => coreTurns.length === turnsBefore + 1);
  assert.equal((coreTurns.at(-1) as { text: string }).text, "你好，你好。");
});

test("WeCom downloads official file and video messages", async () => {
  const user = "wecom-file-video-user";
  const credentials = await fetch(`${base}/api/im-bindings/work-wechat/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { botId: "wecom-file-video-bot", secret: "wecom-file-video-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const client = wecomClients.at(-1)!;
  const fileUrl = "https://wecom.test/media/file";
  const videoUrl = "https://wecom.test/media/video";
  wecomDownloads.set(fileUrl, { buffer: Buffer.from("wecom-file"), filename: "报告.pdf" });
  wecomDownloads.set(videoUrl, { buffer: Buffer.from("wecom-video"), filename: "现场.mp4" });
  const turnsBefore = coreTurns.length;
  client.emit("message.file", {
    headers: { req_id: "wecom-file-request" },
    body: {
      msgid: "wecom-file-message",
      msgtype: "file",
      chattype: "single",
      from: { userid: "wecom-file-video-id" },
      file: { url: fileUrl, aeskey: "file-key" },
    },
  });
  client.emit("message.video", {
    headers: { req_id: "wecom-video-request" },
    body: {
      msgid: "wecom-video-message",
      msgtype: "video",
      chattype: "single",
      from: { userid: "wecom-file-video-id" },
      video: { url: videoUrl, aeskey: "video-key" },
    },
  });
  await waitFor(() => coreTurns.length === turnsBefore + 2);
  const turns = coreTurns.slice(-2) as Array<{ attachments: Array<{ blobId: string }> }>;
  assert.deepEqual(
    turns.map((turn) => coreBlobs.get(turn.attachments[0]!.blobId)?.toString()),
    ["wecom-file", "wecom-video"],
  );
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
    body: JSON.stringify({
      credentials: { botId: "wecom-reused-bot", secret: "wecom-reused-secret" },
      externalTenantId: "wwcorp-reused",
      externalTenantName: "复用企业",
    }),
  });
  assert.equal(credentials.status, 200);
  const credentialsBody = (await credentials.json()) as {
    binding: { externalTenantId?: string; externalTenantName?: string };
  };
  assert.equal(credentialsBody.binding.externalTenantId, "wwcorp-reused");
  assert.equal(credentialsBody.binding.externalTenantName, "复用企业");

  const saved = uiState.get(`${user}#im-bindings`)?.value as {
    resources: { "work-wechat": { encryptedSecret: string } };
  };
  const expectedSecret = {
    provider: "work-wechat",
    credentials: { botId: "wecom-reused-bot", secret: "wecom-reused-secret" },
  };
  assert.deepEqual(legacyDecryptImSecret(saved.resources["work-wechat"].encryptedSecret), expectedSecret);
  saved.resources["work-wechat"].encryptedSecret = legacyEncryptImSecret(expectedSecret);

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

  const forget = await fetch(`${base}/api/im-bindings/work-wechat?forget=1`, {
    method: "DELETE",
    headers: headers(user),
  });
  assert.deepEqual(await forget.json(), { removed: true, reusable: false });

  const fresh = await fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ provider: "work-wechat" }),
  });
  assert.equal(fresh.status, 200);
  const freshBody = (await fresh.json()) as { binding: { status: string; setupMode: string; resourceId?: string } };
  assert.equal(freshBody.binding.status, "pending");
  assert.equal(freshBody.binding.setupMode, "provision-qr");
  assert.equal(freshBody.binding.resourceId, undefined);
});

test("WeCom remembers an opened direct chat and sends Bot locator messages", async () => {
  const user = "wecom-locate-user";
  await fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ provider: "work-wechat" }),
  });
  const credentials = await fetch(`${base}/api/im-bindings/work-wechat/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { botId: "wecom-locate-bot", secret: "wecom-locate-secret" } }),
  });
  assert.equal(credentials.status, 200);

  const unavailable = await fetch(`${base}/api/im-bindings/work-wechat/locate`, {
    method: "POST",
    headers: headers(user),
  });
  assert.equal(unavailable.status, 409);
  const unavailableBody = (await unavailable.json()) as { error: string; message: string };
  assert.equal(unavailableBody.error, "target_unavailable");
  assert.match(unavailableBody.message, /企业微信里打开该 Bot/);

  const client = wecomClients.at(-1)!;
  client.emit("event.enter_chat", {
    headers: { req_id: "wecom-enter-locate" },
    body: {
      msgid: "wecom-enter-message",
      msgtype: "event",
      chattype: "single",
      from: { userid: "wecom-locate-user-id", corpid: "wwcorp-locate", corp_name: "示例企业" },
      event: { eventtype: "enter_chat" },
    },
  });
  await waitFor(() => wecomWelcomes.some(({ reqId }) => reqId === "wecom-enter-locate"));
  assert.match(wecomWelcomes.at(-1)?.content ?? "", /以后可以直接在这里向我提问/);

  await waitFor(() => {
    const stored = uiState.get(`${user}#im-bindings`)?.value as
      | {
          resources?: {
            "work-wechat"?: {
              externalUserId?: string;
              externalChatId?: string;
              externalTenantId?: string;
              externalTenantName?: string;
            };
          };
        }
      | undefined;
    return stored?.resources?.["work-wechat"]?.externalUserId === "wecom-locate-user-id";
  });
  const stored = uiState.get(`${user}#im-bindings`)?.value as {
    resources: {
      "work-wechat": {
        externalUserId: string;
        externalChatId: string;
        externalTenantId: string;
        externalTenantName: string;
      };
    };
  };
  assert.equal(stored.resources["work-wechat"].externalUserId, "wecom-locate-user-id");
  assert.equal(stored.resources["work-wechat"].externalChatId, "wecom-locate-user-id");
  assert.equal(stored.resources["work-wechat"].externalTenantId, "wwcorp-locate");
  assert.equal(stored.resources["work-wechat"].externalTenantName, "示例企业");
  const ready = await fetch(`${base}/api/im-bindings/status?provider=work-wechat`, { headers: headers(user) });
  const readyBody = (await ready.json()) as {
    binding: { externalTenantId?: string; externalTenantName?: string; locatorAvailable?: boolean };
  };
  assert.equal(readyBody.binding.externalTenantId, "wwcorp-locate");
  assert.equal(readyBody.binding.externalTenantName, "示例企业");
  assert.equal(readyBody.binding.locatorAvailable, true);

  const locate = await fetch(`${base}/api/im-bindings/work-wechat/locate`, {
    method: "POST",
    headers: headers(user),
  });
  assert.equal(locate.status, 200);
  assert.deepEqual(await locate.json(), { queued: false, sent: true, message: "定位消息已发送，请打开企业微信查看" });
  await waitFor(() =>
    wecomSent.some(
      ({ target, content }) =>
        target === "wecom-locate-user-id" &&
        content === "你好，我是你的专属 QM 企业微信智能机器人。以后可以直接在这里向我提问。",
    ),
  );
  assert.deepEqual(wecomSent.at(-1), {
    target: "wecom-locate-user-id",
    content: "你好，我是你的专属 QM 企业微信智能机器人。以后可以直接在这里向我提问。",
  });
  assert.equal(
    imDeliveries.some((delivery) => delivery.destination.type === "im:work-wechat"),
    false,
  );

  wecomSendFailures = 1;
  const failedLocate = await fetch(`${base}/api/im-bindings/work-wechat/locate`, {
    method: "POST",
    headers: headers(user),
  });
  assert.equal(failedLocate.status, 502);
  const failedBody = (await failedLocate.json()) as { error: string; message: string };
  assert.equal(failedBody.error, "send_failed");
  assert.match(failedBody.message, /wecom proactive send failed/);
});

test("WeCom leaves idle network reconnection to the SDK before draining later replies", async () => {
  const user = "wecom-idle-user";
  await fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ provider: "work-wechat" }),
  });
  const credentials = await fetch(`${base}/api/im-bindings/work-wechat/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { botId: "wecom-idle-bot", secret: "wecom-idle-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const disconnected = wecomClients.at(-1)!;
  const clientsBeforeReconnect = wecomClients.length;

  disconnected.simulateNetworkDisconnect();
  await waitFor(() => disconnected.isConnected);
  const reconnected = wecomClients.at(-1)!;
  await waitFor(() => reconnected.isConnected);
  assert.equal(wecomClients.length, clientsBeforeReconnect);
  assert.equal(reconnected, disconnected);
  assert.equal(reconnected.isConnected, true);

  imDeliveries.push({
    id: "delivery-wecom-idle-reconnect",
    destination: {
      type: "im:work-wechat",
      target: `im:work-wechat:${createHash("sha256")
        .update(`${user}\0work-wechat\0wecom-idle-bot`)
        .digest("hex")
        .slice(0, 20)}:wecom-idle-target`,
    },
    text: "reply after idle disconnect",
    idempotencyKey: "run:run-idle-reconnect",
    createdAt: Date.now(),
  });
  await drainImSdkDeliveries("work-wechat");
  assert.deepEqual(wecomSent.at(-1), { target: "wecom-idle-target", content: "reply after idle disconnect" });
  assert.ok(ackedDeliveries.includes("delivery-wecom-idle-reconnect"));
});

test("WeCom direct messages do not wait for target persistence conflicts", async () => {
  const user = "wecom-conflict-user";
  await fetch(`${base}/api/im-bindings/start`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ provider: "work-wechat" }),
  });
  const credentials = await fetch(`${base}/api/im-bindings/work-wechat/credentials`, {
    method: "POST",
    headers: headers(user),
    body: JSON.stringify({ credentials: { botId: "wecom-conflict-bot", secret: "wecom-conflict-secret" } }),
  });
  assert.equal(credentials.status, 200);
  const client = wecomClients.at(-1)!;
  const conflictsBefore = uiStateWriteConflicts;
  const turnsBefore = coreTurns.length;
  forcedUiStateConflicts.set(`${user}#im-bindings`, 3);

  client.emit("message.text", {
    headers: { req_id: "wecom-conflict-request" },
    body: {
      msgid: "wecom-conflict-message",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-conflict-user-id" },
      text: { content: "hello through conflict" },
    },
  });

  await waitFor(() => coreTurns.length === turnsBefore + 1);
  assert.equal((coreTurns.at(-1) as { text: string }).text, "hello through conflict");
  await waitFor(() => uiStateWriteConflicts >= conflictsBefore + 3);
});

test("WeCom matches concurrent replies to their original streams", async () => {
  wecomSent.length = 0;
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
  assert.match(wecomReplies.at(-1)?.streamId ?? "", /^stream_\d+_/);
  assert.equal(wecomReplies.at(-1)?.content, "正在思考...");
  assert.equal(wecomReplies.at(-1)?.finish, false);
  const turn = coreTurns.at(-1) as {
    surface: string;
    conversation: { threadRef: string };
    deliveryTarget: string;
    text: string;
  };
  assert.equal(turn.surface, "im:work-wechat");
  assert.equal(turn.text, "hello from wecom");
  assertActiveRunIdentity(turn.conversation.threadRef, user);
  const activeRunId = `run-${coreTurns.length}`;
  coreActiveRuns.set(turn.conversation.threadRef, activeRunId);
  const signalsBeforeSteer = coreSignals.length;
  client.emit("message.text", {
    headers: { req_id: "wecom-request-steer" },
    body: {
      msgid: "wecom-message-steer",
      msgtype: "text",
      chattype: "single",
      chatid: "",
      from: { userid: "wecom-user-id" },
      text: { content: "steer the active response" },
    },
  });
  await waitFor(() => coreSignals.length === signalsBeforeSteer + 1);
  const steeredRequest = coreSignals.at(-1)?.body.request as { deliveryEditRef?: string } | undefined;
  assert.equal(JSON.parse(steeredRequest?.deliveryEditRef ?? "{}").reqId, "wecom-request-steer");
  await waitFor(() => wecomReplies.some(({ reqId, finish }) => reqId === "wecom-request-steer" && finish));
  assert.equal(
    wecomReplies.findLast(({ reqId, finish }) => reqId === "wecom-request" && finish)?.content,
    "正在思考...",
  );
  assert.equal(
    wecomReplies.findLast(({ reqId, finish }) => reqId === "wecom-request-steer" && finish)?.content,
    "已合并。",
  );
  const repliesBeforeSteeredDelivery = wecomReplies.length;
  imDeliveries.push({
    id: "delivery-wecom",
    destination: { type: "im:work-wechat", target: turn.deliveryTarget },
    text: "reply to wecom",
    idempotencyKey: `run:${activeRunId}`,
    createdAt: Date.now(),
  });
  await drainImSdkDeliveries("work-wechat");
  assert.equal(wecomReplies.length, repliesBeforeSteeredDelivery);
  assert.deepEqual(wecomSent.at(-1), { target: "wecom-user-id", content: "reply to wecom" });
  assert.equal(wecomSent.length, 1);
  assert.ok(ackedDeliveries.includes("delivery-wecom"));
  coreActiveRuns.delete(turn.conversation.threadRef);

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
      { runs?: Record<string, { sentActivity?: number; partialLength?: number; partialHash?: string }> } | undefined;
    const entries = Object.entries(value?.runs ?? {});
    const cursor = entries[0]?.[1];
    return (
      entries[0]?.[0].startsWith("work-wechat:") === true &&
      cursor?.sentActivity === 2 &&
      cursor.partialLength === 6 &&
      typeof cursor.partialHash === "string"
    );
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

  const recoveredRunId = "run-recovered-progress";
  coreRunResponses.set(recoveredRunId, [
    {
      status: "done",
      activity: [{ type: "thinking", payload: { thinking: "恢复持久化进度" } }],
    },
  ]);
  uiState.set(`${user}#im-progress-work-wechat`, {
    value: {
      runs: {
        [`work-wechat${recoveredRunId}`]: {
          provider: "work-wechat",
          resourceId: "wecom-bot",
          runId: recoveredRunId,
          target: "wecom-user-id",
          progressAllowed: true,
          createdAt: Date.now(),
        },
      },
    },
    updatedAt: Date.now(),
  });
  await syncImRunProgress();
  imDeliveries.push({
    id: "delivery-wecom-recovered-progress",
    destination: {
      type: "im:work-wechat",
      target: turn.deliveryTarget,
      editRef: JSON.stringify({
        kind: "wecom-stream",
        reqId: "wecom-request-recovered-progress",
        streamId: "wecom-stream-recovered-progress",
        expiresAt: Date.now() + 60_000,
      }),
    },
    text: "恢复后的最终回复",
    idempotencyKey: `run:${recoveredRunId}`,
    createdAt: Date.now(),
  });
  const recoveredStartedAt = Date.now();
  await drainImSdkDeliveries("work-wechat");
  assert.ok(Date.now() - recoveredStartedAt < 1_500);
  const recoveredReply = wecomReplies.findLast(
    ({ reqId, finish }) => reqId === "wecom-request-recovered-progress" && finish,
  );
  assert.match(recoveredReply?.content ?? "", /思考中\n恢复持久化进度/);
  assert.match(recoveredReply?.content ?? "", /回复\n恢复后的最终回复/);
  await waitFor(() => {
    const value = uiState.get(`${user}#im-progress-work-wechat`)?.value as
      { runs?: Record<string, unknown> } | undefined;
    return !Object.keys(value?.runs ?? {}).some((key) => key.includes(recoveredRunId));
  });

  coreRunRejectBeforeRequest = true;
  imDeliveries.push({
    id: "delivery-wecom-run-unavailable",
    destination: {
      type: "im:work-wechat",
      target: turn.deliveryTarget,
      editRef: JSON.stringify({
        kind: "wecom-stream",
        reqId: "wecom-request-run-unavailable",
        streamId: "wecom-stream-run-unavailable",
        expiresAt: Date.now() + 60_000,
      }),
    },
    text: "活动查询失败时仍发送回复",
    idempotencyKey: "run:run-unavailable-activity",
    createdAt: Date.now(),
  });
  await drainImSdkDeliveries("work-wechat");
  assert.deepEqual(
    { reqId: wecomReplies.at(-1)?.reqId, content: wecomReplies.at(-1)?.content },
    { reqId: "wecom-request-run-unavailable", content: "活动查询失败时仍发送回复" },
  );
  assert.ok(ackedDeliveries.includes("delivery-wecom-run-unavailable"));

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
        ({ reqId, finish }) => (reqId === "wecom-request-a" || reqId === "wecom-request-b") && finish === false,
      ).length === 2,
  );
  await waitFor(() => {
    const value = uiState.get(`${user}#im-progress-work-wechat`)?.value as
      { runs?: Record<string, unknown> } | undefined;
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
  const sentBeforeConcurrentReplies = wecomSent.length;
  await drainImSdkDeliveries("work-wechat");
  assert.deepEqual(
    wecomReplies.slice(-2).map(({ reqId, content }) => ({ reqId, content })),
    [
      { reqId: "wecom-request-b", content: "second concurrent reply" },
      { reqId: "wecom-request-a", content: "first concurrent reply" },
    ],
  );
  assert.equal(wecomSent.length, sentBeforeConcurrentReplies);

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
  wecomSendFailures = 1;
  const sentBeforeRetry = wecomSent.length;
  ackByKeyFailures = 1;
  for (let attempt = 0; attempt < 150 && !ackedDeliveries.includes("delivery-wecom-retry"); attempt += 1) {
    await drainImSdkDeliveries("work-wechat").catch(() => undefined);
    if (!ackedDeliveries.includes("delivery-wecom-retry")) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const retriedReplies = wecomReplies
    .filter(({ reqId, finish }) => reqId === "wecom-request-retry" && finish)
    .map(({ streamId, content }) => ({ streamId, content }));
  assert.deepEqual(retriedReplies, [{ streamId: retriedReplies[0]?.streamId, content: "retried stream reply" }]);
  assert.equal(wecomSent.length, sentBeforeRetry);
  assert.ok(ackedDeliveries.includes("delivery-wecom-retry"));
  assert.ok(releasedDeliveryClaims.includes("delivery-wecom-retry"));

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
  assert.equal(completedReplies[0]?.content, "already completed reply");
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
