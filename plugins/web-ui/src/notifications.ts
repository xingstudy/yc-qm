import { nothing, render, type TemplateResult } from "lit";
import { AtSign, Bell, Check, CheckCheck, ChevronRight, CircleAlert, CircleCheck, MessageCircle } from "lucide";
import { api } from "./core-bridge";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { html, localeCode, t } from "./i18n";
import { listPageTpl } from "./list-page";
import { appState } from "./shell-state";
import { icon } from "./ui";

type Kind = "message" | "mention" | "cron_success" | "cron_failure" | "action";

interface NotificationView {
  id: string;
  kind: Kind;
  createdAt: number;
  readAt: number | null;
  unavailable?: boolean;
  source?: string;
  summary?: string;
  sessionId?: string;
  entrySeq?: number;
  cronId?: string;
  fireKey?: string;
  approvalId?: string;
  deliveryStatus?: "pending" | "delivered" | "failed" | null;
}

let items: NotificationView[] = [];
let unread = 0;
let conversationUnread: Record<string, { messages: number; mentions: number }> = {};
let loadedFor: string | null = null;
let filter: Kind | "all" = "all";
let error = "";
let refreshSeq = 0;
let host: HTMLElement | null = null;

function changed(): void {
  document.dispatchEvent(new Event("qm:notifications-updated"));
  if (appState.currentView === "notifications") draw();
}

export function notificationUnreadCount(): number {
  return unread;
}

export function unreadBadgeValue(counts: { messages: number; mentions: number }): string {
  if (counts.mentions > 0) return "@";
  return counts.messages > 99 ? "99+" : String(counts.messages);
}

export function sessionUnread(sessionId: string): { messages: number; mentions: number } {
  return conversationUnread[sessionId] ?? { messages: 0, mentions: 0 };
}

export function scopeUnread(sessionIds: readonly string[]): { messages: number; mentions: number } {
  const ids = new Set(sessionIds);
  return Object.entries(conversationUnread).reduce(
    (counts, [id, current]) => {
      if (ids.has(id)) {
        counts.messages += current.messages;
        counts.mentions += current.mentions;
      }
      return counts;
    },
    { messages: 0, mentions: 0 },
  );
}

export function resetNotifications(): void {
  refreshSeq++;
  items = [];
  unread = 0;
  conversationUnread = {};
  loadedFor = null;
  error = "";
  changed();
}

export async function refreshNotifications(): Promise<void> {
  const user = appState.me?.user;
  if (!user) return;
  const seq = ++refreshSeq;
  try {
    const result = await api<{
      notifications: NotificationView[];
      unread: number;
      conversationUnread: Record<string, { messages: number; mentions: number }>;
    }>("/api/notifications");
    if (appState.me?.user !== user || seq !== refreshSeq) return;
    items = result.notifications ?? [];
    unread = result.unread ?? 0;
    conversationUnread = result.conversationUnread ?? {};
    loadedFor = user;
    error = "";
  } catch {
    if (appState.me?.user !== user || seq !== refreshSeq) return;
    error = t("Could not load notifications.");
  }
  changed();
}

async function markNotificationRead(id: string): Promise<void> {
  const item = items.find((record) => record.id === id);
  if (!item || item.readAt !== null) return;
  try {
    await api(`/api/notifications/${encodeURIComponent(id)}/read`, { method: "POST" });
  } catch {
    await refreshNotifications();
    return;
  }
  await refreshNotifications();
}

export async function markSessionNotificationsRead(sessionId: string): Promise<void> {
  try {
    await api(`/api/notifications/sessions/${encodeURIComponent(sessionId)}/read`, { method: "POST" });
  } catch {
    void 0;
  }
  await refreshNotifications();
}

async function markAllRead(): Promise<void> {
  try {
    await api("/api/notifications/read-all", { method: "POST" });
  } catch {
    await refreshNotifications();
    return;
  }
  await refreshNotifications();
}

const kindLabels: Record<Kind, string> = {
  message: "New message",
  mention: "Mentioned me",
  cron_success: "Task completed",
  cron_failure: "Task failed",
  action: "Action required",
};

const kindIcons = {
  message: MessageCircle,
  mention: AtSign,
  cron_success: CircleCheck,
  cron_failure: CircleAlert,
  action: Bell,
};

function taskHref(item: NotificationView): string | null {
  if (item.unavailable) return null;
  if (item.cronId) {
    const path = deepLinkPath(UI_BASE, "crons", null, null, item.cronId);
    return item.fireKey ? `${path}?run=${encodeURIComponent(item.fireKey)}` : path;
  }
  return null;
}

