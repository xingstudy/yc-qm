import { nothing, render, svg, type TemplateResult } from "lit";
import {
  Box,
  Brain,
  ChevronDown,
  Clock,
  Files,
  Folder,
  ExternalLink,
  KeyRound,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  Trash2,
  X,
  type IconNode,
} from "lucide";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import {
  api,
  fetchRuntimeConfig,
  fetchTranscript,
  setSigninRequiredHandler,
  type SigninRequired,
  TAIL_TURNS,
  withBase,
} from "./core-bridge";
import { applyRuntimeOptions } from "./model-options";
import { errMessage, swallow } from "../../chassis/src/errors";
import { brandMark, brandName, icon, initials } from "./ui";
import { markConnectorConnected } from "./chat";
import { clearSkillsCache, resyncModelSelection, seedRuntimeConfig } from "./composer";
import { ensureDeliveryStream, mainConversation, onExitCanvas } from "./conversations";
import { clearAllDrafts, saveDraft, storedDraft } from "./drafts";
import { deepLinkPath, isPlainLeftClick, parseDeepLink, UI_BASE } from "./deep-link";
import {
  addBlankPane,
  adoptRemoteSplit,
  canvasToast,
  drawCanvas,
  exitSplitIfActive,
  loadPersistedSplit,
  mountRestoredCanvas,
  restoredCanvasNeedsSessionList,
  splitState,
} from "./split";
import { activityOf } from "./session-list";
import { replaceChildrenPreservingFocus } from "./pane-focus";
import {
  openSession,
  closeOpenSessionMenu,
  refreshSessions,
  renderChatsPage,
  renderList,
  resetSessionsState,
  sessionsState,
  toggleWebOnly,
} from "./sessions";
import { openCronById, renderCronsPage, resetActiveCron, routeCronsHistory } from "./crons";
import { renderFiles } from "./files";
import { setScopedSession } from "./session-scope";
import { openChatSearch, SEARCH_HOTKEY_LABEL } from "./search";
import { hideTooltip, showTooltip } from "./tooltip";
import { clearConnectorNotice, noteConnectorResult, renderConnectors, resetKeychainState } from "./connectors";
import { renderDeploys } from "./deploys";
import { renderMemory, resetMemoryState } from "./memory";
import { renderSkills } from "./skills";
import { contextsState, ensureContexts, renderContexts, resetContextsState, resolveProjectScope } from "./contexts";
import { appState, can, isView, type AuthMode, type Me, type View } from "./shell-state";
import { trapDialogFocus } from "./dialog-focus";
import { currentLocale, html, setLocale, t } from "./i18n.ts";
import { qrDataUrl } from "./qr";
import WecomAIBotSDK from "@wecom/wecom-aibot-sdk";
export { appState, can, type Me, type View } from "./shell-state";

let authMode: AuthMode = "portal";
let shellMounted = false;

setSigninRequiredHandler((detail) => {
  authMode = detail.mode ?? authMode;
  renderAuthGate(gateFor(authMode, detail.reason));
});

onExitCanvas(() => exitSplitIfActive());

