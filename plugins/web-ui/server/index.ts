import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, normalize } from "node:path";
import { LRUCache } from "lru-cache";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  WSClient as WeComWSClient,
  type EventMessage as WeComEventMessage,
  type TextMessage as WeComTextMessage,
  type WsFrame,
  type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";
import { QQBot, type QQBotInboundMessage, type ReplyTarget } from "@tencent-connect/qqbot-nodejs";
import { startQrConnect } from "@tencent-connect/qqbot-connector";
import * as DingTalkStream from "dingtalk-stream";
import {
  signedHeaders,
  withSourceAuthNonce,
  CAPABILITY_HEADER,
  type HttpMethod,
} from "../../chassis/src/core-client.ts";
import { findRoute } from "../../chassis/src/router.ts";
import {
  json,
  readBody as readBodyCapped,
  cookie,
  PayloadTooLargeError,
  serveEmojiFavicon,
} from "../../chassis/src/http.ts";
import { mintPortalIdentity, verifyPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
import { createBrandingCache, injectBranding } from "../../chassis/src/branding.ts";
import {
  CORE_API_URL as CORE,
  CORE_ORG_ID as ORG,
  CORE_SIGNING_SECRET,
  PORTAL_IDENTITY_SECRET,
  portFromEnv,
} from "../../chassis/src/env.ts";

const PORT = portFromEnv(8096);
const PUBLIC_URL = (process.env.WEB_UI_PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const WEB_UI_DEV = process.env.WEB_UI_DEV === "1";
const ALLOW_UNSIGNED_TEST_IDENTITY =
  process.env.NODE_ENV === "test" && process.env.ALLOW_UNSIGNED_TEST_IDENTITY === "1";
const COOKIE_AUTH = !CORE_SIGNING_SECRET || ALLOW_UNSIGNED_TEST_IDENTITY;
const AUTH_MODE = COOKIE_AUTH ? "dev" : "portal";
const ALLOW = (process.env.WEB_UI_PRINCIPALS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist-web");

const brandingCache = createBrandingCache(async () => {
  const r = await coreFetch("GET", "/v1/surface-config", "", 2_000);
  if (r.status !== 200) throw new Error(`surface-config ${r.status}`);
  const b = (JSON.parse(r.text) as { branding?: Record<string, unknown> }).branding;
  return {
    ...(typeof b?.accent === "string" ? { accent: b.accent } : {}),
    ...(typeof b?.mark === "string" ? { mark: b.mark } : {}),
    ...(typeof b?.selfLabel === "string" ? { selfLabel: b.selfLabel } : {}),
  };
});

async function brandIndexHtml(html: string): Promise<string> {
  const branding = await brandingCache.forRender();
  return injectBranding(html, branding, { titleSuffix: "· Web" });
}

const portalTokenStore = new AsyncLocalStorage<string | undefined>();

const runOwners = new Map<string, string>();
const runThreadKeys = new Map<string, string>();
const activeRunsByThread = new Map<string, string[]>();

function ownsRun(runId: string, user: string): boolean {
  return runOwners.get(runId) === user;
}

function threadKey(user: string, threadRef: string): string {
  return `${user}\0${threadRef}`;
}

function forgetRun(runId: string): void {
  runOwners.delete(runId);
  const key = runThreadKeys.get(runId);
  if (key) {
    const remaining = (activeRunsByThread.get(key) ?? []).filter((id) => id !== runId);
    if (remaining.length) activeRunsByThread.set(key, remaining);
    else activeRunsByThread.delete(key);
  }
  runThreadKeys.delete(runId);
}

function rememberRun(runId: string, user: string, threadRef: string): void {
  if (runOwners.size > 5000) {
    const oldest = runOwners.keys().next().value;
    if (oldest !== undefined) forgetRun(oldest);
  }
  runOwners.set(runId, user);
  const key = threadKey(user, threadRef);
  runThreadKeys.set(runId, key);
  activeRunsByThread.set(key, [...(activeRunsByThread.get(key) ?? []), runId]);
}

const deliveryClients = new Map<string, Set<ServerResponse>>();

type ImProviderId = "wechat" | "feishu" | "work-wechat" | "qq" | "dingtalk";
type ImSetupMode = "wechat-qr" | "provision-qr" | "manual-credentials";
type ImAuthorizationState =
  "waiting" | "scanned" | "verification-required" | "blocked" | "expired" | "unrecoverable" | "error";

const IM_SDK_PROVIDERS = ["feishu", "work-wechat", "qq", "dingtalk"] as const;
const IM_PROVIDERS = ["wechat", ...IM_SDK_PROVIDERS] as const;

const IM_BINDINGS_KEY = "im-bindings";
const IM_PROGRESS_LEGACY_KEY = "im-progress";
const IM_PROGRESS_KEY_PREFIX = `${IM_PROGRESS_LEGACY_KEY}-`;
const IM_TOKENS_PRINCIPAL = "web-ui-im";
const IM_CREDENTIALS_KEY = parseImCredentialsKey(process.env.WEB_UI_IM_CREDENTIALS_KEY);
if (process.env.NODE_ENV === "production" && !IM_CREDENTIALS_KEY) {
  throw new Error("WEB_UI_IM_CREDENTIALS_KEY must be exactly 32 bytes encoded as hexadecimal");
}
const WEIXIN_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const WEIXIN_ILINK_BOT_TYPE = "3";
const WEIXIN_QR_TTL_MS = 5 * 60_000;
const WEIXIN_API_TIMEOUT_MS = 35_000;
const WEIXIN_BRIDGE_SYNC_MS = 2_500;
const IM_RUN_PROGRESS_POLL_MS = 1_000;
const IM_RUN_PROGRESS_REQUEST_TIMEOUT_MS = 5_000;
const IM_RUN_FINAL_REQUEST_TIMEOUT_MS = 5_000;
const IM_DELIVERY_POLL_MS = WEIXIN_BRIDGE_SYNC_MS;
const IM_PARTIAL_PROGRESS_MS = 2_000;
const IM_RUN_PROGRESS_MAX_AGE_MS = 24 * 60 * 60_000;
const IM_PROGRESS_CLAIM_MS = 45_000;
const IM_SDK_CONNECT_TIMEOUT_MS = 15_000;
const IM_RESOURCE_RESERVATION_MS = Math.max(60_000, IM_SDK_CONNECT_TIMEOUT_MS * 4);
const DINGTALK_REGISTRATION_BASE_URL = "https://oapi.dingtalk.com";
const DINGTALK_REGISTRATION_SOURCE = "qm";
const IM_BRIDGE_INSTANCE_ID = randomUUID();
const IM_BRIDGE_LEASE_MS = Math.max(10_000, WEIXIN_BRIDGE_SYNC_MS * 4);
const IM_QR_LEASE_RESOURCE_ID = "provision";
Lark.defaultHttpInstance.defaults.timeout = IM_SDK_CONNECT_TIMEOUT_MS;
const IM_PROVIDER_META: Record<
  ImProviderId,
  {
    label: string;
    botName: string;
    kind: string;
    docsUrl?: string;
    hint: string;
    setupMode: ImSetupMode;
    setupTitle: string;
    setupSteps: string[];
    credentialFields?: string[];
    manualSetupSteps?: string[];
    primaryActionLabel?: string;
    primaryActionUrl?: string;
    manualSetupTitle?: string;
  }
> = {
  wechat: {
    label: "微信",
    botName: "微信 Bot",
    kind: "weixin-ilink",
    hint: "请使用微信扫描腾讯 iLink 二维码，并在手机上确认授权。",
    setupMode: "wechat-qr",
    setupTitle: "微信扫码连接",
    setupSteps: ["打开微信扫一扫", "扫描二维码并在手机上确认", "保持页面打开，等待绑定完成"],
  },
  feishu: {
    label: "飞书",
    botName: "飞书 Bot",
    kind: "bot-websocket",
    docsUrl: "https://open.feishu.cn/document/home/index",
    hint: "使用飞书扫码后选择已有应用；没有合适应用时再创建新机器人。平台会保存凭据并验证长连接。",
    setupMode: "provision-qr",
    setupTitle: "扫码选择或创建飞书机器人",
    setupSteps: [
      "用飞书扫描二维码并优先选择已有应用",
      "没有可用应用时再创建新机器人并完成授权",
      "平台保存应用凭据并验证长连接",
    ],
    credentialFields: ["App ID", "App Secret"],
    manualSetupSteps: [
      "在飞书开发者平台打开已有企业自建应用",
      "确认应用已添加机器人、开启长连接并完成发布",
      "在这里填写 App ID 和 App Secret 并验证绑定",
    ],
    primaryActionLabel: "打开飞书开放平台",
    primaryActionUrl: "https://open.feishu.cn/app",
    manualSetupTitle: "绑定已有飞书机器人",
  },
  "work-wechat": {
    label: "企业微信",
    botName: "QM 企业微信智能机器人",
    kind: "wecom-aibot",
    docsUrl: "https://work.weixin.qq.com/nl/index/aicli?from=catDetail",
    hint: "使用企业微信扫码创建或授权智能机器人；已有机器人可填写 Bot ID 和 Secret 绑定。",
    setupMode: "provision-qr",
    setupTitle: "扫码创建企业微信智能机器人",
    setupSteps: [
      "打开企业微信扫码创建窗口",
      "在手机端点击一键创建智能机器人并确认授权",
      "平台验证长连接后完成绑定并开始对话",
    ],
    credentialFields: ["Bot ID", "Secret"],
    manualSetupSteps: [
      "在企业微信电脑客户端打开已有 API 模式智能机器人",
      "确认机器人使用长连接方式并取得 Bot ID 和 Secret",
      "在这里填写 Bot ID 和 Secret，验证成功后即可对话",
    ],
    manualSetupTitle: "手动填写企业微信智能机器人",
  },
  qq: {
    label: "QQ",
    botName: "QQ Bot",
    kind: "qq-bot",
    docsUrl: "https://q.qq.com/wiki/",
    hint: "使用手机 QQ 扫码后选择并授权已有 Bot；没有 Bot 时再按平台流程创建。也可以直接填写已有凭据。",
    setupMode: "provision-qr",
    setupTitle: "QQ 扫码连接",
    setupSteps: ["使用手机 QQ 扫描二维码", "优先选择并授权已有机器人", "没有可用机器人时再创建并完成授权"],
    credentialFields: ["AppID", "AppSecret"],
    manualSetupSteps: ["在 QQ 开放平台打开已有机器人并取得 AppID 和 AppSecret", "在这里填写凭据，验证成功后即可对话"],
    manualSetupTitle: "绑定已有 QQ Bot",
    primaryActionLabel: "打开 QQ 开放平台",
    primaryActionUrl: "https://q.qq.com",
  },
  dingtalk: {
    label: "钉钉",
    botName: "QM 钉钉机器人",
    kind: "dingtalk-appbot",
    docsUrl: "https://open.dingtalk.com/?spm=a219a.7629140.0.0.95ChxP",
    hint: "扫码授权页支持选择已有机器人时请直接绑定；否则填写已有 ClientID 和 ClientSecret，只有需要时才创建新机器人。",
    setupMode: "provision-qr",
    setupTitle: "扫码选择或创建钉钉机器人",
    setupSteps: ["使用钉钉扫描二维码并确认授权", "优先选择已有机器人，没有时再创建", "平台验证 Stream 连接后完成绑定"],
    credentialFields: ["ClientID", "ClientSecret"],
    manualSetupSteps: [
      "在钉钉开放平台打开已有企业内部应用",
      "确认应用已添加机器人能力、选择 Stream 长连接并完成发布",
      "在这里填写 ClientID 和 ClientSecret，验证成功后完成配对",
    ],
    manualSetupTitle: "绑定已有钉钉机器人",
    primaryActionLabel: "打开钉钉开放平台",
    primaryActionUrl: "https://open.dingtalk.com/?spm=a219a.7629140.0.0.95ChxP",
  },
};

interface ImBindingRecord {
  provider: ImProviderId;
  status: "pending" | "connected";
  qrPayload?: string;
  botName?: string;
  channelKind?: string;
  setupMode?: ImSetupMode;
  quickSetupAvailable?: boolean;
  setupTitle?: string;
  setupSteps?: string[];
  credentialFields?: string[];
  manualSetupSteps?: string[];
  primaryActionLabel?: string;
  primaryActionUrl?: string;
  manualSetupTitle?: string;
  docsUrl?: string;
  hint?: string;
  externalUserId?: string;
  externalChatId?: string;
  externalDisplayName?: string;
  externalTenantId?: string;
  externalTenantName?: string;
  resourceId?: string;
  locatorAvailable?: boolean;
  locatorUnavailableReason?: string;
  authorizationState?: ImAuthorizationState;
  authorizationMessage?: string;
  verificationRequired?: boolean;
  authorizationExpiresAt?: number;
  authorizationPollIntervalMs?: number;
  providerQrCode?: string;
  providerBaseUrl?: string;
  verifyCode?: string;
  qrGenerationId?: string;
  createdAt?: number;
  connectedAt?: number;
  updatedAt: number;
}

interface ImResourceRecord {
  provider: ImProviderId;
  resourceId: string;
  botName: string;
  externalUserId?: string;
  externalChatId?: string;
  externalDisplayName?: string;
  externalTenantId?: string;
  externalTenantName?: string;
  encryptedSecret?: string;
  createdAt: number;
  updatedAt: number;
}

interface ImBindingsState {
  bindings: Partial<Record<ImProviderId, ImBindingRecord>>;
  resources: Partial<Record<ImProviderId, ImResourceRecord>>;
  revision: number;
}

interface WeixinResourceSecret {
  token: string;
  botId: string;
  userId: string;
  baseUrl: string;
  cursor?: string;
  contextToken?: string;
}

interface ImSdkResourceSecret {
  provider: Exclude<ImProviderId, "wechat">;
  credentials: Record<string, string>;
  replyTargets?: Record<string, string>;
}

interface ImSdkRuntime {
  resourceId: string;
  fingerprint: string;
  stop: () => void;
  send: (
    target: string,
    text: string,
    idempotencyKey?: string,
    editRef?: string,
    activityIncluded?: boolean,
  ) => Promise<void>;
  progress?: (target: string, text: string, activityText: string, runId: string) => Promise<boolean>;
}

class ImBotTargetUnavailableError extends Error {}

function imLocatorMessage(provider: ImProviderId, botName?: string): string {
  return `你好，我是你的专属 ${botName?.trim() || imProviderMeta(provider).botName}。以后可以直接在这里向我提问。`;
}

interface ImQrFlow {
  release: () => void;
  stop: () => void;
}

interface WeixinQrStatusResponse {
  status?:
    | "wait"
    | "scaned"
    | "confirmed"
    | "expired"
    | "scaned_but_redirect"
    | "need_verifycode"
    | "verify_code_blocked"
    | "binded_redirect";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

interface ImResourceOwnerRecord {
  user: string;
  provider: ImProviderId;
  resourceId: string;
  claimId?: string;
  claimExpiresAt?: number;
  committed?: boolean;
  createdAt: number;
}

interface ImResourceReservation {
  user: string;
  provider: ImProviderId;
  resourceId: string;
  claimId: string;
  restoreOnFailure: boolean;
}

class ImResourceConflictError extends Error {}

interface ImBridgeReadyRecord {
  owner: string;
  resourceId: string;
  fingerprint: string;
  expiresAt: number;
}

function isImProviderId(value: string): value is ImProviderId {
  return Object.prototype.hasOwnProperty.call(IM_PROVIDER_META, value);
}

function isImSetupMode(value: string): value is ImSetupMode {
  return value === "wechat-qr" || value === "provision-qr" || value === "manual-credentials";
}

function imStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items.slice(0, 8) : undefined;
}

function imTextField(value: unknown, limit = 256): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : undefined;
}

function weComTenantInfo(from: Record<string, unknown> | undefined): {
  externalTenantId?: string;
  externalTenantName?: string;
} {
  const externalTenantId = imTextField(from?.corpid ?? from?.corp_id ?? from?.corpId);
  const externalTenantName = imTextField(
    from?.corpname ?? from?.corp_name ?? from?.corpName ?? from?.company_name ?? from?.companyName,
  );
  return {
    ...(externalTenantId ? { externalTenantId } : {}),
    ...(externalTenantName ? { externalTenantName } : {}),
  };
}

function truncateUtf8(value: string, maxBytes: number, suffix: string): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  const bytes = Buffer.from(value).subarray(0, maxBytes - Buffer.byteLength(suffix));
  return `${bytes.toString("utf8").replace(/\uFFFD$/, "")}${suffix}`;
}

function parseImCredentialsKey(value: string | undefined): Buffer | undefined {
  const key = value?.trim();
  if (!key || !/^[0-9a-f]{64}$/i.test(key)) return undefined;
  const decoded = Buffer.from(key, "hex");
  return decoded.length === 32 ? decoded : undefined;
}

function encryptImSecret(value: unknown): string {
  if (!IM_CREDENTIALS_KEY) throw new Error("WEB_UI_IM_CREDENTIALS_KEY 未配置或格式无效，无法保存 Bot 凭据");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", IM_CREDENTIALS_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [
    "v2",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

function decryptImSecret<T>(sealed: string): T | null {
  const [version, ivRaw, tagRaw, encryptedRaw] = sealed.split(".");
  if (version !== "v2" || !ivRaw || !tagRaw || !encryptedRaw || !IM_CREDENTIALS_KEY) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", IM_CREDENTIALS_KEY, Buffer.from(ivRaw, "base64url"));
    decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
    return JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8"),
    ) as T;
  } catch {
    return null;
  }
}

function imProviderMeta(provider: ImProviderId): (typeof IM_PROVIDER_META)[ImProviderId] {
  return IM_PROVIDER_META[provider];
}

interface UiStateRecord {
  value: unknown;
  updatedAt: number;
}

async function readUiStateRecord(principalId: string, key: string): Promise<UiStateRecord> {
  const qs = new URLSearchParams({ principalId, key });
  const r = await coreFetch("GET", `/v1/ui-state?${qs.toString()}`);
  if (r.status !== 200) throw new Error(`ui-state read failed (${r.status})`);
  try {
    const parsed = JSON.parse(r.text) as { value?: unknown; updatedAt?: unknown };
    if (typeof parsed.updatedAt !== "number") throw new Error("invalid ui-state response");
    return { value: parsed.value ?? null, updatedAt: parsed.updatedAt };
  } catch {
    throw new Error("ui-state returned malformed JSON");
  }
}

async function writeUiStateValue(
  principalId: string,
  key: string,
  value: unknown,
  expectedUpdatedAt?: number,
): Promise<number> {
  const updatedAt = Math.max(Date.now(), (expectedUpdatedAt ?? 0) + 1);
  const r = await coreFetch(
    "PUT",
    "/v1/ui-state",
    JSON.stringify({
      principalId,
      key,
      value,
      updatedAt,
      ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
    }),
  );
  if (r.status !== 200) throw new Error(`ui-state write failed (${r.status})`);
  const body = JSON.parse(r.text) as { ok?: unknown; updatedAt?: unknown };
  if (body.ok === false) throw new Error("ui-state write conflict");
  if (typeof body.updatedAt !== "number") throw new Error("ui-state write returned malformed JSON");
  return body.updatedAt;
}

async function deleteUiStateValue(principalId: string, key: string, expectedUpdatedAt: number): Promise<boolean> {
  const r = await coreFetch("DELETE", "/v1/ui-state", JSON.stringify({ principalId, key, expectedUpdatedAt }));
  if (r.status !== 200) throw new Error(`ui-state delete failed (${r.status})`);
  const body = JSON.parse(r.text) as { ok?: unknown };
  return body.ok === true;
}

async function listUiStateRecords(key: string): Promise<Array<{ principalId: string; record: UiStateRecord }>> {
  const r = await coreFetch("GET", `/v1/ui-state/entries?key=${encodeURIComponent(key)}`);
  if (r.status !== 200) throw new Error(`ui-state list failed (${r.status})`);
  const parsed = JSON.parse(r.text) as { states?: unknown };
  if (!Array.isArray(parsed.states)) throw new Error("ui-state list returned malformed JSON");
  return parsed.states.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const state = item as { principalId?: unknown; value?: unknown; updatedAt?: unknown };
    return typeof state.principalId === "string" && typeof state.updatedAt === "number"
      ? [{ principalId: state.principalId, record: { value: state.value ?? null, updatedAt: state.updatedAt } }]
      : [];
  });
}

function parseImBindings(value: unknown, revision = 0): ImBindingsState {
  const state: ImBindingsState = { bindings: {}, resources: {}, revision };
  const rawBindings =
    typeof value === "object" && value !== null && typeof (value as { bindings?: unknown }).bindings === "object"
      ? ((value as { bindings: Record<string, unknown> }).bindings ?? {})
      : {};
  for (const [provider, record] of Object.entries(rawBindings)) {
    if (!isImProviderId(provider) || typeof record !== "object" || record === null) continue;
    const r = record as Partial<ImBindingRecord>;
    if (r.status !== "pending" && r.status !== "connected") continue;
    const setupMode = typeof r.setupMode === "string" && isImSetupMode(r.setupMode) ? r.setupMode : undefined;
    const qrPayload = typeof r.qrPayload === "string" ? r.qrPayload : undefined;
    const quickSetupAvailable = typeof r.quickSetupAvailable === "boolean" ? r.quickSetupAvailable : undefined;
    const authorizationState =
      r.authorizationState === "waiting" ||
      r.authorizationState === "scanned" ||
      r.authorizationState === "verification-required" ||
      r.authorizationState === "blocked" ||
      r.authorizationState === "expired" ||
      r.authorizationState === "unrecoverable" ||
      r.authorizationState === "error"
        ? r.authorizationState
        : undefined;
    state.bindings[provider] = {
      provider,
      status: r.status,
      ...(qrPayload ? { qrPayload } : {}),
      ...(typeof r.botName === "string" ? { botName: r.botName } : {}),
      ...(typeof r.channelKind === "string" ? { channelKind: r.channelKind } : {}),
      ...(setupMode ? { setupMode } : {}),
      ...(typeof quickSetupAvailable === "boolean" ? { quickSetupAvailable } : {}),
      ...(typeof r.setupTitle === "string" ? { setupTitle: r.setupTitle } : {}),
      ...(imStringList(r.setupSteps) ? { setupSteps: imStringList(r.setupSteps) } : {}),
      ...(imStringList(r.credentialFields) ? { credentialFields: imStringList(r.credentialFields) } : {}),
      ...(imStringList(r.manualSetupSteps) ? { manualSetupSteps: imStringList(r.manualSetupSteps) } : {}),
      ...(typeof r.primaryActionLabel === "string" ? { primaryActionLabel: r.primaryActionLabel } : {}),
      ...(typeof r.primaryActionUrl === "string" ? { primaryActionUrl: r.primaryActionUrl } : {}),
      ...(typeof r.manualSetupTitle === "string" ? { manualSetupTitle: r.manualSetupTitle } : {}),
      ...(typeof r.docsUrl === "string" ? { docsUrl: r.docsUrl } : {}),
      ...(typeof r.hint === "string" ? { hint: r.hint } : {}),
      ...(typeof r.externalUserId === "string" ? { externalUserId: r.externalUserId } : {}),
      ...(typeof r.externalChatId === "string" ? { externalChatId: r.externalChatId } : {}),
      ...(typeof r.externalDisplayName === "string" ? { externalDisplayName: r.externalDisplayName } : {}),
      ...(typeof r.externalTenantId === "string" ? { externalTenantId: r.externalTenantId } : {}),
      ...(typeof r.externalTenantName === "string" ? { externalTenantName: r.externalTenantName } : {}),
      ...(typeof r.resourceId === "string" ? { resourceId: r.resourceId } : {}),
      ...(typeof r.locatorAvailable === "boolean" ? { locatorAvailable: r.locatorAvailable } : {}),
      ...(typeof r.locatorUnavailableReason === "string"
        ? { locatorUnavailableReason: r.locatorUnavailableReason }
        : {}),
      ...(authorizationState ? { authorizationState } : {}),
      ...(typeof r.authorizationMessage === "string" ? { authorizationMessage: r.authorizationMessage } : {}),
      ...(typeof r.verificationRequired === "boolean" ? { verificationRequired: r.verificationRequired } : {}),
      ...(typeof r.authorizationExpiresAt === "number" ? { authorizationExpiresAt: r.authorizationExpiresAt } : {}),
      ...(typeof r.authorizationPollIntervalMs === "number"
        ? { authorizationPollIntervalMs: r.authorizationPollIntervalMs }
        : {}),
      ...(typeof r.providerQrCode === "string" ? { providerQrCode: r.providerQrCode } : {}),
      ...(typeof r.providerBaseUrl === "string" ? { providerBaseUrl: r.providerBaseUrl } : {}),
      ...(typeof r.verifyCode === "string" ? { verifyCode: r.verifyCode } : {}),
      ...(typeof r.qrGenerationId === "string" ? { qrGenerationId: r.qrGenerationId } : {}),
      ...(typeof r.createdAt === "number" ? { createdAt: r.createdAt } : {}),
      ...(typeof r.connectedAt === "number" ? { connectedAt: r.connectedAt } : {}),
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    };
  }
  const rawResources =
    typeof value === "object" && value !== null && typeof (value as { resources?: unknown }).resources === "object"
      ? ((value as { resources: Record<string, unknown> }).resources ?? {})
      : {};
  for (const [provider, record] of Object.entries(rawResources)) {
    if (!isImProviderId(provider) || typeof record !== "object" || record === null) continue;
    const r = record as Partial<ImResourceRecord>;
    if (typeof r.resourceId !== "string" || !r.resourceId.trim()) continue;
    state.resources[provider] = {
      provider,
      resourceId: r.resourceId.slice(0, 256),
      botName:
        typeof r.botName === "string" && r.botName.trim() ? r.botName.slice(0, 256) : imProviderMeta(provider).botName,
      ...(typeof r.externalUserId === "string" && r.externalUserId.trim()
        ? { externalUserId: r.externalUserId.slice(0, 256) }
        : {}),
      ...(typeof r.externalChatId === "string" ? { externalChatId: r.externalChatId.slice(0, 256) } : {}),
      ...(typeof r.externalDisplayName === "string"
        ? { externalDisplayName: r.externalDisplayName.slice(0, 256) }
        : {}),
      ...(typeof r.externalTenantId === "string" && r.externalTenantId.trim()
        ? { externalTenantId: r.externalTenantId.slice(0, 256) }
        : {}),
      ...(typeof r.externalTenantName === "string" && r.externalTenantName.trim()
        ? { externalTenantName: r.externalTenantName.slice(0, 256) }
        : {}),
      ...(typeof r.encryptedSecret === "string" ? { encryptedSecret: r.encryptedSecret } : {}),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
      updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
    };
  }
  const wechatBinding = state.bindings.wechat;
  if (
    wechatBinding?.status === "pending" &&
    (!wechatBinding.providerQrCode || !wechatBinding.providerBaseUrl || !wechatBinding.qrPayload)
  ) {
    delete state.bindings.wechat;
  }
  if (wechatBinding?.status === "connected" && !readWeixinSecret(state.resources.wechat)) {
    delete state.bindings.wechat;
  }
  for (const provider of Object.keys(state.bindings).filter(isImProviderId)) {
    if (state.bindings[provider]?.status === "connected" && !state.resources[provider]) delete state.bindings[provider];
  }
  return state;
}

