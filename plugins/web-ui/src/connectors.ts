import { render, type TemplateResult } from "lit";
import { Activity, KeyRound, Link, Plus, RefreshCw, ShieldCheck } from "lucide";
import { api } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import { icon } from "./ui";
import { connectorLogo } from "./connector-logo";
import { appState, replacePanePreservingFocus } from "./shell";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { isActiveGrant, isExpiredCredential, KeychainOperations, keychainSummary } from "./keychain-state";
import { html, localeCode, t } from "./i18n.ts";

interface ConnectorProvider {
  connected?: boolean;
  needsReconnect?: boolean;
  refreshError?: string;
  available?: boolean;
  hosts?: Array<{ host?: string } | string>;
}

const CONNECTOR_LABELS: Record<string, { name: string; hosts: string }> = {
  google: {
    name: "Google Workspace",
    hosts: "Gmail, Calendar, Drive, Sheets",
  },
  slack: {
    name: "Slack",
    hosts: "Channels & messages",
  },
  notion: {
    name: "Notion",
    hosts: "Pages & databases",
  },
  linear: {
    name: "Linear",
    hosts: "Issues & projects",
  },
  github: {
    name: "GitHub",
    hosts: "Repos, issues & PRs",
  },
  dropbox: {
    name: "Dropbox",
    hosts: "Files & folders",
  },
  x: {
    name: "X (Twitter)",
    hosts: "Posts & profile",
  },
  atlassian: {
    name: "Atlassian",
    hosts: "Jira, Confluence & Rovo",
  },
};

interface KeychainCredential {
  id: string;
  service: string;
  kind?: string;
  envKey?: string;
  accountLabel?: string;
  host?: string;
  fingerprint?: string;
  expiresAt?: number;
  createdAt?: number;
}

interface KeychainConnectorCredential {
  credentialId: string;
  host: string;
  accountType?: string;
  expiresAt?: number;
  connected: boolean;
  needsReconnect?: boolean;
}

interface KeychainGrant {
  id: string;
  credentialId: string;
  audienceScopeId: string;
  mode: "once" | "standing";
  purpose: string;
  status: "active" | "revoked" | "used";
  expiresAt?: number;
}

interface KeychainAsk {
  id: string;
  credentialId: string;
  requesterId: string;
  requesterScopeId: string;
  purpose: string;
  requestedMode?: "once" | "standing";
  expiresAt: number;
}

let connectorProviders: Record<string, ConnectorProvider> = {};
let keychainCredentials: KeychainCredential[] = [];
let keychainConnectorCredentials: KeychainConnectorCredential[] = [];
interface KeychainUsage {
  credentialId: string;
  ts: number;
  scopeLabel: string;
  status: string;
}

let keychainUsage: KeychainUsage[] = [];

let keychainGrants: KeychainGrant[] = [];
let keychainAsks: KeychainAsk[] = [];
let keychainScopeNames: Record<string, string> = {};
let connectorNotice = "";
let loadNotice = "";
let addingCredential: { service: string; envKey: string; purpose: string } | null = null;
let secureDropUrl: string | null = null;
let confirmation: { title: string; body: string; action: string; run: () => Promise<void> } | null = null;
let confirmationOpener: HTMLElement | null = null;
const keychainOperations = new KeychainOperations();

function connectorErrorNotice(error: unknown, fallback: string): string {
  const message = errMessage(error, fallback);
  return message === fallback ? t(fallback) : message;
}
let connectorsLoading = false;
let keysLoading = false;
let connectorsEverLoaded = false;
let keysEverLoaded = false;
let mcpRefreshInFlight = false;

export function resetKeychainState(): void {
  keychainOperations.reset();
  connectorProviders = {};
  keychainCredentials = [];
  keychainConnectorCredentials = [];
  keychainGrants = [];
  keychainAsks = [];
  keychainScopeNames = {};
  connectorNotice = "";
  loadNotice = "";
  connectorsLoading = false;
  keysLoading = false;
  connectorsEverLoaded = false;
  keysEverLoaded = false;
  mcpRefreshInFlight = false;
  addingCredential = null;
  secureDropUrl = null;
  confirmation = null;
  confirmationOpener = null;
}