export const ADMIN_BASE = (() => {
  const base = ((import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/").replace(/\/$/, "");
  return base ? base.replace(/\/[^/]+$/, "/admin") : "/admin";
})();
export const ADMIN_HOME_URL = `${ADMIN_BASE}/`;

export function syncUrlFromState(sessionOverride?: string | null): void {
  const chatState = mainConversation().state;
  const fromState =
    sessionOverride !== undefined ? sessionOverride : (chatState.sessionId ?? chatState.rememberedSessionId);
  const sessionId = splitState.active ? null : fromState;
  const next = deepLinkPath(UI_BASE, appState.currentView, sessionId, contextsState.selected);
  if (`${location.pathname}${location.search}` !== next) history.replaceState(null, "", next);
}

const appEl = document.getElementById("app");
if (!appEl) throw new Error("missing #app");

const narrowViewport = window.matchMedia("(max-width: 860px)");
let sidebarOpen = !narrowViewport.matches;

const SIDEBAR_MIN_W = 200;
const SIDEBAR_MAX_W = 520;
const SIDEBAR_W_KEY = "webui:sidebar-w";

function applySavedSidebarWidth(): void {
  const saved = Number(localStorage.getItem(SIDEBAR_W_KEY));
  if (Number.isFinite(saved) && saved >= SIDEBAR_MIN_W && saved <= SIDEBAR_MAX_W) {
    document.documentElement.style.setProperty("--sidebar-w", `${saved}px`);
  }
}

function startSidebarResize(e: PointerEvent): void {
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  const startX = e.clientX;
  const sidebar = (appEl as HTMLElement).querySelector<HTMLElement>(".sidebar");
  if (!sidebar) return;
  const startW = sidebar.getBoundingClientRect().width;
  handle.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing-sidebar");
  let w = startW;
  const onMove = (ev: PointerEvent) => {
    w = Math.min(SIDEBAR_MAX_W, Math.max(SIDEBAR_MIN_W, startW + (ev.clientX - startX)));
    document.documentElement.style.setProperty("--sidebar-w", `${w}px`);
  };
  const onUp = () => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("lostpointercapture", onUp);
    document.body.classList.remove("resizing-sidebar");
    localStorage.setItem(SIDEBAR_W_KEY, String(Math.round(w)));
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("lostpointercapture", onUp);
}

function resetSidebarWidth(): void {
  document.documentElement.style.removeProperty("--sidebar-w");
  localStorage.removeItem(SIDEBAR_W_KEY);
}

const NAV_WORKSPACE_KEY = "web-ui:nav-workspace";

function loadNavOpen(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function saveNavOpen(key: string, open: boolean): void {
  try {
    localStorage.setItem(key, open ? "1" : "0");
  } catch {
    void 0;
  }
}

let navWorkspaceOpen = loadNavOpen(NAV_WORKSPACE_KEY);

function toggleNavWorkspace(): void {
  navWorkspaceOpen = !navWorkspaceOpen;
  saveNavOpen(NAV_WORKSPACE_KEY, navWorkspaceOpen);
  renderSidebarTop();
}

const ICON = {
  newChat: Plus,
  chats: MessageSquare,
  contexts: Folder,
  files: Files,
  keychain: KeyRound,
  deploys: Rocket,
  crons: Clock,
  memory: Brain,
  skills: Box,
};

type ImProviderId = "wechat" | "feishu" | "work-wechat" | "qq" | "dingtalk";
type ImSetupMode = "wechat-qr" | "provision-qr" | "manual-credentials";
type ImAuthorizationState =
  "waiting" | "scanned" | "verification-required" | "blocked" | "expired" | "unrecoverable" | "error";

const IM_PROVIDER_OPTIONS: Array<{
  id: ImProviderId;
  label: string;
  className: string;
  viewBox: string;
  path: string | string[];
  colors?: string[];
}> = [
  {
    id: "wechat",
    label: "WeChat",
    className: "wechat",
    viewBox: "0 0 24 24",
    path: "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z",
  },
  {
    id: "feishu",
    label: "Feishu",
    className: "feishu",
    viewBox: "0 0 100 100",
    path: [
      "M20 10h36c7 0 11 5 14 11l5 11c-7 8-14 14-22 19L20 10Z",
      "M53 50c14-11 24-19 32-20 6-1 10 1 14 5L82 57c-7 9-15 13-22 12-7-1-13-6-18-12l11-7Z",
      "M5 30l46 31c10 7 20 7 31-3-8 16-22 27-39 27-16 0-30-5-38-13V30Z",
    ],
    colors: ["#00d6b9", "#133c9a", "#3370ff"],
  },
  {
    id: "work-wechat",
    label: "Enterprise WeChat",
    className: "work-wechat",
    viewBox: "0 0 24 24",
    path: "M12 1c6.075 0 11 4.925 11 11s-4.925 11-11 11S1 18.075 1 12 5.925 1 12 1Zm3.52 15.49a.35.35 0 0 0-.24.1c-.14.13-.16.34.02.53l.07.07c.44.44.74.99.85 1.57l.04.23c.05.19.15.37.29.5.21.21.51.34.82.34.3 0 .59-.12.8-.33.44-.44.44-1.16 0-1.61-.15-.15-.34-.26-.53-.3l-.15-.03a3.1 3.1 0 0 1-1.62-.86l-.1-.11a.34.34 0 0 0-.25-.1ZM11 4.75c-2.117 0-4.264.77-5.75 2.31C4.111 8.246 3.5 9.72 3.5 11.24c0 1.06.3 2.12.88 3.06.47.695.993 1.371 1.66 1.89l-.384 1.624a.6.6 0 0 0 .856.673L8.64 17.41c.53.166 1.08.234 1.63.3a8.3 8.3 0 0 0 1.7-.03l.38-.05q.283-.046.564-.112a2.33 2.33 0 0 1-.92-1.605l-.254.037c-.62.067-1.232.03-1.85-.04-.43-.057-.838-.185-1.25-.31l-1.02.5.23-.67-.74-.6c-.513-.401-.917-.934-1.28-1.47-.4-.65-.61-1.38-.61-2.11 0-1.08.456-2.119 1.26-2.97 1.158-1.198 2.854-1.78 4.5-1.78 1.54 0 3.108.513 4.24 1.58.365.365.707.75.95 1.21.177.354.338.722.424 1.107a2.34 2.34 0 0 1 1.811.123c-.075-.716-.33-1.4-.665-2.04-.329-.62-.776-1.155-1.27-1.65-1.468-1.38-3.471-2.08-5.47-2.08Zm9.37 9.77a1.136 1.136 0 0 0-1.1.86l-.03.15a3.1 3.1 0 0 1-.86 1.63l-.11.1a.35.35 0 0 0 .26.59c.07 0 .15-.02.26-.13l.07-.07c.44-.44.99-.74 1.57-.85l.23-.04c.2-.06.37-.16.5-.3.44-.44.44-1.17 0-1.61-.21-.21-.5-.33-.8-.33Zm-4.21-1.07c-.08 0-.16.03-.27.14l-.07.07c-.44.44-.99.74-1.57.85l-.23.04c-.2.06-.37.16-.5.3-.44.44-.44 1.17 0 1.61.21.21.51.34.82.34.3 0 .59-.12.8-.33.15-.16.25-.34.29-.53l.03-.16c.11-.61.41-1.18.86-1.63l.1-.09a.35.35 0 0 0-.26-.61Zm1.18-1.97c-.3 0-.59.12-.8.33-.44.44-.44 1.16 0 1.61.15.15.34.26.53.3l.15.03c.61.12 1.17.41 1.62.86l.1.11c.08.08.16.1.25.1.1 0 .16-.04.23-.11.12-.13.14-.32-.02-.52l-.08-.08c-.44-.44-.74-.99-.85-1.57l-.04-.23c-.05-.19-.15-.37-.29-.5-.21-.21-.5-.33-.8-.33Z",
  },
  {
    id: "qq",
    label: "QQ",
    className: "qq",
    viewBox: "0 0 24 25",
    path: "M6.795 3.035C8.052 1.24 10.013.042 12.75.042s4.697 1.197 5.954 2.994c1.24 1.773 1.775 4.097 1.775 6.372 0 .137-.004.334-.007.497l-.004.2.99 2.479c.284.74.568 1.519.777 2.193.498 1.6.677 2.76.691 3.547.008.39-.025.71-.09.951a1.2 1.2 0 0 1-.153.355.68.68 0 0 1-.479.311c-.269.033-.49-.096-.603-.171a2.5 2.5 0 0 1-.384-.332 8.5 8.5 0 0 1-.752-.922 7.1 7.1 0 0 1-1.605 2.86c.386.159.771.352 1.074.577.288.215.47.474.533.76a.97.97 0 0 1-.102.7.8.8 0 0 1-.341.304c-.104.052-.219.09-.328.119a5 5 0 0 1-.786.127 23 23 0 0 1-2.136.08c-1.528-.003-3.206-.092-4.02-.179-.815.087-2.492.176-4.02.178-.784.002-1.544-.02-2.137-.079a5 5 0 0 1-.786-.127 1.7 1.7 0 0 1-.328-.12.8.8 0 0 1-.34-.302.97.97 0 0 1-.104-.702c.063-.287.246-.546.534-.76a5.2 5.2 0 0 1 1.073-.575 7.1 7.1 0 0 1-1.606-2.862l-.036.05a8.5 8.5 0 0 1-.715.873c-.118.121-.25.241-.385.332-.112.075-.334.204-.602.171H3.3a.68.68 0 0 1-.477-.31 1.2 1.2 0 0 1-.155-.355q-.1-.366-.092-.952c.014-.787.192-1.948.688-3.547.21-.674.493-1.453.777-2.194l.003-.007.988-2.47-.011-.698c0-2.275.535-4.6 1.775-6.373Z",
  },
  {
    id: "dingtalk",
    label: "DingTalk",
    className: "dingtalk",
    viewBox: "0 0 1024 1024",
    path: "M573.7 252.5C422.5 197.4 201.3 96.7 201.3 96.7c-15.7-4.1-17.9 11.1-17.9 11.1-5 61.1 33.6 160.5 53.6 182.8 19.9 22.3 319.1 113.7 319.1 113.7S326 357.9 270.5 341.9c-55.6-16-37.9 17.8-37.9 17.8 11.4 61.7 64.9 131.8 107.2 138.4 42.2 6.6 220.1 4 220.1 4s-35.5 4.1-93.2 11.9c-42.7 5.8-97 12.5-111.1 17.8-33.1 12.5 24 62.6 24 62.6 84.7 76.8 129.7 50.5 129.7 50.5 33.3-10.7 61.4-18.5 85.2-24.2L565 743.1h84.6L603 928l205.3-271.9H700.8l22.3-38.7.4.8s76.3-122.1 105.5-184.4l.6-1h-.1c5-10.8 8.6-19.7 10-25.8 17-71.3-114.5-99.4-265.8-154.5Z",
  },
];

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
  resourceId?: string;
  authorizationState?: ImAuthorizationState;
  authorizationMessage?: string;
  verificationRequired?: boolean;
  createdAt?: number;
  connectedAt?: number;
  updatedAt: number;
}

let imPanelOpen = false;
let imProviderMenuOpen = false;
let imBindingsLoaded = false;
let imBindingsLoading = false;
let imBindingsError = "";
let imBindings: Partial<Record<ImProviderId, ImBindingRecord>> = {};
let reusableImProviders = new Set<ImProviderId>();
let activeImProvider: ImProviderId | null = null;
let imPollTimer: ReturnType<typeof setInterval> | null = null;
let imPollInFlight = false;
let imVerificationCode = "";
const imCredentialValues: Partial<Record<ImProviderId, Record<string, string>>> = {};

const IM_CREDENTIAL_KEYS: Record<Exclude<ImProviderId, "wechat">, string[]> = {
  feishu: ["appId", "appSecret"],
  "work-wechat": ["botId", "secret"],
  qq: ["appId", "appSecret"],
  dingtalk: ["clientId", "clientSecret"],
};

function isImProviderId(value: string): value is ImProviderId {
  return IM_PROVIDER_OPTIONS.some((option) => option.id === value);
}

function imProvider(id: ImProviderId): (typeof IM_PROVIDER_OPTIONS)[number] {
  return IM_PROVIDER_OPTIONS.find((option) => option.id === id)!;
}

function isImSetupMode(value: string): value is ImSetupMode {
  return value === "wechat-qr" || value === "provision-qr" || value === "manual-credentials";
}

function imStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items.slice(0, 8) : undefined;
}

function normalizeImBindings(raw: unknown): Partial<Record<ImProviderId, ImBindingRecord>> {
  const out: Partial<Record<ImProviderId, ImBindingRecord>> = {};
  const bindings =
    typeof raw === "object" && raw !== null && typeof (raw as { bindings?: unknown }).bindings === "object"
      ? ((raw as { bindings: Record<string, unknown> }).bindings ?? {})
      : {};
  for (const [id, value] of Object.entries(bindings)) {
    if (!isImProviderId(id) || typeof value !== "object" || value === null) continue;
    const record = value as Partial<ImBindingRecord>;
    if (record.status !== "pending" && record.status !== "connected") continue;
    out[id] = {
      provider: id,
      status: record.status,
      ...(typeof record.qrPayload === "string" ? { qrPayload: record.qrPayload } : {}),
      ...(typeof record.botName === "string" ? { botName: record.botName } : {}),
      ...(typeof record.channelKind === "string" ? { channelKind: record.channelKind } : {}),
      ...(typeof record.setupMode === "string" && isImSetupMode(record.setupMode)
        ? { setupMode: record.setupMode }
        : {}),
      ...(typeof record.quickSetupAvailable === "boolean" ? { quickSetupAvailable: record.quickSetupAvailable } : {}),
      ...(typeof record.setupTitle === "string" ? { setupTitle: record.setupTitle } : {}),
      ...(imStringList(record.setupSteps) ? { setupSteps: imStringList(record.setupSteps) } : {}),
      ...(imStringList(record.credentialFields) ? { credentialFields: imStringList(record.credentialFields) } : {}),
      ...(imStringList(record.manualSetupSteps) ? { manualSetupSteps: imStringList(record.manualSetupSteps) } : {}),
      ...(typeof record.primaryActionLabel === "string" ? { primaryActionLabel: record.primaryActionLabel } : {}),
      ...(typeof record.primaryActionUrl === "string" ? { primaryActionUrl: record.primaryActionUrl } : {}),
      ...(typeof record.manualSetupTitle === "string" ? { manualSetupTitle: record.manualSetupTitle } : {}),
      ...(typeof record.docsUrl === "string" ? { docsUrl: record.docsUrl } : {}),
      ...(typeof record.hint === "string" ? { hint: record.hint } : {}),
      ...(typeof record.externalUserId === "string" ? { externalUserId: record.externalUserId } : {}),
      ...(typeof record.externalChatId === "string" ? { externalChatId: record.externalChatId } : {}),
      ...(typeof record.externalDisplayName === "string" ? { externalDisplayName: record.externalDisplayName } : {}),
      ...(typeof record.resourceId === "string" ? { resourceId: record.resourceId } : {}),
      ...(record.authorizationState === "waiting" ||
      record.authorizationState === "scanned" ||
      record.authorizationState === "verification-required" ||
      record.authorizationState === "blocked" ||
      record.authorizationState === "expired" ||
      record.authorizationState === "unrecoverable" ||
      record.authorizationState === "error"
        ? { authorizationState: record.authorizationState }
        : {}),
      ...(typeof record.authorizationMessage === "string" ? { authorizationMessage: record.authorizationMessage } : {}),
      ...(typeof record.verificationRequired === "boolean"
        ? { verificationRequired: record.verificationRequired }
        : {}),
      ...(typeof record.createdAt === "number" ? { createdAt: record.createdAt } : {}),
      ...(typeof record.connectedAt === "number" ? { connectedAt: record.connectedAt } : {}),
      updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
    };
  }
  return out;
}

function imChannelIds(status: ImBindingRecord["status"]): ImProviderId[] {
  return IM_PROVIDER_OPTIONS.map((option) => option.id).filter((id) => imBindings[id]?.status === status);
}

async function loadImBindings(): Promise<void> {
  if (imBindingsLoading) return;
  imBindingsLoading = true;
  imBindingsError = "";
  renderImPanel();
  try {
    const raw = await api<{ bindings?: unknown; reusableProviders?: unknown }>("/api/im-bindings");
    imBindings = normalizeImBindings(raw);
    reusableImProviders = new Set(
      Array.isArray(raw.reusableProviders)
        ? raw.reusableProviders.filter((provider): provider is ImProviderId =>
            typeof provider === "string" ? isImProviderId(provider) : false,
          )
        : [],
    );
    imBindingsLoaded = true;
  } catch (error) {
    imBindingsError = errMessage(error, t("Could not load chat channel bindings."));
  }
  imBindingsLoading = false;
  renderImPanel();
}

function stopImPolling(): void {
  if (imPollTimer) clearInterval(imPollTimer);
  imPollTimer = null;
}

async function refreshImBinding(provider: ImProviderId): Promise<void> {
  if (imPollInFlight) return;
  imPollInFlight = true;
  try {
    const r = await api<{ binding?: ImBindingRecord | null }>(
      `/api/im-bindings/status?provider=${encodeURIComponent(provider)}`,
    );
    if (r.binding) {
      imBindings[provider] = r.binding;
      if (r.binding.status === "connected") stopImPolling();
    } else {
      delete imBindings[provider];
      if (activeImProvider === provider) activeImProvider = null;
      stopImPolling();
    }
    renderImPanel();
  } catch {
    void 0;
  } finally {
    imPollInFlight = false;
  }
}

function startImPolling(provider: ImProviderId): void {
  stopImPolling();
  imPollTimer = setInterval(() => void refreshImBinding(provider), 2000);
}

async function startImBinding(provider: ImProviderId): Promise<void> {
  imProviderMenuOpen = false;
  activeImProvider = provider;
  imBindingsLoading = true;
  imBindingsError = "";
  renderImPanel();
  try {
    const r = await api<{ binding: ImBindingRecord }>("/api/im-bindings/start", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    imBindings[provider] = r.binding;
    if (r.binding.status === "pending") startImPolling(provider);
    else stopImPolling();
  } catch (error) {
    imBindingsError = errMessage(error, t("Could not start chat channel setup."));
  }
  imBindingsLoading = false;
  renderImPanel();
}

async function startWeComBinding(): Promise<void> {
  const provider = "work-wechat";
  if (reusableImProviders.has(provider) || imBindings[provider]?.resourceId) {
    await startImBinding(provider);
    return;
  }
  imProviderMenuOpen = false;
  activeImProvider = provider;
  imBindingsLoading = true;
  imBindingsError = "";
  renderImPanel();
  const authWindow = window.open(
    "about:blank",
    "WecomAIBotAuthWindow",
    "width=950,height=640,resizable=false,scrollbars=false,status=no,toolbar=no,menubar=no,location=no",
  );
  if (!authWindow) {
    imBindingsLoading = false;
    imBindingsError = t("Enterprise WeChat authorization window was blocked.");
    renderImPanel();
    return;
  }
  const startRequest = api<{ binding: ImBindingRecord }>("/api/im-bindings/start", {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
  try {
    const started = await startRequest;
    imBindings[provider] = started.binding;
    renderImPanel();
    if (started.binding.resourceId || started.binding.status === "connected") {
      authWindow.close();
      reusableImProviders.add(provider);
      if (started.binding.status === "pending") startImPolling(provider);
      else stopImPolling();
    } else {
      const authorization = WecomAIBotSDK.openBotInfoAuthWindow({ source: "qm" }).then(
        (bot) => ({ bot }),
        (error: unknown) => ({ error }),
      );
      const outcome = await authorization;
      if ("error" in outcome) throw outcome.error;
      const result = await api<{ binding: ImBindingRecord }>(
        `/api/im-bindings/${encodeURIComponent(provider)}/credentials`,
        {
          method: "POST",
          body: JSON.stringify({ credentials: { botId: outcome.bot.botid, secret: outcome.bot.secret } }),
        },
      );
      imBindings[provider] = result.binding;
      reusableImProviders.add(provider);
      if (result.binding.status === "pending") startImPolling(provider);
      else stopImPolling();
    }
  } catch (error) {
    authWindow.close();
    WecomAIBotSDK.closeWindow();
    imBindingsError = errMessage(error, t("Could not authorize Enterprise WeChat bot."));
  }
  imBindingsLoading = false;
  renderImPanel();
}

async function deleteImBinding(provider: ImProviderId): Promise<void> {
  if (!window.confirm(t("Unbind this chat channel? The existing platform Bot will be kept for reuse."))) return;
  imBindingsLoading = true;
  imBindingsError = "";
  renderImPanel();
  try {
    const result = await api<{ reusable?: boolean }>(`/api/im-bindings/${encodeURIComponent(provider)}`, {
      method: "DELETE",
    });
    delete imBindings[provider];
    if (result.reusable) reusableImProviders.add(provider);
    activeImProvider = null;
    stopImPolling();
  } catch (error) {
    imBindingsError = errMessage(error, t("Could not unbind chat channel."));
  }
  imBindingsLoading = false;
  renderImPanel();
}

async function verifyWeixinCode(): Promise<void> {
  const code = imVerificationCode.trim();
  if (!/^\d{1,8}$/.test(code)) return;
  imBindingsLoading = true;
  renderImPanel();
  try {
    const result = await api<{ binding: ImBindingRecord }>("/api/im-bindings/wechat/verify", {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    imBindings.wechat = result.binding;
    imVerificationCode = "";
    startImPolling("wechat");
  } catch (error) {
    imBindingsError = errMessage(error, t("Could not verify WeChat code."));
  }
  imBindingsLoading = false;
  renderImPanel();
}

async function submitImCredentials(provider: Exclude<ImProviderId, "wechat">): Promise<void> {
  const values = imCredentialValues[provider] ?? {};
  const credentials = Object.fromEntries(IM_CREDENTIAL_KEYS[provider].map((key) => [key, values[key]?.trim() ?? ""]));
  if (Object.values(credentials).some((value) => !value)) return;
  imBindingsLoading = true;
  imBindingsError = "";
  renderImPanel();
  try {
    const result = await api<{ binding: ImBindingRecord }>(
      `/api/im-bindings/${encodeURIComponent(provider)}/credentials`,
      { method: "POST", body: JSON.stringify({ credentials }) },
    );
    imBindings[provider] = result.binding;
    delete imCredentialValues[provider];
    reusableImProviders.add(provider);
    if (result.binding.status === "pending") startImPolling(provider);
    else stopImPolling();
  } catch (error) {
    imBindingsError = errMessage(error, t("Platform credentials could not be verified."));
  }
  imBindingsLoading = false;
  renderImPanel();
}

function showImBinding(provider: ImProviderId): void {
  imProviderMenuOpen = false;
  activeImProvider = provider;
  const binding = imBindings[provider];
  if (
    binding?.status === "pending" &&
    (binding.setupMode === "provision-qr" || provider === "dingtalk") &&
    !binding.resourceId &&
    (provider === "feishu" || provider === "qq" || provider === "dingtalk")
  ) {
    void startImBinding(provider);
    return;
  }
  if (binding?.status === "pending") startImPolling(provider);
  else stopImPolling();
  renderImPanel();
}

function closeImQr(): void {
  activeImProvider = null;
  stopImPolling();
  renderImPanel();
}

function setImPanelOpen(open: boolean, focusPill = false): boolean {
  if (imPanelOpen === open && (!open || !imProviderMenuOpen)) return false;
  imPanelOpen = open;
  if (!open) {
    imProviderMenuOpen = false;
    activeImProvider = null;
    stopImPolling();
  } else if (!imBindingsLoaded) {
    void loadImBindings();
  }
  renderImPanel();
  const pill = (appEl as HTMLElement).querySelector<HTMLButtonElement>(".user-pill");
  pill?.setAttribute("aria-expanded", imPanelOpen ? "true" : "false");
  if (focusPill) pill?.focus();
  return true;
}

function toggleImPanel(event: Event): void {
  event.stopPropagation();
  setImPanelOpen(!imPanelOpen);
}

function toggleImProviderMenu(event: Event): void {
  event.stopPropagation();
  imProviderMenuOpen = !imProviderMenuOpen;
  renderImPanel();
}

function imLogo(option: (typeof IM_PROVIDER_OPTIONS)[number]): TemplateResult {
  const paths = typeof option.path === "string" ? [option.path] : option.path;
  return html`<span class=${`im-logo ${option.className}`} aria-hidden="true"
    ><svg viewBox=${option.viewBox} focusable="false">
      ${paths.map((path, index) => svg`<path d=${path} fill=${option.colors?.[index] ?? "currentColor"}></path>`)}
    </svg></span
  >`;
}

function imQrSrc(url: string): string {
  try {
    return qrDataUrl(url);
  } catch {
    return "";
  }
}

function imSetupModeLabel(mode: ImSetupMode): string {
  if (mode === "wechat-qr") return t("WeChat QR setup");
  if (mode === "provision-qr") return t("Scan to create or bind a bot");
  return t("Manual credential setup");
}

function imSetupSteps(binding: ImBindingRecord): string[] {
  if (binding.setupMode === "provision-qr" && !binding.quickSetupAvailable && binding.manualSetupSteps?.length) {
    return binding.manualSetupSteps;
  }
  return binding.setupSteps?.length
    ? binding.setupSteps
    : [binding.hint ?? t("Follow the setup guide for this channel.")];
}

function imManualSetup(binding: ImBindingRecord): TemplateResult {
  return html`<div class="im-setup-flow">
    <div class="im-setup-mode">
      ${binding.setupMode === "provision-qr" ? t("Manual fallback") : imSetupModeLabel(binding.setupMode ?? "manual-credentials")}
    </div>
    ${
      binding.setupMode === "provision-qr" && !binding.quickSetupAvailable
        ? html`<div class="im-setup-warning">${t("Quick scan setup is temporarily unavailable.")}</div>`
        : nothing
    }
    ${binding.hint ? html`<div class="im-setup-copy">${binding.hint}</div>` : nothing}
    ${binding.manualSetupTitle ? html`<div class="im-setup-subtitle">${binding.manualSetupTitle}</div>` : nothing}
    <ol class="im-setup-steps">
      ${imSetupSteps(binding).map((step) => html`<li>${step}</li>`)}
    </ol>
    ${imCredentialForm(binding)}
    ${
      binding.setupMode === "provision-qr"
        ? nothing
        : html`<div class="im-qr-note">${t("No QR code is used for this channel.")}</div>`
    }
  </div>`;
}

function imWeComProvisionSetup(binding: ImBindingRecord): TemplateResult {
  return html`<div class="im-setup-flow">
    <div class="im-setup-mode">${imSetupModeLabel("provision-qr")}</div>
    ${binding.hint ? html`<div class="im-setup-copy">${binding.hint}</div>` : nothing}
    <ol class="im-setup-steps">
      ${imSetupSteps(binding).map((step) => html`<li>${step}</li>`)}
    </ol>
    <button class="btn primary" type="button" ?disabled=${imBindingsLoading} @click=${() => void startWeComBinding()}>
      ${t("Create a new Enterprise WeChat Bot")}
    </button>
    ${imCredentialForm(binding)}
  </div>`;
}

function imCredentialForm(binding: ImBindingRecord): TemplateResult | typeof nothing {
  if (binding.provider === "wechat" || binding.resourceId || !binding.credentialFields?.length) return nothing;
  const provider = binding.provider;
  const keys = IM_CREDENTIAL_KEYS[provider];
  const values = imCredentialValues[provider] ?? {};
  const complete = keys.every((key) => Boolean(values[key]?.trim()));
  return html`<form
    class="im-credential-form"
    @submit=${(event: Event) => {
      event.preventDefault();
      void submitImCredentials(provider);
    }}
  >
    <div class="im-setup-subtitle">${t("Bind an existing Bot")}</div>
    ${binding.credentialFields.map(
      (field, index) =>
        html`<label>
          <span>${field}</span>
          <input
            type="password"
            autocomplete="off"
            maxlength="512"
            .value=${values[keys[index]!] ?? ""}
            @input=${(event: Event) => {
              imCredentialValues[provider] = {
                ...imCredentialValues[provider],
                [keys[index]!]: (event.target as HTMLInputElement).value,
              };
            }}
          />
        </label>`,
    )}
    <button class="btn primary" type="submit" ?disabled=${!complete || imBindingsLoading}>
      ${t("Verify and bind")}
    </button>
  </form>`;
}

function imProvisionSetup(binding: ImBindingRecord): TemplateResult {
  const src = imQrSrc(binding.qrPayload ?? "");
  return html`<div class="im-setup-flow">
    <div class="im-setup-mode">${imSetupModeLabel("provision-qr")}</div>
    ${binding.hint ? html`<div class="im-setup-copy">${binding.hint}</div>` : nothing}
    <div class="im-qr-box">
      ${src ? html`<img class="im-qr-img" alt=${t("Provisioning QR code")} src=${src} />` : nothing}
    </div>
    <ol class="im-setup-steps">
      ${imSetupSteps(binding).map((step) => html`<li>${step}</li>`)}
    </ol>
    <div class="im-qr-note">${t("Waiting for bot authorization")}</div>
  </div>`;
}

function imQrSetup(binding: ImBindingRecord): TemplateResult {
  if (!binding.quickSetupAvailable || !binding.qrPayload) {
    return html`<div class="im-setup-flow">
      <div class="im-setup-mode">${imSetupModeLabel("wechat-qr")}</div>
      <div class="im-setup-warning">${t("Quick scan setup is temporarily unavailable.")}</div>
      ${binding.hint ? html`<div class="im-setup-copy">${binding.hint}</div>` : nothing}
    </div>`;
  }
  const src = imQrSrc(binding.qrPayload);
  const retryable =
    binding.authorizationState === "expired" ||
    binding.authorizationState === "blocked" ||
    binding.authorizationState === "unrecoverable" ||
    binding.authorizationState === "error";
  return html`<div class="im-qr-box">
      ${src ? html`<img class="im-qr-img" alt=${t("Binding QR code")} src=${src} />` : nothing}
    </div>
    <div class="im-qr-state">
      ${binding.authorizationMessage ?? binding.hint ?? t("Use the matching app to scan this QR code.")}
    </div>
    ${
      binding.verificationRequired
        ? html`<form
            class="im-verify"
            @submit=${(event: Event) => {
              event.preventDefault();
              void verifyWeixinCode();
            }}
          >
            <label for="im-weixin-code">${t("WeChat verification code")}</label>
            <div>
              <input
                id="im-weixin-code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                maxlength="8"
                .value=${imVerificationCode}
                @input=${(event: Event) => {
                  imVerificationCode = (event.target as HTMLInputElement).value.replace(/\D/g, "").slice(0, 8);
                }}
              />
              <button class="btn primary" type="submit" ?disabled=${!/^\d{1,8}$/.test(imVerificationCode.trim())}>
                ${t("Verify")}
              </button>
            </div>
          </form>`
        : nothing
    }
    ${
      retryable
        ? html`<button class="btn im-retry" type="button" @click=${() => void startImBinding("wechat")}>
            ${icon(RefreshCw, 15)}<span>${t("Generate a new QR code")}</span>
          </button>`
        : html`<div class="im-qr-note">${t("Waiting for platform authorization")}</div>`
    }`;
}

function imSetupPanel(): TemplateResult | typeof nothing {
  if (!activeImProvider) return nothing;
  const option = imProvider(activeImProvider);
  const binding = imBindings[activeImProvider];
  if (!binding) {
    return html`<div class="im-qr-backdrop" @click=${closeImQr}>
      <section
        class="im-qr-modal"
        role="dialog"
        aria-modal="true"
        aria-label=${t("Binding QR code")}
        @click=${(event: Event) => event.stopPropagation()}
      >
        <div class="im-qr-loading">${t("Preparing chat channel setup…")}</div>
      </section>
    </div>`;
  }
  const connected = binding.status === "connected";
  const botName = binding.botName ?? `${t(option.label)} Bot`;
  const setupMode = binding.setupMode ?? "wechat-qr";
  let setupContent: TemplateResult;
  if (connected) {
    const displayName = binding.externalDisplayName
      ? html`<div class="im-qr-note">${binding.externalDisplayName}</div>`
      : nothing;
    setupContent = html`<div class="im-qr-state connected">${t("Binding complete")}</div>
      ${displayName}
      ${
        binding.resourceId
          ? html`<div class="im-resource-id"><span>Bot ID</span><code>${binding.resourceId}</code></div>`
          : nothing
      }`;
  } else if (setupMode === "wechat-qr") {
    setupContent = imQrSetup(binding);
  } else if (binding.provider === "work-wechat" && setupMode === "provision-qr" && !binding.resourceId) {
    setupContent = imWeComProvisionSetup(binding);
  } else if (setupMode === "provision-qr" && binding.quickSetupAvailable && binding.qrPayload) {
    setupContent = html`${imProvisionSetup(binding)}${imCredentialForm(binding)}`;
  } else {
    setupContent = imManualSetup(binding);
  }
  return html`<div class="im-qr-backdrop" @click=${closeImQr}>
    <section
      class="im-qr-modal"
      role="dialog"
      aria-modal="true"
      aria-label=${t("Binding QR code")}
      @click=${(event: Event) => event.stopPropagation()}
    >
      <div class="im-qr-head">
        <div class="im-qr-title">
          ${imLogo(option)}
          <div class="im-qr-copy">
            <strong>${botName}</strong>
            <span>${t(option.label)}</span>
          </div>
        </div>
        <button class="im-qr-close" type="button" aria-label=${t("Close")} @click=${closeImQr}>${icon(X, 16)}</button>
      </div>
      ${setupContent}
      ${
        connected
          ? html`<button
              class="btn danger im-unbind"
              type="button"
              @click=${() => void deleteImBinding(activeImProvider!)}
            >
              ${icon(Trash2, 15)}<span>${t("Unbind")}</span>
            </button>`
          : nothing
      }
      ${
        binding.primaryActionUrl
          ? html`<a class="im-doc-link" href=${binding.primaryActionUrl} target="_blank" rel="noreferrer">
              ${icon(ExternalLink, 14)}<span>${binding.primaryActionLabel ?? t("Open provider console")}</span>
            </a>`
          : nothing
      }
      ${
        binding.docsUrl
          ? html`<a class="im-doc-link" href=${binding.docsUrl} target="_blank" rel="noreferrer">
              ${icon(ExternalLink, 14)}<span>${t("Setup guide")}</span>
            </a>`
          : nothing
      }
    </section>
  </div>`;
}

function imBindingRow(id: ImProviderId): TemplateResult {
  const option = imProvider(id);
  const pending = imBindings[id]?.status === "pending";
  return html`<button class="im-channel-row" type="button" @click=${() => showImBinding(id)}>
    ${imLogo(option)}<span>${t(option.label)}</span>
    <span class=${pending ? "im-channel-state pending" : "im-channel-state"}>
      ${pending ? t("Continue setup") : t("Bound")}
    </span>
  </button>`;
}

function imPanel(): TemplateResult {
  const connectedIds = imChannelIds("connected");
  const pendingIds = imChannelIds("pending");
  return html`<div
    id="im-panel"
    class="im-panel"
    role="dialog"
    aria-label=${t("Chat channels")}
    ?hidden=${!imPanelOpen}
    @click=${(event: Event) => event.stopPropagation()}
  >
    <div class="im-panel-title">${t("Chat channels")}</div>
    <div class="im-panel-section">
      <div class="im-panel-section-label">${t("Connected chat channels")}</div>
      <div class="im-channel-list">
        ${
          connectedIds.length
            ? connectedIds.map(imBindingRow)
            : html`<div class="im-panel-empty">${t("No connected chat channels.")}</div>`
        }
      </div>
    </div>
    ${
      pendingIds.length
        ? html`<div class="im-panel-section">
            <div class="im-panel-section-label">${t("Setup in progress")}</div>
            <div class="im-channel-list">${pendingIds.map(imBindingRow)}</div>
          </div>`
        : nothing
    }
    <div class="im-panel-section">
      <div class="im-panel-section-label">${t("Available chat platforms")}</div>
      <div class="im-channel-list">
        <button
          class="im-add"
          type="button"
          aria-haspopup="menu"
          aria-expanded=${imProviderMenuOpen ? "true" : "false"}
          @click=${toggleImProviderMenu}
        >
          ${icon(Plus, 16)}<span>${t("Connect chat channel")}</span>
        </button>
      </div>
    </div>
    ${
      imProviderMenuOpen
        ? html`<div class="im-add-wrap">
            <div class="im-provider-menu" role="menu">
              ${IM_PROVIDER_OPTIONS.map((option) => {
                const binding = imBindings[option.id];
                const connected = binding?.status === "connected";
                const pending = binding?.status === "pending";
                let stateLabel = t("Start setup");
                if (connected) stateLabel = t("Bound");
                else if (pending) stateLabel = t("Continue setup");
                else if (reusableImProviders.has(option.id)) stateLabel = t("Rebind existing Bot");
                return html`<button
                  class="im-provider-option"
                  type="button"
                  role="menuitem"
                  ?disabled=${connected}
                  @click=${() => {
                    if (pending) showImBinding(option.id);
                    else void startImBinding(option.id);
                  }}
                >
                  ${imLogo(option)}<span>${t(option.label)}</span>
                  <span class=${pending ? "im-provider-state pending" : "im-provider-state"}> ${stateLabel} </span>
                </button>`;
              })}
            </div>
          </div>`
        : nothing
    }
    ${imSetupPanel()} ${imBindingsLoading ? html`<div class="im-panel-note">${t("Loading…")}</div>` : nothing}
    ${imBindingsError ? html`<div class="im-panel-error" role="alert">${imBindingsError}</div>` : nothing}
  </div>`;
}

function renderImPanel(): void {
  const host = (appEl as HTMLElement).querySelector<HTMLElement>("#im-panel-host");
  if (host) render(imPanel(), host);
}

export async function signOut(): Promise<void> {
  const portal = authMode === "portal";
  if (!portal) {
    try {
      await api("/signout", { method: "POST" });
    } catch {
      void 0;
    }
  }
  appState.me = null;
  clearAllDrafts();
  exitSplitIfActive();
  mainConversation().resetChatState();
  resetSessionsState();
  appState.currentView = "chats";
  clearSkillsCache();
  resetMemoryState();
  resetContextsState();
  resetKeychainState();
  mainConversation().composer.resetComposer();
  if (!portal) {
    renderAuthGate({ kind: "dev" });
    return;
  }
  let endedSession: boolean;
  try {
    const r = await fetch("/auth/logout", { method: "POST", headers: { accept: "application/json" } });
    endedSession = r.ok;
  } catch {
    endedSession = false;
  }
  if (!endedSession) {
    renderAuthGate({ kind: "portal" });
    return;
  }
  clearPortalAttempt();
  location.href = "/";
}

export async function exitImpersonation(): Promise<void> {
  try {
    await fetch("/auth/impersonate/stop", { method: "POST", headers: { accept: "application/json" } });
  } catch {
    void 0;
  }
  window.location.href = ADMIN_HOME_URL;
}

function impersonationBanner(by: string) {
  return html`
    <div class="top-banner" role="status">
      <span>Viewing the assistant as <b>${appState.me?.user ?? ""}</b> — you are <b>${by}</b></span>
      <button class="top-banner-action" type="button" @click=${exitImpersonation}>Exit impersonation</button>
    </div>
  `;
}

function devBanner(user: string) {
  return html`
    <div class="top-banner dev" role="status">
      <span><b>Dev mode</b> — no identity provider, signed in as ${user}</span>
      <button class="top-banner-action" type="button" @click=${signOut}>Sign out</button>
    </div>
  `;
}

function gateShell(body: unknown) {
  return html`
    <div class="signin">
      <div class="signin-panel">
        <div class="signin-brand">
          ${brandMark()}<span>${brandName()}</span>
          ${authMode === "dev" ? html`<span class="dev-chip">DEV</span>` : nothing}
        </div>
        ${body}
      </div>
    </div>
  `;
}

const PORTAL_ATTEMPT_KEY = "qm.portal.signin.attempt";
const PORTAL_ATTEMPT_WINDOW_MS = 20_000;

function portalAttemptedRecently(): boolean {
  try {
    const at = Number(sessionStorage.getItem(PORTAL_ATTEMPT_KEY) ?? "");
    return Number.isFinite(at) && Date.now() - at < PORTAL_ATTEMPT_WINDOW_MS;
  } catch {
    return false;
  }
}

function signInWithPortal(): void {
  try {
    sessionStorage.setItem(PORTAL_ATTEMPT_KEY, String(Date.now()));
  } catch {
    void 0;
  }
  const returnTo = `${location.pathname}${location.search}`;
  location.href = `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function clearPortalAttempt(): void {
  try {
    sessionStorage.removeItem(PORTAL_ATTEMPT_KEY);
  } catch {
    void 0;
  }
}

function portalGate() {
  if (portalAttemptedRecently())
    return gateShell(html`
      <h1>Sign in through the portal</h1>
      <p class="signin-body">
        This surface is reached through the portal, and signing in there didn't produce a session for it. Open the
        portal address directly rather than this one.
      </p>
      <div class="hint">
        If you opened this surface's own address, that's the cause — it can't authenticate anyone on its own.
      </div>
    `);
  return gateShell(html`
    <h1>Your session ended</h1>
    <p class="signin-body">You've been signed out. Sign in again and you'll come back to this page.</p>
    <button class="btn primary" type="button" @click=${signInWithPortal}>Sign in</button>
  `);
}

function deniedGate() {
  return gateShell(html`
    <h1>You don't have access</h1>
    <p class="signin-body">
      Your account is signed in and verified — it just isn't allowed on this instance. Ask an administrator to add you.
    </p>
    <button class="btn" type="button" @click=${signOut}>Sign out</button>
    ${
      authMode === "dev"
        ? html`<div class="hint">This instance lists its principals in <b>WEB_UI_PRINCIPALS</b>.</div>`
        : nothing
    }
  `);
}

function retryBoot(): void {
  void bootSafely();
}

function unreachableGate() {
  return gateShell(html`
    <h1>We couldn't reach the assistant</h1>
    <p class="signin-body">The service didn't respond. This is usually temporary.</p>
    <button class="btn primary" type="button" @click=${retryBoot}>Try again</button>
    <div class="hint">If this keeps happening, the core service may be down.</div>
  `);
}

async function submitDevSignin(user: string): Promise<void> {
  renderAuthGate({ kind: "dev", value: user, pending: true });
  try {
    await api("/signin", { method: "POST", body: JSON.stringify({ user }) });
  } catch (err) {
    renderAuthGate({ kind: "dev", value: user, error: errMessage(err, "Sign-in failed.") });
    return;
  }
  await bootSafely();
}

function devGate(gate: { value?: string; error?: string; pending?: boolean }) {
  return gateShell(html`
    <form
      @submit=${(e: Event) => {
        e.preventDefault();
        if (gate.pending) return;
        const input = (e.target as HTMLFormElement).querySelector("input") as HTMLInputElement | null;
        const user = input?.value.trim();
        if (user) void submitDevSignin(user);
      }}
    >
      <h1>Dev sign-in</h1>
      <p class="signin-body">
        No identity provider is configured, so this instance trusts a local cookie. Set
        <b>CORE_SIGNING_SECRET</b> and run the portal to use real sign-in.
      </p>
      <label for="dev-principal">Principal</label>
      <input
        id="dev-principal"
        name="principal"
        type="text"
        inputmode="email"
        autocomplete="username"
        spellcheck="false"
        required
        autofocus
        placeholder="you@org.com"
        .value=${gate.value ?? ""}
        ?disabled=${gate.pending === true}
      />
      <button class="btn primary" type="submit" ?disabled=${gate.pending === true}>
        ${t(gate.pending ? "Signing in…" : "Continue")}
      </button>
      ${gate.error ? html`<div class="hint error" role="alert">${gate.error}</div>` : nothing}
    </form>
  `);
}

export type AuthGate =
  | { kind: "portal" }
  | { kind: "denied" }
  | { kind: "unreachable" }
  | { kind: "dev"; value?: string; error?: string; pending?: boolean };

export function renderAuthGate(gate: AuthGate): void {
  shellMounted = false;
  const body = (() => {
    switch (gate.kind) {
      case "portal":
        return portalGate();
      case "denied":
        return deniedGate();
      case "unreachable":
        return unreachableGate();
      default:
        return devGate(gate);
    }
  })();
  render(body, appEl as HTMLElement);
}

function gateFor(mode: AuthMode, reason: "unauthenticated" | "not_allowed" | undefined): AuthGate {
  if (reason === "not_allowed") return { kind: "denied" };
  return mode === "dev" ? { kind: "dev" } : { kind: "portal" };
}

export function mountShell(): void {
  applySavedSidebarWidth();
  const impersonatedBy = appState.me?.impersonatedBy ?? null;
  let banner: TemplateResult | null = null;
  if (impersonatedBy) banner = impersonationBanner(impersonatedBy);
  else if (authMode === "dev") banner = devBanner(appState.me?.user ?? "");
  render(
    html`
      ${banner ?? nothing}
      <div class="layout ${sidebarOpen ? "" : "sidebar-closed"} ${banner ? "bannered" : ""}">
        <aside class="sidebar" aria-label="Navigation" @keydown=${onSidebarKeydown}>
          <div class="brand">
            <div class="brand-lockup">${brandMark()}<span class="brand-name">${brandName()}</span></div>
            <button
              class="icon-btn subtle sidebar-toggle sidebar-collapse-toggle"
              type="button"
              title="Hide sidebar"
              aria-label="Hide sidebar"
              @click=${toggleSidebar}
            >
              ${icon(PanelLeft, 17)}
            </button>
          </div>
          <div id="sidebar-top"></div>
          <div class="list" id="sidebar-body"></div>
          <div class="sidebar-footer">
            <button
              class="user-pill"
              type="button"
              title=${appState.me?.user ?? ""}
              aria-label=${t("Open IM channel settings")}
              aria-haspopup="dialog"
              aria-expanded="false"
              @click=${toggleImPanel}
            >
              <span class="avatar">${initials(appState.me?.user ?? "?")}</span>
              <span class="user-name">${appState.me?.user ?? ""}</span>
            </button>
            <div id="im-panel-host"></div>
            <a class="icon-btn subtle" href=${ADMIN_HOME_URL} title="Back to admin" aria-label="Back to admin"
              >${icon(ShieldCheck, 17)}</a
            >
            <button
              class="language-toggle"
              type="button"
              data-i18n-skip
              title=${currentLocale() === "en" ? "Switch to Chinese" : "切换到英文"}
              aria-label=${currentLocale() === "en" ? "Switch to Chinese" : "切换到英文"}
              @click=${() => setLocale(currentLocale() === "en" ? "zh-CN" : "en")}
            >
              ${currentLocale() === "en" ? "中文" : "EN"}
            </button>
            <theme-toggle .includeSystem=${true} title="Color scheme: light / dark / system"></theme-toggle>
            <button class="icon-btn subtle" title="Sign out" aria-label="Sign out" @click=${signOut}>
              ${icon(LogOut, 17)}
            </button>
          </div>
        </aside>
        <button class="sidebar-scrim" type="button" aria-label="Close sidebar" @click=${toggleSidebar}></button>
        <div
          class="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize · double-click to reset"
          @pointerdown=${startSidebarResize}
          @dblclick=${resetSidebarWidth}
        ></div>
        <section class="main" id="main" tabindex="-1">
          <div class="empty">Pick a conversation, or start a new chat.</div>
        </section>
      </div>
    `,
    appEl as HTMLElement,
  );
  appState.topEl = (appEl as HTMLElement).querySelector("#sidebar-top");
  appState.listEl = (appEl as HTMLElement).querySelector("#sidebar-body");
  appState.mainEl = (appEl as HTMLElement).querySelector("#main");
  renderSidebarTop();
  renderImPanel();
  updateSidebarToggleLabels();
  syncSidebarAccessibility(false);
  shellMounted = true;
}

export function renderSidebarTop(): void {
  if (!appState.topEl) return;
  const navRow = (v: View, glyph: IconNode, label: string) =>
    html`<a
      class="navrow ${appState.currentView === v ? "active" : ""}"
      href=${deepLinkPath(UI_BASE, v, null)}
      data-view=${v}
      title=${label}
    >
      ${icon(glyph, 17)}<span>${label}</span>
    </a>`;
  const navGroup = (id: string, title: string, open: boolean, toggle: () => void, rows: TemplateResult) => html`
    <button
      class="nav-section-toggle"
      type="button"
      aria-expanded=${open ? "true" : "false"}
      aria-controls=${id}
      title=${open ? `${t("Hide")} ${t(title)}` : `${t("Show")} ${t(title)}`}
      @click=${toggle}
    >
      <span>${t(title)}</span>
      <span class="nav-section-chevron">${icon(ChevronDown, 14)}</span>
    </button>
    <div id=${id} class="nav-group ${open ? "" : "collapsed"}">
      <div class="nav-group-inner">${rows}</div>
    </div>
  `;
  render(
    html`
      <button
        class="new-chat"
        title=${t(splitState.active ? "New session" : "New chat")}
        @click=${() => {
          closeSidebarOnNarrowView();
          if (!addBlankPane()) mainConversation().newChat();
        }}
      >
        ${icon(ICON.newChat, 17)}<span>${t(splitState.active ? "New session" : "New chat")}</span>
      </button>
      <nav class="nav" @click=${onNavClick}>
        ${navGroup(
          "nav-workspace",
          "Browse",
          navWorkspaceOpen,
          toggleNavWorkspace,
          html`
            ${navRow("contexts", ICON.contexts, t("Projects"))} ${navRow("chats", ICON.chats, t("Chats"))}
            ${navRow("files", ICON.files, t("Files"))} ${navRow("crons", ICON.crons, t("Crons"))}
            ${navRow("keychain", ICON.keychain, t("Keychain"))} ${navRow("deploys", ICON.deploys, t("Apps"))}
            ${navRow("memory", ICON.memory, t("Memory"))} ${navRow("skills", ICON.skills, t("Skills"))}
            ${
              can("admin")
                ? html`<a class="navrow" href=${ADMIN_HOME_URL} title=${t("Admin")}>
                    ${icon(ShieldCheck, 17)}<span>${t("Admin")}</span>
                  </a>`
                : nothing
            }
          `,
        )}
      </nav>
      ${html`
        <div class="section-label recents-label">
          <span>${t("Sessions")}</span>
          <button
            class="chat-search-open"
            type="button"
            aria-label=${t("Search your chats")}
            @click=${() => {
              hideTooltip();
              openChatSearch();
            }}
            @mouseenter=${(e: Event) =>
              showTooltip(e.currentTarget as Element, `${t("Search your chats")} · ${SEARCH_HOTKEY_LABEL}`)}
            @mouseleave=${(e: Event) => hideTooltip(e.currentTarget as Element)}
            @focus=${(e: Event) =>
              showTooltip(e.currentTarget as Element, `${t("Search your chats")} · ${SEARCH_HOTKEY_LABEL}`)}
            @blur=${(e: Event) => hideTooltip(e.currentTarget as Element)}
          >
            ${icon(Search, 13)}
          </button>
          <button
            class="web-only-toggle ${sessionsState.webOnly ? "on" : ""}"
            type="button"
            role="switch"
            aria-checked=${sessionsState.webOnly ? "true" : "false"}
            title=${t(sessionsState.webOnly ? "Showing web chats only" : "Hide non-web conversations")}
            @click=${toggleWebOnly}
          >
            <span>${t("Web only")}</span><span class="mini-switch"><span class="mini-knob"></span></span>
          </button>
        </div>
      `}
    `,
    appState.topEl,
  );
}

function onNavClick(e: Event): void {
  const target = e.target as Element | null;
  const row = target?.closest<HTMLAnchorElement>(".navrow[data-view]");
  const view = row?.dataset.view;
  if (!isView(view)) return;
  if (e instanceof MouseEvent && !isPlainLeftClick(e)) return;
  e.preventDefault();
  setScopedSession(null);
  switchView(view);
  closeSidebarOnNarrowView();
}

export function switchView(v: View): void {
  closeSidebarOnNarrowView();
  if (appState.currentView === v) {
    refreshActiveView(v);
    return;
  }
  appState.currentView = v;
  appState.viewRenderSeq++;
  sessionsState.openMenuId = null;
  sessionsState.renamingId = null;
  if (v !== "chats") {
    mainConversation().teardown();
    mainConversation().composer.resetComposer();
  }
  renderSidebarTop();
  syncUrlFromState();
  switch (v) {
    case "chats":
      if (splitState.active) drawCanvas();
      else void renderChatsPage();
      renderList();
      break;
    case "crons":
      resetActiveCron();
      void renderCronsPage();
      break;
    case "contexts":
      void renderContexts();
      break;
    case "files":
      void renderFiles();
      break;
    case "keychain":
      void renderConnectors();
      break;
    case "deploys":
      void renderDeploys();
      break;
    case "memory":
      void renderMemory();
      break;
    case "skills":
      void renderSkills();
      break;
  }
}

function refreshActiveView(v: View): void {
  switch (v) {
    case "chats":
      if (splitState.active) void refreshSessions({ silent: true, refreshContexts: true });
      else void renderChatsPage();
      break;
    case "contexts":
      void renderContexts();
      break;
    case "crons":
      void renderCronsPage();
      break;
    case "files":
      void renderFiles();
      break;
    case "keychain":
      clearConnectorNotice();
      void renderConnectors();
      break;
    case "deploys":
      void renderDeploys();
      break;
    case "memory":
      void renderMemory();
      break;
    case "skills":
      void renderSkills();
      break;
  }
}

export function showMainEmpty(text: string): void {
  exitSplitIfActive();
  mainConversation().state.host = null;
  if (appState.mainEl)
    appState.mainEl.replaceChildren(
      Object.assign(document.createElement("div"), { className: "empty", textContent: t(text) }),
    );
}

function toggleSidebar(): void {
  setSidebarOpen(!sidebarOpen);
}

export function closeSidebarOnNarrowView(): void {
  if (!narrowViewport.matches || !sidebarOpen) return;
  setSidebarOpen(false, false);
  requestAnimationFrame(() => appState.mainEl?.focus({ preventScroll: true }));
}

narrowViewport.addEventListener("change", (event) => {
  if (event.matches && sidebarOpen) setSidebarOpen(false, false);
  else syncSidebarAccessibility(false);
});

function setSidebarOpen(open: boolean, moveFocus = true): void {
  sidebarOpen = open;
  if (!open) setImPanelOpen(false);
  (appEl as HTMLElement).querySelector(".layout")?.classList.toggle("sidebar-closed", !sidebarOpen);
  updateSidebarToggleLabels();
  syncSidebarAccessibility(moveFocus);
}

function syncSidebarAccessibility(moveFocus: boolean): void {
  const root = appEl as HTMLElement;
  const sidebar = root.querySelector<HTMLElement>(".sidebar");
  const main = root.querySelector<HTMLElement>(".main");
  const scrim = root.querySelector<HTMLButtonElement>(".sidebar-scrim");
  const modal = narrowViewport.matches && sidebarOpen;
  if (!sidebar || !main || !scrim) return;
  main.inert = modal;
  sidebar.setAttribute("role", modal ? "dialog" : "navigation");
  if (modal) sidebar.setAttribute("aria-modal", "true");
  else sidebar.removeAttribute("aria-modal");
  scrim.hidden = !modal;
  if (!moveFocus || !narrowViewport.matches) return;
  requestAnimationFrame(() => sidebar.querySelector<HTMLElement>(".sidebar-collapse-toggle")?.focus());
}

function onSidebarKeydown(event: KeyboardEvent): void {
  if (!narrowViewport.matches || !sidebarOpen) return;
  if (event.key === "Escape" && event.defaultPrevented) return;
  if (event.key === "Escape" && closeOpenSessionMenu()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  trapDialogFocus(event, () => setSidebarOpen(false));
}

function updateSidebarToggleLabels(): void {
  const collapseLabel = t(sidebarOpen ? "Hide sidebar" : "Show sidebar");
  (appEl as HTMLElement).querySelectorAll<HTMLButtonElement>(".sidebar-toggle").forEach((btn) => {
    btn.setAttribute("aria-expanded", sidebarOpen ? "true" : "false");
    btn.setAttribute("title", collapseLabel);
    btn.setAttribute("aria-label", collapseLabel);
  });
}

export function renderPane(
  title: string,
  status: string,
  onRefresh: () => void,
  cards: unknown,
  controls: unknown = "",
): void {
  if (!appState.mainEl) return;
  const refreshLabel = t(`Refresh ${title.toLowerCase()}`);
  const host = document.createElement("div");
  host.className = "pane";
  render(
    html`
      <div class="pane-head">
        <h1 class="pane-title">${t(title)}</h1>
        <div class="list-page-actions">
          ${controls}
          <button
            class="pane-refresh"
            type="button"
            aria-label=${refreshLabel}
            title=${refreshLabel}
            @click=${onRefresh}
          >
            ${icon(RefreshCw, 17)}
          </button>
        </div>
      </div>
      ${status ? html`<div class="status">${status}</div>` : ""}
      <div class="grid">${cards}</div>
    `,
    host,
  );
  replacePanePreservingFocus(host);
}

export function replacePanePreservingFocus(host: HTMLElement): void {
  if (!appState.mainEl) return;
  replaceChildrenPreservingFocus(appState.mainEl, host);
}

window.addEventListener("popstate", () => {
  if (appState.currentView !== "crons") return;
  const { view, item } = parseDeepLink(UI_BASE, location.pathname, location.search);
  if (view !== "crons") return;
  routeCronsHistory(item);
});

window.addEventListener("focus", () => {
  if (!appState.me) return;
  if (appState.currentView === "contexts") void renderContexts();
  else if (appState.currentView === "chats") void refreshSessions({ silent: true, refreshContexts: true });
});

function warmDeferredChunks(): void {
  const warm = (): void => void import("@earendil-works/pi-web-ui").catch(() => {});
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) ric(warm);
  else setTimeout(warm, 1500);
}

window.addEventListener("click", (event) => {
  if (!imPanelOpen) return;
  const target = event.target as Node | null;
  const footer = (appEl as HTMLElement).querySelector<HTMLElement>(".sidebar-footer");
  if (target && footer?.contains(target)) return;
  setImPanelOpen(false);
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !imPanelOpen) return;
  event.preventDefault();
  setImPanelOpen(false, true);
});

function openAppEditChat(slug: string): void {
  const user = appState.me?.user ?? "anon";
  const threadRef = `web:${user}:app-edit:${slug}`;
  const existing = sessionsState.list.find((s) => s.threadRef === threadRef);
  if (existing) {
    void openSession(existing);
    return;
  }
  if (!storedDraft(threadRef)) saveDraft(threadRef, `Update my deployed app "${slug}": `);
  mainConversation().mountContinuable(threadRef, null, null, []);
  renderList();
}

export async function bootSafely(): Promise<void> {
  try {
    await boot();
  } catch (e) {
    if (shellMounted) swallow("web-ui: boot", e);
    else renderAuthGate({ kind: "unreachable" });
  }
}

export async function boot(): Promise<void> {
  let r: Response;
  try {
    r = await fetch(withBase("/me"));
  } catch {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  if (r.status === 401) {
    const body = (await r.json().catch(() => ({}))) as SigninRequired;
    authMode = body.mode ?? "portal";
    renderAuthGate(gateFor(authMode, body.reason));
    return;
  }
  if (!r.ok) {
    renderAuthGate({ kind: "unreachable" });
    return;
  }
  resetKeychainState();
  appState.me = (await r.json()) as Me;
  authMode = appState.me.mode ?? "portal";
  clearPortalAttempt();
  const personalScope = `personal:${appState.me.user}`;
  const runtimeConfig = await fetchRuntimeConfig(personalScope);
  if (runtimeConfig) {
    applyRuntimeOptions(
      personalScope,
      runtimeConfig.approvedHarnesses,
      runtimeConfig.modelsByHarness,
      runtimeConfig.effective,
      runtimeConfig.modelCatalog,
    );
    seedRuntimeConfig(personalScope, runtimeConfig);
  }
  resyncModelSelection();
  mountShell();
  ensureDeliveryStream();
  warmDeferredChunks();
  loadPersistedSplit();
  await adoptRemoteSplit();

  const params = new URLSearchParams(location.search);
  const {
    view: wanted,
    session: wantedSession,
    item: wantedItem,
  } = parseDeepLink(UI_BASE, location.pathname, location.search);
  const connectedProvider = params.get("status") === "connected" ? params.get("connector") : null;
  if (connectedProvider) markConnectorConnected(connectedProvider);
  const viewIntent = isView(wanted) && wanted !== "chats";
  const entriesPrefetch =
    wantedSession && !viewIntent ? fetchTranscript(wantedSession, { tailTurns: TAIL_TURNS }).catch(() => null) : null;

  const bareEntry = !viewIntent && !wantedSession && wanted !== "app-edit" && !connectedProvider;
  if (bareEntry && !restoredCanvasNeedsSessionList()) mountRestoredCanvas();

  await refreshSessions({ showLoading: true });

  if (wanted === "app-edit") {
    const slug = (params.get("slug") ?? "").toLowerCase();
    if (/^[a-z0-9-]{1,63}$/.test(slug)) {
      openAppEditChat(slug);
      return;
    }
    showMainEmpty("This edit link is missing a valid app name.");
    return;
  }

  if (wanted === "keychain") {
    const provider = params.get("connector");
    const status = params.get("status");
    if (provider && status) noteConnectorResult(provider, status);
    switchView("keychain");
  } else if (viewIntent) {
    if (wanted === "contexts" || wanted === "files" || wanted === "deploys") {
      const scope =
        params.get("scope") ?? (wantedItem ? resolveProjectScope(await ensureContexts(), wantedItem) : null);
      if (scope) contextsState.selected = scope;
    }
    if (wanted === "crons" && wantedItem) openCronById(wantedItem);
    switchView(wanted as View);
  } else if (wantedSession) {
    const match = sessionsState.list.find((s) => s.id === wantedSession);
    if (match) {
      exitSplitIfActive();
      await openSession(match, entriesPrefetch ?? undefined);
    } else if (mountRestoredCanvas()) {
      canvasToast("That conversation wasn't found, or you don't have access to it.");
      syncUrlFromState();
    } else {
      showMainEmpty("That conversation wasn't found, or you don't have access to it.");
      renderList();
    }
  } else if (connectedProvider && sessionsState.list.length) {
    const recent = [...sessionsState.list].sort((a, b) => activityOf(b) - activityOf(a))[0]!;
    exitSplitIfActive();
    await openSession(recent);
  } else if (!mountRestoredCanvas() && !mainConversation().state.threadRef) {
    mainConversation().newChat();
  }
}