function imLocatorAvailable(binding: ImBindingRecord | undefined, resource: ImResourceRecord | undefined): boolean {
  if (binding?.status !== "connected" || !resource) return false;
  if (binding.provider === "wechat")
    return Boolean(resource.externalChatId && readWeixinSecret(resource)?.contextToken);
  if (binding.provider === "feishu") return Boolean(resource.externalChatId);
  if (binding.provider === "qq") return Boolean(resource.externalChatId);
  if (binding.provider === "work-wechat") return Boolean(resource.externalChatId);
  if (binding.provider === "dingtalk") {
    const secret = readImSdkSecret(resource);
    return Boolean(resource.externalChatId && secret?.replyTargets?.[resource.externalChatId]);
  }
  return Boolean(resource.externalChatId);
}

function imLocatorUnavailableReason(
  binding: ImBindingRecord | undefined,
  resource: ImResourceRecord | undefined,
): string {
  if (binding?.status !== "connected" || !resource) return "机器人尚未完成绑定";
  const label = imProviderMeta(binding.provider).label;
  if (binding.provider === "wechat" && !readWeixinSecret(resource)?.contextToken)
    return "请先在微信里给 Bot 发送一条消息，之后才能从这里定位。";
  if (binding.provider === "feishu") return "请先在飞书里给 Bot 发送一条消息，之后才能从这里定位。";
  if (binding.provider === "work-wechat") return "请先在企业微信里打开该 Bot；打开后会自动发送欢迎消息并记录会话。";
  if (binding.provider === "qq") return "请先在 QQ 里给 Bot 发送一条消息，之后才能从这里定位。";
  if (binding.provider === "dingtalk") return "请先在钉钉里给 Bot 发送一条消息，之后才能从这里定位。";
  return `${label}没有可发送的会话上下文，请先在 IM 中打开机器人并发送一条消息。`;
}

function publicImBinding(binding: ImBindingRecord, resource?: ImResourceRecord): ImBindingRecord {
  const {
    providerQrCode: _providerQrCode,
    providerBaseUrl: _providerBaseUrl,
    verifyCode: _verifyCode,
    qrGenerationId: _qrGenerationId,
    locatorAvailable: _locatorAvailable,
    locatorUnavailableReason: _locatorUnavailableReason,
    ...publicBinding
  } = binding;
  const locatorAvailable = imLocatorAvailable(binding, resource);
  const externalTenantId = publicBinding.externalTenantId ?? resource?.externalTenantId;
  const externalTenantName = publicBinding.externalTenantName ?? resource?.externalTenantName;
  return {
    ...publicBinding,
    ...(externalTenantId ? { externalTenantId } : {}),
    ...(externalTenantName ? { externalTenantName } : {}),
    locatorAvailable,
    ...(locatorAvailable ? {} : { locatorUnavailableReason: imLocatorUnavailableReason(binding, resource) }),
  };
}

function publicImBindings(state: ImBindingsState): {
  bindings: Partial<Record<ImProviderId, ImBindingRecord>>;
  reusableProviders: ImProviderId[];
} {
  return {
    bindings: Object.fromEntries(
      Object.entries(state.bindings).map(([provider, binding]) => [
        provider,
        publicImBinding(binding, state.resources[provider as ImProviderId]),
      ]),
    ),
    reusableProviders: Object.keys(state.resources).filter(isImProviderId),
  };
}

async function readImBindings(user: string): Promise<ImBindingsState> {
  const record = await readUiStateRecord(user, IM_BINDINGS_KEY);
  return parseImBindings(record.value, record.updatedAt);
}

async function writeImBindings(user: string, state: ImBindingsState): Promise<void> {
  const { revision, ...value } = state;
  state.revision = await writeUiStateValue(user, IM_BINDINGS_KEY, value, revision);
}

function imStateKey(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 48)}`;
}

function imResourceOwnerKey(provider: ImProviderId, resourceId: string): string {
  return imStateKey("resource", `${provider}\0${resourceId}`);
}

function parseImResourceOwner(value: unknown): ImResourceOwnerRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<ImResourceOwnerRecord>;
  if (
    typeof record.user !== "string" ||
    typeof record.provider !== "string" ||
    !isImProviderId(record.provider) ||
    typeof record.resourceId !== "string"
  )
    return null;
  return {
    user: record.user,
    provider: record.provider,
    resourceId: record.resourceId,
    ...(typeof record.claimId === "string" ? { claimId: record.claimId } : {}),
    ...(typeof record.claimExpiresAt === "number" ? { claimExpiresAt: record.claimExpiresAt } : {}),
    ...(typeof record.committed === "boolean" ? { committed: record.committed } : {}),
    createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
  };
}

function imResourceReservationActive(owner: ImResourceOwnerRecord, now = Date.now()): boolean {
  return typeof owner.claimExpiresAt === "number" && owner.claimExpiresAt > now;
}

async function claimImResourceOwner(user: string, provider: ImProviderId, resourceId: string): Promise<void> {
  const key = imResourceOwnerKey(provider, resourceId);
  const stored = await readUiStateRecord(IM_TOKENS_PRINCIPAL, key);
  const owner = parseImResourceOwner(stored.value);
  if (owner?.user === user) return;
  if (owner) throw new ImResourceConflictError(`这个${imProviderMeta(provider).label}机器人已经绑定到其他用户`);
  try {
    await writeUiStateValue(
      IM_TOKENS_PRINCIPAL,
      key,
      {
        user,
        provider,
        resourceId,
        claimId: randomUUID(),
        committed: true,
        createdAt: Date.now(),
      } satisfies ImResourceOwnerRecord,
      stored.updatedAt,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "ui-state write conflict") {
      const current = parseImResourceOwner((await readUiStateRecord(IM_TOKENS_PRINCIPAL, key)).value);
      if (current?.user === user) return;
      if (current)
        throw new ImResourceConflictError(`这个${imProviderMeta(provider).label}机器人已经绑定到其他用户`, {
          cause: error,
        });
    }
    throw error;
  }
}

async function reserveImResourceOwner(
  user: string,
  provider: ImProviderId,
  resourceId: string,
  discarding = false,
): Promise<ImResourceReservation> {
  const key = imResourceOwnerKey(provider, resourceId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stored = await readUiStateRecord(IM_TOKENS_PRINCIPAL, key);
    const owner = parseImResourceOwner(stored.value);
    const now = Date.now();
    const active = owner ? imResourceReservationActive(owner, now) : false;
    if (owner && owner.user !== user && (owner.committed !== false || active))
      throw new ImResourceConflictError(`这个${imProviderMeta(provider).label}机器人已经绑定到其他用户`);
    if (owner?.user === user && active)
      throw new Error(`这个${imProviderMeta(provider).label}机器人正在绑定，请稍后重试`);
    const claimId = randomUUID();
    const restoreOnFailure = owner?.user === user && owner.committed !== false;
    try {
      await writeUiStateValue(
        IM_TOKENS_PRINCIPAL,
        key,
        {
          user,
          provider,
          resourceId,
          claimId,
          claimExpiresAt: now + IM_RESOURCE_RESERVATION_MS,
          committed: discarding ? false : restoreOnFailure,
          createdAt: owner?.user === user ? owner.createdAt : now,
        } satisfies ImResourceOwnerRecord,
        stored.updatedAt,
      );
      return { user, provider, resourceId, claimId, restoreOnFailure };
    } catch (error) {
      if (!(error instanceof Error && error.message === "ui-state write conflict") || attempt === 2) throw error;
    }
  }
  throw new Error("机器人资源归属写入失败");
}

async function discardImResourceReservation(reservation: ImResourceReservation): Promise<void> {
  const key = imResourceOwnerKey(reservation.provider, reservation.resourceId);
  const stored = await readUiStateRecord(IM_TOKENS_PRINCIPAL, key);
  const owner = parseImResourceOwner(stored.value);
  if (owner?.user !== reservation.user || owner.claimId !== reservation.claimId)
    throw new Error("机器人资源归属已经改变");
  if (!(await deleteUiStateValue(IM_TOKENS_PRINCIPAL, key, stored.updatedAt)))
    throw new Error("机器人资源归属已经改变");
}

async function commitImResourceReservation(reservation: ImResourceReservation): Promise<void> {
  const key = imResourceOwnerKey(reservation.provider, reservation.resourceId);
  const stored = await readUiStateRecord(IM_TOKENS_PRINCIPAL, key);
  const owner = parseImResourceOwner(stored.value);
  if (owner?.user !== reservation.user || owner.claimId !== reservation.claimId)
    throw new Error("机器人资源归属已经改变");
  await writeUiStateValue(
    IM_TOKENS_PRINCIPAL,
    key,
    {
      user: reservation.user,
      provider: reservation.provider,
      resourceId: reservation.resourceId,
      claimId: randomUUID(),
      committed: true,
      createdAt: owner.createdAt,
    } satisfies ImResourceOwnerRecord,
    stored.updatedAt,
  );
}

async function releaseImResourceReservation(reservation: ImResourceReservation): Promise<void> {
  const key = imResourceOwnerKey(reservation.provider, reservation.resourceId);
  const stored = await readUiStateRecord(IM_TOKENS_PRINCIPAL, key);
  const owner = parseImResourceOwner(stored.value);
  if (owner?.user !== reservation.user || owner.claimId !== reservation.claimId) return;
  if (!reservation.restoreOnFailure) {
    await deleteUiStateValue(IM_TOKENS_PRINCIPAL, key, stored.updatedAt);
    return;
  }
  await writeUiStateValue(
    IM_TOKENS_PRINCIPAL,
    key,
    {
      user: reservation.user,
      provider: reservation.provider,
      resourceId: reservation.resourceId,
      claimId: randomUUID(),
      committed: true,
      createdAt: owner.createdAt,
    } satisfies ImResourceOwnerRecord,
    stored.updatedAt,
  );
}

function imBindingBase(provider: ImProviderId, now: number): Omit<ImBindingRecord, "status" | "updatedAt"> {
  const meta = imProviderMeta(provider);
  return {
    provider,
    botName: meta.botName,
    channelKind: meta.kind,
    setupMode: meta.setupMode,
    setupTitle: meta.setupTitle,
    setupSteps: [...meta.setupSteps],
    ...(meta.credentialFields ? { credentialFields: [...meta.credentialFields] } : {}),
    ...(meta.manualSetupSteps ? { manualSetupSteps: [...meta.manualSetupSteps] } : {}),
    ...(meta.primaryActionLabel ? { primaryActionLabel: meta.primaryActionLabel } : {}),
    ...(meta.primaryActionUrl ? { primaryActionUrl: meta.primaryActionUrl } : {}),
    ...(meta.manualSetupTitle ? { manualSetupTitle: meta.manualSetupTitle } : {}),
    ...(meta.docsUrl ? { docsUrl: meta.docsUrl } : {}),
    hint: meta.hint,
    createdAt: now,
  };
}

function bindingFromResource(resource: ImResourceRecord, existing?: ImBindingRecord): ImBindingRecord {
  const now = Date.now();
  return {
    ...imBindingBase(resource.provider, existing?.createdAt ?? now),
    provider: resource.provider,
    status: "connected",
    botName: resource.botName,
    resourceId: resource.resourceId,
    ...(resource.externalUserId ? { externalUserId: resource.externalUserId } : {}),
    ...(resource.externalChatId ? { externalChatId: resource.externalChatId } : {}),
    ...(resource.externalDisplayName ? { externalDisplayName: resource.externalDisplayName } : {}),
    ...(resource.externalTenantId ? { externalTenantId: resource.externalTenantId } : {}),
    ...(resource.externalTenantName ? { externalTenantName: resource.externalTenantName } : {}),
    connectedAt: existing?.connectedAt ?? now,
    updatedAt: now,
  };
}

function weixinBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return WEIXIN_ILINK_BASE_URL;
  return /^https?:\/\//i.test(trimmed) ? trimmed.replace(/\/$/, "") : `https://${trimmed.replace(/\/$/, "")}`;
}

function weixinHeaders(token?: string): Record<string, string> {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return {
    "content-type": "application/json",
    "iLink-App-Id": "bot",
    "iLink-App-ClientVersion": "132102",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": Buffer.from(String(uint32), "utf8").toString("base64"),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function weixinJson<T>(
  baseUrl: string,
  endpoint: string,
  method: "GET" | "POST",
  body?: unknown,
  token?: string,
  timeoutMs = WEIXIN_API_TIMEOUT_MS,
): Promise<T> {
  const response = await fetch(new URL(endpoint, `${baseUrl.replace(/\/$/, "")}/`), {
    method,
    headers: weixinHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Weixin iLink ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

function readWeixinSecret(resource: ImResourceRecord | undefined): WeixinResourceSecret | null {
  if (resource?.provider !== "wechat" || !resource.encryptedSecret) return null;
  const secret = decryptImSecret<Partial<WeixinResourceSecret>>(resource.encryptedSecret);
  if (!secret?.token || !secret.botId || !secret.userId || !secret.baseUrl) return null;
  return secret as WeixinResourceSecret;
}

function readImSdkSecret(resource: ImResourceRecord | undefined): ImSdkResourceSecret | null {
  if (!resource || resource.provider === "wechat" || !resource.encryptedSecret) return null;
  const secret = decryptImSecret<Partial<ImSdkResourceSecret>>(resource.encryptedSecret);
  if (secret?.provider !== resource.provider || typeof secret.credentials !== "object" || !secret.credentials)
    return null;
  const credentials = Object.fromEntries(
    Object.entries(secret.credentials).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim()),
    ),
  );
  if (!Object.keys(credentials).length) return null;
  return {
    provider: secret.provider,
    credentials,
    ...(typeof secret.replyTargets === "object" && secret.replyTargets
      ? {
          replyTargets: Object.fromEntries(
            Object.entries(secret.replyTargets).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1]),
            ),
          ),
        }
      : {}),
  };
}

const imSdkRuntimes = new Map<string, ImSdkRuntime>();
const imSdkActivations = new Map<string, Promise<void>>();
const imQrFlows = new Map<string, ImQrFlow>();
const imBridgeLeases = new Map<string, number>();
const imBridgeClaims = new Map<string, Promise<boolean>>();

function createImKeyedQueue(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<void>>();
  return (key, fn) => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

const queueImSdkMessage = createImKeyedQueue();
const queueImProgressStateUpdate = createImKeyedQueue();
const queueImConversationUpdate = createImKeyedQueue();

function imRuntimeKey(user: string, provider: ImProviderId): string {
  return `${user}\0${provider}`;
}

function imBridgeKey(user: string, provider: ImProviderId, resourceId: string): string {
  return `${user}\0${provider}\0${resourceId}`;
}

function imBridgeStateKey(user: string, provider: ImProviderId, resourceId: string): string {
  return imStateKey("lease", imBridgeKey(user, provider, resourceId));
}

function imBridgeReadyStateKey(user: string, provider: ImProviderId, resourceId: string): string {
  return imStateKey("ready", imBridgeKey(user, provider, resourceId));
}

function ownsImBridge(user: string, provider: ImProviderId, resourceId: string): boolean {
  return (imBridgeLeases.get(imBridgeKey(user, provider, resourceId)) ?? 0) > Date.now();
}

async function renewImBridge(user: string, provider: ImProviderId, resourceId: string): Promise<boolean> {
  const key = imBridgeKey(user, provider, resourceId);
  const stateKey = imBridgeStateKey(user, provider, resourceId);
  const stored = await readUiStateRecord(IM_TOKENS_PRINCIPAL, stateKey);
  const lease =
    typeof stored.value === "object" && stored.value !== null
      ? (stored.value as { owner?: unknown; expiresAt?: unknown })
      : {};
  if (
    typeof lease.owner === "string" &&
    lease.owner !== IM_BRIDGE_INSTANCE_ID &&
    typeof lease.expiresAt === "number" &&
    lease.expiresAt > Date.now()
  ) {
    imBridgeLeases.delete(key);
    return false;
  }
  const expiresAt = Date.now() + IM_BRIDGE_LEASE_MS;
  try {
    await writeUiStateValue(
      IM_TOKENS_PRINCIPAL,
      stateKey,
      { owner: IM_BRIDGE_INSTANCE_ID, expiresAt },
      stored.updatedAt,
    );
    imBridgeLeases.set(key, expiresAt);
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "ui-state write conflict") {
      imBridgeLeases.delete(key);
      return false;
    }
    throw error;
  }
}

async function claimImBridge(user: string, provider: ImProviderId, resourceId: string): Promise<boolean> {
  const key = imBridgeKey(user, provider, resourceId);
  const current = imBridgeClaims.get(key);
  if (current) return current;
  const claim = renewImBridge(user, provider, resourceId);
  imBridgeClaims.set(key, claim);
  try {
    return await claim;
  } finally {
    if (imBridgeClaims.get(key) === claim) imBridgeClaims.delete(key);
  }
}

function imSdkFingerprint(secret: ImSdkResourceSecret): string {
  return createHash("sha256").update(JSON.stringify(secret.credentials)).digest("base64url");
}

async function markImBridgeReady(user: string, resource: ImResourceRecord): Promise<void> {
  const secret = readImSdkSecret(resource);
  if (!secret) throw new Error("平台 Bot 凭据缺失，请重新绑定");
  const leaseExpiresAt = imBridgeLeases.get(imBridgeKey(user, resource.provider, resource.resourceId)) ?? 0;
  if (leaseExpiresAt <= Date.now()) throw new Error("机器人连接租约已失效");
  const key = imBridgeReadyStateKey(user, resource.provider, resource.resourceId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const stored = await readUiStateRecord(IM_TOKENS_PRINCIPAL, key);
    try {
      await writeUiStateValue(
        IM_TOKENS_PRINCIPAL,
        key,
        {
          owner: IM_BRIDGE_INSTANCE_ID,
          resourceId: resource.resourceId,
          fingerprint: imSdkFingerprint(secret),
          expiresAt: leaseExpiresAt,
        } satisfies ImBridgeReadyRecord,
        stored.updatedAt,
      );
      return;
    } catch (error) {
      if (!(error instanceof Error && error.message === "ui-state write conflict") || attempt === 2) throw error;
    }
  }
}

async function hasReadyImBridge(user: string, resource: ImResourceRecord): Promise<boolean> {
  const secret = readImSdkSecret(resource);
  if (!secret) return false;
  const stored = await readUiStateRecord(
    IM_TOKENS_PRINCIPAL,
    imBridgeReadyStateKey(user, resource.provider, resource.resourceId),
  );
  if (typeof stored.value !== "object" || stored.value === null) return false;
  const ready = stored.value as Partial<ImBridgeReadyRecord>;
  return (
    ready.resourceId === resource.resourceId &&
    ready.fingerprint === imSdkFingerprint(secret) &&
    typeof ready.expiresAt === "number" &&
    ready.expiresAt > Date.now()
  );
}

function waitForImConnection(start: (resolve: () => void, reject: (error: Error) => void) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("连接平台超时，请检查凭据和网络后重试")),
      IM_SDK_CONNECT_TIMEOUT_MS,
    );
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    start(
      () => finish(),
      (error) => finish(error),
    );
  });
}

interface ImRunActivity {
  type?: string;
  payload?: unknown;
}

interface ImRunSnapshot {
  status?: string;
  partial?: string;
  activity?: ImRunActivity[];
}

interface StoredImRunProgress {
  provider: ImProviderId;
  resourceId: string;
  runId: string;
  target: string;
  messageId?: string;
  progressAllowed: boolean;
  sentInitial?: boolean;
  sentActivity?: number;
  partialLength?: number;
  partialHash?: string;
  lastProgressId?: string;
  sentMessageIds?: string[];
  pendingMessageId?: string;
  pendingOwner?: string;
  pendingExpiresAt?: number;
  terminal?: boolean;
  createdAt: number;
}

type ImRunProgressCursor = Pick<
  StoredImRunProgress,
  "sentInitial" | "sentActivity" | "partialLength" | "partialHash" | "lastProgressId"
>;

function parseStoredImRunProgress(value: unknown): Record<string, StoredImRunProgress> {
  if (typeof value !== "object" || value === null) return {};
  const candidate = (value as { runs?: unknown }).runs;
  const runs = typeof candidate === "object" && candidate !== null ? candidate : {};
  return Object.fromEntries(
    Object.values(runs).flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const run = value as Partial<StoredImRunProgress>;
      if (
        typeof run.provider !== "string" ||
        !isImProviderId(run.provider) ||
        typeof run.resourceId !== "string" ||
        typeof run.runId !== "string" ||
        typeof run.target !== "string" ||
        typeof run.progressAllowed !== "boolean" ||
        typeof run.createdAt !== "number" ||
        !Number.isFinite(run.createdAt)
      )
        return [];
      return [
        [
          storedImRunProgressKey(run.provider, run.runId),
          {
            provider: run.provider,
            resourceId: run.resourceId,
            runId: run.runId,
            target: run.target,
            ...(typeof run.messageId === "string" ? { messageId: run.messageId } : {}),
            progressAllowed: run.progressAllowed,
            ...(typeof run.sentInitial === "boolean" ? { sentInitial: run.sentInitial } : {}),
            ...(typeof run.sentActivity === "number" && Number.isInteger(run.sentActivity) && run.sentActivity >= 0
              ? { sentActivity: run.sentActivity }
              : {}),
            ...(typeof run.partialLength === "number" && Number.isInteger(run.partialLength) && run.partialLength >= 0
              ? { partialLength: run.partialLength }
              : {}),
            ...(typeof run.partialHash === "string" ? { partialHash: run.partialHash } : {}),
            ...(typeof run.lastProgressId === "string" ? { lastProgressId: run.lastProgressId } : {}),
            ...(Array.isArray(run.sentMessageIds)
              ? { sentMessageIds: run.sentMessageIds.filter((id): id is string => typeof id === "string").slice(-64) }
              : {}),
            ...(typeof run.pendingMessageId === "string" ? { pendingMessageId: run.pendingMessageId } : {}),
            ...(typeof run.pendingOwner === "string" ? { pendingOwner: run.pendingOwner } : {}),
            ...(typeof run.pendingExpiresAt === "number" && Number.isFinite(run.pendingExpiresAt)
              ? { pendingExpiresAt: run.pendingExpiresAt }
              : {}),
            ...(typeof run.terminal === "boolean" ? { terminal: run.terminal } : {}),
            createdAt: run.createdAt,
          },
        ],
      ];
    }),
  );
}

function storedImRunProgressKey(provider: ImProviderId, runId: string): string {
  return `${provider}:${runId}`;
}

function imProgressStateKey(provider: ImProviderId): string {
  return `${IM_PROGRESS_KEY_PREFIX}${provider}`;
}

function updateStoredImRunProgress(
  user: string,
  provider: ImProviderId,
  update: (runs: Record<string, StoredImRunProgress>) => void,
): Promise<void> {
  return queueImProgressStateUpdate(imRuntimeKey(user, provider), async () => {
    const key = imProgressStateKey(provider);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const stored = await readUiStateRecord(user, key);
      const runs = parseStoredImRunProgress(stored.value);
      update(runs);
      try {
        await writeUiStateValue(user, key, { runs }, stored.updatedAt);
        return;
      } catch (error) {
        if (!(error instanceof Error && error.message === "ui-state write conflict") || attempt === 2) throw error;
      }
    }
  });
}

function saveStoredImRunProgress(user: string, progress: StoredImRunProgress): Promise<void> {
  return updateStoredImRunProgress(user, progress.provider, (runs) => {
    runs[storedImRunProgressKey(progress.provider, progress.runId)] = progress;
  });
}

async function claimStoredImProgressMessage(
  user: string,
  progress: StoredImRunProgress,
  messageId: string,
): Promise<"claimed" | "sent" | "busy"> {
  let result: "claimed" | "sent" | "busy" = "busy";
  let expiresAt = 0;
  await updateStoredImRunProgress(user, progress.provider, (runs) => {
    result = "busy";
    const key = storedImRunProgressKey(progress.provider, progress.runId);
    const stored = runs[key];
    if (!stored || stored.createdAt !== progress.createdAt) return;
    if (stored.sentMessageIds?.includes(messageId)) {
      result = "sent";
      return;
    }
    if (stored.pendingMessageId && (stored.pendingExpiresAt ?? 0) > Date.now()) return;
    expiresAt = Date.now() + IM_PROGRESS_CLAIM_MS;
    runs[key] = {
      ...stored,
      pendingMessageId: messageId,
      pendingOwner: IM_BRIDGE_INSTANCE_ID,
      pendingExpiresAt: expiresAt,
    };
    result = "claimed";
  });
  return result;
}

async function releaseStoredImProgressMessage(
  user: string,
  progress: StoredImRunProgress,
  messageId: string,
): Promise<void> {
  await updateStoredImRunProgress(user, progress.provider, (runs) => {
    const key = storedImRunProgressKey(progress.provider, progress.runId);
    const stored = runs[key];
    if (
      !stored ||
      stored.createdAt !== progress.createdAt ||
      stored.pendingMessageId !== messageId ||
      stored.pendingOwner !== IM_BRIDGE_INSTANCE_ID
    )
      return;
    const { pendingMessageId: _messageId, pendingOwner: _owner, pendingExpiresAt: _expiresAt, ...released } = stored;
    runs[key] = released;
  });
  delete progress.pendingMessageId;
  delete progress.pendingOwner;
  delete progress.pendingExpiresAt;
}

