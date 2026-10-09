import { nothing, render, type TemplateResult } from "lit";
import { Archive, Pause, Pencil, Play, Plus, RotateCcw, Trash2 } from "lucide";
import { api, isContinuable, userSendMessage, type CoreSession } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { listBackLink, listPageTpl } from "./list-page";
import { contextsState, ensureContexts, scopeChip } from "./contexts";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { appState } from "./shell";
import { defaultSessionTitle, openSession, sessionsState, startNewChat, surfaceOf } from "./sessions";
import { allConversations, mainConversation } from "./conversations";
import { activityOf } from "./session-list";
import { deepLinkPath, isPlainLeftClick, UI_BASE } from "./deep-link";
import { html, localeCode, t } from "./i18n.ts";
import {
  cronNextFire,
  cronRunSummary,
  cronRunSummaryTitle,
  cronScheduleDetail,
  cronScheduleSummary,
} from "./cron-format";
import { tip } from "./tooltip";
import { focusTextInputOnDesktop } from "./viewport";

export interface CronView {
  id: string;
  ownerScopeId: string;
  owner: string;
  title?: string;
  action?: string;
  message?: string;
  schedule: { everyMs?: number; firstFireAt?: number; cron?: string; timezone?: string };
  destination?: { type: string; target: string } | null;
  enabled: boolean;
  archived?: boolean;
  createdAt: number;
  lastFiredAt?: number;
  nextFireAt?: number;
  lastFireNote?: { text: string; at: number; by?: string } | null;
  scopeName?: string;
  permission?: "read" | "manage";
}

interface CronRunView {
  fireKey: string;
  threadRef: string;
  firedAt: number;
  scheduledAt?: number;
  status?: string;
  endedAt?: number;
  note?: string;
  reply?: string;
  sessionId?: string;
  resultSessionId?: string;
  resultEntrySeq?: number;
  deliveryStatus?: "pending" | "delivered" | "failed" | null;
}

function cronRunTiming(run: CronRunView): string {
  const fired = new Date(run.firedAt).toLocaleString(localeCode(), { timeZoneName: "short" });
  if (run.status === "running") {
    const min = Math.max(0, Math.round((Date.now() - run.firedAt) / 60_000));
    return t(`${fired} — in flight for ${min}m`);
  }
  if (run.endedAt === undefined) return fired;
  return t(`${fired} — took ${Math.max(0, Math.round((run.endedAt - run.firedAt) / 1000))}s`);
}

function deliveryStatusLabel(status: NonNullable<CronRunView["deliveryStatus"]>): string {
  if (status === "failed") return "Delivery failed";
  if (status === "pending") return "Delivery pending";
  return "Delivered";
}

type CronTab = "yours" | "shared" | "archived";
const CRON_TABS: Array<{ value: CronTab; label: string }> = [
  { value: "yours", label: "Yours" },
  { value: "shared", label: "Shared" },
  { value: "archived", label: "Archived" },
];

let cronList: CronView[] = [];
let visibleCronList: CronView[] = [];
let cronsScope: string | null = null;
let cronTab: CronTab = "yours";
let showDisabledCrons = false;
let cronsPageHost: HTMLElement | null = null;
let cronsLoading = false;
let cronsNotice = "";
let cronRefreshSeq = 0;
let cronActionNotice = "";
let cronMutationInFlight = false;
let cronsSearch = "";
const cronRuns = new Map<string, CronRunView[]>();
const cronRunsLoading = new Set<string>();
let cronDialog: { kind: "rename" | "delete"; cron: CronView } | null = null;
let activeCronId: string | null = null;
let pendingCronId: string | null = null;
let pendingRunKey: string | null = new URLSearchParams(location.search).get("run");
let linkedRun: { cronId: string; fireKey: string } | null = null;

export function resetActiveCron(): void {
  cronsScope = null;
}

export function openCronById(id: string): void {
  pendingCronId = id;
  if (pendingRunKey) linkedRun = { cronId: id, fireKey: pendingRunKey };
}

function syncCronUrl(cronId: string | null, push = false): void {
  if (appState.currentView !== "crons") return;
  const path = deepLinkPath(UI_BASE, "crons", null, null, cronId);
  const next = cronId && linkedRun?.cronId === cronId ? `${path}?run=${encodeURIComponent(linkedRun.fireKey)}` : path;
  if (!cronId) linkedRun = null;
  if (`${location.pathname}${location.search}` === next) return;
  if (push) history.pushState(null, "", next);
  else history.replaceState(null, "", next);
}

export function routeCronsHistory(cronId: string | null): void {
  if (appState.currentView !== "crons") return;
  const cron = cronId
    ? (cronList.find((c) => c.id === cronId) ?? visibleCronList.find((c) => c.id === cronId))
    : undefined;
  if (cron) openCron(cron);
  else drawCronsPage();
}