function fmtDate(ms?: number): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleDateString(localeCode());
  } catch {
    return "";
  }
}

function accessModeLabel(mode?: "once" | "standing"): string {
  return mode === "standing" ? "standing" : "one-time";
}

function credentialCard(c: KeychainCredential): TemplateResult {
  const subtitle = [c.accountLabel, c.host, c.envKey].filter(Boolean).join(" · ");
  const expired = isExpiredCredential(c);
  const grants = keychainGrants.filter((grant) => grant.credentialId === c.id && isActiveGrant(grant, c));
  const asks = keychainAsks.filter((ask) => ask.credentialId === c.id);
  const lastUse = keychainUsage.find((usage) => usage.credentialId === c.id);
  let added = "Encrypted at rest";
  if (c.kind !== "file" && c.expiresAt) added = `${t("Expires")} ${fmtDate(c.expiresAt)}`;
  else if (c.createdAt) added = `${t("Added")} ${fmtDate(c.createdAt)}`;
  else added = t(added);
  return html`
    <article class="kc-resource kc-credential">
      <div class="kc-resource-main">
        <div class="kc-resource-icon">${icon(KeyRound, 18)}</div>
        <div class="kc-resource-copy">
          <div class="kc-resource-title-row">
            <h3>${c.service}</h3>
            ${expired ? html`<span class="kc-state warning">Expired</span>` : ""}
          </div>
          ${subtitle ? html`<div class="kc-resource-meta">${subtitle}</div>` : ""}
          <div class="kc-credential-facts">
            <div class="kc-audit-line">
              ${icon(
                Activity,
                14,
              )}${lastUse ? html`${t("Last used")} ${fmtDate(lastUse.ts)} ${t("in")} ${scopeName(lastUse.scopeLabel)} · ${lastUse.status}` : t("No audited use yet")}
            </div>
            <div class="kc-resource-foot">${added}</div>
          </div>
        </div>
        <button
          class="kc-text-action danger"
          type="button"
          data-confirm-key=${`delete:${c.id}`}
          ?disabled=${keychainOperations.mutationInFlight}
          @click=${() => void deleteCredential(c)}
        >
          Delete
        </button>
      </div>
      ${
        asks.length
          ? html`<div class="kc-access-block pending">
              ${asks.map(
                (ask) =>
                  html`<div class="kc-access-row">
                    <div>
                      <span class="kc-access-label">Pending</span>
                      <bdi><strong>${scopeName(ask.requesterScopeId)}</strong></bdi>
                      <span
                        >· ${t(accessModeLabel(ask.requestedMode))} · ${ask.purpose} · expires
                        ${fmtDate(ask.expiresAt)}</span
                      >
                    </div>
                  </div>`,
              )}
            </div>`
          : ""
      }
      ${
        grants.length
          ? html`<div class="kc-access-block">
              ${grants.map(
                (grant) =>
                  html` <div class="kc-access-row">
                    <div>
                      <span class="kc-access-label">Access</span>
                      <bdi><strong>${scopeName(grant.audienceScopeId)}</strong></bdi>
                      <span
                        >· ${t(accessModeLabel(grant.mode))} ·
                        ${grant.purpose}${grant.expiresAt ? ` · expires ${fmtDate(grant.expiresAt)}` : ""}</span
                      >
                    </div>
                    <button
                      class="kc-text-action"
                      type="button"
                      data-confirm-key=${`revoke:${grant.id}`}
                      ?disabled=${keychainOperations.mutationInFlight}
                      @click=${() => void revokeGrant(grant)}
                    >
                      Revoke
                    </button>
                  </div>`,
              )}
            </div>`
          : ""
      }
    </article>
  `;
}

// Raw Slack IDs (C0…, G0…) mean nothing to people — always prefer a resolved
// name, and fall back to a human description. The raw ID appears only as a
// parenthetical of last resort, to disambiguate when no name is available.
function scopeName(scope: string): string {
  const resolved = keychainScopeNames[scope];
  if (resolved) return resolved;
  const [kind, ...rest] = scope.split(":");
  const ref = rest.join(":");
  switch (kind) {
    case "personal":
      return ref || t("a personal DM");
    case "channel":
      return ref ? `${t("a Slack channel")} (${ref})` : t("a Slack channel");
    case "group":
      return t("a group DM");
    case "team":
      return ref ? `${t("a team")} (${ref})` : t("a team");
    case "org":
      return t("the whole org");
    default:
      return scope;
  }
}