async function commitStoredImProgressMessage(
  user: string,
  progress: StoredImRunProgress,
  messageId: string,
  cursor: ImRunProgressCursor,
): Promise<void> {
  let committed = false;
  await updateStoredImRunProgress(user, progress.provider, (runs) => {
    committed = false;
    const key = storedImRunProgressKey(progress.provider, progress.runId);
    const stored = runs[key];
    if (
      !stored ||
      stored.createdAt !== progress.createdAt ||
      stored.pendingMessageId !== messageId ||
      stored.pendingOwner !== IM_BRIDGE_INSTANCE_ID
    )
      return;
    const { pendingMessageId: _messageId, pendingOwner: _owner, pendingExpiresAt: _expiresAt, ...claimed } = stored;
    runs[key] = {
      ...claimed,
      ...cursor,
      sentMessageIds: [...(claimed.sentMessageIds ?? []), messageId].slice(-64),
    };
    committed = true;
  });
  if (!committed) throw new Error("IM progress claim lost");
  delete progress.pendingMessageId;
  delete progress.pendingOwner;
  delete progress.pendingExpiresAt;
  Object.assign(progress, cursor, {
    sentMessageIds: [...(progress.sentMessageIds ?? []), messageId].slice(-64),
  });
}

function removeStoredImRunProgress(user: string, provider: ImProviderId, runId: string): Promise<void> {
  return updateStoredImRunProgress(user, provider, (runs) => {
    delete runs[storedImRunProgressKey(provider, runId)];
  });
}

async function readStoredImRunProgress(
  user: string,
  provider: ImProviderId,
  runId: string,
): Promise<StoredImRunProgress | undefined> {
  const stored = await readUiStateRecord(user, imProgressStateKey(provider));
  return parseStoredImRunProgress(stored.value)[storedImRunProgressKey(provider, runId)];
}

function imProgressActivityText(activity: ImRunActivity): string | null {
  const payload =
    typeof activity.payload === "object" && activity.payload !== null
      ? (activity.payload as Record<string, unknown>)
      : {};
  if (activity.type === "thinking") {
    const thinking = typeof payload.thinking === "string" && payload.redacted !== true ? payload.thinking.trim() : "";
    return thinking ? `思考中\n${thinking}` : null;
  }
  const tool = typeof payload.tool === "string" && payload.tool ? payload.tool : "步骤";
  if (activity.type === "tool_call") return `执行中: ${tool}`;
  if (activity.type === "tool_result") {
    const failed =
      payload.isError === true || payload.ok === false || Boolean(payload.error) || payload.denied === true;
    return `${failed ? "执行失败" : "已完成"}: ${tool}`;
  }
  if (activity.type === "approval_request") return "等待确认";
  if (activity.type === "approval_resolved") return payload.approved === false ? "已拒绝" : "已确认";
  return null;
}

export function formatImRunProgress(snapshot: ImRunSnapshot): { text: string; activityText: string } {
  const activityText = (snapshot.activity ?? [])
    .map(imProgressActivityText)
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const partial = typeof snapshot.partial === "string" ? snapshot.partial.trim() : "";
  return {
    text: [activityText, partial ? `回复中\n${partial}` : ""].filter(Boolean).join("\n\n") || "正在思考...",
    activityText,
  };
}

function imProgressMessageId(user: string, provider: ImProviderId, runId: string, text: string): string {
  return `qm-progress-${createHash("sha256").update(`${user}\0${provider}\0${runId}\0${text}`).digest("hex").slice(0, 32)}`;
}

function imProgressTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

async function persistImRunProgressCursor(
  user: string,
  progress: StoredImRunProgress,
  cursor: ImRunProgressCursor,
): Promise<void> {
  if (
    progress.sentInitial === cursor.sentInitial &&
    progress.sentActivity === cursor.sentActivity &&
    progress.partialLength === cursor.partialLength &&
    progress.partialHash === cursor.partialHash &&
    progress.lastProgressId === cursor.lastProgressId
  )
    return;
  await saveStoredImRunProgress(user, { ...progress, ...cursor });
  Object.assign(progress, cursor);
}

async function sendWeixinProgress(user: string, target: string, text: string, messageId: string): Promise<void> {
  const state = await readImBindings(user);
  const binding = state.bindings.wechat;
  const resource = state.resources.wechat;
  const secret = readWeixinSecret(resource);
  if (binding?.status !== "connected" || binding.externalChatId !== target || !secret) return;
  const sent = await weixinJson<{ ret?: number; errmsg?: string }>(
    secret.baseUrl,
    "ilink/bot/sendmessage",
    "POST",
    {
      msg: {
        from_user_id: "",
        to_user_id: secret.userId,
        client_id: messageId,
        message_type: 2,
        message_state: 2,
        item_list: [{ type: 1, text_item: { text } }],
        ...(secret.contextToken ? { context_token: secret.contextToken } : {}),
      },
      base_info: { channel_version: "0.1.0", bot_agent: "QM/0.1.0" },
    },
    secret.token,
    15_000,
  );
  if ((sent.ret ?? 0) !== 0) throw new Error(`Weixin progress failed: ${sent.ret} ${sent.errmsg ?? ""}`);
}

const sentImProgress = new LRUCache<string, true>({ max: 50_000, ttl: IM_RUN_PROGRESS_MAX_AGE_MS });

async function sendImProgress(
  user: string,
  provider: ImProviderId,
  target: string,
  runId: string,
  text: string,
  progressState?: StoredImRunProgress,
  cursor?: ImRunProgressCursor,
): Promise<boolean> {
  const content = truncateUtf8(text, 12_000, "\n\n[平台单条进度上限，内容已截断]");
  const messageId = imProgressMessageId(user, provider, runId, content);
  const runtime = provider === "wechat" ? undefined : imSdkRuntimes.get(imRuntimeKey(user, provider));
  if (provider !== "wechat" && !runtime) throw new Error(`${provider} runtime unavailable`);
  if (sentImProgress.has(messageId)) return true;
  const claim =
    progressState && cursor ? await claimStoredImProgressMessage(user, progressState, messageId) : "claimed";
  if (claim === "sent") return true;
  if (claim === "busy") return false;
  if (progressState && !ownsImBridge(user, provider, progressState.resourceId)) {
    await releaseStoredImProgressMessage(user, progressState, messageId);
    return false;
  }
  try {
    if (provider === "wechat") await sendWeixinProgress(user, target, content, messageId);
    else await runtime!.send(target, content, messageId);
  } catch (error) {
    if (progressState) await releaseStoredImProgressMessage(user, progressState, messageId);
    throw error;
  }
  if (progressState && cursor) await commitStoredImProgressMessage(user, progressState, messageId, cursor);
  sentImProgress.set(messageId, true);
  return true;
}

interface ImRunProgressFollower {
  promise: Promise<void>;
  canceled: boolean;
  finalizing: boolean;
}

class ImProgressLeaseLostError extends Error {}

const imRunProgressFollowers = new Map<string, ImRunProgressFollower>();

function imRunProgressKey(user: string, provider: ImProviderId, runId: string): string {
  return `${user}\0${provider}\0${runId}`;
}

async function finishImRunProgress(
  user: string,
  provider: ImProviderId,
  runId: string,
): Promise<StoredImRunProgress | undefined> {
  const key = imRunProgressKey(user, provider, runId);
  const follower = imRunProgressFollowers.get(key);
  if (follower) {
    follower.finalizing = true;
    follower.canceled = true;
    await follower.promise;
  }
  const progress = await readStoredImRunProgress(user, provider, runId);
  if (progress && !ownsImBridge(user, provider, progress.resourceId)) throw new ImProgressLeaseLostError();
  return progress;
}

function fetchImRun(
  user: string,
  runId: string,
  timeoutMs = IM_RUN_PROGRESS_REQUEST_TIMEOUT_MS,
): Promise<{ status: number; text: string }> {
  const request = () => coreFetch("GET", `/v1/runs/${encodeURIComponent(runId)}`, "", timeoutMs);
  if (!PORTAL_IDENTITY_SECRET) return request();
  const token = mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, PORTAL_IDENTITY_SECRET);
  return portalTokenStore.run(token, request);
}

async function followImRunProgress(
  user: string,
  provider: ImProviderId,
  target: string,
  runId: string,
  progressAllowed = true,
  canceled: () => boolean = () => false,
  finalizing: () => boolean = () => false,
  progressState?: StoredImRunProgress,
): Promise<void> {
  let sentInitial = progressState?.sentInitial ?? false;
  let sentActivity = progressState?.sentActivity ?? 0;
  let partialLength = progressState?.partialLength ?? 0;
  let partialHash = progressState?.partialHash ?? "";
  let lastPartialAt = 0;
  let lastProgressId = progressState?.lastProgressId ?? "";
  let failures = 0;
  if (provider === "wechat") await sleep(100);
  for (;;) {
    if (canceled()) return;
    if (progressState && !ownsImBridge(user, provider, progressState.resourceId)) throw new ImProgressLeaseLostError();
    try {
      const response = await fetchImRun(user, runId);
      if (canceled()) return;
      if (progressState && !ownsImBridge(user, provider, progressState.resourceId))
        throw new ImProgressLeaseLostError();
      if (response.status === 404) {
        if (progressState) await removeStoredImRunProgress(user, provider, runId);
        return;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(`core run failed (${response.status})`);
      const snapshot = JSON.parse(response.text) as ImRunSnapshot;
      if (!snapshot.status || !["pending", "running", "done", "failed"].includes(snapshot.status)) return;
      const terminal = snapshot.status === "done" || snapshot.status === "failed";
      const activity = Array.isArray(snapshot.activity) ? snapshot.activity : [];
      if (terminal) {
        if (progressState) {
          progressState.terminal = true;
          await saveStoredImRunProgress(user, progressState);
        }
        return;
      }
      const runtime = provider === "wechat" ? undefined : imSdkRuntimes.get(imRuntimeKey(user, provider));
      if (!progressAllowed) {
        sentActivity = activity.length;
      } else {
        let streamed = false;
        const progress = formatImRunProgress(snapshot);
        const progressId = imProgressMessageId(user, provider, runId, progress.text);
        if (runtime?.progress) {
          const partial = typeof snapshot.partial === "string" ? snapshot.partial : "";
          const nextCursor: ImRunProgressCursor = {
            sentInitial: true,
            sentActivity: activity.length,
            partialLength: partial.length,
            partialHash: imProgressTextHash(partial),
            lastProgressId: progressId,
          };
          streamed = progressId === lastProgressId;
          if (!streamed && !canceled()) {
            const claim = progressState
              ? await claimStoredImProgressMessage(user, progressState, progressId)
              : "claimed";
            if (claim === "sent") streamed = true;
            else if (claim === "busy") {
              await sleep(IM_RUN_PROGRESS_POLL_MS);
              continue;
            } else {
              if (progressState && !ownsImBridge(user, provider, progressState.resourceId)) {
                await releaseStoredImProgressMessage(user, progressState, progressId);
                throw new ImProgressLeaseLostError();
              }
              try {
                streamed = await runtime.progress(target, progress.text, progress.activityText, runId);
              } catch (error) {
                if (progressState) await releaseStoredImProgressMessage(user, progressState, progressId);
                throw error;
              }
              if (streamed && progressState)
                await commitStoredImProgressMessage(user, progressState, progressId, nextCursor);
              if (!streamed && progressState) await releaseStoredImProgressMessage(user, progressState, progressId);
            }
          }
          if (streamed) {
            if (progressState) Object.assign(progressState, nextCursor);
            lastProgressId = progressId;
            sentInitial = true;
            sentActivity = activity.length;
            partialLength = partial.length;
            partialHash = imProgressTextHash(partial);
            if (progressState)
              await persistImRunProgressCursor(user, progressState, {
                sentInitial,
                sentActivity,
                partialLength,
                partialHash,
                lastProgressId,
              });
          }
        }
        if (!streamed && !canceled()) {
          const updates: string[] = [];
          if (!sentInitial && !terminal) updates.push("正在思考...");
          const activityText = activity
            .slice(sentActivity)
            .map(imProgressActivityText)
            .filter((value): value is string => Boolean(value))
            .join("\n\n");
          if (activityText) updates.push(activityText);
          const partial = typeof snapshot.partial === "string" ? snapshot.partial : "";
          const currentPartialHash = imProgressTextHash(partial);
          const partialChanged = partial && (partial.length !== partialLength || currentPartialHash !== partialHash);
          const partialDue = terminal || Date.now() - lastPartialAt >= IM_PARTIAL_PROGRESS_MS;
          if (partialChanged && partialDue) {
            const prefixMatches =
              partial.length >= partialLength && imProgressTextHash(partial.slice(0, partialLength)) === partialHash;
            const delta = prefixMatches ? partial.slice(partialLength) : partial;
            if (delta) updates.push(`回复中\n${delta}`);
          }
          if (progressState && !ownsImBridge(user, provider, progressState.resourceId))
            throw new ImProgressLeaseLostError();
          const nextCursor: ImRunProgressCursor = {
            sentInitial: true,
            sentActivity: activity.length,
            partialLength: partialChanged && partialDue ? partial.length : partialLength,
            partialHash: partialChanged && partialDue ? currentPartialHash : partialHash,
            lastProgressId,
          };
          if (updates.length) {
            const delivered = await sendImProgress(
              user,
              provider,
              target,
              runId,
              updates.join("\n\n"),
              progressState,
              nextCursor,
            );
            if (!delivered) {
              await sleep(IM_RUN_PROGRESS_POLL_MS);
              continue;
            }
          }
          sentInitial = nextCursor.sentInitial ?? false;
          sentActivity = nextCursor.sentActivity ?? 0;
          partialLength = nextCursor.partialLength ?? 0;
          partialHash = nextCursor.partialHash ?? "";
          if (partialChanged && partialDue) {
            lastPartialAt = Date.now();
          }
          if (progressState)
            await persistImRunProgressCursor(user, progressState, {
              sentInitial,
              sentActivity,
              partialLength,
              partialHash,
              lastProgressId,
            });
        }
      }
      failures = 0;
      await sleep(IM_RUN_PROGRESS_POLL_MS);
    } catch (error) {
      failures += 1;
      if (finalizing() || failures >= 5) throw error;
      await sleep(Math.min(5_000, 500 * 2 ** (failures - 1)));
    }
  }
}

async function imFinalDeliveryText(
  user: string,
  provider: ImProviderId,
  runId: string,
  text: string,
  sentActivity: number,
): Promise<{ text: string; activityIncluded: boolean }> {
  try {
    const response = await fetchImRun(user, runId, IM_RUN_FINAL_REQUEST_TIMEOUT_MS);
    if (response.status !== 200) return { text, activityIncluded: false };
    const snapshot = JSON.parse(response.text) as ImRunSnapshot;
    const activity = Array.isArray(snapshot.activity) ? snapshot.activity : [];
    const activityText = activity
      .slice(provider === "work-wechat" ? 0 : sentActivity)
      .map(imProgressActivityText)
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const activityLimit = provider === "work-wechat" ? 8_000 : 12_000;
    const replyLimit = provider === "work-wechat" ? 12_000 : 27_000;
    const finalActivity = truncateUtf8(activityText, activityLimit, "\n\n[较早进度已截断]");
    const finalReply = truncateUtf8(text, replyLimit, "\n\n[最终回复已截断]");
    return {
      text: [finalActivity, finalReply ? `回复\n${finalReply}` : ""].filter(Boolean).join("\n\n") || text,
      activityIncluded: true,
    };
  } catch {
    return { text, activityIncluded: false };
  }
}

function launchImRunProgress(user: string, progress: StoredImRunProgress, persist: boolean): void {
  const { provider, target, runId, progressAllowed } = progress;
  const key = imRunProgressKey(user, provider, runId);
  if (imRunProgressFollowers.has(key)) return;
  const follower: ImRunProgressFollower = { promise: Promise.resolve(), canceled: false, finalizing: false };
  follower.promise = (persist ? saveStoredImRunProgress(user, progress) : Promise.resolve())
    .then(() =>
      followImRunProgress(
        user,
        provider,
        target,
        runId,
        progressAllowed,
        () => follower.canceled,
        () => follower.finalizing,
        progress,
      ),
    )
    .catch((error: unknown) => console.error(`[web-ui] ${provider} progress failed:`, String(error)));
  imRunProgressFollowers.set(key, follower);
  void follower.promise.finally(() => {
    if (imRunProgressFollowers.get(key) === follower) imRunProgressFollowers.delete(key);
    void drainImDeliveriesAfterProgress().catch((error: unknown) =>
      console.error("[web-ui] IM delivery after progress failed:", String(error)),
    );
  });
}

function startImRunProgress(
  user: string,
  provider: ImProviderId,
  resourceId: string,
  target: string,
  runId: string,
  messageId?: string,
  progressAllowed = true,
): void {
  launchImRunProgress(
    user,
    {
      provider,
      resourceId,
      target,
      runId,
      ...(messageId ? { messageId } : {}),
      progressAllowed,
      createdAt: Date.now(),
    },
    true,
  );
}

interface ImConversationTarget {
  externalUserId: string;
  externalChatId: string;
  externalDisplayName: string;
  externalTenantId?: string;
  externalTenantName?: string;
  replyWebhook?: string;
  direct?: boolean;
}

async function rememberImConversation(
  user: string,
  provider: Exclude<ImProviderId, "wechat">,
  input: ImConversationTarget,
): Promise<{ binding: ImBindingRecord; resource: ImResourceRecord } | undefined> {
  const state = await readImBindings(user);
  const binding = state.bindings[provider];
  const resource = state.resources[provider];
  if (binding?.status !== "connected" || !resource || !readImSdkSecret(resource)) return undefined;
  void persistImConversation(user, provider, input).catch((error: unknown) =>
    console.error(`[web-ui] ${provider} conversation target update failed:`, String(error)),
  );
  return { binding, resource };
}

function persistImConversation(
  user: string,
  provider: Exclude<ImProviderId, "wechat">,
  input: ImConversationTarget,
): Promise<void> {
  return queueImConversationUpdate(imRuntimeKey(user, provider), async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = await readImBindings(user);
      const binding = state.bindings[provider];
      const resource = state.resources[provider];
      const secret = readImSdkSecret(resource);
      if (binding?.status !== "connected" || !resource || !secret) return;
      let changed = false;
      const directOwner = !resource.externalUserId || resource.externalUserId === input.externalUserId;
      if (input.externalTenantId && resource.externalTenantId !== input.externalTenantId) {
        const now = Date.now();
        resource.externalTenantId = input.externalTenantId;
        binding.externalTenantId = input.externalTenantId;
        resource.updatedAt = now;
        binding.updatedAt = now;
        changed = true;
      }
      if (input.externalTenantName && resource.externalTenantName !== input.externalTenantName) {
        const now = Date.now();
        resource.externalTenantName = input.externalTenantName;
        binding.externalTenantName = input.externalTenantName;
        resource.updatedAt = now;
        binding.updatedAt = now;
        changed = true;
      }
      if (input.direct && directOwner) {
        const externalUserId = resource.externalUserId ?? input.externalUserId;
        if (
          resource.externalUserId !== externalUserId ||
          resource.externalChatId !== input.externalChatId ||
          resource.externalDisplayName !== input.externalDisplayName ||
          (input.externalTenantId && resource.externalTenantId !== input.externalTenantId) ||
          (input.externalTenantName && resource.externalTenantName !== input.externalTenantName)
        ) {
          const now = Date.now();
          resource.externalUserId = externalUserId;
          resource.externalChatId = input.externalChatId;
          resource.externalDisplayName = input.externalDisplayName;
          if (input.externalTenantId) resource.externalTenantId = input.externalTenantId;
          if (input.externalTenantName) resource.externalTenantName = input.externalTenantName;
          resource.updatedAt = now;
          binding.externalUserId = externalUserId;
          binding.externalChatId = input.externalChatId;
          binding.externalDisplayName = input.externalDisplayName;
          if (input.externalTenantId) binding.externalTenantId = input.externalTenantId;
          if (input.externalTenantName) binding.externalTenantName = input.externalTenantName;
          binding.updatedAt = now;
          changed = true;
        }
      }
      if (
        provider === "dingtalk" &&
        input.replyWebhook &&
        secret.replyTargets?.[input.externalChatId] !== input.replyWebhook
      ) {
        secret.replyTargets = { ...secret.replyTargets, [input.externalChatId]: input.replyWebhook };
        resource.encryptedSecret = encryptImSecret(secret);
        resource.updatedAt = Date.now();
        changed = true;
      }
      if (!changed) return;
      try {
        await writeImBindings(user, state);
        return;
      } catch (error) {
        if (!(error instanceof Error && error.message === "ui-state write conflict") || attempt === 2) throw error;
      }
    }
  });
}

async function postImSdkMessageNow(
  user: string,
  provider: Exclude<ImProviderId, "wechat">,
  input: {
    externalUserId: string;
    externalChatId: string;
    externalDisplayName: string;
    externalTenantId?: string;
    externalTenantName?: string;
    text: string;
    messageId?: string;
    replyWebhook?: string;
    deliveryEditRef?: string;
    direct?: boolean;
  },
): Promise<{ runId?: string; reply?: string; replayed?: true }> {
  const remembered = await rememberImConversation(user, provider, input);
  if (!remembered) return {};
  const { binding, resource } = remembered;
  const { turn } = imTurn(provider, { user, binding }, input);
  const posted = await coreFetch("POST", "/v1/turns?async=1", JSON.stringify(turn), IM_SDK_CONNECT_TIMEOUT_MS);
  if (posted.status < 200 || posted.status >= 300) throw new Error(`core turn failed (${posted.status})`);
  let body: { runId?: unknown; status?: unknown; reply?: unknown; reason?: unknown };
  try {
    body = JSON.parse(posted.text) as typeof body;
  } catch {
    return {};
  }
  const runId = typeof body.runId === "string" ? body.runId : undefined;
  const active = body.status === "queued" || body.status === "pending" || body.status === "running";
  if (runId && (posted.status !== 200 || active))
    startImRunProgress(user, provider, resource.resourceId, input.externalChatId, runId, input.messageId);
  if (posted.status === 200 && runId) return { runId, replayed: true };
  if (body.status === "queued") return runId ? { runId } : {};
  let reply = "消息已处理。";
  if (typeof body.reply === "string" && body.reply) reply = body.reply;
  else if (body.status === "failed" && typeof body.reason === "string")
    reply = `⚠️ I couldn't finish that turn: ${body.reason}`;
  return { ...(runId ? { runId } : {}), reply };
}

function postImSdkMessage(
  user: string,
  provider: Exclude<ImProviderId, "wechat">,
  input: {
    externalUserId: string;
    externalChatId: string;
    externalDisplayName: string;
    externalTenantId?: string;
    externalTenantName?: string;
    text: string;
    messageId?: string;
    replyWebhook?: string;
    deliveryEditRef?: string;
    direct?: boolean;
  },
): Promise<{ runId?: string; reply?: string; replayed?: true }> {
  return queueImSdkMessage(imRuntimeKey(user, provider), () => postImSdkMessageNow(user, provider, input));
}

function larkText(data: unknown): {
  externalUserId: string;
  externalChatId: string;
  externalDisplayName: string;
  externalTenantId?: string;
  externalTenantName?: string;
  text: string;
  messageId?: string;
  direct?: boolean;
} | null {
  if (typeof data !== "object" || data === null) return null;
  const event = data as {
    sender?: { sender_id?: { open_id?: unknown } };
    message?: {
      message_id?: unknown;
      chat_id?: unknown;
      chat_type?: unknown;
      message_type?: unknown;
      content?: unknown;
    };
  };
  const externalUserId = typeof event.sender?.sender_id?.open_id === "string" ? event.sender.sender_id.open_id : "";
  const externalChatId = typeof event.message?.chat_id === "string" ? event.message.chat_id : "";
  if (!externalUserId || !externalChatId || event.message?.message_type !== "text") return null;
  let text = "";
  try {
    const content = JSON.parse(typeof event.message.content === "string" ? event.message.content : "{}") as {
      text?: unknown;
    };
    if (typeof content.text === "string") text = content.text.trim().slice(0, 40_000);
  } catch {
    return null;
  }
  if (!text) return null;
  return {
    externalUserId,
    externalChatId,
    externalDisplayName: externalUserId,
    text,
    direct: event.message.chat_type === "p2p",
    ...(typeof event.message.message_id === "string" ? { messageId: event.message.message_id } : {}),
  };
}