async function refreshCrons(opts: { showLoading?: boolean } = {}): Promise<boolean> {
  const seq = ++cronRefreshSeq;
  if (opts.showLoading) {
    cronsLoading = true;
    cronsNotice = "";
  }
  try {
    const r = await api<{ crons: CronView[]; visible?: CronView[] }>("/api/crons");
    if (seq !== cronRefreshSeq) return false;
    cronList = r.crons ?? [];
    visibleCronList = r.visible ?? [];
    cronsNotice = "";
    return true;
  } catch (e) {
    if (seq !== cronRefreshSeq) return false;
    cronsNotice = t(errMessage(e, "Failed to load crons."));
    return false;
  } finally {
    if (seq === cronRefreshSeq) cronsLoading = false;
  }
}

function cronText(c: CronView): string {
  return c.message ?? c.action ?? "";
}

function cleanCronText(text: string): string {
  return text
    .trim()
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function clipWords(text: string, max = 64): string {
  const clean = cleanCronText(text);
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const wordCut = cut.replace(/\s+\S*$/, "");
  return `${(wordCut.length >= max * 0.55 ? wordCut : cut).trim()}…`;
}

function suggestedCronTitle(text: string): string {
  const clean = cleanCronText(text);
  if (!clean) return "(untitled cron)";
  const candidate = clean
    .replace(/^(please\s+)?(run|generate|create|send|post|deliver|summarize|check)\s+(the\s+)?/i, "")
    .replace(/\s*[:;.!?]\s+.*$/, "")
    .trim();
  const clipped = clipWords(candidate || clean, 58);
  return clipped.replace(/^[a-z]/, (ch) => ch.toUpperCase());
}

function cronTitle(c: CronView): string {
  const title = c.title?.trim();
  if (title) return title === "Refresh my suggested activities" ? t(title) : title;
  const suggested = suggestedCronTitle(cronText(c));
  return suggested === "(untitled cron)" ? t(suggested) : suggested;
}

function cronScopeLabel(c: CronView): string {
  const sep = c.ownerScopeId.indexOf(":");
  const kind = sep === -1 ? c.ownerScopeId : c.ownerScopeId.slice(0, sep);
  if (kind === "channel") return c.scopeName ? `#${c.scopeName}` : t("a Slack channel");
  if (kind === "org") return t("org-wide");
  if (kind === "group") return t("group");
  return c.owner;
}

function isPersonalScope(c: CronView): boolean {
  const kind = c.ownerScopeId.split(":", 1)[0];
  return kind !== "channel" && kind !== "org" && kind !== "group";
}

function cronStatusLabel(c: CronView): "enabled" | "disabled" | "archived" {
  if (c.archived) return "archived";
  return c.enabled ? "enabled" : "disabled";
}

function cronStatusText(c: CronView): string {
  const status = cronStatusLabel(c);
  return t(status.charAt(0).toUpperCase() + status.slice(1));
}

export async function renderCronsPage(): Promise<void> {
  if (appState.currentView !== "crons") return;
  if (scopedSession.active) cronsScope = scopedSession.active.scopeId;
  else if (contextsState.selected) {
    cronsScope = contextsState.selected;
    contextsState.selected = null;
  } else cronsScope = null;
  await ensureContexts();
  drawCronsPage();
  const loaded = await refreshCrons({ showLoading: cronList.length === 0 && visibleCronList.length === 0 });
  const wanted = pendingCronId;
  pendingCronId = null;
  if (appState.currentView !== "crons") return;
  if (!loaded) return drawCronsPage();
  const cron = wanted
    ? (cronList.find((c) => c.id === wanted) ?? visibleCronList.find((c) => c.id === wanted))
    : undefined;
  if (wanted && !cron) {
    cronActionNotice = t("That cron wasn't found, or you don't have access to it.");
  }
  if (cron) openCron(cron);
  else drawCronsPage();
}

function drawCronsPage(): void {
  if (appState.currentView !== "crons" || !appState.mainEl) return;
  activeCronId = null;
  if (!pendingCronId) syncCronUrl(null);
  if (!cronsPageHost || cronsPageHost.parentElement !== appState.mainEl) {
    cronsPageHost = document.createElement("div");
    cronsPageHost.className = "pane crons-page";
    appState.mainEl.replaceChildren(cronsPageHost);
  }
  const all = [...cronList.map((c) => ({ c, mine: true })), ...visibleCronList.map((c) => ({ c, mine: false }))]
    .filter(({ c }) => (cronsScope ? c.ownerScopeId === cronsScope : true))
    .filter(
      ({ c }) =>
        !cronsSearch.trim() ||
        `${cronTitle(c)} ${cronText(c)} ${c.scopeName ?? ""}`.toLowerCase().includes(cronsSearch.trim().toLowerCase()),
    )
    .sort((a, b) => b.c.createdAt - a.c.createdAt);
  const archived = all.filter(({ c }) => c.archived);
  const yours = all.filter(({ c, mine }) => mine && !c.archived);
  const yoursEnabled = yours.filter(({ c }) => c.enabled);
  const yoursDisabled = yours.filter(({ c }) => !c.enabled);
  const shared = all.filter(({ c, mine }) => !mine && !c.archived);
  const ownsAny = all.some(({ mine }) => mine);
  const counts: Record<CronTab, number> = {
    yours: yoursEnabled.length,
    shared: shared.filter(({ c }) => c.enabled).length,
    archived: archived.length,
  };

  const rows: TemplateResult[] = [];
  if (cronActionNotice) {
    rows.push(html`<div class="action-notice">${cronActionNotice}</div>`);
    cronActionNotice = "";
  }
  if (all.length) rows.push(cronTabs(counts, shared.length > 0));
  if (cronTab === "yours") {
    rows.push(...yoursEnabled.map(({ c }) => cronPageRow(c, true)));
    if (all.length && !yoursEnabled.length)
      rows.push(cronEmptyRow(ownsAny ? "No active crons." : "None of your own crons yet."));
    if (yoursDisabled.length) {
      rows.push(cronDisabledToggle(yoursDisabled.length));
      if (showDisabledCrons) rows.push(...yoursDisabled.map(({ c }) => cronPageRow(c, true)));
    }
  } else if (cronTab === "shared") {
    rows.push(...shared.map(({ c }) => cronPageRow(c, false)));
    if (!shared.length) rows.push(cronEmptyRow("No crons shared with you."));
  } else {
    rows.push(...archived.map(({ c, mine }) => cronPageRow(c, mine)));
    if (!archived.length) rows.push(cronEmptyRow("Nothing archived."));
  }
  let empty = "No crons yet.";
  if (cronsNotice) empty = cronsNotice;
  else if (cronsLoading && cronList.length === 0 && visibleCronList.length === 0) empty = "Loading crons…";
  else if (cronsScope) empty = "No crons in this context.";
  const scoped = Boolean(scopedSession.active);
  cronsPageHost.classList.toggle("scoped-view", scoped);
  render(
    html`${scopedViewTopbar("crons", drawCronsPage)}
    ${listPageTpl({
      title: "Crons",
      action: { label: "New cron", onClick: showNewCron },
      search: {
        value: cronsSearch,
        placeholder: "Search crons",
        onInput: (value) => {
          cronsSearch = value;
          drawCronsPage();
        },
      },
      rows,
      empty,
    })}`,
    cronsPageHost,
  );
}

function setCronTab(tab: CronTab): void {
  cronTab = tab;
  drawCronsPage();
}

function toggleDisabledCrons(): void {
  showDisabledCrons = !showDisabledCrons;
  drawCronsPage();
}

function cronEmptyRow(text: string): TemplateResult {
  return html`<div class="empty compact cron-filter-empty">${t(text)}</div>`;
}

function cronTabs(counts: Record<CronTab, number>, hasShared: boolean): TemplateResult {
  const tabs = CRON_TABS.filter(
    (t) => t.value === "yours" || (t.value === "shared" && hasShared) || counts[t.value] > 0 || cronTab === t.value,
  );
  return html`
    <div class="cron-list-controls" role="tablist" aria-label="Cron view">
      ${tabs.map(
        (tab) => html`
          <button
            type="button"
            role="tab"
            aria-selected=${cronTab === tab.value}
            class="cron-filter-chip ${cronTab === tab.value ? "active" : ""}"
            @click=${() => setCronTab(tab.value)}
          >
            <span>${t(tab.label)}</span>
            <span class="cron-filter-count">${counts[tab.value]}</span>
          </button>
        `,
      )}
    </div>
  `;
}

function cronDisabledToggle(count: number): TemplateResult {
  return html`
    <button class="archived-toggle cron-disabled-toggle" type="button" @click=${toggleDisabledCrons}>
      <span>${t(showDisabledCrons ? "Hide disabled" : "Show disabled")}</span>
      <span class="archived-count">${count}</span>
    </button>
  `;
}

function canManageCron(c: CronView, mine: boolean): boolean {
  return c.permission ? c.permission === "manage" : mine;
}

function cronPageRow(c: CronView, mine: boolean): TemplateResult {
  const status = cronStatusLabel(c);
  return html`
    <div class="list-row cron-row cron-${status}">
      <a
        class="cron-row-main"
        href=${deepLinkPath(UI_BASE, "crons", null, null, c.id)}
        @click=${(event: MouseEvent) => {
          if (!isPlainLeftClick(event)) return;
          event.preventDefault();
          openCron(c, { push: true });
        }}
      >
        <span class="list-row-title cron-title-line"><span dir="auto">${cronTitle(c)}</span></span>
        <span class="list-row-meta">
          ${isPersonalScope(c) ? nothing : scopeChip(c.ownerScopeId, c.scopeName ?? null)}
          <span class="cron-meta-line" ${tip(cronRunSummaryTitle(c))}>${cronRunSummary(c)}</span>
        </span>
      </a>
      ${canManageCron(c, mine) ? cronRowActions(c) : nothing}
    </div>
  `;
}

function cronRowActions(c: CronView): TemplateResult {
  let stateAction = html`
    <button
      class="icon-btn subtle compact"
      type="button"
      ${tip("Enable")}
      aria-label="Enable cron"
      @click=${() => void setCronEnabled(c.id, true)}
    >
      ${icon(Play, 14)}
    </button>
  `;
  if (c.archived) {
    stateAction = html`
      <button
        class="icon-btn subtle compact"
        type="button"
        ${tip("Unarchive")}
        aria-label="Unarchive cron"
        @click=${() => void archiveCron(c.id, false)}
      >
        ${icon(RotateCcw, 14)}
      </button>
    `;
  } else if (c.enabled) {
    stateAction = html`
      <button
        class="icon-btn subtle compact"
        type="button"
        ${tip("Disable")}
        aria-label="Disable cron"
        @click=${() => void setCronEnabled(c.id, false)}
      >
        ${icon(Pause, 14)}
      </button>
    `;
  }
  return html`
    <div class="cron-row-actions" aria-label="Cron actions">
      <button
        class="icon-btn subtle compact"
        type="button"
        ${tip("Edit")}
        aria-label="Edit cron"
        @click=${() => {
          openCron(c);
          showCronDialog("rename", c);
        }}
      >
        ${icon(Pencil, 14)}
      </button>
      ${stateAction}
      ${
        c.archived
          ? nothing
          : html`
              <button
                class="icon-btn subtle compact"
                type="button"
                ${tip("Archive")}
                aria-label="Archive cron"
                @click=${() => void archiveCron(c.id, true)}
              >
                ${icon(Archive, 14)}
              </button>
            `
      }
    </div>
  `;
}

function openCron(c: CronView, opts: { push?: boolean; refreshRuns?: boolean } = {}): void {
  if (!appState.mainEl) return;
  const shouldRefreshRuns = opts.refreshRuns || activeCronId !== c.id;
  activeCronId = c.id;
  syncCronUrl(c.id, opts.push);
  const mine = cronList.some((x) => x.id === c.id);
  const manageable = canManageCron(c, mine);
  const notice = cronActionNotice;
  cronActionNotice = "";
  const next = cronNextFire(c);
  const linkedChat = linkedCronChat(c);
  let stateActions = html`
    <button class="btn" @click=${() => void setCronEnabled(c.id, true)}>${icon(Play, 15)}<span>Enable</span></button>
    <button class="btn" @click=${() => void archiveCron(c.id, true)}>${icon(Archive, 15)}<span>Archive</span></button>
  `;
  if (c.archived) {
    stateActions = html`<button class="btn" @click=${() => void archiveCron(c.id, false)}>
      ${icon(RotateCcw, 15)}<span>Unarchive</span>
    </button>`;
  } else if (c.enabled) {
    stateActions = html`
      <button class="btn" @click=${() => void runCronNow(c.id)}>${icon(Play, 15)}<span>Run now</span></button>
      <button class="btn" @click=${() => void setCronEnabled(c.id, false)}>
        ${icon(Pause, 15)}<span>Disable</span>
      </button>
      <button class="btn" @click=${() => void archiveCron(c.id, true)}>${icon(Archive, 15)}<span>Archive</span></button>
    `;
  }
  const host = document.createElement("div");
  host.className = "pane cron-detail-page";
  render(
    html`
      <div class="cron-detail">
        ${listBackLink("Crons", drawCronsPage)}
        <div class="cron-detail-heading">
          <div>
            <div class="cron-detail-eyebrow">Scheduled task</div>
            <h1 dir="auto">${cronTitle(c)}</h1>
            <span class="cron-detail-status ${cronStatusLabel(c)}">${cronStatusText(c)}</span>
          </div>
          <button class="btn primary" @click=${showNewCron}>${icon(Plus, 15)}<span>New cron</span></button>
        </div>
        ${notice ? html`<div class="hint">${notice}</div>` : ""}
        <section class="cron-detail-card cron-detail-task">
          <h2>${t(c.message !== undefined ? "Message" : "Task")}</h2>
          <div class="cron-detail-task-text" dir="auto">${cronText(c)}</div>
        </section>
        <section class="cron-detail-card">
          <h2>Schedule and delivery</h2>
          <div class="cron-detail-fields">
            <div class="field">
              <label>Schedule</label>
              <div class="value">${cronScheduleDetail(c)}</div>
            </div>
            <div class="field">
              <label>Next run</label>
              <div class="value">
                ${next != null ? new Date(next).toLocaleString(localeCode(), { timeZoneName: "short" }) : t("Never")}
              </div>
            </div>
            <div class="field">
              <label>Last fired</label>
              <div class="value">
                ${c.lastFiredAt ? new Date(c.lastFiredAt).toLocaleString(localeCode(), { timeZoneName: "short" }) : t("Never")}
              </div>
            </div>
            <div class="field">
              <label>Context</label>
              <div class="value">${scopeChip(c.ownerScopeId, c.scopeName ?? null)}</div>
            </div>
            ${
              c.destination
                ? html`<div class="field">
                    <label>Destination</label>
                    <div class="value" dir="auto">${c.destination.type} → ${c.destination.target}</div>
                  </div>`
                : nothing
            }
            <div class="field">
              <label>${t("Result conversation")}</label>
              <div class="value">
                ${
                  linkedChat
                    ? html`<a href=${deepLinkPath(UI_BASE, "chats", linkedChat.id)}
                        >${t("Open original conversation")}:
                        ${linkedChat.title?.trim() || defaultSessionTitle(linkedChat)}</a
                      >`
                    : t(
                        c.destination?.type === "web"
                          ? "Original conversation is unavailable. Results are available in run history."
                          : "No linked conversation. Results are available in run history.",
                      )
                }
              </div>
            </div>
            ${
              mine
                ? nothing
                : html`<div class="field">
                    <label>Owner</label>
                    <div class="value" dir="auto">${c.owner}</div>
                  </div>`
            }
            ${
              mine
                ? nothing
                : html`<div class="field">
                    <label>Scope</label>
                    <div class="value">${cronScopeLabel(c)}</div>
                  </div>`
            }
          </div>
        </section>
        ${
          c.lastFireNote
            ? html`<section class="cron-detail-card">
                <h2>${t(c.lastFireNote.by ? `Note left by ${c.lastFireNote.by}` : "Note from last fire")}</h2>
                <div class="cron-detail-note-time">
                  ${new Date(c.lastFireNote.at).toLocaleString(localeCode(), { timeZoneName: "short" })}
                </div>
                <div class="cron-detail-task-text" dir="auto">${c.lastFireNote.text}</div>
              </section>`
            : nothing
        }
        ${manageable ? html`<section class="cron-detail-card cron-detail-runs">${cronRunHistory(c)}</section>` : nothing}
        ${
          manageable
            ? html`
                <div class="actions cron-detail-actions">
                  <button class="btn" @click=${() => showCronDialog("rename", c)}>
                    ${icon(Pencil, 15)}<span>Edit</span>
                  </button>
                  ${stateActions}
                  <button class="btn danger" @click=${() => showCronDialog("delete", c)}>
                    ${icon(Trash2, 15)}<span>Delete</span>
                  </button>
                </div>
              `
            : html`<div class="hint">Shared from ${cronScopeLabel(c)}. You can view it, but not change it.</div>`
        }
        ${cronDialog?.cron.id === c.id ? cronDialogTpl(cronDialog) : nothing}
      </div>
    `,
    host,
  );
  appState.mainEl.replaceChildren(host);
  if (pendingRunKey) {
    const row = [...host.querySelectorAll<HTMLElement>("[data-fire-key]")].find(
      (node) => node.dataset.fireKey === pendingRunKey,
    );
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.classList.add("notification-target");
      pendingRunKey = null;
    }
  }
  if (manageable && (shouldRefreshRuns || !cronRuns.has(c.id)) && !cronRunsLoading.has(c.id)) void loadCronRuns(c.id);
}