function addCredentialCard(): TemplateResult {
  const draft = addingCredential!;
  return html`<section class="kc-add-card" aria-labelledby="kc-add-title">
    <div class="kc-panel-head">
      <div>
        <h2 id="kc-add-title">Add a credential</h2>
        <p>You’ll paste the secret on an encrypted one-time page next.</p>
      </div>
    </div>
    ${
      secureDropUrl
        ? html`
            <div class="kc-success" role="status">
              <strong>Your one-time page is ready</strong><span>Open it in a new tab and paste the secret there.</span>
            </div>
            <div class="kc-form-actions">
              <a class="btn primary" href=${secureDropUrl} target="_blank" rel="noopener noreferrer"
                >Open the one-time page</a
              ><button
                class="btn"
                type="button"
                @click=${() => {
                  addingCredential = null;
                  secureDropUrl = null;
                  drawConnectors();
                }}
              >
                Done
              </button>
            </div>
          `
        : html`
            <div class="kc-form-grid">
              <label class="skill-field"
                ><span>Service</span
                ><input
                  class="skill-desc-input"
                  placeholder="Stripe"
                  autocomplete="off"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.service}
                  @input=${(e: Event) => {
                    draft.service = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <label class="skill-field"
                ><span>Environment variable <em>optional</em></span
                ><input
                  class="skill-desc-input"
                  placeholder="STRIPE_API_KEY"
                  autocapitalize="characters"
                  autocomplete="off"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.envKey}
                  @input=${(e: Event) => {
                    draft.envKey = (e.target as HTMLInputElement).value;
                  }}
              /></label>
              <label class="skill-field kc-purpose-field"
                ><span>Purpose</span
                ><input
                  class="skill-desc-input"
                  placeholder="What may the agent use this credential for?"
                  ?disabled=${keychainOperations.dropInFlight}
                  .value=${draft.purpose}
                  @input=${(e: Event) => {
                    draft.purpose = (e.target as HTMLInputElement).value;
                  }}
              /></label>
            </div>
            <div class="kc-form-actions">
              <button
                class="btn"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => {
                  addingCredential = null;
                  secureDropUrl = null;
                  drawConnectors();
                }}
              >
                Cancel</button
              ><button
                class="btn primary"
                type="button"
                ?disabled=${keychainOperations.dropInFlight}
                @click=${() => void createDrop()}
              >
                ${t(keychainOperations.dropInFlight ? "Preparing…" : "Continue")}
              </button>
            </div>
          `
    }
  </section>`;
}

function confirmationCard(): TemplateResult {
  const pending = confirmation!;
  return html`<div
    class="kc-dialog-scrim"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeConfirmation()}
  >
    <article
      class="kc-confirm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="kc-confirm-title"
      aria-describedby="kc-confirm-body"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeConfirmation)}
    >
      <span class="kc-eyebrow danger">Check impact</span>
      <h2 id="kc-confirm-title">${pending.title}</h2>
      <p id="kc-confirm-body">${pending.body}</p>
      <div class="kc-form-actions">
        <button class="btn" type="button" data-dialog-cancel @click=${closeConfirmation}>Cancel</button
        ><button class="btn danger" type="button" @click=${() => void pending.run()}>${pending.action}</button>
      </div>
    </article>
  </div>`;
}

function closeConfirmation(): void {
  const opener = confirmationOpener;
  const key = opener?.dataset.confirmKey;
  confirmation = null;
  confirmationOpener = null;
  drawConnectors();
  restoreDialogFocus(opener, () =>
    key
      ? [...document.querySelectorAll<HTMLElement>("[data-confirm-key]")].find(
          (element) => element.dataset.confirmKey === key,
        )
      : null,
  );
}

export function clearConnectorNotice(): void {
  connectorNotice = "";
}

export function noteConnectorResult(provider: string, status: string): void {
  const name = CONNECTOR_LABELS[provider]?.name ?? provider;
  connectorNotice = `${name}: ${t(status === "connected" ? "connected." : "connection failed.")}`;
}