async function startImSdkResource(user: string, resource: ImResourceRecord): Promise<void> {
  if (resource.provider === "wechat") return;
  const key = imRuntimeKey(user, resource.provider);
  const current = imSdkRuntimes.get(key);
  const secret = readImSdkSecret(resource);
  if (!secret) throw new Error("平台 Bot 凭据缺失，请重新绑定");
  const fingerprint = imSdkFingerprint(secret);
  if (current?.resourceId === resource.resourceId && current.fingerprint === fingerprint) return;
  const credentials = secret.credentials;
  let runtime: ImSdkRuntime;
  if (resource.provider === "feishu") {
    const appId = credentials.appId;
    const appSecret = credentials.appSecret;
    if (!appId || !appSecret) throw new Error("App ID 和 App Secret 不能为空");
    const client = new Lark.Client({ appId, appSecret });
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data: unknown) => {
        if (!ownsImBridge(user, resource.provider, resource.resourceId)) return;
        const message = larkText(data);
        if (message) await postImSdkMessage(user, "feishu", message);
      },
    });
    let wsClient: Lark.WSClient | undefined;
    await waitForImConnection((resolve, reject) => {
      wsClient = new Lark.WSClient({
        appId,
        appSecret,
        autoReconnect: true,
        handshakeTimeoutMs: IM_SDK_CONNECT_TIMEOUT_MS,
        onReady: resolve,
        onError: reject,
      });
      void wsClient.start({ eventDispatcher: dispatcher }).catch(reject);
    }).catch((error) => {
      wsClient?.close({ force: true });
      throw error;
    });
    runtime = {
      resourceId: resource.resourceId,
      fingerprint,
      stop: () => wsClient?.close({ force: true }),
      send: async (target, text, idempotencyKey) => {
        const response = await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: target,
            content: JSON.stringify({ text }),
            msg_type: "text",
            ...(idempotencyKey ? { uuid: idempotencyKey } : {}),
          },
        });
        if (typeof response.code === "number" && response.code !== 0)
          throw new Error(response.msg || `飞书发送失败 (${response.code})`);
      },
    };
  } else if (resource.provider === "qq") {
    const appId = credentials.appId;
    const appSecret = credentials.appSecret;
    if (!appId || !appSecret) throw new Error("AppID 和 AppSecret 不能为空");
    const bot = new QQBot({ appId, appSecret, accountId: resource.resourceId, tokenPrefetch: "sync" });
    bot.on("message", (_context, message: QQBotInboundMessage) => {
      if (!ownsImBridge(user, resource.provider, resource.resourceId)) return;
      const text = message.content.trim().slice(0, 40_000);
      if (!text || (message.kind !== "c2c" && message.kind !== "group")) return;
      void postImSdkMessage(user, "qq", {
        externalUserId: message.senderId,
        externalChatId: `${message.replyTarget.scope}|${message.replyTarget.targetId}`,
        externalDisplayName: message.senderName || message.senderId,
        text,
        messageId: message.messageId,
        direct: message.kind === "c2c",
      }).catch((error: unknown) => console.error("[web-ui] QQ message failed:", String(error)));
    });
    await waitForImConnection((resolve, reject) => {
      bot.on("ready", resolve);
      bot.on("error", reject);
      void bot.start().catch(reject);
    }).catch((error) => {
      bot.stop();
      throw error;
    });
    runtime = {
      resourceId: resource.resourceId,
      fingerprint,
      stop: () => bot.stop(),
      send: async (target, text) => {
        const separator = target.indexOf("|");
        const scope = target.slice(0, separator);
        const targetId = target.slice(separator + 1);
        if ((scope !== "c2c" && scope !== "group") || !targetId) throw new Error("QQ 消息目标无效");
        await bot.sendText({ scope, targetId } satisfies ReplyTarget, text);
      },
    };
  } else if (resource.provider === "work-wechat") {
    const botId = credentials.botId;
    const botSecret = credentials.secret;
    if (!botId || !botSecret) throw new Error("Bot ID 和 Secret 不能为空");
    const client = new WeComWSClient({
      botId,
      secret: botSecret,
      requestTimeout: IM_SDK_CONNECT_TIMEOUT_MS,
      maxAuthFailureAttempts: 1,
      maxReconnectAttempts: -1,
    });
    type PendingReply = {
      frame: WsFrameHeaders;
      streamId: string;
      expiresAt: number;
      runId?: string;
      progressText?: string;
      activityText?: string;
    };
    const pendingRepliesByRun = new Map<string, PendingReply>();
    const completedMessageIds = new LRUCache<string, true>({ max: 10_000, ttl: 10 * 60_000 });
    const inFlightMessageIds = new Set<string>();
    const inFlightWelcomeIds = new Set<string>();
    const retryMessageFrames = new Map<string, WsFrame<WeComTextMessage>>();
    const sentDeliveryKeys = new LRUCache<string, true>({ max: 100_000 });
    const pendingRunMappings = new Set<Promise<void>>();
    const removePendingReply = (pending: PendingReply): void => {
      if (pending.runId) pendingRepliesByRun.delete(pending.runId);
    };
    const pendingReplyForRun = async (runId: string): Promise<PendingReply | undefined> => {
      let pending = pendingRepliesByRun.get(runId);
      while (!pending && pendingRunMappings.size) {
        await Promise.race(pendingRunMappings);
        pending = pendingRepliesByRun.get(runId);
      }
      if (pending && pending.expiresAt <= Date.now()) {
        removePendingReply(pending);
        return undefined;
      }
      return pending;
    };
    const handleWeComText = (frame: WsFrame<WeComTextMessage>): void => {
      if (!ownsImBridge(user, resource.provider, resource.resourceId)) return;
      const body = frame.body;
      if (!body) return;
      if (completedMessageIds.has(body.msgid)) return;
      const tenant = weComTenantInfo(body.from as unknown as Record<string, unknown>);
      const text = body.text.content.trim().slice(0, 40_000);
      if (!text) return;
      if (inFlightMessageIds.has(body.msgid)) {
        retryMessageFrames.set(body.msgid, frame);
        return;
      }
      inFlightMessageIds.add(body.msgid);
      const target = body.chatid || body.from.userid;
      const streamId = `qm-${randomUUID()}`;
      let finishRunMapping!: () => void;
      const runMapping = new Promise<void>((resolve) => {
        finishRunMapping = resolve;
      });
      pendingRunMappings.add(runMapping);
      void (async () => {
        const pending: PendingReply = {
          frame: { headers: frame.headers },
          streamId,
          expiresAt: Date.now() + 5 * 60_000,
        };
        const posted = await postImSdkMessage(user, "work-wechat", {
          externalUserId: body.from.userid,
          externalChatId: target,
          externalDisplayName: body.from.userid,
          ...tenant,
          text,
          messageId: body.msgid,
          direct: body.chattype === "single",
          deliveryEditRef: JSON.stringify({
            kind: "wecom-stream",
            reqId: frame.headers.req_id,
            streamId,
            expiresAt: pending.expiresAt,
          }),
        });
        if (posted.replayed) return;
        if (posted.runId && !posted.reply) {
          await client.replyStream(frame, streamId, "正在思考...", false);
          pending.runId = posted.runId;
          pending.progressText = "正在思考...";
          pendingRepliesByRun.set(posted.runId, pending);
        } else if (posted.reply) {
          await client.replyStream(
            pending.frame,
            pending.streamId,
            truncateUtf8(posted.reply, 20_480, "\n\n[企业微信单条回复上限，内容已截断]"),
            true,
          );
        }
      })()
        .then(() => completedMessageIds.set(body.msgid, true))
        .catch((error: unknown) => {
          console.error("[web-ui] WeCom message failed:", String(error));
        })
        .finally(() => {
          finishRunMapping();
          pendingRunMappings.delete(runMapping);
          inFlightMessageIds.delete(body.msgid);
          const retry = retryMessageFrames.get(body.msgid);
          retryMessageFrames.delete(body.msgid);
          if (retry && !completedMessageIds.has(body.msgid)) handleWeComText(retry);
        });
    };
    const handleWeComEnter = (frame: WsFrame<WeComEventMessage>): void => {
      if (!ownsImBridge(user, resource.provider, resource.resourceId)) return;
      const body = frame.body;
      if (
        !body ||
        body.chattype === "group" ||
        completedMessageIds.has(body.msgid) ||
        inFlightWelcomeIds.has(body.msgid)
      )
        return;
      inFlightWelcomeIds.add(body.msgid);
      const tenant = weComTenantInfo(body.from as unknown as Record<string, unknown>);
      const welcome = client.replyWelcome(frame, {
        msgtype: "text",
        text: {
          content: imLocatorMessage("work-wechat", resource.botName),
        },
      });
      void persistImConversation(user, "work-wechat", {
        externalUserId: body.from.userid,
        externalChatId: body.from.userid,
        externalDisplayName: body.from.userid,
        ...tenant,
        direct: true,
      }).catch((error: unknown) => console.error("[web-ui] WeCom target persistence failed:", String(error)));
      void welcome
        .then(() => completedMessageIds.set(body.msgid, true))
        .catch((error: unknown) => console.error("[web-ui] WeCom welcome failed:", String(error)))
        .finally(() => inFlightWelcomeIds.delete(body.msgid));
    };
    client.on("message.text", handleWeComText);
    client.on("event.enter_chat", handleWeComEnter);
    await waitForImConnection((resolve, reject) => {
      client.on("authenticated", resolve);
      client.on("error", reject);
      client.connect();
    }).catch((error) => {
      client.disconnect();
      throw error;
    });
    runtime = {
      resourceId: resource.resourceId,
      fingerprint,
      stop: () => {
        pendingRepliesByRun.clear();
        completedMessageIds.clear();
        inFlightMessageIds.clear();
        inFlightWelcomeIds.clear();
        retryMessageFrames.clear();
        sentDeliveryKeys.clear();
        client.disconnect();
      },
      progress: async (_target, text, activityText, runId) => {
        const pending = await pendingReplyForRun(runId);
        if (!pending) return false;
        const content = truncateUtf8(text, 20_480, "\n\n[企业微信单条回复上限，进度已截断]");
        if (pending.progressText === content) return true;
        await client.replyStreamNonBlocking(pending.frame, pending.streamId, content, false);
        pending.progressText = content;
        pending.activityText = activityText;
        return true;
      },
      send: async (target, text, idempotencyKey, editRef, activityIncluded = false) => {
        if (idempotencyKey && sentDeliveryKeys.has(idempotencyKey)) return;
        const runId = idempotencyKey?.startsWith("run:") ? idempotencyKey.slice("run:".length) : undefined;
        const pending = runId ? await pendingReplyForRun(runId) : undefined;
        const finalText = truncateUtf8(
          text,
          pending?.activityText && !activityIncluded ? 12_000 : 20_480,
          "\n\n[企业微信单条回复上限，内容已截断]",
        );
        const content =
          pending?.activityText && !activityIncluded
            ? `${truncateUtf8(pending.activityText, 8_000, "\n\n[较早进度已截断]")}\n\n回复\n${finalText}`
            : finalText;
        let frame = pending?.frame;
        let streamId = pending?.streamId;
        if (!frame && editRef) {
          try {
            const stored = JSON.parse(editRef) as {
              kind?: unknown;
              reqId?: unknown;
              streamId?: unknown;
              expiresAt?: unknown;
            };
            if (
              stored.kind === "wecom-stream" &&
              typeof stored.reqId === "string" &&
              typeof stored.streamId === "string" &&
              typeof stored.expiresAt === "number" &&
              stored.expiresAt > Date.now()
            ) {
              frame = { headers: { req_id: stored.reqId } };
              streamId = stored.streamId;
            }
          } catch {
            frame = undefined;
          }
        }
        if (frame && streamId) {
          await client.replyStream(frame, streamId, content, true);
          if (pending) removePendingReply(pending);
          if (idempotencyKey) {
            sentDeliveryKeys.set(idempotencyKey, true);
            const acked = await coreFetch(
              "POST",
              "/v1/deliveries/ack-by-key",
              JSON.stringify({ idempotencyKey }),
              IM_SDK_CONNECT_TIMEOUT_MS,
            );
            if (acked.status !== 200) throw new Error(`core delivery ack failed (${acked.status})`);
          }
          return;
        }
        await client.sendMessage(target, { msgtype: "markdown", markdown: { content } });
        if (idempotencyKey) sentDeliveryKeys.set(idempotencyKey, true);
      },
    };
  } else {
    const clientId = credentials.clientId;
    const clientSecret = credentials.clientSecret;
    if (!clientId || !clientSecret) throw new Error("ClientID 和 ClientSecret 不能为空");
    const client = new DingTalkStreamClient({ clientId, clientSecret, keepAlive: true });
    let accessToken = "";
    client.registerCallbackListener(DingTalkStream.TOPIC_ROBOT, (frame) => {
      void (async () => {
        try {
          if (!ownsImBridge(user, resource.provider, resource.resourceId)) return;
          const message = JSON.parse(frame.data) as DingTalkStreamMessage;
          const content = message.text?.content?.trim();
          if (message.msgtype !== "text" || !content) return;
          await postImSdkMessage(user, "dingtalk", {
            externalUserId: message.senderStaffId || message.senderId,
            externalChatId: message.conversationId,
            externalDisplayName: message.senderNick || message.senderStaffId || message.senderId,
            text: content.slice(0, 40_000),
            messageId: message.msgId,
            replyWebhook: message.sessionWebhook,
            direct: message.conversationType === "1",
          });
        } finally {
          client.socketCallBackResponse(frame.headers.messageId, {});
        }
      })().catch((error: unknown) => console.error("[web-ui] DingTalk message failed:", String(error)));
    });
    await waitForImConnection((_resolve, reject) => {
      void (async () => {
        accessToken = String(await client.getAccessToken());
        await client.connect();
        if (!client.connected) throw new Error("钉钉 Stream 连接失败");
        _resolve();
      })().catch(reject);
    }).catch((error) => {
      client.disconnect();
      throw error;
    });
    runtime = {
      resourceId: resource.resourceId,
      fingerprint,
      stop: () => client.disconnect(),
      send: async (target, text) => {
        const latest = await readImBindings(user);
        const webhook = readImSdkSecret(latest.resources.dingtalk)?.replyTargets?.[target];
        if (!webhook) throw new Error("钉钉会话已失效，请先从钉钉向 Bot 发送一条消息");
        const response = await fetch(webhook, {
          method: "POST",
          headers: { "content-type": "application/json", "x-acs-dingtalk-access-token": accessToken },
          body: JSON.stringify({ msgtype: "text", text: { content: text } }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) throw new Error(`钉钉发送失败 (${response.status})`);
      },
    };
  }
  current?.stop();
  imSdkRuntimes.set(key, runtime);
}

async function activateImSdkResource(user: string, resource: ImResourceRecord): Promise<void> {
  const key = imRuntimeKey(user, resource.provider);
  const current = imSdkActivations.get(key);
  if (current) {
    await current;
    return activateImSdkResource(user, resource);
  }
  const secret = readImSdkSecret(resource);
  const runtime = imSdkRuntimes.get(key);
  if (secret && runtime?.resourceId === resource.resourceId && runtime.fingerprint === imSdkFingerprint(secret)) return;
  const activation = startImSdkResource(user, resource);
  imSdkActivations.set(key, activation);
  try {
    await activation;
  } finally {
    if (imSdkActivations.get(key) === activation) imSdkActivations.delete(key);
  }
}

interface ImLocatorTarget {
  target: string;
}

interface DingTalkStreamFrame {
  data: string;
  headers: { messageId: string };
}

interface DingTalkStreamMessage {
  conversationId: string;
  conversationType?: string;
  msgId: string;
  msgtype: string;
  senderId: string;
  senderNick?: string;
  senderStaffId?: string;
  sessionWebhook?: string;
  text?: { content?: string };
}

interface DingTalkStreamRuntimeClient {
  connected: boolean;
  connect(): Promise<void>;
  disconnect(): void;
  getAccessToken(): Promise<string> | string;
  registerCallbackListener(eventId: string, callback: (frame: DingTalkStreamFrame) => void): unknown;
  socketCallBackResponse(messageId: string, response: Record<string, never>): void;
}

const dingtalkStreamClientExport = ["D", "W", "Client"].join("");
const DingTalkStreamClient = DingTalkStream[
  dingtalkStreamClientExport as keyof typeof DingTalkStream
] as new (options: { clientId: string; clientSecret: string; keepAlive: boolean }) => DingTalkStreamRuntimeClient;

interface ImLocatorResult {
  label: string;
  queued: boolean;
}

function imLocatorTarget(provider: ImProviderId, resource: ImResourceRecord): ImLocatorTarget | null {
  return resource.externalChatId ? { target: resource.externalChatId } : null;
}

async function sendImLocatorNow(
  user: string,
  provider: ImProviderId,
  resource: ImResourceRecord,
  locator: ImLocatorTarget,
  text: string,
): Promise<boolean> {
  if (provider === "wechat") return false;
  const runtime = imSdkRuntimes.get(imRuntimeKey(user, provider));
  if (!runtime || runtime.resourceId !== resource.resourceId) return false;
  await runtime.send(locator.target, text);
  return true;
}

async function locateImBot(user: string, provider: ImProviderId): Promise<ImLocatorResult> {
  const state = await readImBindings(user);
  const binding = state.bindings[provider];
  const resource = state.resources[provider];
  if (binding?.status !== "connected" || !resource)
    throw new ImBotTargetUnavailableError(`${imProviderMeta(provider).label}机器人尚未完成绑定`);
  if (!imLocatorAvailable(binding, resource))
    throw new ImBotTargetUnavailableError(imLocatorUnavailableReason(binding, resource));
  const message = imLocatorMessage(provider, binding.botName);
  const locator = imLocatorTarget(provider, resource);
  if (!locator)
    throw new ImBotTargetUnavailableError(
      `${imProviderMeta(provider).label}没有返回扫码人的会话标识，请先在 IM 中打开机器人并发送一条消息`,
    );
  const label = imProviderMeta(provider).label;
  if (await sendImLocatorNow(user, provider, resource, locator, message)) return { label, queued: false };
  const routePrefix = imRoutePrefix(provider, user, binding);
  const queued = await coreFetch(
    "POST",
    "/v1/deliveries",
    JSON.stringify({
      destination: {
        type: `im:${provider}`,
        target: `${routePrefix}${locator.target}`,
      },
      text: message,
      idempotencyKey: `im-locate:${provider}:${randomUUID()}`,
    }),
  );
  if (queued.status !== 202) throw new Error(`定位消息入队失败 (${queued.status})`);
  void drainImDeliveries().catch((error: unknown) =>
    console.error(`[web-ui] ${provider} locator delivery failed:`, String(error)),
  );
  return { label, queued: true };
}

async function saveImSdkResource(
  user: string,
  provider: Exclude<ImProviderId, "wechat">,
  credentials: Record<string, string>,
  resourceId: string,
  externalUserId?: string,
  expectedQrGenerationId?: string,
  externalTenantId?: string,
  externalTenantName?: string,
): Promise<ImBindingRecord> {
  const state = await readImBindings(user);
  const existing = state.bindings[provider];
  if (expectedQrGenerationId && existing?.qrGenerationId !== expectedQrGenerationId) throw new Error("绑定流程已取消");
  const now = Date.now();
  const resource: ImResourceRecord = {
    provider,
    resourceId: resourceId.slice(0, 256),
    botName: imProviderMeta(provider).botName,
    ...(externalUserId ? { externalUserId: externalUserId.slice(0, 256) } : {}),
    ...(externalTenantId ? { externalTenantId: externalTenantId.slice(0, 256) } : {}),
    ...(externalTenantName ? { externalTenantName: externalTenantName.slice(0, 256) } : {}),
    encryptedSecret: encryptImSecret({
      provider,
      credentials,
    } satisfies ImSdkResourceSecret),
    createdAt: state.resources[provider]?.createdAt ?? now,
    updatedAt: now,
  };
  const ownerReservation = await reserveImResourceOwner(user, provider, resource.resourceId);
  try {
    state.resources[provider] = resource;
    state.bindings[provider] = {
      ...imBindingBase(provider, existing?.createdAt ?? now),
      status: "pending",
      botName: resource.botName,
      resourceId: resource.resourceId,
      ...(resource.externalTenantId ? { externalTenantId: resource.externalTenantId } : {}),
      ...(resource.externalTenantName ? { externalTenantName: resource.externalTenantName } : {}),
      authorizationState: "waiting",
      authorizationMessage: `${imProviderMeta(provider).label}机器人凭据已获取，正在验证消息连接`,
      updatedAt: now,
    };
    await writeImBindings(user, state);
    const binding = await connectImSdkResource(user, provider);
    await commitImResourceReservation(ownerReservation);
    imQrFlows.delete(imRuntimeKey(user, provider));
    return binding;
  } catch (error) {
    await releaseImResourceReservation(ownerReservation).catch((releaseError: unknown) =>
      console.error("[web-ui] IM resource owner release failed:", String(releaseError)),
    );
    throw error;
  }
}

async function connectImSdkResource(user: string, provider: Exclude<ImProviderId, "wechat">): Promise<ImBindingRecord> {
  let state = await readImBindings(user);
  let resource = state.resources[provider];
  if (!resource || !readImSdkSecret(resource)) throw new Error("平台 Bot 凭据缺失，请重新绑定");
  await claimImResourceOwner(user, provider, resource.resourceId);
  try {
    if (await claimImBridge(user, provider, resource.resourceId)) {
      await activateImSdkResource(user, resource);
      await markImBridgeReady(user, resource);
    } else if (!(await hasReadyImBridge(user, resource))) {
      throw new Error(`${imProviderMeta(provider).label}机器人正在由其他服务实例启动，请稍后重试`);
    }
  } catch (error) {
    state = await readImBindings(user);
    const failed = state.bindings[provider];
    if (failed && state.resources[provider]?.resourceId === resource.resourceId) {
      failed.authorizationState = "error";
      failed.authorizationMessage = `${imProviderMeta(provider).label}机器人连接验证失败：${error instanceof Error ? error.message : String(error)}`;
      failed.updatedAt = Date.now();
      await writeImBindings(user, state);
    }
    throw error;
  }
  state = await readImBindings(user);
  resource = state.resources[provider];
  if (!resource) throw new Error("平台 Bot 凭据已被删除");
  const existing = state.bindings[provider];
  const binding = bindingFromResource(resource, existing);
  state.bindings[provider] = binding;
  await writeImBindings(user, state);
  return binding;
}

function imCredentials(
  provider: Exclude<ImProviderId, "wechat">,
  value: unknown,
): { credentials: Record<string, string>; resourceId: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const fields: Record<Exclude<ImProviderId, "wechat">, string[]> = {
    feishu: ["appId", "appSecret"],
    "work-wechat": ["botId", "secret"],
    qq: ["appId", "appSecret"],
    dingtalk: ["clientId", "clientSecret"],
  };
  const credentials: Record<string, string> = {};
  for (const field of fields[provider]) {
    const item = raw[field];
    if (typeof item !== "string" || !item.trim() || item.length > 512) return null;
    credentials[field] = item.trim();
  }
  return { credentials, resourceId: credentials[fields[provider][0]!]! };
}

type DirectImQrProvider = "feishu" | "qq" | "dingtalk";

interface DingtalkRegistration {
  deviceCode: string;
  verificationUrl: string;
  expiresAt: number;
  pollIntervalMs: number;
}

async function dingtalkRegistrationRequest<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, string>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${DINGTALK_REGISTRATION_BASE_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const data = (await response.json()) as T & { errcode?: unknown; errmsg?: unknown };
  if (!response.ok || data.errcode !== 0) {
    throw new Error(typeof data.errmsg === "string" ? data.errmsg : `钉钉授权接口失败 (${response.status})`);
  }
  return data;
}

async function beginDingtalkRegistration(signal: AbortSignal): Promise<DingtalkRegistration> {
  const initialized = await dingtalkRegistrationRequest<{ nonce?: unknown; expires_in?: unknown }>(
    "/app/registration/init",
    { source: DINGTALK_REGISTRATION_SOURCE },
    signal,
  );
  const nonce = typeof initialized.nonce === "string" ? initialized.nonce.trim() : "";
  if (!nonce) throw new Error("钉钉授权未返回 nonce");
  const started = await dingtalkRegistrationRequest<{
    device_code?: unknown;
    verification_uri_complete?: unknown;
    expires_in?: unknown;
    interval?: unknown;
  }>("/app/registration/begin", { nonce }, signal);
  const deviceCode = typeof started.device_code === "string" ? started.device_code.trim() : "";
  const verificationUrl =
    typeof started.verification_uri_complete === "string" ? started.verification_uri_complete.trim() : "";
  if (!deviceCode || !verificationUrl) throw new Error("钉钉授权未返回有效二维码");
  const expiresInSeconds = Number(started.expires_in ?? 7_200);
  const intervalSeconds = Number(started.interval ?? 3);
  return {
    deviceCode,
    verificationUrl,
    expiresAt:
      Date.now() + (Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 7_200) * 1_000,
    pollIntervalMs: (Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds : 3) * 1_000,
  };
}

async function pollDingtalkRegistration(
  deviceCode: string,
  signal: AbortSignal,
): Promise<{ status: string; clientId?: string; clientSecret?: string; reason?: string }> {
  const result = await dingtalkRegistrationRequest<{
    status?: unknown;
    client_id?: unknown;
    client_secret?: unknown;
    fail_reason?: unknown;
  }>("/app/registration/poll", { device_code: deviceCode }, signal);
  return {
    status: typeof result.status === "string" ? result.status.trim().toUpperCase() : "UNKNOWN",
    ...(typeof result.client_id === "string" ? { clientId: result.client_id.trim() } : {}),
    ...(typeof result.client_secret === "string" ? { clientSecret: result.client_secret.trim() } : {}),
    ...(typeof result.fail_reason === "string" ? { reason: result.fail_reason.trim() } : {}),
  };
}

async function updateImQrBinding(
  user: string,
  provider: DirectImQrProvider,
  qrGenerationId: string,
  qrPayload: string,
  message: string,
  dingtalk?: DingtalkRegistration,
): Promise<ImBindingRecord> {
  const state = await readImBindings(user);
  const binding = state.bindings[provider];
  if (!binding || binding.status !== "pending" || binding.qrGenerationId !== qrGenerationId)
    throw new Error("绑定流程已取消");
  binding.qrPayload = qrPayload;
  binding.quickSetupAvailable = true;
  binding.authorizationState = "waiting";
  binding.authorizationMessage = message;
  if (dingtalk) {
    binding.providerQrCode = dingtalk.deviceCode;
    binding.providerBaseUrl = DINGTALK_REGISTRATION_BASE_URL;
    binding.authorizationExpiresAt = dingtalk.expiresAt;
    binding.authorizationPollIntervalMs = dingtalk.pollIntervalMs;
  }
  binding.updatedAt = Date.now();
  await writeImBindings(user, state);
  return binding;
}

async function failImQrBinding(
  user: string,
  provider: DirectImQrProvider,
  qrGenerationId: string,
  error: unknown,
): Promise<void> {
  const state = await readImBindings(user);
  const binding = state.bindings[provider];
  if (!binding || binding.status !== "pending" || binding.qrGenerationId !== qrGenerationId) return;
  binding.authorizationState = "error";
  binding.authorizationMessage = error instanceof Error ? error.message : "平台授权失败，请重试";
  binding.updatedAt = Date.now();
  await writeImBindings(user, state);
  imQrFlows.delete(imRuntimeKey(user, provider));
}

function beginImQrBinding(
  user: string,
  provider: DirectImQrProvider,
  qrGenerationId: string,
): Promise<ImBindingRecord> {
  const key = imRuntimeKey(user, provider);
  imQrFlows.get(key)?.stop();
  return new Promise<ImBindingRecord>((resolve, reject) => {
    let ready = false;
    let terminal = false;
    let dispose = (): void => {};
    let leaseTimer: ReturnType<typeof setInterval> | undefined;
    const flow: ImQrFlow = {
      release: () => {
        if (leaseTimer) clearInterval(leaseTimer);
        leaseTimer = undefined;
        if (imQrFlows.get(key) === flow) imQrFlows.delete(key);
      },
      stop: () => {
        flow.release();
        dispose();
      },
    };
    const timer = setTimeout(() => {
      fail(new Error("生成平台授权二维码超时，请重试"));
      dispose();
    }, IM_SDK_CONNECT_TIMEOUT_MS);
    const fail = (error: unknown): void => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      flow.release();
      const reason = error instanceof Error ? error : new Error(String(error));
      void failImQrBinding(user, provider, qrGenerationId, reason).finally(() => {
        if (!ready) {
          ready = true;
          reject(reason);
        }
      });
    };
    const show = (url: string, message: string): void => {
      clearTimeout(timer);
      void updateImQrBinding(user, provider, qrGenerationId, url, message)
        .then((binding) => {
          if (!ready) {
            ready = true;
            resolve(binding);
          }
        })
        .catch(fail);
    };
    const complete = (credentials: Record<string, string>, resourceId: string, externalUserId?: string): void => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      void saveImSdkResource(user, provider, credentials, resourceId, externalUserId, qrGenerationId)
        .catch((error) => failImQrBinding(user, provider, qrGenerationId, error))
        .finally(() => flow.release());
    };
    if (provider === "feishu") {
      const controller = new AbortController();
      dispose = () => controller.abort();
      imQrFlows.set(key, flow);
      void Lark.registerApp({
        signal: controller.signal,
        createOnly: false,
        source: "qm",
        appPreset: { name: "{user} 的 QM 智能机器人", desc: "{user} 的专属 QM 对话机器人" },
        addons: {
          scopes: { tenant: ["im:message:send_as_bot"] },
          events: { items: { tenant: ["im.message.receive_v1"] } },
        },
        onQRCodeReady: ({ url }) => show(url, "请使用飞书扫描二维码，优先选择已有应用"),
      })
        .then((result) => {
          complete(
            { appId: result.client_id, appSecret: result.client_secret },
            result.client_id,
            result.user_info?.open_id,
          );
        })
        .catch(fail);
    } else if (provider === "qq") {
      dispose = startQrConnect(
        {
          onQrDisplayed: (url) => show(url, "请使用手机 QQ 扫描二维码，优先选择并授权已有机器人"),
          onFailure: fail,
          onSuccess: (results) => {
            const result = results[0];
            if (!result) return fail(new Error("QQ 未返回 Bot 凭据"));
            complete({ appId: result.appId, appSecret: result.appSecret }, result.appId, result.userOpenid);
          },
        },
        { displayQrCodeToConsole: false, source: "qm" },
      );
      imQrFlows.set(key, flow);
    } else {
      const controller = new AbortController();
      dispose = () => controller.abort();
      imQrFlows.set(key, flow);
      void (async () => {
        const current = (await readImBindings(user)).bindings.dingtalk;
        const reusable =
          current?.providerQrCode &&
          current.qrPayload &&
          typeof current.authorizationExpiresAt === "number" &&
          current.authorizationExpiresAt > Date.now();
        const registration: DingtalkRegistration = reusable
          ? {
              deviceCode: current.providerQrCode!,
              verificationUrl: current.qrPayload!,
              expiresAt: current.authorizationExpiresAt!,
              pollIntervalMs: current.authorizationPollIntervalMs ?? 3_000,
            }
          : await beginDingtalkRegistration(controller.signal);
        await updateImQrBinding(
          user,
          provider,
          qrGenerationId,
          registration.verificationUrl,
          "请使用钉钉扫描二维码并一键创建或绑定机器人",
          registration,
        ).then((binding) => {
          if (!ready) {
            ready = true;
            resolve(binding);
          }
        });
        while (!controller.signal.aborted && Date.now() < registration.expiresAt) {
          await sleep(registration.pollIntervalMs);
          if (controller.signal.aborted) return;
          const result = await pollDingtalkRegistration(registration.deviceCode, controller.signal);
          if (result.status === "WAITING") continue;
          if (result.status === "SUCCESS" && result.clientId && result.clientSecret) {
            complete({ clientId: result.clientId, clientSecret: result.clientSecret }, result.clientId);
            return;
          }
          if (result.status === "FAIL") throw new Error(result.reason || "钉钉授权失败");
          if (result.status === "EXPIRED") throw new Error("钉钉授权二维码已过期，请重试");
        }
        throw new Error("钉钉授权二维码已过期，请重试");
      })().catch(fail);
    }
    leaseTimer = setInterval(
      () => {
        void readImBindings(user)
          .then((state) => {
            if (state.bindings[provider]?.qrGenerationId !== qrGenerationId) return false;
            return renewImBridge(user, provider, IM_QR_LEASE_RESOURCE_ID);
          })
          .then((owned) => {
            if (!owned) flow.stop();
          })
          .catch(() => flow.stop());
      },
      Math.max(1_000, Math.floor(IM_BRIDGE_LEASE_MS / 3)),
    );
  });
}