function cronRunHistory(c: CronView): TemplateResult {
  const runs = cronRuns.get(c.id);
  const heading = html`<div class="cron-run-heading">
    <h2>Recent runs</h2>
  </div>`;
  if (!runs)
    return html`<div class="field">
      ${heading}
      <div class="hint">Loading…</div>
    </div>`;
  if (!runs.length)
    return html`<div class="field">
      ${heading}
      <div class="hint">No runs yet.</div>
    </div>`;
  return html` <div class="field">
    ${heading}
    <div class="cron-run-list">
      ${[...runs].reverse().map((run) => {
        const detail = run.note ?? (run.reply ? clipWords(run.reply, 120) : "");
        return html` <div class="cron-run-row" data-fire-key=${run.fireKey}>
          <span class="badge">${t(run.status ?? "completed")}</span>
          ${run.deliveryStatus ? html`<span class="badge">${t(deliveryStatusLabel(run.deliveryStatus))}</span>` : nothing}
          <span class="cron-run-time">${cronRunTiming(run)}</span>
          <span class=${run.note ? "cron-run-detail cron-run-error" : "cron-run-detail"} ${tip(detail)}>
            ${detail}
          </span>
          ${
            run.resultSessionId || run.sessionId
              ? html`<span class="cron-run-links">
                  ${
                    run.resultSessionId
                      ? html`<a
                          class="cron-run-link"
                          href=${`${deepLinkPath(UI_BASE, "chats", run.resultSessionId)}${run.resultEntrySeq === undefined ? "" : `?entry=${run.resultEntrySeq}`}`}
                          >${t("View result in conversation")}</a
                        >`
                      : nothing
                  }
                  ${
                    run.sessionId
                      ? html`<a
                          class="cron-run-link cron-run-worklog"
                          href=${deepLinkPath(UI_BASE, "chats", run.sessionId)}
                          >${t("Execution log")}</a
                        >`
                      : nothing
                  }
                </span>`
              : nothing
          }
        </div>`;
      })}
    </div>
  </div>`;
}