function loadingPlaceholder(label: string): TemplateResult {
  return html`<div class="kc-loading"><span class="spinner"></span>${label}</div>`;
}

function drawConnectors(): void {
  if (appState.currentView !== "keychain") return;
  const accountsLoading = connectorsLoading && !connectorsEverLoaded;
  const keysLoadingFresh = keysLoading && !keysEverLoaded;
  const loading = accountsLoading || keysLoadingFresh;
  const entries = Object.entries(connectorProviders);
  const connectorCards = entries.map(([id, p]) => {
    const meta = CONNECTOR_LABELS[id] ?? { name: id, hosts: "" };
    const connected = Boolean(p.connected);
    const needsReconnect = Boolean(p.needsReconnect);
    const available = Boolean(p.available);
    const hosts = new Set(
      (p.hosts ?? [])
        .map((entry) => (typeof entry === "string" ? entry : entry.host))
        .filter((host): host is string => Boolean(host)),
    );
    const credentials = keychainConnectorCredentials.filter((credential) => hosts.has(credential.host));
    const credentialsById = new Map(
      credentials.map((credential) => [credential.credentialId, { id: credential.credentialId, kind: "connector" }]),
    );
    const grants = keychainGrants.filter((grant) => isActiveGrant(grant, credentialsById.get(grant.credentialId)));
    let connectionState: TemplateResult | string = html`<span class="kc-state neutral">Not connected</span>`;
    if (needsReconnect) connectionState = html`<span class="kc-state warning">Reconnect needed</span>`;
    else if (connected) connectionState = "";
    return html`
      <article class="kc-resource kc-account">
        <div class="kc-resource-main">
          ${connectorLogo(id)}
          <div class="kc-resource-copy">
            <div class="kc-resource-title-row">
              <h3>${meta.name}</h3>
              ${connectionState}
            </div>
            ${meta.hosts ? html`<div class="kc-resource-meta">${t(meta.hosts)}</div>` : ""}
          </div>
          <div class="kc-resource-actions">
            ${available ? html`<button class="btn" type="button" @click=${() => void startConnector(id)}>${t(connected || needsReconnect ? "Reconnect" : "Connect account")}</button>` : ""}
            ${connected || needsReconnect ? html`<button class="kc-text-action danger" type="button" data-confirm-key=${`disconnect:${id}`} ?disabled=${keychainOperations.mutationInFlight} @click=${() => void revokeConnector(id)}>Disconnect</button>` : ""}
          </div>
        </div>

        ${needsReconnect && p.refreshError ? html`<div class="kc-inline-warning" role="status">${t("Refresh failed:")} ${p.refreshError}</div>` : ""}
        ${
          grants.length
            ? html`<div class="kc-access-block">
                ${grants.map(
                  (grant) =>
                    html` <div class="kc-access-row">
                      <div>
                        <span class="kc-access-label">Access</span>
                        <bdi><strong>${scopeName(grant.audienceScopeId)}</strong></bdi>
                        <span
                          >· ${t(accessModeLabel(grant.mode))} ·
                          ${grant.purpose}${grant.expiresAt ? ` · expires ${fmtDate(grant.expiresAt)}` : ""}</span
                        >
                      </div>
                      <button
                        class="kc-text-action"
                        type="button"
                        data-confirm-key=${`revoke:${grant.id}`}
                        ?disabled=${keychainOperations.mutationInFlight}
                        @click=${() => void revokeGrant(grant)}
                      >
                        Revoke
                      </button>
                    </div>`,
                )}
              </div>`
            : ""
        }
      </article>
    `;
  });
  let accountsContent: TemplateResult | TemplateResult[] = connectorCards;
  if (accountsLoading) accountsContent = loadingPlaceholder("Loading accounts\u2026");
  else if (!connectorCards.length)
    accountsContent = html`<div class="kc-empty">
      ${icon(Link, 20)}
      <div>
        <strong>No accounts available</strong><span>Your workspace has not configured any account providers yet.</span>
      </div>
    </div>`;
  let credentialsContent: TemplateResult | TemplateResult[] = keychainCredentials.map(credentialCard);
  if (keysLoadingFresh) credentialsContent = loadingPlaceholder("Loading credentials\u2026");
  else if (!keychainCredentials.length)
    credentialsContent = html`<div class="kc-empty">
      ${icon(KeyRound, 20)}
      <div><strong>No stored credentials</strong><span>Add one without pasting a secret into chat.</span></div>
      <button
        class="btn"
        type="button"
        @click=${() => {
          addingCredential = { service: "", envKey: "", purpose: "" };
          secureDropUrl = null;
          drawConnectors();
        }}
      >
        Add credential
      </button>
    </div>`;
  if (!appState.mainEl) return;
  const section = (
    id: string,
    heading: string,
    count: number,
    content: TemplateResult | TemplateResult[],
    sectionLoading: boolean,
  ) =>
    html`<section class="kc-section" aria-labelledby=${id}>
      <div class="kc-section-head">
        <div class="kc-section-title">
          <h2 id=${id}>${t(heading)}</h2>
          <span>${sectionLoading ? "…" : count}</span>
        </div>
      </div>
      <div class="kc-resource-list">${content}</div>
    </section>`;
  const summary = keychainSummary(Object.values(connectorProviders), keychainCredentials, keychainGrants, keychainAsks);
  const rows: TemplateResult[] = [];
  const notice = [connectorNotice, loadNotice].filter(Boolean).join(" ");
  if (notice || loading)
    rows.push(html`<div class="status" role="status">${t(loading ? "Loading your keychain…" : notice)}</div>`);
  if (addingCredential) rows.push(addCredentialCard());
  rows.push(
    section("kc-accounts-title", "Linked accounts", entries.length, accountsContent, accountsLoading),
    section(
      "kc-credentials-title",
      "Stored credentials",
      keychainCredentials.length,
      credentialsContent,
      keysLoadingFresh,
    ),
  );
  const host = document.createElement("div");
  host.className = scopedSession.active ? "pane keychain-page scoped-view" : "pane keychain-page";
  render(
    html`
      ${scopedViewTopbar("keychain", () => drawConnectors())}
      <div class="kc-page-content" ?inert=${Boolean(confirmation)}>
        <header class="kc-hero">
          <div class="kc-hero-copy">
            <h1>Keychain</h1>
            <p>Accounts and credentials your agent may use on your behalf.</p>
            <div class="kc-trust-note">
              ${icon(ShieldCheck, 14)}<span>Secrets stay encrypted and every use or shared grant is audited.</span>
            </div>
          </div>
          <div class="kc-hero-actions">
            <button
              class="pane-refresh"
              type="button"
              aria-label="Refresh keychain"
              title="Refresh keychain and discover MCP tools"
              ?disabled=${mcpRefreshInFlight}
              @click=${() => void refreshKeychain()}
            >
              ${icon(RefreshCw, 17)}
            </button>
            <button
              class="btn primary"
              type="button"
              @click=${() => {
                addingCredential = { service: "", envKey: "", purpose: "" };
                secureDropUrl = null;
                drawConnectors();
              }}
            >
              ${icon(Plus, 16)} Add credential
            </button>
          </div>
        </header>
        <div class="kc-summary" aria-label="Keychain summary">
          <div><span>${loading ? "—" : summary.connected}</span><small>Connected accounts</small></div>
          <div><span>${loading ? "—" : keychainCredentials.length}</span><small>Stored credentials</small></div>
          <div><span>${loading ? "—" : summary.activeGrants}</span><small>Active grants</small></div>
          <div class=${summary.attention ? "needs-attention" : ""}>
            <span>${loading ? "—" : summary.attention}</span><small>Need attention</small>
          </div>
        </div>
        ${rows}
      </div>
      ${confirmation ? confirmationCard() : ""}
    `,
    host,
  );
  replacePanePreservingFocus(host);
  if (confirmation) focusDialogCancel(host);
}