async function createWeixinQr(state: ImBindingsState): Promise<{ qrcode: string; image: string }> {
  const tokens = Object.values(state.resources)
    .map((resource) => readWeixinSecret(resource)?.token)
    .filter((token): token is string => Boolean(token))
    .slice(0, 10);
  const response = await weixinJson<{ qrcode?: string; qrcode_img_content?: string }>(
    WEIXIN_ILINK_BASE_URL,
    `ilink/bot/get_bot_qrcode?bot_type=${WEIXIN_ILINK_BOT_TYPE}`,
    "POST",
    { local_token_list: tokens },
    undefined,
    15_000,
  );
  if (!response.qrcode?.trim() || !response.qrcode_img_content?.trim()) {
    throw new Error("微信 iLink 没有返回有效二维码");
  }
  return { qrcode: response.qrcode, image: response.qrcode_img_content };
}

async function startImBinding(user: string, provider: ImProviderId): Promise<ImBindingRecord> {
  const state = await readImBindings(user);
  const existing = state.bindings[provider];
  const directQr = provider === "feishu" || provider === "qq" || provider === "dingtalk";
  const retryable =
    existing?.status === "pending" &&
    (existing.authorizationState === "expired" ||
      existing.authorizationState === "blocked" ||
      existing.authorizationState === "unrecoverable" ||
      existing.authorizationState === "error" ||
      (directQr && !imQrFlows.has(imRuntimeKey(user, provider))));
  if (existing && !retryable) {
    return existing;
  }
  const resource = state.resources[provider];
  const reusable = resource && (provider !== "wechat" || readWeixinSecret(resource));
  if (reusable) {
    await claimImResourceOwner(user, provider, resource.resourceId);
    if (provider !== "wechat" && readImSdkSecret(resource)) return connectImSdkResource(user, provider);
    const restored = bindingFromResource(resource, existing);
    state.bindings[provider] = restored;
    await writeImBindings(user, state);
    return restored;
  }
  if (provider === "wechat") {
    const qr = await createWeixinQr(state);
    const now = Date.now();
    const record: ImBindingRecord = {
      ...imBindingBase(provider, now),
      status: "pending",
      quickSetupAvailable: true,
      qrPayload: qr.image,
      providerQrCode: qr.qrcode,
      providerBaseUrl: WEIXIN_ILINK_BASE_URL,
      authorizationState: "waiting",
      authorizationMessage: "等待微信扫码",
      updatedAt: now,
    };
    state.bindings[provider] = record;
    await writeImBindings(user, state);
    return record;
  }
  if (provider === "work-wechat") {
    const now = Date.now();
    const record: ImBindingRecord = {
      ...imBindingBase(provider, now),
      status: "pending",
      quickSetupAvailable: true,
      authorizationState: "waiting",
      authorizationMessage: "请打开企业微信扫码创建窗口",
      updatedAt: now,
    };
    state.bindings[provider] = record;
    await writeImBindings(user, state);
    return record;
  }
  if (directQr) {
    const key = imRuntimeKey(user, provider);
    if (imQrFlows.has(key)) return existing!;
    if (!(await claimImBridge(user, provider, IM_QR_LEASE_RESOURCE_ID))) {
      const current = (await readImBindings(user)).bindings[provider];
      if (current) return current;
      throw new Error("平台授权二维码正在生成，请稍后重试");
    }
    const now = Date.now();
    const qrGenerationId = randomUUID();
    const record: ImBindingRecord = {
      ...imBindingBase(provider, now),
      status: "pending",
      quickSetupAvailable: false,
      authorizationState: "waiting",
      authorizationMessage: "正在生成平台授权二维码",
      qrGenerationId,
      updatedAt: now,
    };
    state.bindings[provider] = record;
    await writeImBindings(user, state);
    return beginImQrBinding(user, provider, qrGenerationId);
  }
  throw new Error("不支持的 IM 平台");
}

async function removeImBinding(user: string, provider: ImProviderId, forgetResource = false): Promise<boolean> {
  const state = await readImBindings(user);
  const binding = state.bindings[provider];
  const resource = state.resources[provider];
  if (!binding && !(forgetResource && resource)) return false;
  const resourceId = resource?.resourceId;
  const ownerReservation =
    forgetResource && resourceId ? await reserveImResourceOwner(user, provider, resourceId, true) : undefined;
  delete state.bindings[provider];
  if (forgetResource) delete state.resources[provider];
  try {
    await writeImBindings(user, state);
  } catch (error) {
    if (ownerReservation) await releaseImResourceReservation(ownerReservation);
    throw error;
  }
  if (ownerReservation) await discardImResourceReservation(ownerReservation);
  imQrFlows.get(imRuntimeKey(user, provider))?.stop();
  imQrFlows.delete(imRuntimeKey(user, provider));
  imSdkRuntimes.get(imRuntimeKey(user, provider))?.stop();
  imSdkRuntimes.delete(imRuntimeKey(user, provider));
  if (resourceId) imBridgeLeases.delete(imBridgeKey(user, provider, resourceId));
  return true;
}

async function connectWeixinBinding(
  user: string,
  state: ImBindingsState,
  status: WeixinQrStatusResponse,
): Promise<ImBindingRecord> {
  const existing = state.bindings.wechat;
  const token = status.bot_token?.trim();
  const botId = status.ilink_bot_id?.trim();
  const userId = status.ilink_user_id?.trim();
  if (!token || !botId || !userId) throw new Error("微信授权成功，但返回的 Bot 凭据不完整");
  const now = Date.now();
  const baseUrl = weixinBaseUrl(status.baseurl || existing?.providerBaseUrl);
  const prior = state.resources.wechat;
  const priorSecret = readWeixinSecret(prior);
  const secret: WeixinResourceSecret = {
    token,
    botId,
    userId,
    baseUrl,
    ...(priorSecret?.cursor ? { cursor: priorSecret.cursor } : {}),
  };
  const resource: ImResourceRecord = {
    provider: "wechat",
    resourceId: botId.slice(0, 256),
    botName: "微信 Bot",
    externalUserId: userId.slice(0, 256),
    externalChatId: userId.slice(0, 256),
    externalDisplayName: "微信用户",
    encryptedSecret: encryptImSecret(secret),
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
  const ownerReservation = await reserveImResourceOwner(user, "wechat", resource.resourceId);
  const binding = bindingFromResource(resource, existing);
  state.resources.wechat = resource;
  state.bindings.wechat = binding;
  try {
    await writeImBindings(user, state);
    await commitImResourceReservation(ownerReservation);
  } catch (error) {
    await releaseImResourceReservation(ownerReservation).catch((releaseError: unknown) =>
      console.error("[web-ui] IM resource owner release failed:", String(releaseError)),
    );
    throw error;
  }
  return binding;
}

const weixinBindingRefreshes = new Map<string, Promise<ImBindingRecord | null>>();

async function refreshWeixinBindingNow(user: string): Promise<ImBindingRecord | null> {
  const state = await readImBindings(user);
  const binding = state.bindings.wechat;
  if (!binding || binding.status === "connected") return binding ?? null;
  if (!binding.providerQrCode || !binding.providerBaseUrl) return binding;
  if (Date.now() - (binding.createdAt ?? 0) >= WEIXIN_QR_TTL_MS) {
    binding.authorizationState = "expired";
    binding.authorizationMessage = "二维码已过期，请重新生成";
    binding.verificationRequired = false;
    binding.updatedAt = Date.now();
    await writeImBindings(user, state);
    return binding;
  }
  let status: WeixinQrStatusResponse;
  try {
    const query = new URLSearchParams({ qrcode: binding.providerQrCode });
    if (binding.verifyCode) query.set("verify_code", binding.verifyCode);
    status = await weixinJson<WeixinQrStatusResponse>(
      binding.providerBaseUrl,
      `ilink/bot/get_qrcode_status?${query.toString()}`,
      "GET",
      undefined,
      undefined,
      WEIXIN_API_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return binding;
    binding.authorizationState = "error";
    binding.authorizationMessage = "暂时无法连接微信授权服务，请重试";
    binding.updatedAt = Date.now();
    await writeImBindings(user, state);
    return binding;
  }
  const now = Date.now();
  if (status.status === "confirmed") return connectWeixinBinding(user, state, status);
  const previousBaseUrl = binding.providerBaseUrl;
  const previousAuthorizationState = binding.authorizationState;
  const previousAuthorizationMessage = binding.authorizationMessage;
  const previousVerificationRequired = binding.verificationRequired;
  const previousVerifyCode = binding.verifyCode;
  if (status.status === "binded_redirect") {
    const resource = state.resources.wechat;
    if (resource && readWeixinSecret(resource)) {
      const restored = bindingFromResource(resource, binding);
      state.bindings.wechat = restored;
      await writeImBindings(user, state);
      return restored;
    }
    binding.authorizationState = "unrecoverable";
    binding.authorizationMessage = "微信确认这个 Bot 已创建，但本平台没有可复用凭据，请联系管理员恢复原数据";
  } else if (status.status === "scaned_but_redirect") {
    binding.providerBaseUrl = weixinBaseUrl(status.redirect_host);
    binding.authorizationState = "scanned";
    binding.authorizationMessage = "已扫码，正在切换微信授权服务";
  } else if (status.status === "scaned") {
    binding.verifyCode = undefined;
    binding.authorizationState = "scanned";
    binding.authorizationMessage = "已扫码，等待手机确认";
    binding.verificationRequired = false;
  } else if (status.status === "need_verifycode") {
    binding.authorizationState = "verification-required";
    binding.authorizationMessage = binding.verifyCode ? "验证码不匹配，请重新输入" : "请输入手机微信显示的数字";
    binding.verificationRequired = true;
    binding.verifyCode = undefined;
  } else if (status.status === "verify_code_blocked") {
    binding.authorizationState = "blocked";
    binding.authorizationMessage = "验证码错误次数过多，请重新生成二维码";
    binding.verificationRequired = false;
    binding.verifyCode = undefined;
  } else if (status.status === "expired") {
    binding.authorizationState = "expired";
    binding.authorizationMessage = "二维码已过期，请重新生成";
    binding.verificationRequired = false;
  } else {
    binding.authorizationState = "waiting";
    binding.authorizationMessage = "等待微信扫码";
  }
  if (
    binding.providerBaseUrl === previousBaseUrl &&
    binding.authorizationState === previousAuthorizationState &&
    binding.authorizationMessage === previousAuthorizationMessage &&
    binding.verificationRequired === previousVerificationRequired &&
    binding.verifyCode === previousVerifyCode
  ) {
    return binding;
  }
  binding.updatedAt = now;
  await writeImBindings(user, state);
  return binding;
}

async function refreshWeixinBinding(user: string): Promise<ImBindingRecord | null> {
  const current = weixinBindingRefreshes.get(user);
  if (current) return current;
  const refresh = refreshWeixinBindingNow(user);
  weixinBindingRefreshes.set(user, refresh);
  try {
    return await refresh;
  } finally {
    if (weixinBindingRefreshes.get(user) === refresh) weixinBindingRefreshes.delete(user);
  }
}

async function verifyWeixinBinding(user: string, code: string): Promise<ImBindingRecord | null> {
  const state = await readImBindings(user);
  const binding = state.bindings.wechat;
  if (!binding || binding.status !== "pending" || !binding.verificationRequired) return null;
  if (!/^\d{1,8}$/.test(code)) return null;
  binding.verifyCode = code;
  binding.verificationRequired = false;
  binding.authorizationState = "waiting";
  binding.authorizationMessage = "正在校验验证码";
  binding.updatedAt = Date.now();
  await writeImBindings(user, state);
  return binding;
}

function ownerOfWebThread(threadRef: string): string | null {
  if (!threadRef.startsWith("web:")) return null;
  const rest = threadRef.slice("web:".length);
  const i = rest.indexOf(":");
  return i > 0 ? rest.slice(0, i) : null;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

function withSecurityHeaders(headers: Record<string, string>): Record<string, string> {
  return {
    ...headers,
    "content-security-policy": SPA_CSP,
    "strict-transport-security": "max-age=63072000; includeSubDomains",
    "referrer-policy": "no-referrer",
    "x-frame-options": "SAMEORIGIN",
    "x-content-type-options": "nosniff",
  };
}

const UNTRUSTED_CONTENT_SANDBOX_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads";

interface ViteDevServer {
  middlewares(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void;
  transformIndexHtml(url: string, html: string): Promise<string>;
}

type CreateViteServer = (opts: Record<string, unknown>) => Promise<ViteDevServer>;

function relay(res: ServerResponse, r: { status: number; text: string }): void {
  res.writeHead(r.status, { "content-type": "application/json", "x-content-type-options": "nosniff" });
  res.end(r.text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, withSecurityHeaders({ "content-type": "text/html; charset=utf-8" }));
  res.end(html);
}

const SSE_CORE_POLL_MS = 100;
const SSE_STALE_POLL_MS = 1_000;
const SSE_IDLE_MS = 6 * 60_000;
const SSE_STALE_GRACE_MS = 10 * 60_000;
const SSE_HEARTBEAT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });
}

function sseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function mayManageDeployment(d: { permission?: unknown }): boolean {
  return d.permission === "write";
}

async function gateManageDeployment(res: ServerResponse, user: string, id: string): Promise<boolean> {
  const r = await coreFetch("GET", `/v1/deployments?principalId=${encodeURIComponent(user)}`);
  if (r.status !== 200) {
    relay(res, r);
    return false;
  }
  let list: Array<Record<string, unknown>>;
  try {
    list = (JSON.parse(r.text) as { deployments?: Array<Record<string, unknown>> }).deployments ?? [];
  } catch {
    json(res, 502, { error: "bad_core_response" });
    return false;
  }
  const d = list.find((x) => x.id === id || x.name === id);
  if (!d) {
    json(res, 404, { error: "not_found" });
    return false;
  }
  if (!mayManageDeployment(d)) {
    json(res, 403, { error: "forbidden", message: "you do not manage this deployment" });
    return false;
  }
  return true;
}

function callbackHtml(query: string): string {
  const safe = query.replaceAll("&", "&amp;");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=../../../?${safe}"><title>Connector</title>`;
}

function conversationForScope(
  user: string,
  threadRef: string,
  scope: string | undefined,
  channelName: string | undefined,
): { kind: "dm" | "channel" | "group"; threadRef: string; channelRef?: string; channelName?: string } | null {
  if (!scope || scope === `personal:${user}`) return { kind: "dm", threadRef };
  const sep = scope.indexOf(":");
  const kind = scope.slice(0, sep);
  const ref = scope.slice(sep + 1);
  if ((kind !== "channel" && kind !== "group") || !ref) return null;
  return { kind, channelRef: ref, threadRef, ...(channelName ? { channelName } : {}) };
}

interface Identity {
  user: string;
  name: string | null;
  impersonator: string | null;
}
type Denial = "unauthenticated" | "not_allowed";

function authenticate(req: IncomingMessage): { identity: Identity } | { denied: Denial } {
  let user: string | null | undefined;
  let name: string | null | undefined;
  let impersonator: string | null | undefined;
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const claims =
    token && PORTAL_IDENTITY_SECRET ? verifyPortalIdentity(token, PORTAL_IDENTITY_SECRET, Date.now()) : null;
  if (claims) {
    user = claims.p;
    name = claims.n ?? null;
    impersonator = claims.imp ?? null;
  } else {
    if (!COOKIE_AUTH) return { denied: "unauthenticated" };
    user = cookie(req, "webuiuser");
    name = cookie(req, "webuiuser_name");
    impersonator = cookie(req, "webui_impersonator");
  }
  if (!user) return { denied: "unauthenticated" };
  if (ALLOW.length > 0 && !ALLOW.includes(user)) return { denied: "not_allowed" };
  return { identity: { user, name: name?.trim() || null, impersonator: impersonator ?? null } };
}

function resolveIdentity(req: IncomingMessage): Identity | null {
  const outcome = authenticate(req);
  return "identity" in outcome ? outcome.identity : null;
}

function cookieUser(req: IncomingMessage): string | null {
  return resolveIdentity(req)?.user ?? null;
}

function unauthorized(res: ServerResponse, req: IncomingMessage): void {
  const outcome = authenticate(req);
  const denied = "denied" in outcome ? outcome.denied : "unauthenticated";
  return json(res, 401, { error: "sign in", mode: AUTH_MODE, reason: denied });
}

const SESSION_TTL_S = 90 * 24 * 60 * 60;
function sessionCookie(id: string): string {
  return `webuiuser=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL_S}`;
}

const MAX_BODY_BYTES = 1_000_000;
const readBody = (req: IncomingMessage): Promise<string> => readBodyCapped(req, MAX_BODY_BYTES);

const slackUrlCache = new LRUCache<string, { url: string | null }>({ max: 1, ttl: 5 * 60_000 });
async function slackWorkspaceUrl(): Promise<string | null> {
  const hit = slackUrlCache.get("url");
  if (hit) return hit.url;
  let urlValue: string | null = null;
  try {
    const r = await coreFetch("GET", "/v1/directory/meta");
    if (r.status === 200) urlValue = (JSON.parse(r.text) as { workspaceUrl?: string | null }).workspaceUrl ?? null;
  } catch {
    void 0;
  }
  slackUrlCache.set("url", { url: urlValue });
  return urlValue;
}

const WEB_DELIVERY_POLL_MS = Number(process.env.WEB_DELIVERY_POLL_MS ?? 2500);
const WEB_DELIVERY_GIVEUP_MS = 60_000;
let deliveriesPollInFlight = false;

interface PendingWebDelivery {
  id: string;
  idempotencyKey: string;
  createdAt: number;
  destination?: { target?: string };
}

async function drainWebDeliveries(): Promise<void> {
  if (deliveriesPollInFlight) return;
  deliveriesPollInFlight = true;
  try {
    const r = await coreFetch("GET", "/v1/deliveries?type=web");
    if (r.status !== 200) return;
    let pending: PendingWebDelivery[] = [];
    try {
      pending = (JSON.parse(r.text) as { deliveries?: PendingWebDelivery[] }).deliveries ?? [];
    } catch {
      return;
    }
    const now = Date.now();
    for (const d of pending) {
      const target = d.destination?.target ?? "";
      const isRecovery = d.idempotencyKey.startsWith("run:");
      const conns = !isRecovery ? deliveryClients.get(ownerOfWebThread(target) ?? "") : undefined;
      if (conns && conns.size) {
        for (const res of conns) sseEvent(res, "delivery", { threadRef: target });
      } else if (!isRecovery && now - (d.createdAt ?? 0) < WEB_DELIVERY_GIVEUP_MS) {
        continue;
      }
      await coreFetch("POST", `/v1/deliveries/${encodeURIComponent(d.id)}/ack`).catch(() => {});
    }
  } catch {
    void 0;
  } finally {
    deliveriesPollInFlight = false;
  }
}

const STATE_FEED_RECONNECT_MS = Number(process.env.STATE_FEED_RECONNECT_MS ?? 3_000);

interface SessionStateFrame {
  threadRef?: string;
  state?: string;
  participants?: string[];
  [k: string]: unknown;
}

function forwardSessionState(frame: SessionStateFrame): void {
  const threadRef = typeof frame.threadRef === "string" ? frame.threadRef : "";
  if (!threadRef) return;
  const targets = new Set<string>(
    Array.isArray(frame.participants) ? frame.participants.filter((p): p is string => typeof p === "string") : [],
  );
  if (targets.size === 0) {
    const owner = ownerOfWebThread(threadRef);
    if (owner) targets.add(owner);
  }
  const { participants: _participants, ...visible } = frame;
  for (const user of targets) {
    for (const res of deliveryClients.get(user) ?? []) sseEvent(res, "session_state", visible);
  }
}

async function runStateFeed(): Promise<void> {
  let dropped = false;
  for (;;) {
    try {
      const signedPath = withSourceAuthNonce("/v1/session-state/events", CORE_SIGNING_SECRET);
      const r = await fetch(`${CORE}${signedPath}`, {
        headers: signedHeaders(CORE_SIGNING_SECRET, "GET", signedPath, ""),
      });
      if (r.status === 200 && r.body) {
        if (dropped) {
          dropped = false;
          for (const conns of deliveryClients.values())
            for (const res of conns) sseEvent(res, "session_state_resync", {});
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            if (!frame.split("\n").some((l) => l === "event: session_state")) continue;
            const data = frame
              .split("\n")
              .find((l) => l.startsWith("data: "))
              ?.slice("data: ".length);
            if (!data) continue;
            try {
              forwardSessionState(JSON.parse(data) as SessionStateFrame);
            } catch {
              void 0;
            }
          }
        }
      }
      dropped = true;
    } catch {
      dropped = true;
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_FEED_RECONNECT_MS));
  }
}

async function coreFetch(
  method: HttpMethod,
  pathWithQuery: string,
  rawBody = "",
  timeoutMs?: number,
): Promise<{ status: number; text: string }> {
  const signedPath = withSourceAuthNonce(pathWithQuery, CORE_SIGNING_SECRET);
  const portalTok = portalTokenStore.getStore();
  const r = await fetch(`${CORE}${signedPath}`, {
    method,
    headers: {
      ...signedHeaders(CORE_SIGNING_SECRET, method, signedPath, rawBody),
      ...(portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : {}),
    },
    ...(rawBody ? { body: rawBody } : {}),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    redirect: "manual",
  });
  return { status: r.status, text: await r.text() };
}

async function coreFetchCap(
  method: HttpMethod,
  pathWithQuery: string,
  rawBody = "",
): Promise<{ status: number; text: string }> {
  const cap = await coreFetch("POST", "/v1/session-cap", "");
  if (cap.status !== 200) return { status: cap.status === 401 ? 401 : 503, text: cap.text };
  let token: string | undefined;
  try {
    token = (JSON.parse(cap.text) as { token?: string }).token;
  } catch {
    token = undefined;
  }
  if (!token)
    return { status: 503, text: JSON.stringify({ error: "not_configured", message: "no session capability" }) };
  const r = await fetch(`${CORE}${pathWithQuery}`, {
    method,
    headers: { "content-type": "application/json", [CAPABILITY_HEADER]: token },
    ...(rawBody ? { body: rawBody } : {}),
    redirect: "manual",
  });
  return { status: r.status, text: await r.text() };
}