async function loadCronRuns(id: string): Promise<void> {
  cronRunsLoading.add(id);
  try {
    const result = await api<{ runs: CronRunView[] }>(`/api/crons/${encodeURIComponent(id)}/runs`);
    cronRuns.set(id, result.runs ?? []);
  } catch (error) {
    cronActionNotice = t(errMessage(error, "Couldn't load run history."));
    cronRuns.set(id, []);
  } finally {
    cronRunsLoading.delete(id);
  }
  if (activeCronId !== id || appState.currentView !== "crons") return;
  const current =
    cronList.find((candidate) => candidate.id === id) ?? visibleCronList.find((candidate) => candidate.id === id);
  if (current) openCron(current);
}

async function reopenCron(id: string): Promise<void> {
  await refreshCrons();
  const c = cronList.find((x) => x.id === id) ?? visibleCronList.find((x) => x.id === id);
  if (c) openCron(c, { refreshRuns: true });
  else drawCronsPage();
}

async function cronMutate<T>(fn: () => Promise<T>, busyValue: T): Promise<T> {
  if (cronMutationInFlight) return busyValue;
  cronMutationInFlight = true;
  try {
    return await fn();
  } finally {
    cronMutationInFlight = false;
  }
}

function runCronNow(id: string): Promise<void> {
  return cronMutate(async () => {
    try {
      await api(`/api/crons/${encodeURIComponent(id)}/run`, { method: "POST" });
      cronActionNotice = t("Run started. Refresh recent runs after it completes.");
    } catch (e) {
      cronActionNotice = t(errMessage(e, "run failed"));
    }
    await reopenCron(id);
  }, undefined);
}