function conversationHref(item: NotificationView): string | null {
  if (item.unavailable) return null;
  if (item.sessionId) {
    const path = deepLinkPath(UI_BASE, "chats", item.sessionId);
    return item.entrySeq === undefined ? path : `${path}?entry=${item.entrySeq}`;
  }
  return null;
}

function notificationRow(item: NotificationView): TemplateResult {
  const chatHref = conversationHref(item);
  const detailHref = taskHref(item);
  const href = chatHref ?? detailHref;
  const date = new Date(item.createdAt).toLocaleString(localeCode(), { timeZoneName: "short" });
  const content = html`
    <span class="notification-glyph" aria-hidden="true">${icon(kindIcons[item.kind], 19)}</span>
    <span class="notification-main">
      <span class="notification-heading">
        <span class="notification-kind">${t(kindLabels[item.kind])}</span>
        <time class="notification-time" datetime=${new Date(item.createdAt).toISOString()}>${date}</time>
      </span>
      <span class="notification-source" dir="auto"
        >${item.unavailable ? t("Source unavailable") : (item.source ?? t("Conversation"))}</span
      >
      ${item.unavailable || !item.summary ? nothing : html`<span class="notification-summary" dir="auto">${item.summary}</span>`}
      ${item.deliveryStatus === "failed" ? html`<span class="notification-delivery-failed">${t("Delivery failed")}</span>` : nothing}
      ${detailHref ? html`<span class="notification-open-label">${t(chatHref ? "View conversation" : "Task details")}</span>` : nothing}
    </span>
    ${href ? html`<span class="notification-arrow" aria-hidden="true">${icon(ChevronRight, 17)}</span>` : nothing}
  `;
  return html`<div class="notification-row ${item.kind} ${item.readAt === null ? "unread" : ""}">
    ${
      href
        ? html`<a
            class="notification-content"
            href=${href}
            aria-label=${`${t(kindLabels[item.kind])}: ${item.source ?? t("Conversation")}`}
            @click=${(event: MouseEvent) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              void markNotificationRead(item.id).then(() => location.assign(href));
            }}
            >${content}</a
          >`
        : html`<div class="notification-content">${content}</div>`
    }
    ${
      chatHref && detailHref
        ? html`<a
            class="notification-detail-link"
            href=${detailHref}
            @click=${(event: MouseEvent) => {
              if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              void markNotificationRead(item.id).then(() => location.assign(detailHref));
            }}
            >${t("Task details")}</a
          >`
        : nothing
    }
    ${
      item.readAt === null
        ? html`<button
            class="icon-btn notification-mark-read"
            type="button"
            aria-label=${t("Mark as read")}
            @click=${() => void markNotificationRead(item.id)}
          >
            ${icon(Check, 17)}
          </button>`
        : nothing
    }
  </div>`;
}

function draw(): void {
  if (appState.currentView !== "notifications" || !appState.mainEl) return;
  if (!host || host.parentElement !== appState.mainEl) {
    host = document.createElement("div");
    host.className = "pane notifications-page";
    appState.mainEl.replaceChildren(host);
  }
  const visible = filter === "all" ? items : items.filter((item) => item.kind === filter);
  const filters: Array<{ key: Kind | "all"; label: string }> = [
    { key: "all", label: "All" },
    { key: "mention", label: "Mentioned me" },
    { key: "cron_success", label: "Task completed" },
    { key: "cron_failure", label: "Task failed" },
    { key: "action", label: "Action required" },
  ];
  let empty = "Loading notifications…";
  if (error) empty = error;
  else if (loadedFor) empty = filter === "all" ? "No notifications." : "No notifications of this type.";
  render(
    html`
      ${listPageTpl({
        title: "Notifications",
        subtitle: unread ? `${t("Unread notifications")}: ${unread}` : "All caught up",
        controls: html`<button class="btn" type="button" ?disabled=${unread === 0} @click=${() => void markAllRead()}>
          ${icon(CheckCheck, 15)} ${t("Mark all as read")}
        </button>`,
        filters: html`<div class="notification-filters" role="group" aria-label=${t("Notification type")}>
          ${filters.map(({ key, label }) => {
            const count = key === "all" ? items.length : items.filter((item) => item.kind === key).length;
            return html`<button
              class="notification-filter-chip ${filter === key ? "active" : ""}"
              type="button"
              aria-pressed=${filter === key}
              @click=${() => {
                filter = key;
                draw();
              }}
            >
              ${t(label)} <span class="notification-filter-count">${count}</span>
            </button>`;
          })}
        </div>`,
        rows: visible.map(notificationRow),
        empty,
      })}
    `,
    host,
  );
}

export function renderNotifications(): void {
  draw();
  void refreshNotifications();
}