async function relayCore(res: ServerResponse, method: HttpMethod, pathWithQuery: string, rawBody = ""): Promise<void> {
  relay(res, await coreFetch(method, pathWithQuery, rawBody));
}

async function relayCap(res: ServerResponse, method: HttpMethod, pathWithQuery: string, rawBody = ""): Promise<void> {
  relay(res, await coreFetchCap(method, pathWithQuery, rawBody));
}

async function readJson<T extends object>(
  req: IncomingMessage,
  res: ServerResponse,
  allowEmpty = true,
): Promise<T | null> {
  try {
    const raw = await readBody(req);
    if (!raw && !allowEmpty) {
      json(res, 400, { error: "bad_request" });
      return null;
    }
    const parsed: unknown = JSON.parse(raw || "{}");
    if (typeof parsed !== "object" || parsed === null) {
      json(res, 400, { error: "bad_request" });
      return null;
    }
    return parsed as T;
  } catch (e) {
    if (e instanceof PayloadTooLargeError) throw e;
    json(res, 400, { error: "bad_request" });
    return null;
  }
}

function imRoutePrefix(provider: ImProviderId, user: string, binding: ImBindingRecord): string {
  const namespace = createHash("sha256")
    .update(`${user}\0${provider}\0${binding.resourceId ?? ""}`)
    .digest("hex")
    .slice(0, 20);
  return `im:${provider}:${namespace}:`;
}

function imTurn(
  provider: ImProviderId,
  found: { user: string; binding: ImBindingRecord },
  input: {
    externalUserId: string;
    externalChatId: string;
    externalDisplayName: string;
    externalTenantId?: string;
    externalTenantName?: string;
    text: string;
    messageId?: string;
    deliveryEditRef?: string;
  },
): { turn: unknown; threadRef: string } {
  const meta = imProviderMeta(provider);
  const routePrefix = imRoutePrefix(provider, found.user, found.binding);
  const namespace = routePrefix.slice(`im:${provider}:`.length, -1);
  const threadRef = `${routePrefix}${input.externalChatId}`;
  return {
    threadRef,
    turn: {
      surface: `im:${provider}`,
      actor: { externalId: found.user, displayName: input.externalDisplayName },
      conversation: {
        kind: "dm",
        threadRef,
        channelName: `${meta.label} ${input.externalDisplayName}`.slice(0, 200),
        audience: [{ externalId: found.user, displayName: input.externalDisplayName }],
      },
      liveActor: true,
      deliveryTarget: threadRef,
      ...(input.deliveryEditRef ? { deliveryEditRef: input.deliveryEditRef } : {}),
      text: input.text,
      origin: {
        kind: "human",
        ...(input.messageId ? { messageTs: input.messageId, entryTs: input.messageId } : {}),
      },
      gatewayContext: {
        location: meta.label,
        botHandle: found.binding.botName ?? meta.botName,
        details: {
          provider,
          externalUserId: input.externalUserId,
          externalChatId: input.externalChatId,
          ...(input.externalTenantId ? { externalTenantId: input.externalTenantId } : {}),
          ...(input.externalTenantName ? { externalTenantName: input.externalTenantName } : {}),
        },
      },
      ...(input.messageId ? { idempotencyKey: `im:${provider}:${namespace}:${input.messageId}` } : {}),
    },
  };
}

interface WeixinMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: { text?: string };
}

interface WeixinMessage {
  message_id?: number;
  client_id?: string;
  from_user_id?: string;
  message_type?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

interface WeixinUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
}

interface PendingImDelivery {
  id: string;
  idempotencyKey?: string;
  text?: string;
  destination?: { target?: string; editRef?: string };
}

function imDeliveryRunId(delivery: PendingImDelivery): string | undefined {
  return delivery.idempotencyKey?.startsWith("run:") ? delivery.idempotencyKey.slice("run:".length) : undefined;
}

function imLocatorDelivery(delivery: PendingImDelivery): boolean {
  return delivery.idempotencyKey?.startsWith("im-locate:") === true;
}

async function ackImDelivery(delivery: PendingImDelivery): Promise<void> {
  const acked = await coreFetch("POST", `/v1/deliveries/${encodeURIComponent(delivery.id)}/ack`);
  if (acked.status !== 200) throw new Error(`core delivery ack failed (${acked.status})`);
}

async function ackFailedImLocatorDelivery(
  provider: ImProviderId,
  delivery: PendingImDelivery,
  error: unknown,
): Promise<boolean> {
  if (!imLocatorDelivery(delivery)) return false;
  console.error(`[web-ui] ${provider} locator delivery failed:`, String(error));
  await ackImDelivery(delivery);
  return true;
}

function weixinMessageText(message: WeixinMessage): string {
  return (message.item_list ?? [])
    .filter((item) => item.type === 1 && typeof item.text_item?.text === "string")
    .map((item) => item.text_item!.text!.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, 40_000);
}

function weixinMessageId(message: WeixinMessage): string | undefined {
  if (message.message_id !== undefined) return String(message.message_id);
  const itemId = message.item_list?.find((item) => item.msg_id)?.msg_id;
  return itemId || message.client_id || undefined;
}

const weixinPolls = new Set<string>();
const imDeliveryDrains = new Map<string, Promise<void>>();
const imDeliveryReruns = new Map<string, () => Promise<void>>();

function queueImDeliveryDrain(key: string, drain: () => Promise<void>): Promise<void> {
  const current = imDeliveryDrains.get(key);
  if (current) {
    imDeliveryReruns.set(key, drain);
    return current;
  }
  const run = (async () => {
    let next: (() => Promise<void>) | undefined = drain;
    while (next) {
      await next();
      next = imDeliveryReruns.get(key);
      imDeliveryReruns.delete(key);
    }
  })();
  imDeliveryDrains.set(key, run);
  void run.then(
    () => {
      if (imDeliveryDrains.get(key) === run) imDeliveryDrains.delete(key);
      imDeliveryReruns.delete(key);
    },
    () => {
      if (imDeliveryDrains.get(key) === run) imDeliveryDrains.delete(key);
      imDeliveryReruns.delete(key);
    },
  );
  return run;
}

export async function pollWeixinAccount(user: string, expectedResourceId: string, requireLease = false): Promise<void> {
  const state = await readImBindings(user);
  const binding = state.bindings.wechat;
  const resource = state.resources.wechat;
  const secret = readWeixinSecret(resource);
  if (binding?.status !== "connected" || resource?.resourceId !== expectedResourceId || !secret) return;
  const response = await weixinJson<WeixinUpdatesResponse>(
    secret.baseUrl,
    "ilink/bot/getupdates",
    "POST",
    {
      get_updates_buf: secret.cursor ?? "",
      base_info: { channel_version: "0.1.0", bot_agent: "QM/0.1.0" },
    },
    secret.token,
    WEIXIN_API_TIMEOUT_MS,
  );
  if ((response.ret ?? 0) !== 0 || (response.errcode ?? 0) !== 0) {
    throw new Error(`Weixin getupdates failed: ${response.errcode ?? response.ret} ${response.errmsg ?? ""}`);
  }
  if (requireLease && !ownsImBridge(user, "wechat", expectedResourceId)) return;
  const messages = (response.msgs ?? []).filter(
    (message) =>
      message.message_type === 1 && message.from_user_id === resource.externalUserId && weixinMessageText(message),
  );
  for (const message of messages) {
    const externalChatId = binding.externalChatId ?? secret.userId;
    const { turn } = imTurn(
      "wechat",
      { user, binding },
      {
        externalUserId: secret.userId,
        externalChatId,
        externalDisplayName: binding.externalDisplayName ?? "微信用户",
        text: weixinMessageText(message),
        ...(weixinMessageId(message) ? { messageId: weixinMessageId(message)! } : {}),
      },
    );
    const posted = await coreFetch("POST", "/v1/turns?async=1", JSON.stringify(turn));
    if (posted.status < 200 || posted.status >= 300) throw new Error(`core turn failed (${posted.status})`);
    try {
      const body = JSON.parse(posted.text) as { runId?: unknown; status?: unknown };
      const active = body.status === "queued" || body.status === "pending" || body.status === "running";
      if (typeof body.runId === "string" && (posted.status !== 200 || active)) {
        const messageId = weixinMessageId(message);
        startImRunProgress(user, "wechat", resource.resourceId, externalChatId, body.runId, messageId);
      }
    } catch {
      void 0;
    }
  }
  const latest = await readImBindings(user);
  const latestResource = latest.resources.wechat;
  const latestSecret = readWeixinSecret(latestResource);
  if (
    latest.bindings.wechat?.status !== "connected" ||
    latestResource?.resourceId !== expectedResourceId ||
    !latestSecret
  ) {
    return;
  }
  const contextToken = [...messages].reverse().find((message) => message.context_token)?.context_token;
  const nextCursor = response.get_updates_buf ?? latestSecret.cursor;
  const nextContextToken = contextToken ?? latestSecret.contextToken;
  const nextExternalChatId = contextToken ? latestSecret.userId.slice(0, 256) : latestResource.externalChatId;
  if (
    nextCursor === latestSecret.cursor &&
    nextContextToken === latestSecret.contextToken &&
    nextExternalChatId === latestResource.externalChatId
  ) {
    return;
  }
  latestResource.encryptedSecret = encryptImSecret({
    ...latestSecret,
    ...(nextCursor !== undefined ? { cursor: nextCursor } : {}),
    ...(nextContextToken ? { contextToken: nextContextToken } : {}),
  } satisfies WeixinResourceSecret);
  if (nextExternalChatId) {
    latestResource.externalChatId = nextExternalChatId;
    if (latest.bindings.wechat) latest.bindings.wechat.externalChatId = nextExternalChatId;
  }
  latestResource.updatedAt = Date.now();
  await writeImBindings(user, latest);
}

interface StoredImBindings {
  user: string;
  state: ImBindingsState;
}

async function listStoredImBindings(): Promise<StoredImBindings[]> {
  return (await listUiStateRecords(IM_BINDINGS_KEY)).map(({ principalId, record }) => ({
    user: principalId,
    state: parseImBindings(record.value, record.updatedAt),
  }));
}

export async function drainWeixinDeliveries(stored?: StoredImBindings[]): Promise<void> {
  const bindings = stored ?? (await listStoredImBindings());
  await Promise.all(
    bindings.map(async ({ user, state }) => {
      const binding = state.bindings.wechat;
      const resource = state.resources.wechat;
      if (!binding || binding.status !== "connected" || !resource) return;
      await queueImDeliveryDrain(imRuntimeKey(user, "wechat"), async () => {
        if (!(await claimImBridge(user, "wechat", resource.resourceId))) return;
        const targetPrefix = imRoutePrefix("wechat", user, binding);
        const claimed = await coreFetch(
          "GET",
          `/v1/deliveries?type=im%3Awechat&claimMs=45000&targetPrefix=${encodeURIComponent(targetPrefix)}`,
        );
        if (claimed.status !== 200) return;
        const deliveries = (JSON.parse(claimed.text) as { deliveries?: PendingImDelivery[] }).deliveries ?? [];
        const secret = readWeixinSecret(resource);
        if (!secret) return;
        for (const delivery of deliveries) {
          const target = (delivery.destination?.target ?? "").slice(targetPrefix.length);
          if (target !== binding.externalChatId) {
            if (imLocatorDelivery(delivery)) await ackImDelivery(delivery);
            continue;
          }
          const runId = imDeliveryRunId(delivery);
          const progress = runId ? await finishImRunProgress(user, "wechat", runId) : undefined;
          const finalDelivery = runId
            ? await imFinalDeliveryText(user, "wechat", runId, delivery.text ?? "", progress?.sentActivity ?? 0)
            : { text: delivery.text, activityIncluded: false };
          try {
            const sent = await weixinJson<{ ret?: number; errmsg?: string }>(
              secret.baseUrl,
              "ilink/bot/sendmessage",
              "POST",
              {
                msg: {
                  from_user_id: "",
                  to_user_id: secret.userId,
                  client_id: `qm-${randomUUID()}`,
                  message_type: 2,
                  message_state: 2,
                  ...(finalDelivery.text
                    ? { item_list: [{ type: 1, text_item: { text: finalDelivery.text.slice(0, 40_000) } }] }
                    : {}),
                  ...(secret.contextToken ? { context_token: secret.contextToken } : {}),
                  ...(runId ? { run_id: runId } : {}),
                },
                base_info: { channel_version: "0.1.0", bot_agent: "QM/0.1.0" },
              },
              secret.token,
              15_000,
            );
            if ((sent.ret ?? 0) !== 0) throw new Error(`Weixin sendmessage failed: ${sent.ret} ${sent.errmsg ?? ""}`);
          } catch (error) {
            if (await ackFailedImLocatorDelivery("wechat", delivery, error)) continue;
            throw error;
          }
          await ackImDelivery(delivery);
          if (runId) await removeStoredImRunProgress(user, "wechat", runId);
        }
      });
    }),
  );
}

async function syncWeixinBridge(): Promise<void> {
  const stored = await listStoredImBindings();
  for (const { user, state } of stored) {
    const resourceId = state.resources.wechat?.resourceId;
    if (!resourceId || state.bindings.wechat?.status !== "connected") continue;
    try {
      await claimImResourceOwner(user, "wechat", resourceId);
    } catch (error) {
      console.error("[web-ui] Weixin resource owner conflict:", String(error));
      continue;
    }
    const key = `${user}\0${resourceId}`;
    if (!(await claimImBridge(user, "wechat", resourceId))) continue;
    if (weixinPolls.has(key)) continue;
    weixinPolls.add(key);
    void pollWeixinAccount(user, resourceId, true)
      .catch((error: unknown) => console.error("[web-ui] Weixin poll failed:", String(error)))
      .finally(() => weixinPolls.delete(key));
  }
}

export async function drainImSdkDeliveries(
  provider: Exclude<ImProviderId, "wechat">,
  stored?: StoredImBindings[],
): Promise<void> {
  if (![...imSdkRuntimes.keys()].some((key) => key.endsWith(`\0${provider}`))) return;
  const bindings = stored ?? (await listStoredImBindings());
  await Promise.all(
    bindings.map(async ({ user, state }) => {
      const binding = state.bindings[provider];
      const resource = state.resources[provider];
      if (!binding || binding.status !== "connected" || !resource) return;
      const runtime = imSdkRuntimes.get(imRuntimeKey(user, provider));
      if (!runtime) return;
      const inFlightKey = imRuntimeKey(user, provider);
      await queueImDeliveryDrain(inFlightKey, async () => {
        if (!ownsImBridge(user, provider, resource.resourceId)) return;
        const targetPrefix = imRoutePrefix(provider, user, binding);
        const claimed = await coreFetch(
          "GET",
          `/v1/deliveries?type=${encodeURIComponent(`im:${provider}`)}&claimMs=45000&targetPrefix=${encodeURIComponent(targetPrefix)}`,
        );
        if (claimed.status !== 200) return;
        const deliveries = (JSON.parse(claimed.text) as { deliveries?: PendingImDelivery[] }).deliveries ?? [];
        for (const delivery of deliveries) {
          const target = (delivery.destination?.target ?? "").slice(targetPrefix.length);
          const runId = imDeliveryRunId(delivery);
          const progress = runId ? await finishImRunProgress(user, provider, runId) : undefined;
          const finalDelivery = runId
            ? await imFinalDeliveryText(user, provider, runId, delivery.text ?? "", progress?.sentActivity ?? 0)
            : { text: delivery.text, activityIncluded: false };
          const text = (finalDelivery.text ?? "").slice(0, 40_000);
          try {
            await runtime.send(
              target,
              text,
              delivery.idempotencyKey,
              delivery.destination?.editRef,
              finalDelivery.activityIncluded,
            );
          } catch (error) {
            if (await ackFailedImLocatorDelivery(provider, delivery, error)) continue;
            throw error;
          }
          await ackImDelivery(delivery);
          if (runId) await removeStoredImRunProgress(user, provider, runId);
        }
      });
    }),
  );
}

async function syncImSdkBridges(): Promise<void> {
  const stored = await listStoredImBindings();
  const active = new Set<string>();
  for (const { user, state } of stored) {
    for (const provider of IM_SDK_PROVIDERS) {
      const resource = state.resources[provider];
      if (!resource || !state.bindings[provider] || !readImSdkSecret(resource)) continue;
      const key = imRuntimeKey(user, provider);
      try {
        await claimImResourceOwner(user, provider, resource.resourceId);
      } catch (error) {
        console.error(`[web-ui] ${provider} resource owner conflict:`, String(error));
        continue;
      }
      active.add(key);
      if (!(await claimImBridge(user, provider, resource.resourceId))) {
        imSdkRuntimes.get(key)?.stop();
        imSdkRuntimes.delete(key);
        continue;
      }
      await activateImSdkResource(user, resource).catch((error: unknown) =>
        console.error(`[web-ui] ${provider} connection failed:`, String(error)),
      );
      if (imSdkRuntimes.has(key)) {
        await markImBridgeReady(user, resource).catch((error: unknown) =>
          console.error(`[web-ui] ${provider} ready heartbeat failed:`, String(error)),
        );
      }
    }
  }
  for (const [key, runtime] of imSdkRuntimes) {
    if (active.has(key)) continue;
    runtime.stop();
    imSdkRuntimes.delete(key);
  }
}

export async function syncImRunProgress(): Promise<void> {
  const [recordsByProvider, legacyRecords, bindings] = await Promise.all([
    Promise.all(IM_PROVIDERS.map((provider) => listUiStateRecords(imProgressStateKey(provider)))),
    listUiStateRecords(IM_PROGRESS_LEGACY_KEY),
    listStoredImBindings(),
  ]);
  const now = Date.now();
  await Promise.all(
    legacyRecords.map(({ principalId, record }) => {
      const progress = Object.values(parseStoredImRunProgress(record.value));
      if (progress.some((run) => now - run.createdAt <= IM_RUN_PROGRESS_MAX_AGE_MS)) return Promise.resolve(false);
      return deleteUiStateValue(principalId, IM_PROGRESS_LEGACY_KEY, record.updatedAt);
    }),
  );
  const states = new Map(bindings.map(({ user, state }) => [user, state]));
  for (const { principalId: user, record } of recordsByProvider.flat()) {
    for (const progress of Object.values(parseStoredImRunProgress(record.value))) {
      const binding = states.get(user)?.bindings[progress.provider];
      const resource = states.get(user)?.resources[progress.provider];
      const invalid =
        now - progress.createdAt > IM_RUN_PROGRESS_MAX_AGE_MS ||
        binding?.status !== "connected" ||
        resource?.resourceId !== progress.resourceId;
      if (invalid) {
        const follower = imRunProgressFollowers.get(imRunProgressKey(user, progress.provider, progress.runId));
        if (follower) follower.canceled = true;
        void removeStoredImRunProgress(user, progress.provider, progress.runId).catch((error: unknown) =>
          console.error(`[web-ui] ${progress.provider} progress cleanup failed:`, String(error)),
        );
        continue;
      }
      if (progress.terminal) continue;
      if (!ownsImBridge(user, progress.provider, progress.resourceId)) continue;
      if (progress.provider !== "wechat" && !imSdkRuntimes.has(imRuntimeKey(user, progress.provider))) continue;
      launchImRunProgress(user, progress, false);
    }
  }
}

export async function drainImDeliveries(): Promise<void> {
  const stored = await listStoredImBindings();
  await Promise.all([
    drainWeixinDeliveries(stored),
    ...IM_SDK_PROVIDERS.map((provider) => drainImSdkDeliveries(provider, stored)),
  ]);
}

async function drainImDeliveriesAfterProgress(): Promise<void> {
  await drainImDeliveries();
}

let imBridgeSyncInFlight: Promise<void> | null = null;

async function syncImBridges(): Promise<void> {
  if (imBridgeSyncInFlight) return imBridgeSyncInFlight;
  const sync = Promise.all([syncWeixinBridge(), syncImSdkBridges()]).then(() => syncImRunProgress());
  imBridgeSyncInFlight = sync;
  try {
    await sync;
  } finally {
    if (imBridgeSyncInFlight === sync) imBridgeSyncInFlight = null;
  }
}

async function postTurnAndMint(res: ServerResponse, turn: unknown, user: string, threadRef: string): Promise<void> {
  const r = await coreFetch("POST", `/v1/turns?async=1`, JSON.stringify(turn));
  if (r.status >= 200 && r.status < 300) {
    try {
      const parsed = JSON.parse(r.text) as Record<string, unknown> & { runId?: string };
      const runId = parsed.runId;
      if (runId) {
        rememberRun(runId, user, threadRef);
        return json(res, r.status, parsed);
      }
    } catch {
      void 0;
    }
  }
  relay(res, r);
}

async function userPermissions(): Promise<string[]> {
  if (!CORE_SIGNING_SECRET) return [];
  try {
    const r = await coreFetchCap("GET", "/v1/admin/whoami");
    if (r.status !== 200) return [];
    const j = JSON.parse(r.text) as { permissions?: unknown };
    return Array.isArray(j.permissions) ? j.permissions.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

interface CoreCron {
  id: string;
  ownerScopeId: string;
  owner: string;
  createdBy: string;
  title?: string;
  action?: string;
  message?: string;
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  destination?: unknown;
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
  permission?: "read" | "manage";
}

interface CoreAttachment {
  name: string;
  mimetype: string;
  sizeBytes: number;
  blobId: string;
}

interface CoreApprovalRecord {
  requestId: string;
  sessionId?: unknown;
  command: string;
  reason?: string;
  request?: {
    surface?: string;
    actor?: { externalId?: unknown };
    conversation?: { threadRef?: unknown };
    text?: unknown;
  } & Record<string, unknown>;
}

function uploadFileName(url: URL): string {
  return url.searchParams.get("name")?.trim() || "file";
}

async function stageUploadStream(req: IncomingMessage, sha256: string): Promise<Response> {
  const corePath = withSourceAuthNonce("/v1/blobs", CORE_SIGNING_SECRET);
  const headers = {
    ...signedHeaders(CORE_SIGNING_SECRET, "POST", corePath, "", sha256),
    "content-type": "application/octet-stream",
    "x-content-sha256": sha256,
  };
  return fetch(`${CORE}${corePath}`, {
    method: "POST",
    headers,
    body: req as unknown as RequestInit["body"],
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function declaredSha(url: URL): string {
  return url.searchParams.get("sha") ?? "";
}

async function uploadBlobFromRequest(req: IncomingMessage, res: ServerResponse, sha256: string): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    req.resume();
    return json(res, 400, { error: "bad_request", message: "sha (hex sha-256) required" });
  }
  const staged = await stageUploadStream(req, sha256);
  res.writeHead(staged.status, { "content-type": staged.headers.get("content-type") ?? "application/json" });
  return void res.end(await staged.text());
}

async function uploadFileFromRequest(
  req: IncomingMessage,
  res: ServerResponse,
  user: string,
  scope: string | null,
  sha256: string,
  name: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    req.resume();
    return json(res, 400, { error: "bad_request", message: "sha (hex sha-256) required" });
  }
  const staged = await stageUploadStream(req, sha256);
  const stagedText = await staged.text();
  if (!staged.ok) {
    res.writeHead(staged.status, { "content-type": staged.headers.get("content-type") ?? "application/json" });
    return void res.end(stagedText);
  }
  const stagedBody = JSON.parse(stagedText) as { blobId: string };
  const body = JSON.stringify({
    principalId: user,
    ...(scope ? { scopeId: scope } : {}),
    name,
    mimetype:
      typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "application/octet-stream",
    blobId: stagedBody.blobId,
  });
  const registered = await coreFetch("POST", "/v1/files/upload", body);
  res.writeHead(registered.status, { "content-type": "application/json" });
  return void res.end(registered.text);
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(DIST, rel);
  if (!filePath.startsWith(DIST)) return void json(res, 403, { error: "forbidden" });

  const isFile = existsSync(filePath) && statSync(filePath).isFile();
  const immutable = isFile && /(?:^|[/\\])assets[/\\]/.test(rel);
  if (!isFile) {
    if (extname(rel)) return void json(res, 404, { error: "not_found" });
    filePath = join(DIST, "index.html");
    if (!existsSync(filePath)) {
      return void json(res, 503, { error: "not_built", message: "run `npm run build` to produce dist-web/" });
    }
  }
  if (filePath.endsWith("index.html")) {
    const branded = await brandIndexHtml(readFileSync(filePath, "utf8"));
    res.writeHead(
      200,
      withSecurityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }),
    );
    return void res.end(branded);
  }
  const type = CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream";
  res.writeHead(
    200,
    withSecurityHeaders({
      "content-type": type,
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    }),
  );
  createReadStream(filePath).pipe(res);
}

const APPS_FRAME_DOMAIN = (process.env.DEPLOY_APPS_DOMAIN ?? "").toLowerCase();

async function serveAppEditHtml(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const slug = (url.searchParams.get("slug") ?? "").toLowerCase();
  if (!APPS_FRAME_DOMAIN || !/^[a-z0-9-]{1,63}$/.test(slug)) return false;
  let html: string;
  if (vite) {
    const raw = readFileSync(join(ROOT, "index.html"), "utf8").replace("%BASE_URL%favicon.svg", "favicon.svg");
    html = await vite.transformIndexHtml(req.url ?? "/", raw);
  } else {
    const filePath = join(DIST, "index.html");
    if (!existsSync(filePath)) return false;
    html = readFileSync(filePath, "utf8");
  }
  const headers = withSecurityHeaders({ "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
  headers["content-security-policy"] = SPA_CSP.replace(
    "frame-ancestors 'self'",
    `frame-ancestors 'self' ${slug}.${APPS_FRAME_DOMAIN}`,
  );
  delete headers["x-frame-options"];
  res.removeHeader("x-frame-options");
  res.writeHead(200, headers);
  res.end(await brandIndexHtml(html));
  return true;
}

let vite: ViteDevServer | undefined;

async function createVite(server: Server): Promise<ViteDevServer | undefined> {
  if (!WEB_UI_DEV) return undefined;
  const importVite = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<{ createServer: CreateViteServer }>;
  const { createServer: createViteServer } = await importVite("vite");
  return createViteServer({
    root: ROOT,
    configFile: join(ROOT, "vite.config.ts"),
    appType: "custom",
    server: {
      middlewareMode: true,
      hmr: { server },
    },
  });
}

async function serveVite(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (!vite) return false;
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      res.off("finish", finish);
      res.off("close", finish);
    };
    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };
    res.once("finish", finish);
    res.once("close", finish);
    vite!.middlewares(req, res, (err?: unknown) => {
      if (done) return;
      done = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    });
  });
  if (res.headersSent || res.writableEnded) return true;
  if (extname(path)) return false;
  let html = readFileSync(join(ROOT, "index.html"), "utf8");
  html = html.replace("%BASE_URL%favicon.svg", "favicon.svg");
  html = await vite.transformIndexHtml(req.url ?? "/", html);
  sendHtml(res, 200, await brandIndexHtml(html));
  return true;
}