function patchCron(
  id: string,
  patch: { title?: string; task?: string; schedule?: CronView["schedule"]; enabled?: boolean; archived?: boolean },
  errorLabel: string,
): Promise<boolean> {
  return cronMutate(async () => {
    try {
      await api(`/api/crons/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      return true;
    } catch (e) {
      cronActionNotice = t(errMessage(e, errorLabel));
      await reopenCron(id);
      return false;
    }
  }, false);
}

function showCronDialog(kind: "rename" | "delete", cron: CronView): void {
  cronDialog = { kind, cron };
  openCron(cron);
  queueMicrotask(() => focusTextInputOnDesktop(document.querySelector<HTMLInputElement>(".cron-edit-dialog input")));
}

function closeCronDialog(c: CronView): void {
  cronDialog = null;
  openCron(c);
}

function cronDialogTpl(dialog: { kind: "rename" | "delete"; cron: CronView }): TemplateResult {
  const c = dialog.cron;
  const editableChat =
    c.destination?.type === "web" && cronChatChoices().some((session) => session.threadRef === c.destination?.target);
  if (dialog.kind === "delete") {
    return html` <div
      class="project-dialog-backdrop"
      @click=${(event: MouseEvent) => event.target === event.currentTarget && closeCronDialog(c)}
    >
      <div class="project-dialog cron-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="cron-delete-title">
        <div class="project-dialog-head">
          <div>
            <h2 id="cron-delete-title">Delete <bdi>${cronTitle(c)}</bdi>?</h2>
          </div>
        </div>
        <p>
          This permanently removes the schedule and its retained run history. Archive it instead if you may need it
          later.
        </p>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${() => closeCronDialog(c)}>Cancel</button>
          <button class="btn danger" type="button" @click=${() => void confirmDeleteCron(c.id)}>
            Delete permanently
          </button>
        </div>
      </div>
    </div>`;
  }
  return html` <div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeCronDialog(c)}
  >
    <form
      class="project-dialog cron-edit-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cron-edit-title"
      @submit=${(event: SubmitEvent) => void saveCronEdit(event, c)}
    >
      <div class="project-dialog-head">
        <div><h2 id="cron-edit-title">Edit cron</h2></div>
      </div>
      <label>Title<input name="title" maxlength="80" value=${c.title ?? cronTitle(c)} required /></label>
      ${
        c.message === undefined
          ? html`<label>Task<textarea name="task" rows="5" required>${cronText(c)}</textarea></label>`
          : html`<div class="field">
              <label>Message</label>
              <div class="value pre">${c.message}</div>
            </div>`
      }
      <p class="hint">
        ${
          editableChat
            ? t(
                c.message === undefined
                  ? "To change the schedule, timezone, destination, or run mode, use the agent so it can validate the resulting behavior and permissions."
                  : "To change the message, schedule, timezone, destination, or run mode, use the agent so it can validate the resulting behavior and permissions.",
              )
            : t(
                "No linked conversation is available. Edit this task here, or ask the agent from an existing conversation to change its schedule or destination.",
              )
        }
      </p>
      <div class="form-error"></div>
      <div class="project-dialog-actions">
        ${editableChat ? html`<button class="btn" type="button" @click=${() => editCronWithAgent(c)}>Edit behavior with agent</button>` : nothing}
        <button class="btn" type="button" @click=${() => closeCronDialog(c)}>Cancel</button>
        <button class="btn primary" type="submit">Save</button>
      </div>
    </form>
  </div>`;
}

async function saveCronEdit(event: SubmitEvent, c: CronView): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const title = (form.elements.namedItem("title") as HTMLInputElement).value.trim();
  const taskControl = form.elements.namedItem("task") as HTMLTextAreaElement | null;
  const task = taskControl?.value.trim();
  const error = form.querySelector<HTMLElement>(".form-error");
  if (!title || (taskControl && !task)) {
    if (error) error.textContent = t(taskControl ? "Title and task are required." : "Title is required.");
    return;
  }
  const ok = await patchCron(c.id, { title, ...(task ? { task } : {}) }, "edit failed");
  if (!ok) return;
  cronDialog = null;
  cronActionNotice = t("Cron updated.");
  await reopenCron(c.id);
}

async function editCronWithAgent(c: CronView): Promise<void> {
  const destinationChat =
    c.destination?.type === "web"
      ? cronChatChoices().find((session) => session.threadRef === c.destination?.target)
      : undefined;
  if (!destinationChat) return;
  cronDialog = null;
  await openSession(destinationChat);
  const conv = allConversations().find((candidate) => candidate.state.sessionId === destinationChat.id);
  void conv?.state.agent?.prompt(
    userSendMessage(
      `Help me edit cron ${c.id} ("${cronTitle(c)}"). Its current schedule is ${cronScheduleSummary(c)}. Ask what I want changed, then update its task, schedule, timezone, destination, or run mode as requested.`,
    ),
  );
}

async function archiveCron(id: string, archived: boolean): Promise<void> {
  const ok = await patchCron(id, { archived }, archived ? "archive failed" : "unarchive failed");
  if (!ok) return;
  await refreshCrons();
  if (archived) {
    cronTab = "yours";
    drawCronsPage();
    return;
  }
  cronTab = "yours";
  showDisabledCrons = true;
  await reopenCron(id);
}

function setCronEnabled(id: string, enabled: boolean): Promise<void> {
  return cronMutate(async () => {
    try {
      await api(`/api/crons/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, { method: "POST" });
      cronTab = "yours";
      if (!enabled) showDisabledCrons = true;
    } catch (e) {
      cronActionNotice = t(errMessage(e, enabled ? "enable failed" : "disable failed"));
    }
    await reopenCron(id);
  }, undefined);
}