export async function renderConnectors(): Promise<void> {
  if (appState.currentView !== "keychain") return;
  const seq = appState.viewRenderSeq;
  const load = keychainOperations.beginLoad();
  connectorsLoading = true;
  keysLoading = true;
  drawConnectors();
  const fresh = () =>
    seq === appState.viewRenderSeq && keychainOperations.isCurrentLoad(load) && appState.currentView === "keychain";
  const notices: string[] = [];
  loadNotice = "";
  const applyNotices = () => {
    loadNotice = notices.join(" ");
  };

  const connDone = api<{ providers?: Record<string, ConnectorProvider> }>("/api/connectors").then(
    (value) => {
      if (!fresh()) return;
      connectorProviders = Object.fromEntries(
        Object.entries(value.providers ?? {}).filter(([, p]) => p.available || p.connected || p.needsReconnect),
      );
      connectorsEverLoaded = true;
      connectorsLoading = false;
      applyNotices();
      drawConnectors();
    },
    (reason) => {
      if (!fresh()) return;
      notices.push(connectorErrorNotice(reason, "Failed to load connectors."));
      connectorsLoading = false;
      applyNotices();
      drawConnectors();
    },
  );
  const keysDone = api<{
    credentials?: KeychainCredential[];
    connectorCredentials?: KeychainConnectorCredential[];
    grants?: KeychainGrant[];
    asks?: KeychainAsk[];
    scopeNames?: Record<string, string>;
    usage?: KeychainUsage[];
  }>("/api/keychain/overview").then(
    (value) => {
      if (!fresh()) return;
      keychainCredentials = (value.credentials ?? []).slice().sort((a, b) => a.service.localeCompare(b.service));
      keychainConnectorCredentials = value.connectorCredentials ?? [];
      keychainGrants = value.grants ?? [];
      keychainAsks = value.asks ?? [];
      keychainScopeNames = value.scopeNames ?? {};
      keychainUsage = value.usage ?? [];
      keysEverLoaded = true;
      keysLoading = false;
      applyNotices();
      drawConnectors();
    },
    (reason) => {
      if (!fresh()) return;
      notices.push(connectorErrorNotice(reason, "Failed to load stored keys."));
      keysLoading = false;
      applyNotices();
      drawConnectors();
    },
  );
  await Promise.all([connDone, keysDone]);
}

