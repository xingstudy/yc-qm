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
let status: "all" | "unread" | "read" = "all";
let read = 0;
let total = 0;
let kindCounts: Partial<Record<Kind, number>> = {};
let page = 1;
let pages = 1;
let loading = false;
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
  status = "all";
  filter = "all";
  read = 0;
  total = 0;
  kindCounts = {};
  page = 1;
  pages = 1;
  loading = false;
  error = "";
  changed();
}

export async function refreshNotifications(): Promise<void> {
  const user = appState.me?.user;
  if (!user) return;
  const seq = ++refreshSeq;
  loading = true;
  draw();
  const query = new URLSearchParams();
  if (status !== "all") query.set("status", status);
  if (filter !== "all") query.set("kind", filter);
  if (page > 1) query.set("page", String(page));
  try {
    const result = await api<{
      notifications: NotificationView[];
      unread: number;
      read?: number;
      total?: number;
      kindCounts?: Partial<Record<Kind, number>>;
      page?: number;
      pages?: number;
      conversationUnread: Record<string, { messages: number; mentions: number }>;
    }>(`/api/notifications${query.size ? `?${query}` : ""}`);
    if (appState.me?.user !== user || seq !== refreshSeq) return;
    items = result.notifications ?? [];
    unread = result.unread ?? 0;
    read = result.read ?? items.filter((item) => item.readAt !== null).length;
    total = result.total ?? items.length;
    kindCounts = result.kindCounts ?? {};
    page = result.page ?? 1;
    pages = result.pages ?? 1;
    conversationUnread = result.conversationUnread ?? {};
    loadedFor = user;
    error = "";
  } catch {
    if (appState.me?.user !== user || seq !== refreshSeq) return;
    error = t("Could not load notifications.");
  }
  loading = false;
  changed();
}

function loadPage(number: number): void {
  page = number;
  items = [];
  loadedFor = null;
  error = "";
  void refreshNotifications();
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
  const groups = new Map<string, NotificationView[]>();
  for (const item of items) {
    const cronId = item.kind.startsWith("cron_") ? (item.cronId ?? /^cron:([^:]+):/.exec(item.id)?.[1]) : undefined;
    const key = cronId ? `cron:${cronId}` : item.id;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const filters: Array<{ key: Kind | "all"; label: string }> = [
    { key: "all", label: "All" },
    { key: "mention", label: "Mentioned me" },
    { key: "cron_success", label: "Task completed" },
    { key: "cron_failure", label: "Task failed" },
    { key: "action", label: "Action required" },
  ];
  const pageNumbers = [
    ...new Set([
      1,
      ...Array.from({ length: Math.min(5, pages) }, (_, i) => Math.max(1, Math.min(page - 2, pages - 4)) + i),
      pages,
    ]),
  ].sort((a, b) => a - b);
  let empty = "Loading notifications…";
  if (error) empty = error;
  else if (loadedFor) {
    if (status === "unread")
      empty = filter === "all" ? "No unread notifications." : "No unread notifications of this type.";
    else if (status === "read")
      empty = filter === "all" ? "No read notifications." : "No read notifications of this type.";
    else empty = filter === "all" ? "No notifications." : "No notifications of this type.";
  }
  render(
    html`
      ${listPageTpl({
        title: "Notifications",
        subtitle: unread ? `${t("Unread notifications")}: ${unread}` : "All caught up",
        controls: html`
          <div class="list-page-actions" role="group" aria-label=${t("Read status")}>
            ${(
              [
                { key: "all", label: "All notifications", count: unread + read },
                { key: "unread", label: "Unread", count: unread },
                { key: "read", label: "Read", count: read },
              ] as const
            ).map(
              ({ key, label, count }) =>
                html`<button
                  class="notification-filter-chip ${status === key ? "active" : ""}"
                  type="button"
                  aria-pressed=${status === key}
                  @click=${() => {
                    status = key;
                    loadPage(1);
                  }}
                >
                  ${t(label)} <span class="notification-filter-count">${count}</span>
                </button>`,
            )}
          </div>
          <button class="btn" type="button" ?disabled=${unread === 0} @click=${() => void markAllRead()}>
            ${icon(CheckCheck, 15)} ${t("Mark all as read")}
          </button>
        `,
        filters: html`<div class="notification-filters" role="group" aria-label=${t("Notification type")}>
          ${filters.map(({ key, label }) => {
            const count =
              key === "all" ? Object.values(kindCounts).reduce((sum, value) => sum + value, 0) : (kindCounts[key] ?? 0);
            return html`<button
              class="notification-filter-chip ${filter === key ? "active" : ""}"
              type="button"
              aria-pressed=${filter === key}
              @click=${() => {
                filter = key;
                loadPage(1);
              }}
            >
              ${t(label)} <span class="notification-filter-count">${count}</span>
            </button>`;
          })}
        </div>`,
        rows: [...groups.values()].map(
          ([latest, ...older]) =>
            html`<div class="notification-group">
              ${notificationRow(latest!)}
              ${
                older.length
                  ? html`<details class="notification-history">
                      <summary>
                        <span class="notification-expand">${t("Show task history")}</span>
                        <span class="notification-collapse">${t("Hide task history")}</span>
                        · ${t("Notifications")}: ${older.length}
                        ${older.some((item) => item.readAt === null) ? html` · ${t("Unread")}: ${older.filter((item) => item.readAt === null).length}` : nothing}
                        ${older.some((item) => item.kind === "cron_failure") ? html` · ${t("Task failed")}: ${older.filter((item) => item.kind === "cron_failure").length}` : nothing}
                      </summary>
                      <div class="notification-history-rows">${older.map(notificationRow)}</div>
                    </details>`
                  : nothing
              }
            </div>`,
        ),
        empty,
      })}
      <nav class="notification-pagination" aria-label=${t("Notification pages")}>
        <span class="notification-page-total">${t("Notifications")}: ${total} · ${t("Per page")}: 20</span>
        <div class="notification-page-buttons">
          <button class="btn" type="button" ?disabled=${loading || page <= 1} @click=${() => loadPage(page - 1)}>
            ${t("Previous page")}
          </button>
          ${pageNumbers.map(
            (number, index) => html`
              ${index > 0 && number - pageNumbers[index - 1]! > 1 ? html`<span class="notification-page-gap">…</span>` : nothing}
              <button
                class="btn notification-page-number ${page === number ? "active" : ""}"
                type="button"
                aria-label=${`${t("Page")} ${number}`}
                aria-current=${page === number ? "page" : nothing}
                ?disabled=${loading}
                @click=${() => loadPage(number)}
              >
                ${number}
              </button>
            `,
          )}
          <button class="btn" type="button" ?disabled=${loading || page >= pages} @click=${() => loadPage(page + 1)}>
            ${t("Next page")}
          </button>
        </div>
        <form
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            const input = (event.currentTarget as HTMLFormElement).querySelector("input")!;
            const value = Number(input.value);
            if (!loading && Number.isInteger(value) && value >= 1 && value <= pages) loadPage(value);
          }}
        >
          <label
            >${t("Jump to")}
            <input
              type="number"
              aria-label=${t("Page")}
              min="1"
              max=${pages}
              required
              .value=${String(page)}
              ?disabled=${loading}
            />
          </label>
          <span>${t("Page unit")}</span>
          <button class="btn" type="submit" ?disabled=${loading}>${t("Go to page")}</button>
        </form>
      </nav>
    `,
    host,
  );
}

export function renderNotifications(): void {
  draw();
  void refreshNotifications();
}