interface WebCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  user: string;
  params: Record<string, string>;
}

type WebRoute = { handle: (c: WebCtx) => unknown } & (
  { method: string; path: string } | { match: (method: string, pathname: string) => boolean }
);

const apiRoutes: readonly WebRoute[] = [
  {
    match: (_method, pathname) => pathname === "/me",
    handle: async (c) => {
      const { req, res, user } = c;
      res.setHeader("set-cookie", sessionCookie(user));
      const permissions = await userPermissions();
      return json(res, 200, {
        user,
        org: ORG,
        mode: AUTH_MODE,
        slackWorkspaceUrl: await slackWorkspaceUrl(),
        impersonatedBy: resolveIdentity(req)?.impersonator ?? null,
        permissions,
      });
    },
  },
  {
    method: "POST",
    path: "/api/blobs",
    handle: async (c) => {
      const { req, res, url } = c;
      return uploadBlobFromRequest(req, res, declaredSha(url));
    },
  },
  {
    method: "POST",
    path: "/api/files/upload",
    handle: async (c) => {
      const { req, res, url, user } = c;
      return uploadFileFromRequest(
        req,
        res,
        user,
        url.searchParams.get("scope"),
        declaredSha(url),
        uploadFileName(url),
      );
    },
  },
  {
    method: "GET",
    path: "/api/search",
    handle: async (c) => {
      const { res, url, user } = c;
      const q = url.searchParams.get("q") ?? "";
      const limit = url.searchParams.get("limit");
      return relayCore(
        res,
        "GET",
        `/v1/sessions/search?principalId=${encodeURIComponent(user)}&q=${encodeURIComponent(q)}${
          limit ? `&limit=${encodeURIComponent(limit)}` : ""
        }`,
      );
    },
  },
  {
    method: "GET",
    path: "/api/sessions",
    handle: async (c) => {
      const { res, user } = c;
      return relayCore(res, "GET", `/v1/sessions?principalId=${encodeURIComponent(user)}`);
    },
  },
  {
    method: "GET",
    path: "/api/contexts",
    handle: async (c) => {
      const { res, user } = c;
      return relayCore(res, "GET", `/v1/contexts?principalId=${encodeURIComponent(user)}`);
    },
  },
  {
    method: "GET",
    path: "/api/contexts/:scope/ambient-policy",
    handle: async (c) => {
      const { res, user } = c;
      const scope = c.params.scope!;
      return relayCore(
        res,
        "GET",
        `/v1/contexts/policy?principalId=${encodeURIComponent(user)}&scope=${encodeURIComponent(scope)}`,
      );
    },
  },
  {
    method: "PUT",
    path: "/api/contexts/:scope/ambient-policy",
    handle: async (c) => {
      const { req, res, user } = c;
      const scope = c.params.scope!;
      const p = await readJson<{ orders?: unknown; bots?: unknown; ambientEnabled?: unknown; baseUpdatedAt?: unknown }>(
        req,
        res,
      );
      if (!p) return;
      return relayCore(
        res,
        "PUT",
        "/v1/contexts/policy",
        JSON.stringify({
          principalId: user,
          scope,
          orders: p.orders,
          bots: p.bots,
          ambientEnabled: p.ambientEnabled,
          baseUpdatedAt: p.baseUpdatedAt,
        }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/projects",
    handle: async (c) => {
      const { req, res, user } = c;
      const p = await readJson<{ name?: unknown }>(req, res);
      if (!p) return;
      const name = typeof p.name === "string" ? p.name.trim().slice(0, 200) : "";
      if (!name) return json(res, 400, { error: "bad_request", message: "name required" });
      return relayCore(res, "POST", "/v1/projects", JSON.stringify({ principalId: user, name }));
    },
  },
  {
    method: "PATCH",
    path: "/api/projects/:id",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      const p = await readJson<{ name?: unknown }>(req, res);
      if (!p) return;
      const name = typeof p.name === "string" ? p.name.trim().slice(0, 200) : "";
      if (!name) return json(res, 400, { error: "bad_request", message: "name required" });
      return relayCore(
        res,
        "PATCH",
        `/v1/projects/${encodeURIComponent(id)}`,
        JSON.stringify({ principalId: user, name }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/projects/:id/members",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      const p = await readJson<{ memberId?: unknown }>(req, res);
      if (!p) return;
      const memberId = typeof p.memberId === "string" ? p.memberId.trim() : "";
      if (!memberId) return json(res, 400, { error: "bad_request", message: "memberId required" });
      return relayCore(
        res,
        "POST",
        `/v1/projects/${encodeURIComponent(id)}/members`,
        JSON.stringify({ principalId: user, memberId }),
      );
    },
  },
  {
    method: "PUT",
    path: "/api/projects/:id/slack-channel",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      const p = await readJson<{ channel?: unknown }>(req, res);
      if (!p) return;
      const channel = typeof p.channel === "string" ? p.channel.trim().slice(0, 200) : "";
      if (!channel) return json(res, 400, { error: "bad_request", message: "channel required" });
      return relayCore(
        res,
        "PUT",
        `/v1/projects/${encodeURIComponent(id)}/slack-channel`,
        JSON.stringify({ principalId: user, channel }),
      );
    },
  },
  {
    method: "DELETE",
    path: "/api/projects/:id/slack-channel",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(
        res,
        "DELETE",
        `/v1/projects/${encodeURIComponent(id)}/slack-channel`,
        JSON.stringify({ principalId: user }),
      );
    },
  },
  {
    method: "DELETE",
    path: "/api/projects/:id/members/:memberId",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      const memberId = c.params.memberId!;
      return relayCore(
        res,
        "DELETE",
        `/v1/projects/${encodeURIComponent(id)}/members/${encodeURIComponent(memberId)}`,
        JSON.stringify({ principalId: user }),
      );
    },
  },
  {
    method: "GET",
    path: "/api/directory/resolve",
    handle: async (c) => {
      const { res, url } = c;
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
      if (!q) return json(res, 400, { error: "bad_request", message: "q required" });
      return relayCore(res, "GET", `/v1/directory/resolve?q=${encodeURIComponent(q)}`);
    },
  },
  {
    method: "GET",
    path: "/api/surface-config",
    handle: async (c) => {
      const { res } = c;
      return relayCore(res, "GET", "/v1/surface-config");
    },
  },
  {
    method: "GET",
    path: "/api/ui-state",
    handle: async (c) => {
      const { res, url, user } = c;
      const key = url.searchParams.get("key") ?? "";
      const qs = new URLSearchParams({ principalId: user, key });
      return relayCore(res, "GET", `/v1/ui-state?${qs.toString()}`);
    },
  },
  {
    method: "PUT",
    path: "/api/ui-state",
    handle: async (c) => {
      const { req, res, user } = c;
      const body = await readJson<Record<string, unknown>>(req, res);
      if (!body) return;
      return relayCore(res, "PUT", "/v1/ui-state", JSON.stringify({ ...body, principalId: user }));
    },
  },
  {
    method: "GET",
    path: "/api/im-bindings",
    handle: async (c) => {
      const { res, user } = c;
      return json(res, 200, publicImBindings(await readImBindings(user)));
    },
  },
  {
    method: "GET",
    path: "/api/im-bindings/status",
    handle: async (c) => {
      const { res, url, user } = c;
      const provider = url.searchParams.get("provider") ?? "";
      if (!isImProviderId(provider)) return json(res, 400, { error: "bad_request", message: "provider required" });
      try {
        if (provider === "wechat") await refreshWeixinBinding(user);
        const state = await readImBindings(user);
        const binding = state.bindings[provider];
        return json(res, 200, {
          binding: binding ? publicImBinding(binding, state.resources[provider]) : null,
        });
      } catch (error) {
        if (error instanceof ImResourceConflictError)
          return json(res, 409, { error: "resource_conflict", message: error.message });
        throw error;
      }
    },
  },
  {
    method: "POST",
    path: "/api/im-bindings/start",
    handle: async (c) => {
      const { req, res, user } = c;
      const body = await readJson<{ provider?: unknown }>(req, res, false);
      if (!body) return;
      const provider = typeof body.provider === "string" ? body.provider : "";
      if (!isImProviderId(provider)) return json(res, 400, { error: "bad_request", message: "unknown provider" });
      try {
        const binding = await startImBinding(user, provider);
        const state = await readImBindings(user);
        return json(res, 200, { binding: publicImBinding(binding, state.resources[provider]) });
      } catch (error) {
        if (error instanceof ImResourceConflictError)
          return json(res, 409, { error: "resource_conflict", message: error.message });
        throw error;
      }
    },
  },
  {
    method: "POST",
    path: "/api/im-bindings/wechat/verify",
    handle: async (c) => {
      const { req, res, user } = c;
      const body = await readJson<{ code?: unknown }>(req, res, false);
      if (!body) return;
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const binding = await verifyWeixinBinding(user, code);
      if (!binding) return json(res, 400, { error: "bad_request", message: "valid verification code required" });
      const state = await readImBindings(user);
      return json(res, 200, { binding: publicImBinding(binding, state.resources.wechat) });
    },
  },
  {
    method: "POST",
    path: "/api/im-bindings/:provider/credentials",
    handle: async (c) => {
      const { req, res, user } = c;
      const provider = c.params.provider ?? "";
      if (!isImProviderId(provider) || provider === "wechat") {
        return json(res, 400, { error: "bad_request", message: "unknown provider" });
      }
      const body = await readJson<{ credentials?: unknown; externalTenantId?: unknown; externalTenantName?: unknown }>(
        req,
        res,
        false,
      );
      if (!body) return;
      const parsed = imCredentials(provider, body.credentials);
      if (!parsed) return json(res, 400, { error: "bad_request", message: "请完整填写平台凭据" });
      const externalTenantId = imTextField(body.externalTenantId);
      const externalTenantName = imTextField(body.externalTenantName);
      try {
        const binding = await saveImSdkResource(
          user,
          provider,
          parsed.credentials,
          parsed.resourceId,
          undefined,
          undefined,
          externalTenantId,
          externalTenantName,
        );
        const state = await readImBindings(user);
        return json(res, 200, { binding: publicImBinding(binding, state.resources[provider]) });
      } catch (error) {
        if (error instanceof ImResourceConflictError)
          return json(res, 409, { error: "resource_conflict", message: error.message });
        return json(res, 400, {
          error: "invalid_credentials",
          message: error instanceof Error ? error.message : "平台凭据验证失败",
        });
      }
    },
  },
  {
    method: "POST",
    path: "/api/im-bindings/:provider/locate",
    handle: async (c) => {
      const { res, user } = c;
      const provider = c.params.provider ?? "";
      if (!isImProviderId(provider)) return json(res, 400, { error: "bad_request", message: "unknown provider" });
      try {
        const result = await locateImBot(user, provider);
        return json(res, 200, {
          queued: result.queued,
          sent: !result.queued,
          message: result.queued
            ? `定位消息已提交，请打开${result.label}查看`
            : `定位消息已发送，请打开${result.label}查看`,
        });
      } catch (error) {
        if (error instanceof ImBotTargetUnavailableError)
          return json(res, 409, { error: "target_unavailable", message: error.message });
        return json(res, 502, {
          error: "send_failed",
          message: error instanceof Error ? error.message : "定位消息发送失败",
        });
      }
    },
  },
  {
    method: "DELETE",
    path: "/api/im-bindings/:provider",
    handle: async (c) => {
      const { res, url, user } = c;
      const provider = c.params.provider ?? "";
      if (!isImProviderId(provider)) return json(res, 400, { error: "bad_request", message: "unknown provider" });
      const removed = await removeImBinding(user, provider, url.searchParams.get("forget") === "1");
      const state = await readImBindings(user);
      return json(res, 200, { removed, reusable: Boolean(state.resources[provider]) });
    },
  },
  {
    method: "GET",
    path: "/api/runtime-config",
    handle: async (c) => {
      const { res, url, user } = c;
      const scopeId = url.searchParams.get("scopeId") || `personal:${user}`;
      const qs = new URLSearchParams({ principalId: user, scopeId });
      return relayCore(res, "GET", `/v1/runtime-config?${qs.toString()}`);
    },
  },
  {
    method: "PUT",
    path: "/api/runtime-config",
    handle: async (c) => {
      const { req, res, user } = c;
      const body = await readJson<Record<string, unknown>>(req, res);
      if (!body) return;
      const scopeId = typeof body.scopeId === "string" && body.scopeId ? body.scopeId : `personal:${user}`;
      return relayCore(res, "PUT", "/v1/runtime-config", JSON.stringify({ ...body, principalId: user, scopeId }));
    },
  },
  {
    method: "GET",
    path: "/api/channel-header-pin",
    handle: async (c) => {
      const { res, url, user } = c;
      const scopeId = url.searchParams.get("scopeId") || `personal:${user}`;
      const qs = new URLSearchParams({ principalId: user, scopeId });
      return relayCore(res, "GET", `/v1/channel-header-pin?${qs.toString()}`);
    },
  },
  {
    method: "PUT",
    path: "/api/channel-header-pin",
    handle: async (c) => {
      const { req, res, user } = c;
      const body = await readJson<Record<string, unknown>>(req, res);
      if (!body) return;
      const scopeId = typeof body.scopeId === "string" && body.scopeId ? body.scopeId : `personal:${user}`;
      return relayCore(res, "PUT", "/v1/channel-header-pin", JSON.stringify({ ...body, principalId: user, scopeId }));
    },
  },
  {
    method: "GET",
    path: "/api/scope-resources",
    handle: async (c) => {
      const { res, url, user } = c;
      const scope = url.searchParams.get("scope");
      if (!scope) return json(res, 400, { error: "bad_request", message: "scope required" });
      const qs = new URLSearchParams({ principalId: user, scope });
      return relayCore(res, "GET", `/v1/scope-resources?${qs.toString()}`);
    },
  },
  {
    method: "GET",
    path: "/api/skills",
    handle: async (c) => {
      const { res, url, user } = c;
      const qs = new URLSearchParams({ principalId: user });
      if (url.searchParams.get("includeShadowed") === "1") qs.set("includeShadowed", "1");
      return relayCore(res, "GET", `/v1/skills?${qs.toString()}`);
    },
  },
  {
    method: "GET",
    path: "/api/skills/:id",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(res, "GET", `/v1/skills/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`);
    },
  },
  {
    method: "POST",
    path: "/api/skills",
    handle: async (c) => {
      const { req, res, user } = c;
      const p = await readJson<{ name?: unknown; description?: unknown; body?: unknown; scopeId?: unknown }>(req, res);
      if (!p) return;
      const draft: { name?: string; description?: string; body?: string; scopeId?: string } = {};
      if (typeof p.name === "string") draft.name = p.name;
      if (typeof p.description === "string") draft.description = p.description;
      if (typeof p.body === "string") draft.body = p.body;
      if (typeof p.scopeId === "string") draft.scopeId = p.scopeId;
      return relayCore(res, "POST", "/v1/skills", JSON.stringify({ principalId: user, ...draft }));
    },
  },
  {
    method: "PUT",
    path: "/api/skills/:id",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      const p = await readJson<{ description?: unknown; body?: unknown }>(req, res);
      if (!p) return;
      const patch: { description?: string; body?: string } = {};
      if (typeof p.description === "string") patch.description = p.description;
      if (typeof p.body === "string") patch.body = p.body;
      return relayCore(
        res,
        "PUT",
        `/v1/skills/${encodeURIComponent(id)}`,
        JSON.stringify({ principalId: user, ...patch }),
      );
    },
  },
  {
    method: "DELETE",
    path: "/api/skills/:id",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(res, "DELETE", `/v1/skills/${encodeURIComponent(id)}`, JSON.stringify({ principalId: user }));
    },
  },
  {
    method: "POST",
    path: "/api/skills/:id/restore",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(
        res,
        "POST",
        `/v1/skills/${encodeURIComponent(id)}/restore`,
        JSON.stringify({ principalId: user }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/sessions/:id/title",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(
        res,
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/title`,
        JSON.stringify({ principalId: user }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/sessions/:id/fork",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      const p = await readJson<{ upToSeq?: unknown }>(req, res);
      if (!p) return;
      const upToSeq = typeof p.upToSeq === "number" ? p.upToSeq : undefined;
      return relayCore(
        res,
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/fork`,
        JSON.stringify({ principalId: user, ...(upToSeq !== undefined ? { upToSeq } : {}) }),
      );
    },
  },
  {
    method: "GET",
    path: "/api/sessions/:id/approvals",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(
        res,
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/approvals?viewer=${encodeURIComponent(user)}`,
      );
    },
  },
  {
    method: "GET",
    path: "/api/sessions/:id/background/:pid/output",
    handle: async (c) => {
      const { res, url, user } = c;
      const id = c.params.id!;
      const pid = c.params.pid!;
      const sinceCursor = url.searchParams.get("sinceCursor") ?? "0";
      return relayCore(
        res,
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/background/${encodeURIComponent(pid)}/output?viewer=${encodeURIComponent(user)}&sinceCursor=${encodeURIComponent(sinceCursor)}`,
      );
    },
  },
  {
    method: "GET",
    path: "/api/sessions/:id/background",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(
        res,
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/background?viewer=${encodeURIComponent(user)}`,
      );
    },
  },
  {
    method: "GET",
    path: "/api/sessions/:id/entries/:seq",
    handle: async (c) => {
      const { res, user } = c;
      const { id, seq } = c.params as { id: string; seq: string };
      if (!/^\d+$/.test(seq)) return json(c.res, 404, { error: "not found" });
      return relayCore(
        res,
        "GET",
        `/v1/sessions/${encodeURIComponent(id)}/entries/${seq}?viewer=${encodeURIComponent(user)}`,
      );
    },
  },
  {
    method: "GET",
    path: "/api/sessions/:id",
    handle: async (c) => {
      const { res, url, user } = c;
      const id = c.params.id!;
      const qs = new URLSearchParams({ viewer: user });
      for (const p of ["tailTurns", "sinceSeq", "beforeSeq"] as const) {
        const v = url.searchParams.get(p);
        if (v !== null) qs.set(p, v);
      }
      return relayCore(res, "GET", `/v1/sessions/${encodeURIComponent(id)}?${qs.toString()}`);
    },
  },
  {
    method: "GET",
    path: "/api/files/:id/content",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      const corePath = withSourceAuthNonce(
        `/v1/files/${encodeURIComponent(id)}/content?viewer=${encodeURIComponent(user)}`,
        CORE_SIGNING_SECRET,
      );
      const portalTok = portalTokenStore.getStore();
      const r = await fetch(`${CORE}${corePath}`, {
        headers: {
          ...signedHeaders(CORE_SIGNING_SECRET, "GET", corePath, ""),
          ...(portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : {}),
        },
        redirect: "manual",
      });
      if (!r.ok || !r.body) {
        res.writeHead(r.status === 404 ? 404 : 502, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: r.status === 404 ? "not_found" : "upstream_error" }));
      }
      res.writeHead(200, {
        "content-type": r.headers.get("content-type") ?? "application/octet-stream",
        ...(r.headers.get("content-length") ? { "content-length": r.headers.get("content-length")! } : {}),
        ...(r.headers.get("content-disposition")
          ? { "content-disposition": r.headers.get("content-disposition")! }
          : {}),
        "content-security-policy": UNTRUSTED_CONTENT_SANDBOX_CSP,
        "x-content-type-options": "nosniff",
      });
      return Readable.fromWeb(r.body as Parameters<typeof Readable.fromWeb>[0]).pipe(res);
    },
  },
  {
    method: "GET",
    path: "/api/files",
    handle: async (c) => {
      const { res, url, user } = c;
      const qs = new URLSearchParams({ viewer: user });
      const limit = url.searchParams.get("limit");
      if (limit) qs.set("limit", limit);
      const cursor = url.searchParams.get("cursor");
      if (cursor) qs.set("cursor", cursor);
      const scope = url.searchParams.get("scope");
      if (scope) qs.set("scope", scope);
      return relayCore(res, "GET", `/v1/files?${qs.toString()}`);
    },
  },
  {
    method: "GET",
    path: "/api/memory",
    handle: async (c) => {
      const { res, user } = c;
      return relayCore(res, "GET", `/v1/memory?principalId=${encodeURIComponent(user)}`);
    },
  },
  {
    method: "GET",
    path: "/api/memory/history",
    handle: async (c) => {
      const { res, user } = c;
      return relayCore(res, "GET", `/v1/memory/history?principalId=${encodeURIComponent(user)}`);
    },
  },
  {
    method: "POST",
    path: "/api/memory/restore",
    handle: async (c) => {
      const { req, res, user } = c;
      const p = await readJson<{ revision?: unknown; expectedRevision?: unknown }>(req, res, false);
      if (!p) return;
      const revision = typeof p.revision === "string" ? p.revision : "";
      const expectedRevision = typeof p.expectedRevision === "string" ? p.expectedRevision : "";
      return relayCore(
        res,
        "POST",
        "/v1/memory/restore",
        JSON.stringify({ principalId: user, revision, expectedRevision }),
      );
    },
  },
  {
    method: "PUT",
    path: "/api/memory",
    handle: async (c) => {
      const { req, res, user } = c;
      const p = await readJson<{ content?: unknown; revision?: unknown }>(req, res, false);
      if (!p) return;
      if (typeof p.content !== "string")
        return json(res, 400, { error: "bad_request", message: "content must be a string" });
      const content = p.content;
      const revision =
        typeof p.revision === "string"
          ? p.revision
          : await coreFetch("GET", `/v1/memory?principalId=${encodeURIComponent(user)}`).then((head) => {
              try {
                return String((JSON.parse(head.text) as { revision?: unknown }).revision ?? "");
              } catch {
                return "";
              }
            });
      return relayCore(res, "PUT", "/v1/memory", JSON.stringify({ principalId: user, content, revision }));
    },
  },
  {
    method: "POST",
    path: "/api/sessions/:id",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      const p = await readJson<{ title?: unknown; archived?: unknown; pinned?: unknown; color?: unknown }>(
        req,
        res,
        false,
      );
      if (!p) return;
      const patch: { title?: string | null; archived?: boolean; pinned?: boolean; color?: string | null } = {};
      if (p.title === null || typeof p.title === "string") patch.title = p.title as string | null;
      if (typeof p.archived === "boolean") patch.archived = p.archived;
      if (typeof p.pinned === "boolean") patch.pinned = p.pinned;
      if (p.color === null || typeof p.color === "string") patch.color = p.color as string | null;
      if (
        patch.title === undefined &&
        patch.archived === undefined &&
        patch.pinned === undefined &&
        patch.color === undefined
      ) {
        return json(res, 400, { error: "bad_request", message: "title, archived, pinned, or color required" });
      }
      return relayCore(
        res,
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}`,
        JSON.stringify({ principalId: user, ...patch }),
      );
    },
  },
  {
    method: "GET",
    path: "/api/connectors",
    handle: async (c) => {
      const { res, user } = c;
      return relayCore(res, "GET", `/v1/connectors/oauth/status?principalId=${encodeURIComponent(user)}`);
    },
  },
  {
    method: "POST",
    path: "/api/connectors/:provider/start",
    handle: async (c) => {
      const { res, user } = c;
      const provider = c.params.provider!;
      const callback = `${PUBLIC_URL}/v1/connectors/oauth/${encodeURIComponent(provider)}/callback`;
      const params = new URLSearchParams({ principalId: user, redirectUri: callback, returnTo: "/keychain" });
      const corePath = `/v1/connectors/oauth/${encodeURIComponent(provider)}/start?${params.toString()}`;
      return relayCore(res, "GET", corePath);
    },
  },
  {
    method: "POST",
    path: "/api/connectors/revoke",
    handle: async (c) => {
      const { req, res, user } = c;
      const p = await readJson<{ provider?: unknown; host?: unknown }>(req, res, false);
      if (!p) return;
      const provider = typeof p.provider === "string" ? p.provider : "";
      const host = typeof p.host === "string" ? p.host : "";
      if (!provider && !host) return json(res, 400, { error: "bad_request", message: "provider or host required" });
      const rawBody = JSON.stringify({ principalId: user, ...(provider ? { provider } : { host }) });
      return relayCore(res, "POST", "/v1/connectors/oauth/revoke", rawBody);
    },
  },
  {
    method: "GET",
    path: "/api/keychain/credentials",
    handle: async (c) => {
      const { res } = c;
      return relayCap(res, "GET", "/v1/keychain/credentials");
    },
  },
  {
    method: "GET",
    path: "/api/keychain/overview",
    handle: async (c) => {
      const { res } = c;
      return relayCap(res, "GET", "/v1/keychain/overview");
    },
  },
  {
    method: "POST",
    path: "/api/keychain/grants/:id/revoke",
    handle: async (c) => {
      const { res } = c;
      const id = c.params.id!;
      return relayCap(res, "POST", `/v1/keychain/grants/${encodeURIComponent(id)}/revoke`, "{}");
    },
  },
  {
    method: "POST",
    path: "/api/keychain/drops",
    handle: async (c) => {
      const { req, res } = c;
      const p = await readJson<{ service?: unknown; purpose?: unknown; envKey?: unknown }>(req, res, false);
      if (!p) return;
      const draft = {
        ...(typeof p.service === "string" ? { service: p.service } : {}),
        ...(typeof p.purpose === "string" ? { purpose: p.purpose } : {}),
        ...(typeof p.envKey === "string" ? { envKey: p.envKey } : {}),
      };
      return relayCap(res, "POST", "/v1/keychain/drops", JSON.stringify(draft));
    },
  },
  {
    method: "DELETE",
    path: "/api/keychain/credentials/:id",
    handle: async (c) => {
      const { res } = c;
      const id = c.params.id!;
      if (!id) return json(res, 400, { error: "bad_request", message: "credential id required" });
      return relayCap(res, "DELETE", `/v1/keychain/credentials/${encodeURIComponent(id)}`);
    },
  },
  {
    method: "GET",
    path: "/api/deployments/:id/owner-url",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      if (!id || id.includes("/")) return json(res, 404, { error: "not_found" });
      return relayCore(
        res,
        "GET",
        `/v1/deployments/${encodeURIComponent(id)}/owner-url?principalId=${encodeURIComponent(user)}`,
      );
    },
  },
  {
    method: "GET",
    path: "/api/deployments",
    handle: async (c) => {
      const { res, user } = c;
      const r = await coreFetch("GET", `/v1/deployments?principalId=${encodeURIComponent(user)}`);
      if (r.status !== 200) {
        return relay(res, r);
      }
      let deployments: Array<Record<string, unknown>>;
      try {
        const parsed = JSON.parse(r.text) as { deployments?: Array<Record<string, unknown>> };
        deployments = parsed.deployments ?? [];
      } catch {
        return json(res, 502, { error: "bad_core_response" });
      }
      return json(res, 200, {
        deployments: deployments.map((d) => ({ ...d, webUrl: `/deployments/${encodeURIComponent(String(d.id))}/` })),
      });
    },
  },
  {
    method: "GET",
    path: "/api/deployments/:id",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      if (!id || id.includes("/")) return json(res, 404, { error: "not_found" });
      const r = await coreFetch(
        "GET",
        `/v1/deployments/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`,
      );
      if (r.status !== 200) return relay(res, r);
      try {
        const parsed = JSON.parse(r.text) as { deployment?: Record<string, unknown> };
        if (!parsed.deployment) return json(res, 502, { error: "bad_core_response" });
        return json(res, 200, {
          deployment: {
            ...parsed.deployment,
            webUrl: `/deployments/${encodeURIComponent(String(parsed.deployment.id))}/`,
          },
        });
      } catch {
        return json(res, 502, { error: "bad_core_response" });
      }
    },
  },
  {
    method: "POST",
    path: "/api/deployments/:id/display-name",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      if (!(await gateManageDeployment(res, user, id))) return;
      const p = await readJson<{ displayName?: unknown }>(req, res, false);
      if (!p) return;
      const displayName = String(p.displayName ?? "");
      return relayCore(
        res,
        "POST",
        `/v1/deployments/${encodeURIComponent(id)}/display-name`,
        JSON.stringify({ displayName }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/deployments/:id/name",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      if (!(await gateManageDeployment(res, user, id))) return;
      const p = await readJson<{ name?: unknown }>(req, res, false);
      if (!p) return;
      const name = String(p.name ?? "");
      return relayCore(res, "POST", `/v1/deployments/${encodeURIComponent(id)}/name`, JSON.stringify({ name }));
    },
  },
  {
    method: "POST",
    path: "/api/deployments/:id/archive",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      if (!(await gateManageDeployment(res, user, id))) return;
      return relayCore(res, "POST", `/v1/deployments/${encodeURIComponent(id)}/archive`);
    },
  },
  {
    method: "POST",
    path: "/api/deployments/:id/restore",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      if (!(await gateManageDeployment(res, user, id))) return;
      return relayCore(
        res,
        "POST",
        `/v1/deployments/${encodeURIComponent(id)}/restore`,
        JSON.stringify({ principalId: user }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/approvals/:requestId",
    handle: async (c) => {
      const { req, res, user } = c;
      const requestId = c.params.requestId!;
      if (!requestId || requestId.includes("/")) return json(res, 404, { error: "not_found" });
      let approved = false;
      let scope: "once" | "session" | "always" | undefined;
      try {
        const p = JSON.parse(await readBody(req)) as { approved?: unknown; scope?: unknown };
        approved = p.approved === true;
        if (p.scope === "once" || p.scope === "session" || p.scope === "always") scope = p.scope;
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
      }

      const fetched = await coreFetch("GET", `/v1/approvals/${encodeURIComponent(requestId)}`);
      if (fetched.status !== 200) {
        res.writeHead(fetched.status, { "content-type": "application/json" });
        return res.end(fetched.text);
      }
      let record: CoreApprovalRecord;
      try {
        record = JSON.parse(fetched.text) as CoreApprovalRecord;
      } catch {
        return json(res, 502, { error: "bad_core_response" });
      }
      const threadRef =
        typeof record.request?.conversation?.threadRef === "string" ? record.request.conversation.threadRef : "";
      const actor = typeof record.request?.actor?.externalId === "string" ? record.request.actor.externalId : "";
      if (!threadRef.startsWith("web:") || actor !== user || !record.request) {
        return json(res, 404, { error: "not_found" });
      }
      if (!threadRef.startsWith(`web:${user}:`)) {
        const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
        const visible = sessionId
          ? await coreFetch(
              "GET",
              `/v1/sessions/${encodeURIComponent(sessionId)}?viewer=${encodeURIComponent(user)}&tailTurns=1`,
            )
          : null;
        if (visible?.status !== 200) return json(res, 404, { error: "not_found" });
      }

      const approval = { requestId, approved, ...(scope ? { scope } : {}) };
      return postTurnAndMint(res, { ...record.request, approval }, user, threadRef);
    },
  },
  {
    method: "POST",
    path: "/api/turn",
    handle: async (c) => {
      const { req, res, user } = c;
      const ownPrefix = `web:${user}:`;
      let text = "";
      let threadRef = `${ownPrefix}default`;
      let model: string | undefined;
      let harness: string | undefined;
      let thinkingLevel: string | undefined;
      let fastMode: boolean | undefined;
      let timezone: string | undefined;
      let scope: string | undefined;
      let channelName: string | undefined;
      const attachments: CoreAttachment[] = [];
      let approval: { requestId: string; approved: boolean; scope?: string } | undefined;
      let proactiveOpener = false;
      try {
        const p = JSON.parse(await readBody(req));
        text = String(p.text ?? "");
        if (p.proactiveOpener === true) proactiveOpener = true;
        if (p.approval && typeof p.approval.requestId === "string" && typeof p.approval.approved === "boolean") {
          approval = {
            requestId: p.approval.requestId,
            approved: p.approval.approved,
            ...(p.approval.scope === "once" || p.approval.scope === "session" || p.approval.scope === "always"
              ? { scope: p.approval.scope }
              : {}),
          };
        }
        if (typeof p.threadRef === "string" && p.threadRef.startsWith("web:")) threadRef = p.threadRef;
        if (typeof p.scopeId === "string" && p.scopeId) scope = p.scopeId;
        if (typeof p.channelName === "string" && p.channelName.trim()) channelName = p.channelName.trim().slice(0, 200);
        if (typeof p.model === "string" && p.model) model = p.model;
        if (typeof p.harness === "string") harness = p.harness;
        if (typeof p.thinkingLevel === "string") thinkingLevel = p.thinkingLevel;
        if (typeof p.fastMode === "boolean") fastMode = p.fastMode;
        if (typeof p.timezone === "string" && p.timezone.trim()) timezone = p.timezone.trim().slice(0, 64);
        if (Array.isArray(p.attachments)) {
          for (const raw of p.attachments as unknown[]) {
            if (!raw || typeof raw !== "object") continue;
            const a = raw as { name?: unknown; mimetype?: unknown; sizeBytes?: unknown; blobId?: unknown };
            if (typeof a.name !== "string" || typeof a.blobId !== "string" || !a.blobId) continue;
            attachments.push({
              name: a.name,
              mimetype: typeof a.mimetype === "string" && a.mimetype ? a.mimetype : "application/octet-stream",
              sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0,
              blobId: a.blobId,
            });
          }
        }
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
      }
      if (!text.trim() && attachments.length === 0 && !approval && !proactiveOpener)
        return json(res, 400, { error: "empty message" });

      if (!threadRef.startsWith(ownPrefix) && !(scope?.startsWith("channel:") || scope?.startsWith("group:"))) {
        return json(res, 403, {
          error: "forbidden_thread",
          message: "this conversation can only be continued from its own context",
        });
      }

      const conversation = conversationForScope(user, threadRef, scope, channelName);
      if (!conversation) {
        return json(res, 403, {
          error: "forbidden_scope",
          message: "you can only chat in your personal context or a shared context you're in",
        });
      }

      const displayName = resolveIdentity(req)?.name ?? null;
      const turn = {
        surface: "web",
        actor: { externalId: user, ...(displayName ? { displayName } : {}) },
        conversation,
        liveActor: true,
        deliveryTarget: threadRef,
        text,
        ...(harness ? { harness } : {}),
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        ...(typeof fastMode === "boolean" ? { fastMode } : {}),
        ...(timezone ? { timezone } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(approval ? { approval } : {}),
        ...(proactiveOpener ? { proactiveOpener: true } : {}),
      };
      return postTurnAndMint(res, turn, user, threadRef);
    },
  },
  {
    method: "GET",
    path: "/api/deliveries/events",
    handle: async (c) => {
      const { req, res, user } = c;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": open\n\n");
      let set = deliveryClients.get(user);
      if (!set) {
        set = new Set();
        deliveryClients.set(user, set);
      }
      set.add(res);
      const beat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
      beat.unref?.();
      req.on("close", () => {
        clearInterval(beat);
        const s = deliveryClients.get(user);
        if (s) {
          s.delete(res);
          if (!s.size) deliveryClients.delete(user);
        }
      });
      return;
    },
  },
  {
    method: "GET",
    path: "/api/runs/active",
    handle: async (c) => {
      const { res, url, user } = c;
      const threadRef = url.searchParams.get("threadRef") ?? "";
      if (!threadRef.startsWith("web:")) return json(res, 404, { error: "not_found" });
      let queued: Array<{ runId: string; text: string }> = [];
      let durableRunId: string | null = null;
      const durable = await coreFetch("GET", `/v1/runs?threadRef=${encodeURIComponent(threadRef)}`);
      if (durable.status >= 200 && durable.status < 300) {
        try {
          const parsed = JSON.parse(durable.text) as { runId?: string | null; queued?: typeof queued };
          durableRunId = parsed.runId ?? null;
          queued = parsed.queued ?? [];
        } catch {
          queued = [];
          durableRunId = null;
        }
      }
      const tryRun = async (runId: string, ownedByUser = true): Promise<boolean> => {
        const r = await coreFetch("GET", `/v1/runs/${encodeURIComponent(runId)}`);
        if (r.status < 200 || r.status >= 300) {
          if (ownedByUser) forgetRun(runId);
          return false;
        }
        let run: { status?: string };
        try {
          run = JSON.parse(r.text) as { status?: string };
        } catch {
          json(res, 502, { error: "bad_core_response" });
          return true;
        }
        if (run.status === "done" || run.status === "failed") {
          forgetRun(runId);
          return false;
        }
        rememberRun(runId, user, threadRef);
        const waiting = queued.filter((q) => q.runId !== runId);
        json(res, 200, { runId, run, ...(waiting.length ? { queued: waiting } : {}) });
        return true;
      };
      if (durableRunId && (await tryRun(durableRunId, false))) return;
      for (const runId of Array.from(activeRunsByThread.get(threadKey(user, threadRef)) ?? [])) {
        if (await tryRun(runId)) return;
      }
      json(res, 200, { runId: null, run: null, ...(queued.length ? { queued } : {}) });
      return;
    },
  },
  {
    method: "POST",
    path: "/api/runs/:id/signal",
    handle: async (c) => {
      const { req, res } = c;
      const id = c.params.id!;
      const p = await readJson<{ kind?: unknown; text?: unknown }>(req, res, false);
      if (!p) return;
      const kind = typeof p.kind === "string" ? p.kind : "";
      const text = typeof p.text === "string" ? p.text : undefined;
      return relayCore(
        res,
        "POST",
        `/v1/runs/${encodeURIComponent(id)}/signal`,
        JSON.stringify({ kind, ...(text !== undefined ? { text } : {}) }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/runs/:id/withdraw",
    handle: async (c) => {
      const { res } = c;
      const id = c.params.id!;
      const r = await coreFetch("POST", `/v1/runs/${encodeURIComponent(id)}/withdraw`);
      if (r.status >= 200 && r.status < 300) forgetRun(id);
      return relay(res, r);
    },
  },
  {
    method: "GET",
    path: "/api/runs/:id/events",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      let closed = false;
      req.on("close", () => {
        closed = true;
      });
      if (!ownsRun(id, user)) {
        const auth = await coreFetch("GET", `/v1/runs/${encodeURIComponent(id)}`);
        if (auth.status < 200 || auth.status >= 300)
          return json(res, auth.status === 404 ? 404 : 502, {
            error: auth.status === 404 ? "not_found" : "upstream_error",
          });
      }
      if (closed) return;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": open\n\n");
      let acc = "";
      let activityLen = 0;
      let lastStale: boolean | null = null;
      let staleSince: number | null = null;
      let lastProgressAt = Date.now();
      let lastBeat = lastProgressAt;
      for (;;) {
        if (closed) return;
        let r: { status: number; text: string };
        try {
          r = await coreFetch("GET", `/v1/runs/${encodeURIComponent(id)}`);
        } catch {
          try {
            r = await coreFetch("GET", `/v1/runs/${encodeURIComponent(id)}`);
          } catch {
            sseEvent(res, "failed", { reason: "upstream_unreachable" });
            break;
          }
        }
        if (closed) return;
        if (r.status < 200 || r.status >= 300) {
          sseEvent(res, "failed", { reason: `HTTP ${r.status}` });
          break;
        }
        let run: {
          status?: string;
          result?: unknown;
          partial?: string;
          alive?: boolean;
          stale?: boolean;
          replyComplete?: boolean;
          activity?: unknown[];
          startedAt?: number | null;
          finishedAt?: number | null;
        } = {};
        let parsed = true;
        try {
          run = JSON.parse(r.text);
        } catch {
          parsed = false;
        }
        const now = Date.now();
        const partial = typeof run.partial === "string" ? run.partial : "";
        const activity = Array.isArray(run.activity) ? run.activity : [];
        if (partial.length > acc.length) {
          acc = partial;
          sseEvent(res, "partial", { partial: acc });
          lastProgressAt = now;
          lastBeat = now;
        }
        if (activity.length > activityLen) {
          activityLen = activity.length;
          sseEvent(res, "activity", { activity, startedAt: run.startedAt ?? null });
          lastProgressAt = now;
          lastBeat = now;
        }
        if (parsed) {
          if (run.stale === true) staleSince ??= now;
          else staleSince = null;
          if ((run.stale === true) !== lastStale) {
            lastStale = run.stale === true;
            sseEvent(res, "stale", { stale: lastStale });
            lastBeat = now;
          }
        }
        if (now - lastBeat > SSE_HEARTBEAT_MS) {
          if (run.alive === true) sseEvent(res, "alive", { at: now });
          else if (lastStale === true) sseEvent(res, "stale", { stale: true });
          else res.write(": ping\n\n");
          lastBeat = now;
        }
        if (run.alive === true || (staleSince !== null && now - staleSince < SSE_STALE_GRACE_MS)) lastProgressAt = now;
        const terminal = run.status === "done" || run.status === "failed" || run.result != null;
        if (terminal || run.replyComplete) {
          forgetRun(id);
          sseEvent(res, "done", {
            status: run.status ?? null,
            result: run.result ?? null,
            partial: acc,
            activity,
            replyComplete: run.replyComplete ?? false,
            startedAt: run.startedAt ?? null,
            finishedAt: run.finishedAt ?? null,
          });
          break;
        }
        if (now - lastProgressAt > SSE_IDLE_MS) break;
        await sleep(lastStale === true ? SSE_STALE_POLL_MS : SSE_CORE_POLL_MS);
      }
      if (!closed) res.end();
      return;
    },
  },
  {
    method: "GET",
    path: "/api/runs/:id",
    handle: async (c) => {
      const { res } = c;
      const id = c.params.id!;
      const r = await coreFetch("GET", `/v1/runs/${encodeURIComponent(id)}`);
      try {
        const s = (JSON.parse(r.text) as { status?: string }).status;
        if (s === "done" || s === "failed") forgetRun(id);
      } catch {
        void 0;
      }
      return relay(res, r);
    },
  },
  {
    method: "GET",
    path: "/api/crons",
    handle: async (c) => {
      const { res, user } = c;
      const r = await coreFetch("GET", `/v1/crons?viewer=${encodeURIComponent(user)}`);
      if (r.status < 200 || r.status >= 300) {
        return relay(res, r);
      }
      let crons: CoreCron[] = [];
      let visible: CoreCron[] = [];
      try {
        const parsed = JSON.parse(r.text) as { crons?: CoreCron[]; visible?: CoreCron[] };
        crons = parsed.crons ?? [];
        visible = parsed.visible ?? [];
      } catch {
        void 0;
      }
      return json(res, 200, { crons, visible });
    },
  },
  {
    method: "GET",
    path: "/api/crons/:id/runs",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relay(
        res,
        await coreFetch(
          "GET",
          `/v1/crons/${encodeURIComponent(id)}/runs?principalId=${encodeURIComponent(user)}&limit=20`,
        ),
      );
    },
  },
  {
    method: "PATCH",
    path: "/api/crons/:id",
    handle: async (c) => {
      const { req, res, user } = c;
      const id = c.params.id!;
      let patch: { title?: string; task?: string; schedule?: unknown; enabled?: boolean; archived?: boolean } = {};
      try {
        const p = JSON.parse(await readBody(req)) as {
          title?: unknown;
          task?: unknown;
          schedule?: unknown;
          enabled?: unknown;
          archived?: unknown;
        };
        if ("title" in p) {
          if (typeof p.title !== "string")
            return json(res, 400, { error: "bad_request", message: "title must be a string" });
          patch = { ...patch, title: p.title.trim() };
        }
        if ("task" in p) {
          if (typeof p.task !== "string" || !p.task.trim())
            return json(res, 400, { error: "bad_request", message: "task must be a non-empty string" });
          patch = { ...patch, task: p.task.trim() };
        }
        if ("schedule" in p) patch = { ...patch, schedule: p.schedule };
        if ("enabled" in p) {
          if (typeof p.enabled !== "boolean")
            return json(res, 400, { error: "bad_request", message: "enabled must be a boolean" });
          patch = { ...patch, enabled: p.enabled };
        }
        if ("archived" in p) {
          if (typeof p.archived !== "boolean")
            return json(res, 400, { error: "bad_request", message: "archived must be a boolean" });
          patch = { ...patch, archived: p.archived };
        }
      } catch (e) {
        if (e instanceof PayloadTooLargeError) throw e;
        return json(res, 400, { error: "bad_request", message: "expected JSON body" });
      }
      if (Object.keys(patch).length === 0)
        return json(res, 400, {
          error: "bad_request",
          message: "expected title, task, schedule, enabled, or archived",
        });
      if (patch.archived === true) patch = { ...patch, enabled: false };
      return relayCore(
        res,
        "PATCH",
        `/v1/crons/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`,
        JSON.stringify(patch),
      );
    },
  },
  {
    method: "POST",
    path: "/api/crons/:id/disable",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(
        res,
        "POST",
        `/v1/crons/${encodeURIComponent(id)}/disable?principalId=${encodeURIComponent(user)}`,
      );
    },
  },
  {
    method: "POST",
    path: "/api/crons/:id/enable",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(
        res,
        "PATCH",
        `/v1/crons/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`,
        JSON.stringify({ enabled: true, archived: false }),
      );
    },
  },
  {
    method: "POST",
    path: "/api/crons/:id/run",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(res, "POST", `/v1/crons/${encodeURIComponent(id)}/run?principalId=${encodeURIComponent(user)}`);
    },
  },
  {
    method: "DELETE",
    path: "/api/crons/:id",
    handle: async (c) => {
      const { res, user } = c;
      const id = c.params.id!;
      return relayCore(res, "DELETE", `/v1/crons/${encodeURIComponent(id)}?principalId=${encodeURIComponent(user)}`);
    },
  },
];