async function refreshKeychain(): Promise<void> {
  if (mcpRefreshInFlight) return;
  const stateEpoch = keychainOperations.captureEpoch();
  mcpRefreshInFlight = true;
  connectorNotice = t("Refreshing MCP tools…");
  drawConnectors();
  try {
    const { toolCount = 0 } = await api<{ toolCount?: number }>("/api/connectors/mcp/refresh", { method: "POST" });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = toolCount
      ? t("MCP tools refreshed.")
      : t("No MCP tools were found. Reconnect the account if this is unexpected.");
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch))
      connectorNotice = connectorErrorNotice(e, "Could not refresh MCP tools.");
  } finally {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) {
      mcpRefreshInFlight = false;
      await renderConnectors();
    }
  }
}

async function deleteCredential(credential: KeychainCredential): Promise<void> {
  const active = keychainGrants.filter(
    (grant) => grant.credentialId === credential.id && isActiveGrant(grant, credential),
  );
  const impact = active.length
    ? ` ${t("It will immediately revoke")} ${t(`${active.length} active grant${active.length === 1 ? "" : "s"}`)}: ${active.map((grant) => scopeName(grant.audienceScopeId)).join(", ")}.`
    : "";
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `${t("Delete")} ${credential.service}?`,
    body: `${impact} ${t("Automations using it may stop working. The credential cannot be recovered.")}`.trim(),
    action: t("Delete credential"),
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performDeleteCredential(credential, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

function beginKeychainMutation() {
  const operation = keychainOperations.beginMutation();
  if (operation) return operation;
  confirmation = null;
  confirmationOpener = null;
  connectorNotice = t("Another keychain change is still in progress.");
  drawConnectors();
  return null;
}

async function performDeleteCredential(credential: KeychainCredential, stateEpoch: number): Promise<void> {
  connectorNotice = "";
  try {
    await api(`/api/keychain/credentials/${encodeURIComponent(credential.id)}`, { method: "DELETE" });
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch))
      connectorNotice = connectorErrorNotice(e, "Could not delete the key.");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}

async function revokeGrant(grant: KeychainGrant): Promise<void> {
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `${t("Revoke access for")} ${scopeName(grant.audienceScopeId)}?`,
    body: `${t("This")} ${t(grant.mode === "standing" ? "standing" : "one-time")} ${t("access ends immediately. Automations using it may stop working.")}`,
    action: t("Revoke access"),
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performRevokeGrant(grant.id, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

async function performRevokeGrant(id: string, stateEpoch: number): Promise<void> {
  try {
    await api(`/api/keychain/grants/${encodeURIComponent(id)}/revoke`, { method: "POST", body: "{}" });
    if (keychainOperations.isCurrentEpoch(stateEpoch)) connectorNotice = t("Access revoked ✓");
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch))
      connectorNotice = connectorErrorNotice(e, "Could not revoke access.");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}

async function createDrop(): Promise<void> {
  if (keychainOperations.dropInFlight) return;
  if (!addingCredential?.service.trim() || !addingCredential.purpose.trim()) {
    connectorNotice = t("Service and purpose are required.");
    return drawConnectors();
  }
  const submittedDraft = { ...addingCredential };
  const stateEpoch = keychainOperations.beginDrop();
  if (stateEpoch === null) return;
  drawConnectors();
  try {
    const result = await api<{ url?: string }>("/api/keychain/drops", {
      method: "POST",
      body: JSON.stringify(submittedDraft),
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (!result.url) throw new Error("No one-time page URL was returned.");
    secureDropUrl = result.url;
    connectorNotice = t("Your one-time page is ready.");
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = connectorErrorNotice(e, "Could not create the one-time page.");
  } finally {
    if (keychainOperations.isCurrentEpoch(stateEpoch)) {
      keychainOperations.finishDrop(stateEpoch);
      drawConnectors();
    }
  }
}

async function startConnector(provider: string): Promise<void> {
  const stateEpoch = keychainOperations.captureEpoch();
  connectorNotice = "";
  try {
    const r = await api<{ authorizeUrl?: string }>(`/api/connectors/${encodeURIComponent(provider)}/start`, {
      method: "POST",
    });
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    if (r.authorizeUrl) {
      location.href = r.authorizeUrl;
      return;
    }
    connectorNotice = t("No authorization URL was returned.");
  } catch (e) {
    if (!keychainOperations.isCurrentEpoch(stateEpoch)) return;
    connectorNotice = connectorErrorNotice(e, "Could not start the connector.");
  }
  drawConnectors();
}

async function revokeConnector(provider: string): Promise<void> {
  const hosts = new Set(
    (connectorProviders[provider]?.hosts ?? [])
      .map((entry) => (typeof entry === "string" ? entry : entry.host))
      .filter((host): host is string => Boolean(host)),
  );
  const providerCredentials = keychainConnectorCredentials.filter((credential) => hosts.has(credential.host));
  const credentialIds = new Set(providerCredentials.map((credential) => credential.credentialId));
  const credentialsById = new Map(
    providerCredentials.map((credential) => [
      credential.credentialId,
      { id: credential.credentialId, kind: "connector" },
    ]),
  );
  const active = keychainGrants.filter(
    (grant) => credentialIds.has(grant.credentialId) && isActiveGrant(grant, credentialsById.get(grant.credentialId)),
  );
  const impact = active.length
    ? ` ${t("It will also stop")} ${t(`${active.length} active credential grant${active.length === 1 ? "" : "s"}`)} ${t("for this account.")}`
    : "";
  confirmationOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  confirmation = {
    title: `${t("Disconnect")} ${CONNECTOR_LABELS[provider]?.name ?? provider}?`,
    body: `${impact} ${t("Automations using this account may stop working.")}`.trim(),
    action: t("Disconnect account"),
    run: async () => {
      const operation = beginKeychainMutation();
      if (!operation) return;
      confirmation = null;
      confirmationOpener = null;
      drawConnectors();
      try {
        await performRevokeConnector(provider, operation.epoch);
      } finally {
        if (keychainOperations.finishMutation(operation)) drawConnectors();
      }
    },
  };
  drawConnectors();
}

async function performRevokeConnector(provider: string, stateEpoch: number): Promise<void> {
  connectorNotice = "";
  try {
    await api("/api/connectors/revoke", { method: "POST", body: JSON.stringify({ provider }) });
  } catch (e) {
    if (keychainOperations.isCurrentEpoch(stateEpoch))
      connectorNotice = connectorErrorNotice(e, "Could not disconnect.");
  }
  if (keychainOperations.isCurrentEpoch(stateEpoch)) await renderConnectors();
}