async function confirmDeleteCron(id: string): Promise<void> {
  await cronMutate(async () => {
    cronDialog = null;
    try {
      await api(`/api/crons/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (e) {
      cronActionNotice = t(errMessage(e, "delete failed"));
    }
    await reopenCron(id);
  }, undefined);
}

const NEW_CRON_CHAT = "__new__";

function linkedCronChat(c: CronView): CoreSession | undefined {
  if (c.destination?.type !== "web") return undefined;
  return sessionsState.list.find(
    (session) => session.threadRef === c.destination?.target && surfaceOf(session) === "web",
  );
}

function cronChatChoices(): CoreSession[] {
  const user = appState.me?.user ?? "";
  return sessionsState.list
    .filter(
      (session) =>
        !session.archived && !session.parentSessionId && surfaceOf(session) === "web" && isContinuable(session, user),
    )
    .sort((a, b) => activityOf(b) - activityOf(a));
}

function cronForm() {
  const chats = cronChatChoices();
  const remembered = mainConversation().state.rememberedSessionId;
  let selected = chats.length ? "" : NEW_CRON_CHAT;
  if (chats.some((session) => session.id === remembered)) selected = remembered ?? "";
  return html`
    <form class="resource-form cron-form" @submit=${onCreateCron}>
      ${listBackLink("Crons", drawCronsPage)}
      <h2>New cron</h2>
      <p class="hint">
        ${t(
          "Describe what you want scheduled — what to do, how often, and where the result should go. The agent sets it up and confirms in chat; it will ask if anything is unclear. It should give the cron a short, distinctive title naming what it is for, like",
        )}
        <code>${t("Gmail unread digest")}</code> ${t("or")} <code>${t("GitLab CI watch")}</code>${t(".")}
      </p>
      <p class="hint">
        ${t("Results stay in each run history. By default, they return to the setup chat, and you receive notifications. The agent confirms the destination, timezone and next run before finishing.")}
      </p>
      <label>
        <span>${t("Result conversation")}</span>
        ${fieldSelect({
          name: "sessionId",
          required: true,
          value: selected,
          onChange: (value) => {
            selected = value;
          },
          options: [
            ...(chats.length ? [html`<option value="" disabled>${t("Choose an existing conversation")}</option>`] : []),
            ...chats.map(
              (session) =>
                html`<option value=${session.id}>${session.title?.trim() || defaultSessionTitle(session)}</option>`,
            ),
            html`<option value=${NEW_CRON_CHAT}>${t("Start a new conversation")}</option>`,
          ],
        })}
      </label>
      <label>
        <textarea
          name="text"
          rows="4"
          placeholder="Every weekday at 9am, summarize my unread email and DM me the highlights."
          required
        ></textarea>
      </label>
      <div class="form-error"></div>
      <div class="actions"><button class="btn primary" type="submit">Ask the agent to set it up</button></div>
    </form>
  `;
}

function showNewCron(): void {
  if (!appState.mainEl) return;
  activeCronId = null;
  const host = document.createElement("div");
  host.className = "resource-pane cron-pane";
  render(cronForm(), host);
  appState.mainEl.replaceChildren(host);
}

async function onCreateCron(e: Event): Promise<void> {
  e.preventDefault();
  const form = e.currentTarget as HTMLFormElement;
  const errSlot = form.querySelector(".form-error") as HTMLElement | null;
  const text = (form.querySelector('textarea[name="text"]') as HTMLTextAreaElement | null)?.value.trim() ?? "";
  if (!text) {
    if (errSlot) errSlot.textContent = t("Describe the cron you want.");
    return;
  }
  const chatId = (form.elements.namedItem("sessionId") as HTMLSelectElement | null)?.value ?? "";
  const selected = chatId === NEW_CRON_CHAT ? null : cronChatChoices().find((session) => session.id === chatId);
  if (!chatId || (chatId !== NEW_CRON_CHAT && !selected)) {
    if (errSlot) errSlot.textContent = t("Choose a result conversation.");
    return;
  }
  if (form.dataset.submitting) return;
  form.dataset.submitting = "true";
  if (selected) await openSession(selected);
  const conv = selected
    ? allConversations().find((candidate) => candidate.state.sessionId === selected.id)
    : startNewChat();
  const agent = conv?.state.agent;
  if (!agent) {
    if (errSlot) errSlot.textContent = t("Could not open the selected conversation.");
    delete form.dataset.submitting;
    return;
  }
  if (agent.state.isStreaming) {
    conv.composer.state.error = t("Wait for the current reply before creating the scheduled task.");
    conv.redraw();
    return;
  }
  void agent
    .prompt(
      userSendMessage(
        `Set up a cron for me: ${text}\n\n(Sent from the web UI's New-cron pane: create it now with your scheduling API, use a calendar schedule with timezone for daily/weekly/monthly timing, give it a 2-5 word title naming what the cron is for and distinctive in a list, like "Gmail unread digest" or "GitLab CI watch", not the command and not a generic word. Use this setup chat as the default result destination unless I specified a different supported destination. Confirm where results are saved, who is notified, the destination, timezone, and next run.)`,
      ),
    )
    .catch((error: unknown) => {
      conv.composer.state.error = errMessage(error, "Could not create the scheduled task.");
      conv.redraw();
    });
}