const routeRequest = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/healthz") return json(res, 200, { ok: true });
  if (method === "GET" && path === "/favicon.svg") {
    return serveEmojiFavicon(res, process.env.WEB_UI_FAVICON_EMOJI ?? "\u{1F3F4}\u{200D}\u2620\uFE0F", "no-cache");
  }

  if (method === "POST" && path === "/signin") {
    if (!COOKIE_AUTH) return json(res, 404, { error: "not_found" });
    const body = await readBody(req);
    const id = (() => {
      try {
        return String(JSON.parse(body).user ?? "").trim();
      } catch {
        return "";
      }
    })();
    if (!id) return json(res, 400, { error: "bad_request", message: "Enter a principal to sign in as." });
    if (ALLOW.length > 0 && !ALLOW.includes(id))
      return json(res, 403, {
        error: "not_allowed",
        message: `${id.slice(0, 120)} isn't in this instance's allowed principals. Add it to WEB_UI_PRINCIPALS, or leave that unset to allow any principal.`,
      });
    res.writeHead(200, {
      "set-cookie": sessionCookie(id),
      "content-type": "application/json",
    });
    return res.end(JSON.stringify({ ok: true, user: id }));
  }

  if (method === "POST" && path === "/signout") {
    res.writeHead(200, { "set-cookie": "webuiuser=; HttpOnly; Path=/; Max-Age=0", "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  let oauthCallbackPrefix: string | null = null;
  if (path.startsWith("/v1/connectors/oauth/")) oauthCallbackPrefix = "/v1/connectors/oauth/";
  else if (path.startsWith("/connectors/oauth/")) oauthCallbackPrefix = "/connectors/oauth/";
  if (method === "GET" && oauthCallbackPrefix && path.endsWith("/callback")) {
    const provider = path.slice(oauthCallbackPrefix.length, -"/callback".length);
    const corePath = `/v1/connectors/oauth/${encodeURIComponent(provider)}/callback${url.search}`;
    let ok: boolean;
    try {
      const r = await fetch(`${CORE}${corePath}`, { redirect: "manual" });
      ok = r.status >= 200 && r.status < 300;
    } catch {
      ok = false;
    }
    const q = `view=keychain&connector=${encodeURIComponent(provider)}&status=${ok ? "connected" : "error"}`;
    return sendHtml(res, ok ? 200 : 400, callbackHtml(q));
  }

  if (path === "/me" || path.startsWith("/api/")) {
    const user = cookieUser(req);
    if (!user) return unauthorized(res, req);
    const found = findRoute(apiRoutes, method, path);
    if (!found) return json(res, 404, { error: "not found" });
    return found.route.handle({ req, res, url, user, params: found.params });
  }

  if (method === "GET" && path.startsWith("/deployments/")) {
    const user = cookieUser(req);
    if (!user) return unauthorized(res, req);
    const rest = path.slice("/deployments/".length);
    const slash = rest.indexOf("/");
    const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const subPath = slash === -1 ? "/" : rest.slice(slash);
    const corePath = `/d/${encodeURIComponent(id)}${subPath}${url.search}`;
    const portalTok = portalTokenStore.getStore();
    const headers: Record<string, string> = {
      ...signedHeaders(CORE_SIGNING_SECRET, method, corePath, "", user),
      "x-as-principal": user,
      ...(portalTok ? { [PORTAL_IDENTITY_HEADER]: portalTok } : {}),
    };
    delete headers["content-type"];
    const up = await fetch(`${CORE}${corePath}`, { method, headers, redirect: "manual" });
    const outHeaders = Object.fromEntries(up.headers.entries());
    delete outHeaders["content-encoding"];
    delete outHeaders["content-length"];
    res.writeHead(up.status, {
      ...outHeaders,
      "content-security-policy": UNTRUSTED_CONTENT_SANDBOX_CSP,
      "x-content-type-options": "nosniff",
    });
    return res.end(Buffer.from(await up.arrayBuffer()));
  }

  if (method === "GET" && path === "/app-edit" && (await serveAppEditHtml(req, res, url))) return;

  if (method === "GET") {
    if (await serveVite(req, res, path)) return;
    return await serveStatic(res, path === "/" ? "/index.html" : path);
  }

  json(res, 404, { error: "not found" });
};

export const handler = async (req: IncomingMessage, res: ServerResponse) => {
  res.setHeader("strict-transport-security", "max-age=63072000; includeSubDomains");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("x-frame-options", "DENY");
  const raw = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(raw) ? raw[0] : raw;
  try {
    await portalTokenStore.run(token, () => routeRequest(req, res));
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      if (!res.headersSent) json(res, 413, { error: "payload_too_large", message: err.message });
      else res.end();
      return;
    }
    throw err;
  }
};

const server = createServer((req, res) => {
  void handler(req, res).catch((err: unknown) => {
    console.error("[web-ui] 502 %s %s: %s", req.method ?? "?", req.url ?? "?", String(err));
    if (!res.headersSent) json(res, 502, { error: "bad_gateway", message: "upstream error" });
    else res.end();
  });
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createVite(server)
    .then((v) => {
      vite = v;
      server.listen(PORT, () => {
        console.log(
          `[web-ui] surface on http://localhost:${PORT} → core ${CORE} (org ${ORG})${WEB_UI_DEV ? " [vite hmr]" : ""}`,
        );
        if (!WEB_UI_DEV && !existsSync(join(DIST, "index.html")))
          console.warn("[web-ui] dist-web/ not built — run `npm run build`");
        if (COOKIE_AUTH && ALLOW.length === 0)
          console.warn("[web-ui] WEB_UI_PRINCIPALS unset — any principal id may sign in (dev only)");
        const t = setInterval(() => void drainWebDeliveries(), WEB_DELIVERY_POLL_MS);
        t.unref?.();
        const imBridgeTimer = setInterval(() => {
          void syncImBridges().catch((error: unknown) => console.error("[web-ui] IM bridge failed:", String(error)));
        }, WEIXIN_BRIDGE_SYNC_MS);
        imBridgeTimer.unref?.();
        const imDeliveryTimer = setInterval(() => {
          void drainImDeliveries().catch((error: unknown) =>
            console.error("[web-ui] IM delivery failed:", String(error)),
          );
        }, IM_DELIVERY_POLL_MS);
        imDeliveryTimer.unref?.();
        void syncImBridges().catch((error: unknown) => console.error("[web-ui] IM bridge failed:", String(error)));
        void drainImDeliveries().catch((error: unknown) =>
          console.error("[web-ui] IM delivery failed:", String(error)),
        );
        void runStateFeed();
      });
    })
    .catch((err: unknown) => {
      console.error("[web-ui] failed to start:", String(err));
      process.exit(1);
    });
}
