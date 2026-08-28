import { nothing, render, type TemplateResult } from "lit";
import { html, t } from "./i18n.ts";
import { Box, Search } from "lucide";
import { api, type CoreContext } from "./core-bridge";
import type { SkillItem } from "./composer";
import { errMessage } from "../../chassis/src/errors";
import { fieldSelect, icon } from "./ui";
import { appState } from "./shell";
import { skillActions } from "./skill-actions";
import {
  createReviewMatches,
  isSharedSkillScope,
  reviewMatches,
  shouldBlockRepeatedPublishClick,
  type SkillCreateReview,
  type SkillEditReview,
} from "./skill-edit-review";
import {
  filterSkillGroups,
  groupSkills,
  isArchivedSkill,
  skillEmptyState,
  statusCounts,
  type SkillStatusFilter,
} from "./skill-registry";
import { listBackLink, listPageTpl } from "./list-page";
import { scopeTitle } from "./contexts";
import { scopedSession, scopedViewTopbar } from "./session-scope";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { SkillsRefreshSequence } from "./skills-refresh";
import { SkillsMutationSequence } from "./skills-mutation";

let skillRows: SkillItem[] = [];
let skillsNotice = "";
let skillSearch = "";
let scopeFilter = "all";
let sourceFilter = "all";
let statusFilter: SkillStatusFilter = "active";
let createScopes: Array<{ scopeId: string; name: string }> = [];
let skillsPageHost: HTMLElement | null = null;

let editing: {
  id: string;
  description: string;
  body: string;
  originalDescription: string;
  originalBody: string;
  scopeId?: string;
  name: string;
  review: SkillEditReview | null;
} | null = null;
let editingTarget: SkillItem | null = null;
let saving = false;
let editError = "";

type SkillAccessMode = "home" | "organization" | "restricted";
type SkillAccessSubjectKind = "user" | "org_unit" | "access_group";
type SkillAccessSubject = { kind: SkillAccessSubjectKind; id: string; name?: string };
type SkillAccessView = {
  mode: SkillAccessMode;
  subjects: SkillAccessSubject[];
  hiddenSubjectCount: number;
  editable: boolean;
  organizationModeAllowed: boolean;
  revision: number;
  updatedAt: number;
  updatedBy: string;
  effectiveSummary: {
    activeUsers: number | null;
    orgUnits: number | null;
    accessGroups: number | null;
    directUsers: number | null;
  };
};

let editingAccess: SkillAccessView | null = null;
let accessCandidates: SkillAccessSubject[] = [];
let accessSaving = false;
let accessError = "";
let accessSearch = "";
let accessSearching = false;
let accessSearchSeq = 0;

let creating: {
  name: string;
  description: string;
  body: string;
  scopeId: string;
  review: SkillCreateReview | null;
} | null = null;
let creatingSaving = false;
let createError = "";

let deleting: string | null = null;
let archiveConfirmation: SkillItem | null = null;
let editRequestSeq = 0;
const skillsRefreshes = new SkillsRefreshSequence();
const skillMutations = new SkillsMutationSequence();
let flowFocusTarget: HTMLElement | null = null;
let archiveFocusTarget: HTMLElement | null = null;

function scopeLabel(scope: string): string {
  return scope ? t(scope.charAt(0).toUpperCase() + scope.slice(1)) : "";
}

function editAudience(scopeId: string | undefined): string {
  if (scopeId?.startsWith("personal:")) return t("only you");
  return scopeId ? scopeTitle(scopeId) : t("this context");
}

async function startEdit(s: SkillItem): Promise<void> {
  if (!s.id) return;
  const request = ++editRequestSeq;
  skillMutations.invalidate();
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  creating = null;
  editing = null;
  editingTarget = s;
  editError = "";
  editingAccess = null;
  accessCandidates = [];
  accessSaving = false;
  accessError = "";
  accessSearch = "";
  accessSearching = false;
  skillsNotice = t("Loading skill instructions…");
  drawSkills();
  queueMicrotask(() => skillsPageHost?.querySelector<HTMLElement>(".context-back")?.focus());
  try {
    const [r, access, units, users, groups] = await Promise.all([
      api<{ skill: SkillItem }>(`/api/skills/${encodeURIComponent(s.id)}`),
      api<SkillAccessView>(`/api/skills/${encodeURIComponent(s.id)}/access`),
      api<{ units: Array<{ id: string; name: string }> }>("/api/org/tree"),
      api<{ users: Array<{ principalId: string; displayName: string }> }>("/api/org/users?limit=100"),
      api<{ groups: Array<{ id: string; name: string }> }>("/api/org/access-groups"),
    ]);
    if (request !== editRequestSeq) return;
    editing = {
      id: s.id,
      description: r.skill.description,
      body: r.skill.body ?? "",
      originalDescription: r.skill.description,
      originalBody: r.skill.body ?? "",
      scopeId: r.skill.scopeId,
      name: r.skill.name,
      review: null,
    };
    editingTarget = r.skill;
    editingAccess = { ...access, subjects: access.subjects.map((subject) => ({ ...subject })) };
    accessCandidates = mergeAccessCandidates(
      access.subjects,
      units.units.map((unit) => ({ kind: "org_unit" as const, id: unit.id, name: unit.name })),
      groups.groups.map((group) => ({ kind: "access_group" as const, id: group.id, name: group.name })),
      users.users.map((user) => ({ kind: "user" as const, id: user.principalId, name: user.displayName })),
    );
    skillsNotice = "";
  } catch (e) {
    if (request !== editRequestSeq) return;
    editError = errMessage(e, "Failed to load skill details.");
    skillsNotice = "";
  }
  drawSkills();
  queueMicrotask(() => {
    const target =
      skillsPageHost?.querySelector<HTMLElement>("#skill-edit-description") ??
      skillsPageHost?.querySelector<HTMLElement>(".context-back");
    target?.focus();
  });
}

function restoreFocusedFlow(target: HTMLElement | null): void {
  queueMicrotask(() => {
    if (creating || editingTarget || archiveConfirmation || appState.currentView !== "skills") return;
    const skillId = target?.dataset.skillId;
    const matchingEdit = skillId
      ? [...(skillsPageHost?.querySelectorAll<HTMLElement>(".skill-edit-trigger") ?? [])].find(
          (element) => element.dataset.skillId === skillId,
        )
      : null;
    const search = skillsPageHost?.querySelector<HTMLElement>(".list-search input") ?? null;
    const create = skillsPageHost?.querySelector<HTMLElement>(".list-page-action") ?? null;
    const fallback = skillId ? (matchingEdit ?? search ?? create) : (create ?? search);
    restoreDialogFocus(target, () => fallback ?? null);
  });
}

function closeFocusedFlow(): void {
  editRequestSeq += 1;
  skillMutations.invalidate();
  editing = null;
  editingTarget = null;
  creating = null;
  editError = "";
  editingAccess = null;
  accessCandidates = [];
  accessSaving = false;
  accessError = "";
  accessSearch = "";
  accessSearching = false;
  createError = "";
  skillsNotice = "";
  saving = false;
  creatingSaving = false;
  const target = flowFocusTarget;
  flowFocusTarget = null;
  drawSkills();
  restoreFocusedFlow(target);
}

function startCreate(): void {
  if (creating) return;
  flowFocusTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  skillMutations.invalidate();
  editing = null;
  editingTarget = null;
  editRequestSeq += 1;
  creating = { name: "", description: "", body: "", scopeId: createScopes[0]?.scopeId ?? "", review: null };
  createError = "";
  creatingSaving = false;
  drawSkills();
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#skill-create-name")?.focus());
}

function skillMeta(s: SkillItem): string {
  const source = s.source === "pack" ? `${t("Pack")} ${s.pack?.upstreamName ?? t("source")}` : t("Created here");
  return `${scopeLabel(s.scope)} · v${s.version ?? 1} · ${source}`;
}

function skillVariant(s: SkillItem, hasScopeVariants: boolean): TemplateResult {
  const actions = skillActions(s);
  const archived = isArchivedSkill(s);
  let state = "Active";
  if (archived) state = "Archived";
  else if (hasScopeVariants) state = "Scope variant";
  let archiveLabel = "Archive";
  if (deleting === s.id) archiveLabel = "Working…";
  else if (archived) archiveLabel = "Restore";
  return html`
    <div class="skill-variant ${archived ? "archived" : ""}">
      <span class="skill-variant-icon">${icon(Box, 16)}</span>
      <div class="skill-variant-copy">
        <div class="skill-variant-description" title=${s.description}>${s.description}</div>
        <div class="skill-variant-meta">
          ${skillMeta(s)}${s.assetCount ? ` · ${t(`${s.assetCount} asset${s.assetCount === 1 ? "" : "s"}`)}` : ""}
        </div>
        <details class="skill-variant-details">
          <summary>Details</summary>
          <p>${s.description}</p>
          <dl>
            <div>
              <dt>Scope</dt>
              <dd>${s.scopeId ? scopeTitle(s.scopeId) : scopeLabel(s.scope)}</dd>
            </div>
            <div>
              <dt>Capabilities</dt>
              <dd>${s.requiredCapabilities?.length ? s.requiredCapabilities.join(", ") : t("None required")}</dd>
            </div>
          </dl>
        </details>
      </div>
      <div class="skill-variant-state">
        <span class="badge ${archived ? "" : "skill-active"}">${t(state)}</span>
        ${actions.edit && !archived ? html`<button class="btn skill-edit-trigger" data-skill-id=${s.id ?? ""} type="button" ?disabled=${deleting === s.id} @click=${() => void startEdit(s)}>Edit</button>` : nothing}
        ${
          actions.delete
            ? html`<button
                class="btn skill-archive-trigger"
                data-skill-id=${s.id ?? ""}
                type="button"
                ?disabled=${deleting === s.id}
                @click=${(event: Event) => void deleteSkill(s, event.currentTarget as HTMLElement)}
              >
                ${t(archiveLabel)}
              </button>`
            : nothing
        }
      </div>
    </div>
  `;
}

function skillGroup(name: string, skills: SkillItem[]): TemplateResult {
  const activeVariants = skills.filter((skill) => !isArchivedSkill(skill)).length;
  const hasScopeVariants = activeVariants > 1;
  return html`<section class="skill-group">
    <div class="skill-group-head">
      <h2 class="skill-group-name">
        <code>/${name}</code>${skills.length > 1 ? html`<span>${t(`${skills.length} variants`)}</span>` : nothing}
      </h2>
      ${hasScopeVariants ? html`<span class="skill-precedence">Narrower scope takes precedence where both apply</span>` : nothing}
    </div>
    ${skills.map((skill) => skillVariant(skill, hasScopeVariants))}
  </section>`;
}

function accessSubjectKey(subject: SkillAccessSubject): string {
  return `${subject.kind}:${subject.id}`;
}

function accessSubjectKindLabel(kind: SkillAccessSubject["kind"]): string {
  if (kind === "user") return t("Person");
  if (kind === "org_unit") return t("Organization unit");
  return t("Access group");
}

function accessPreview(access: SkillAccessView): string {
  if (access.mode === "home") return t("current members of the home context");
  if (access.mode === "organization") return t("all active organization users");
  return t(`${access.subjects.length} selected subject${access.subjects.length === 1 ? "" : "s"}`);
}

function mergeAccessCandidates(...groups: SkillAccessSubject[][]): SkillAccessSubject[] {
  const merged = new Map<string, SkillAccessSubject>();
  for (const subject of groups.flat()) {
    const key = accessSubjectKey(subject);
    const existing = merged.get(key);
    if (!existing || (!existing.name && subject.name)) merged.set(key, { ...subject });
  }
  return [...merged.values()];
}

async function searchAccessUsers(): Promise<void> {
  const query = accessSearch.trim();
  if (query.length < 2) {
    accessError = t("Enter at least two characters to search for a person.");
    drawSkills();
    return;
  }
  const request = ++accessSearchSeq;
  const skillId = editing?.id;
  const editRequest = editRequestSeq;
  if (!skillId || !editingAccess) return;
  accessSearching = true;
  accessError = "";
  drawSkills();
  try {
    const response = await api<{ users: Array<{ principalId: string; displayName: string }> }>(
      `/api/org/users?q=${encodeURIComponent(query)}&limit=100`,
    );
    if (
      request !== accessSearchSeq ||
      editRequest !== editRequestSeq ||
      editing?.id !== skillId ||
      accessSearch.trim() !== query
    ) {
      return;
    }
    const selected = new Set(editingAccess.subjects.map(accessSubjectKey));
    accessCandidates = mergeAccessCandidates(
      editingAccess.subjects,
      accessCandidates.filter((candidate) => candidate.kind !== "user" || selected.has(accessSubjectKey(candidate))),
      response.users.map((user) => ({ kind: "user" as const, id: user.principalId, name: user.displayName })),
    );
    if (response.users.length === 0) accessError = t(`No people found for “${query}”.`);
  } catch (error) {
    if (request === accessSearchSeq && editRequest === editRequestSeq && editing?.id === skillId) {
      accessError = errMessage(error, t("Couldn't search for people."));
    }
  } finally {
    if (request === accessSearchSeq && editRequest === editRequestSeq && editing?.id === skillId) {
      accessSearching = false;
      drawSkills();
    }
  }
}

function setAccessSubject(subject: SkillAccessSubject, selected: boolean): void {
  if (!editingAccess || !editingAccess.editable || editingAccess.mode !== "restricted") return;
  const key = accessSubjectKey(subject);
  const next = editingAccess.subjects.filter((candidate) => accessSubjectKey(candidate) !== key);
  if (selected) next.push({ ...subject });
  editingAccess.subjects = next;
  accessError = "";
  drawSkills();
}

async function saveSkillAccess(): Promise<void> {
  if (!editing || !editingAccess || !editingAccess.editable || accessSaving) return;
  accessSaving = true;
  accessError = "";
  drawSkills();
  try {
    editingAccess = await api<SkillAccessView>(`/api/skills/${encodeURIComponent(editing.id)}/access`, {
      method: "PUT",
      body: JSON.stringify({
        mode: editingAccess.mode,
        subjects: editingAccess.mode === "restricted" ? editingAccess.subjects : [],
        expectedRevision: editingAccess.revision,
      }),
    });
  } catch (error) {
    accessError = errMessage(error, t("Failed to update Skill Access."));
    try {
      editingAccess = await api<SkillAccessView>(`/api/skills/${encodeURIComponent(editing.id)}/access`);
      accessError = `${accessError} ${t("The current policy was reloaded.")}`;
    } catch {
      accessError = `${accessError} ${t("Reload the page before retrying.")}`;
    }
  } finally {
    accessSaving = false;
    drawSkills();
  }
}

function skillAccessPane(): TemplateResult | typeof nothing {
  const access = editingAccess;
  if (!access) return nothing;
  const selected = new Set(access.subjects.map(accessSubjectKey));
  const candidateRows = accessCandidates.map((candidate) => {
    const key = accessSubjectKey(candidate);
    return html`<label class="skill-access-subject">
      <input
        type="checkbox"
        .checked=${selected.has(key)}
        ?disabled=${accessSaving || !access.editable || access.mode !== "restricted"}
        @change=${(event: Event) => setAccessSubject(candidate, (event.target as HTMLInputElement).checked)}
      />
      <span>${candidate.name ?? candidate.id}</span>
      <span class="card-meta">${accessSubjectKindLabel(candidate.kind)}</span>
    </label>`;
  });
  return html`<section class="skill-impact skill-access-card">
    <div class="skill-form-heading">
      <div>
        <h2>${t("Skill Access")}</h2>
        <p>${t("Use permission is separate from this Skill's home context and management permission.")}</p>
      </div>
      <span class="badge">${t("Revision")} ${access.revision}</span>
    </div>
    ${
      access.hiddenSubjectCount > 0
        ? html`<div class="form-error" role="alert">
            ${t(
              `${access.hiddenSubjectCount} existing subject${access.hiddenSubjectCount === 1 ? " is" : "s are"} outside your directory view. An organization administrator must update this policy.`,
            )}
          </div>`
        : nothing
    }
    <label class="skill-field">
      <span>${t("Access mode")}</span>
      ${fieldSelect({
        value: access.mode,
        disabled: accessSaving || !access.editable,
        onChange: (value) => {
          const mode = value as SkillAccessMode;
          access.mode = mode;
          if (mode !== "restricted") access.subjects = [];
          accessError = "";
          drawSkills();
        },
        options: [
          html`<option value="home">${t("Home context")}</option>`,
          access.organizationModeAllowed
            ? html`<option value="organization">${t("Entire organization")}</option>`
            : html``,
          html`<option value="restricted">${t("Selected people and groups")}</option>`,
        ],
      })}
    </label>
    ${
      access.mode === "restricted"
        ? html`<div class="skill-access-subjects">
            <strong>${t("Authorized subjects")}</strong>
            <div class="project-member-picker">
              <label for="skill-access-person-search">${t("Find a person")}</label>
              <div class="project-member-search-row">
                ${icon(Search, 16)}
                <input
                  id="skill-access-person-search"
                  type="search"
                  autocomplete="off"
                  maxlength="100"
                  placeholder=${t("Search by name or handle")}
                  .value=${accessSearch}
                  ?disabled=${accessSearching || accessSaving || !access.editable}
                  @input=${(event: InputEvent) => {
                    accessSearch = (event.currentTarget as HTMLInputElement).value;
                    accessError = "";
                  }}
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key !== "Enter") return;
                    event.preventDefault();
                    void searchAccessUsers();
                  }}
                />
                <button
                  class="project-icon-button"
                  type="button"
                  aria-label=${t("Search people")}
                  ?disabled=${accessSearching || accessSaving || !access.editable}
                  @click=${() => void searchAccessUsers()}
                >
                  ${accessSearching ? t("Searching…") : icon(Search, 15)}
                </button>
              </div>
            </div>
            ${candidateRows.length ? candidateRows : html`<div class="card-meta">${t("No visible directory subjects.")}</div>`}
            ${access.subjects.length === 0 ? html`<div class="form-error" role="alert">${t("No active user will be able to use this Skill.")}</div>` : nothing}
          </div>`
        : nothing
    }
    <div class="card-meta">${t("Change preview")}: ${accessPreview(access)} ${t("will be evaluated at use time.")}</div>
    <div class="card-meta">
      ${t("Effective active users")}: ${access.effectiveSummary.activeUsers ?? t("Unavailable for this home context")} ·
      ${t("Last updated by")} ${access.updatedBy} ${t("at")} ${new Date(access.updatedAt).toLocaleString()} ·
      ${t("Changes are recorded in Audit.")}
    </div>
    ${accessError ? html`<div class="form-error" role="alert">${accessError}</div>` : nothing}
    <div class="actions">
      <button
        class="btn"
        type="button"
        ?disabled=${accessSaving || !access.editable}
        @click=${() => void saveSkillAccess()}
      >
        ${accessSaving ? t("Saving access…") : t("Save access")}
      </button>
    </div>
  </section>`;
}

function editorPane() {
  const e = editing;
  if (!e) {
    return html`<section class="skill-form-page">
      ${listBackLink("Back to skills", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">Edit /${editingTarget?.name ?? "skill"}</h1>
          <p>${t(editError ? "Instructions unavailable." : "Loading instructions…")}</p>
        </div>
      </div>
      ${editError ? html`<div class="form-error" role="alert">${editError}</div>` : nothing}
    </section>`;
  }
  const reviewed = reviewMatches(e.review, e.description, e.body);
  let saveLabel = "Save";
  if (saving) saveLabel = "Saving…";
  else if (reviewed) saveLabel = "Publish change";
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveEdit();
      }}
    >
      ${listBackLink("Back to skills", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">Edit /${e.name}</h1>
          <p>${t("Available to")} ${editAudience(e.scopeId)}</p>
        </div>
        <span class="badge">Editing</span>
      </div>
      <label class="skill-field">
        <span>Description</span>
        <input
          id="skill-edit-description"
          class="skill-desc-input"
          type="text"
          .value=${e.description}
          data-focus-key="skill-edit-description"
          ?disabled=${saving}
          @input=${(ev: Event) => {
            e.description = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>Instructions</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          data-focus-key="skill-edit-body"
          ?disabled=${saving}
          @input=${(ev: Event) => {
            e.body = (ev.target as HTMLTextAreaElement).value;
            drawSkills();
          }}
          .value=${e.body}
        ></textarea>
      </label>
      ${skillAccessPane()} ${editError ? html`<div class="card-meta skill-shadowed">${editError}</div>` : nothing}
      ${
        reviewed
          ? html`<div class="skill-impact" role="alert">
              <strong>${t("Publish this change to")} ${scopeTitle(e.scopeId ?? null)}?</strong>
              <div class="card-meta">
                Everyone in this context can invoke the updated instructions. ${t("Description")}
                ${t(e.description === e.originalDescription ? "unchanged" : "changed")}; ${t("instructions")}
                ${t(e.body === e.originalBody ? "unchanged" : "changed")}.
              </div>
            </div>`
          : nothing
      }
      <div class="actions skill-form-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${saving}
          @click=${(event: MouseEvent) => {
            if (shouldBlockRepeatedPublishClick(reviewed, event.detail)) event.preventDefault();
          }}
        >
          ${t(saveLabel)}
        </button>
        ${
          reviewed
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${saving}
                @click=${() => {
                  e.review = null;
                  drawSkills();
                }}
              >
                Review again
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${saving} @click=${closeFocusedFlow}>Cancel</button>
      </div>
    </form>
  `;
}

function creatorPane() {
  const c = creating!;
  const ready = c.name.trim() !== "" && c.description.trim() !== "" && c.body.trim() !== "";
  const reviewed = createReviewMatches(c.review, c.name.trim(), c.description.trim(), c.body.trim(), c.scopeId);
  let createLabel = "Create skill";
  if (creatingSaving) createLabel = "Saving…";
  else if (reviewed) createLabel = "Publish skill";
  return html`
    <form
      class="skill-form-page"
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        void saveCreate();
      }}
    >
      ${listBackLink("Back to skills", closeFocusedFlow)}
      <div class="skill-form-heading">
        <div>
          <h1 class="pane-title">New skill</h1>
          <p>Create a reusable procedure for yourself or a shared context.</p>
        </div>
        <span class="badge">New</span>
      </div>
      <div class="card-meta">
        New Skills start with Home context access. After publishing, open Edit to configure Skill Access.
      </div>
      <label class="skill-field">
        <span>Name</span>
        <input
          id="skill-create-name"
          class="skill-desc-input"
          type="text"
          placeholder="watch-pipeline"
          data-focus-key="skill-create-name"
          .value=${c.name}
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.name = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>Available to</span>
        ${fieldSelect({
          className: "skill-scope-select",
          value: c.scopeId,
          disabled: creatingSaving,
          onChange: (value) => {
            c.scopeId = value;
            c.review = null;
            drawSkills();
          },
          options: createScopes.map((scope) => html`<option value=${scope.scopeId}>${scope.name}</option>`),
        })}
        <small class="card-meta">Everyone in a shared context can invoke and edit this skill.</small>
      </label>
      <label class="skill-field">
        <span>Description</span>
        <input
          class="skill-desc-input"
          type="text"
          placeholder="One line: what it does / when to use it"
          data-focus-key="skill-create-description"
          .value=${c.description}
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.description = (ev.target as HTMLInputElement).value;
            drawSkills();
          }}
        />
      </label>
      <label class="skill-field">
        <span>Instructions</span>
        <textarea
          class="skill-body-input"
          spellcheck="false"
          placeholder="The SKILL.md contents — the steps to follow when this skill is used."
          data-focus-key="skill-create-body"
          ?disabled=${creatingSaving}
          @input=${(ev: Event) => {
            c.body = (ev.target as HTMLTextAreaElement).value;
            drawSkills();
          }}
          .value=${c.body}
        ></textarea>
      </label>
      ${createError ? html`<div class="card-meta skill-shadowed">${createError}</div>` : nothing}
      ${
        reviewed
          ? html`<div class="skill-impact" role="alert">
              <strong>${t("Publish")} /${c.name.trim()} ${t("to")} ${scopeTitle(c.scopeId)}?</strong>
              <div class="card-meta">Everyone in this context can invoke and edit these instructions.</div>
            </div>`
          : nothing
      }
      <div class="actions skill-form-actions">
        <button
          class="btn primary"
          type="submit"
          ?disabled=${creatingSaving || !ready}
          @click=${(event: MouseEvent) => {
            if (shouldBlockRepeatedPublishClick(reviewed, event.detail)) event.preventDefault();
          }}
        >
          ${t(createLabel)}
        </button>
        ${
          reviewed
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${creatingSaving}
                @click=${() => {
                  c.review = null;
                  drawSkills();
                }}
              >
                Review again
              </button>`
            : nothing
        }
        <button class="btn" type="button" ?disabled=${creatingSaving} @click=${closeFocusedFlow}>Cancel</button>
      </div>
    </form>
  `;
}

function drawSkills(loading = false): void {
  if (appState.currentView !== "skills" || !appState.mainEl) return;
  if (!skillsPageHost || skillsPageHost.parentElement !== appState.mainEl) {
    skillsPageHost = document.createElement("div");
    skillsPageHost.className = "pane skills-page";
    appState.mainEl.replaceChildren(skillsPageHost);
  }
  if (creating || editingTarget) {
    render(creating ? creatorPane() : editorPane(), skillsPageHost);
    return;
  }
  const filters = { query: skillSearch, scope: scopeFilter, source: sourceFilter, status: statusFilter };
  const scopedScope = scopedSession.active?.scopeId ?? null;
  skillsPageHost.classList.toggle("scoped-view", Boolean(scopedScope));
  let groups = filterSkillGroups(groupSkills(skillRows), filters);
  if (scopedScope)
    groups = groups
      .map((group) => ({
        ...group,
        skills: group.skills.filter((skill) => skill.scopeId === scopedScope),
      }))
      .filter((group) => group.skills.length > 0);
  const filtered = groups.flatMap((group) => group.skills);
  const counts = statusCounts(skillRows);
  const rows: TemplateResult[] = groups.map((group) => skillGroup(group.name, group.skills));
  const clearFilters = () => {
    skillSearch = "";
    scopeFilter = "all";
    sourceFilter = "all";
    statusFilter = "all";
    drawSkills();
  };
  const emptyState = skillEmptyState(skillRows.length, filtered.length, loading);
  let empty: string | TemplateResult = scopedScope ? "No skills in this context." : "No skills available yet.";
  if (emptyState === "filtered") {
    empty = html`<div class="skill-empty">
      <span>No skills match these filters.</span
      ><button class="btn" type="button" @click=${clearFilters}>Clear filters</button>
    </div>`;
  } else if (emptyState === "loading") {
    empty = "Loading skills…";
  }
  render(
    html`${scopedViewTopbar("skills", () => drawSkills())}${listPageTpl({
      title: "Skills",
      onRefresh: () => void renderSkills(),
      action: { label: "New skill", onClick: startCreate },
      search: {
        value: skillSearch,
        placeholder: "Search skills…",
        onInput: (value) => {
          skillSearch = value;
          drawSkills();
        },
      },
      filters: html`<div class="skill-registry-controls">
          <div class="resource-tabs" role="group" aria-label="Filter by skill status">
            ${(
              [
                ["active", "Active", counts.active],
                ["archived", "Archived", counts.archived],
                ["all", "All", counts.all],
              ] as const
            ).map(
              ([value, label, count]) =>
                html`<button
                  type="button"
                  aria-pressed=${statusFilter === value}
                  class=${statusFilter === value ? "active" : ""}
                  @click=${() => {
                    statusFilter = value;
                    drawSkills();
                  }}
                >
                  ${t(label)}<span>${count}</span>
                </button>`,
            )}
          </div>
          <div class="skill-filter-fields">
            <label class="list-select"
              ><span>Scope</span>${fieldSelect({
                compact: true,
                ariaLabel: "Filter skills by scope",
                value: scopeFilter,
                onChange: (value) => {
                  scopeFilter = value;
                  drawSkills();
                },
                options: [
                  html`<option value="all">All scopes</option>`,
                  html`<option value="personal">Personal</option>`,
                  html`<option value="channel">Channel</option>`,
                  html`<option value="group">Project / group</option>`,
                  html`<option value="team">Team</option>`,
                  html`<option value="org">Organization</option>`,
                ],
              })}</label
            >
            <label class="list-select"
              ><span>Source</span>${fieldSelect({
                compact: true,
                ariaLabel: "Filter skills by source",
                value: sourceFilter,
                onChange: (value) => {
                  sourceFilter = value;
                  drawSkills();
                },
                options: [
                  html`<option value="all">All sources</option>`,
                  html`<option value="native">Created here</option>`,
                  html`<option value="pack">Skill packs</option>`,
                  html`<option value="overrides">Overrides</option>`,
                ],
              })}</label
            >
          </div>
        </div>
        <div class="skill-result-count" aria-live="polite">
          ${
            loading
              ? t("Loading…")
              : t(
                  `${filtered.length} skill${filtered.length === 1 ? "" : "s"} in ${groups.length} ${groups.length === 1 ? "group" : "groups"}`,
                )
          }
        </div>
        ${skillsNotice ? html`<div class="status">${skillsNotice}</div>` : nothing}`,
      rows,
      empty,
    })}${archiveConfirmation ? archiveDialog(archiveConfirmation) : nothing}`,
    skillsPageHost,
  );
}

function setSkillsBackgroundInert(inert: boolean): void {
  skillsPageHost?.querySelectorAll<HTMLElement>(":scope > :not(.project-dialog-backdrop)").forEach((element) => {
    element.inert = inert;
  });
}

function closeArchiveDialog(): void {
  if (deleting) return;
  const target = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  drawSkills();
  setSkillsBackgroundInert(false);
  queueMicrotask(() => {
    if (archiveConfirmation || appState.currentView !== "skills") return;
    const fallback = target?.dataset.skillId
      ? [...document.querySelectorAll<HTMLElement>(".skill-archive-trigger")].find(
          (element) => element.dataset.skillId === target.dataset.skillId,
        )
      : null;
    restoreDialogFocus(target, () => fallback);
  });
}

function archiveDialog(skill: SkillItem): TemplateResult {
  const audience =
    skill.scope === "personal"
      ? t("you")
      : `${t("everyone in")} ${skill.scopeId ? scopeTitle(skill.scopeId) : `${t("this")} ${scopeLabel(skill.scope)}`}`;
  return html`<div
    class="project-dialog-backdrop"
    @click=${(event: MouseEvent) => event.target === event.currentTarget && closeArchiveDialog()}
  >
    <div
      class="project-dialog skill-archive-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-archive-title"
      aria-describedby="skill-archive-impact"
      @keydown=${(event: KeyboardEvent) => trapDialogFocus(event, closeArchiveDialog)}
    >
      <div class="project-dialog-head">
        <div><h2 id="skill-archive-title">Archive /${skill.name}?</h2></div>
      </div>
      <p id="skill-archive-impact">
        ${t("This version will stop being available to")} ${audience}. ${t("If it overrides a broader version of")}
        /${skill.name},
        ${t("that version becomes effective. Its history and assets are kept, and you can restore it later.")}
      </p>
      <div class="project-dialog-actions actions">
        <button
          class="btn"
          type="button"
          data-dialog-cancel
          ?disabled=${deleting === skill.id}
          @click=${closeArchiveDialog}
        >
          Cancel</button
        ><button
          class="btn danger skill-archive-confirm"
          type="button"
          ?disabled=${deleting === skill.id}
          @click=${() => void performArchive(skill)}
        >
          ${t(deleting === skill.id ? "Archiving…" : "Archive skill")}
        </button>
      </div>
    </div>
  </div>`;
}

async function saveEdit(): Promise<void> {
  if (!editing || saving) return;
  if (isSharedSkillScope(editing.scopeId) && !reviewMatches(editing.review, editing.description, editing.body)) {
    editing.review = { description: editing.description, body: editing.body };
    return drawSkills();
  }
  const operation = skillMutations.begin();
  saving = true;
  editError = "";
  drawSkills();
  try {
    await api(`/api/skills/${encodeURIComponent(editing.id)}`, {
      method: "PUT",
      body: JSON.stringify({ description: editing.description, body: editing.body }),
    });
    if (!skillMutations.isCurrent(operation)) {
      await renderSkills();
      return;
    }
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    editing = null;
    editingTarget = null;
    saving = false;
    await renderSkills();
    if (!skillMutations.isCurrent(operation)) return;
    restoreFocusedFlow(returnTarget);
  } catch (e) {
    if (!skillMutations.isCurrent(operation)) return;
    editError = errMessage(e, "Failed to save skill.");
    saving = false;
    drawSkills();
  }
}

async function saveCreate(): Promise<void> {
  if (!creating || creatingSaving) return;
  const name = creating.name.trim();
  const description = creating.description.trim();
  const body = creating.body.trim();
  if (!name || !description || !body) {
    createError = "Name, description, and instructions are all required.";
    drawSkills();
    return;
  }
  if (
    isSharedSkillScope(creating.scopeId) &&
    !createReviewMatches(creating.review, name, description, body, creating.scopeId)
  ) {
    creating.review = { name, description, body, scopeId: creating.scopeId };
    return drawSkills();
  }
  const operation = skillMutations.begin();
  creatingSaving = true;
  createError = "";
  drawSkills();
  try {
    await api("/api/skills", {
      method: "POST",
      body: JSON.stringify({ name, description, body, scopeId: creating.scopeId }),
    });
    if (!skillMutations.isCurrent(operation)) {
      await renderSkills();
      return;
    }
    const returnTarget = flowFocusTarget;
    flowFocusTarget = null;
    creating = null;
    creatingSaving = false;
    await renderSkills();
    if (!skillMutations.isCurrent(operation)) return;
    restoreFocusedFlow(returnTarget);
  } catch (e) {
    if (!skillMutations.isCurrent(operation)) return;
    createError = errMessage(e, "Failed to create skill.");
    creatingSaving = false;
    drawSkills();
  }
}

async function deleteSkill(s: SkillItem, trigger?: HTMLElement): Promise<void> {
  if (!s.id || deleting) return;
  if (s.status === "archived") {
    deleting = s.id;
    try {
      await api(`/api/skills/${encodeURIComponent(s.id)}/restore`, { method: "POST", body: "{}" });
      deleting = null;
      return void renderSkills();
    } catch (e) {
      deleting = null;
      skillsNotice = errMessage(e, "Failed to restore skill.");
      return drawSkills();
    }
  }
  archiveFocusTarget = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  archiveConfirmation = s;
  drawSkills();
  setSkillsBackgroundInert(true);
  queueMicrotask(() => {
    if (archiveConfirmation?.id !== s.id || appState.currentView !== "skills") return;
    if (skillsPageHost) focusDialogCancel(skillsPageHost);
  });
}

async function performArchive(s: SkillItem): Promise<void> {
  if (!s.id || deleting) return;
  const focusTarget = archiveFocusTarget;
  archiveConfirmation = null;
  archiveFocusTarget = null;
  deleting = s.id;
  skillsNotice = "";
  drawSkills();
  setSkillsBackgroundInert(false);
  queueMicrotask(() => {
    const target =
      skillsPageHost?.querySelector<HTMLElement>(".list-search input") ??
      skillsPageHost?.querySelector<HTMLElement>(".list-page-action");
    target?.focus();
  });
  try {
    await api(`/api/skills/${encodeURIComponent(s.id)}`, { method: "DELETE" });
    deleting = null;
    await renderSkills();
  } catch (e) {
    deleting = null;
    skillsNotice = errMessage(e, "Failed to archive skill.");
    drawSkills();
    requestAnimationFrame(() => {
      const fallback = focusTarget?.dataset.skillId
        ? [...(skillsPageHost?.querySelectorAll<HTMLElement>(".skill-archive-trigger") ?? [])].find(
            (element) => element.dataset.skillId === focusTarget.dataset.skillId,
          )
        : null;
      restoreDialogFocus(
        focusTarget,
        () => fallback ?? skillsPageHost?.querySelector<HTMLElement>(".list-search input") ?? null,
      );
    });
  }
}

export async function renderSkills(): Promise<void> {
  if (appState.currentView !== "skills") return;
  if (!skillsPageHost || skillsPageHost.parentElement !== appState.mainEl) {
    archiveConfirmation = null;
    archiveFocusTarget = null;
    setSkillsBackgroundInert(false);
  }
  const seq = appState.viewRenderSeq;
  const request = skillsRefreshes.begin();
  skillsNotice = "";
  drawSkills(true);
  try {
    const [r, contexts] = await Promise.all([
      api<{ skills: SkillItem[] }>("/api/skills?includeShadowed=1"),
      api<{ contexts?: CoreContext[] }>("/api/contexts").catch(() => ({ contexts: [] })),
    ]);
    if (!skillsRefreshes.isCurrent(request) || seq !== appState.viewRenderSeq || appState.currentView !== "skills")
      return;
    skillRows = (r.skills ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    const personal = appState.me ? `personal:${appState.me.user}` : "";
    createScopes = [
      { scopeId: personal, name: t("Personal — only you") },
      ...(contexts.contexts ?? [])
        .filter(
          (context) =>
            context.scopeId !== personal &&
            (context.kind === "group" || (context.kind === "channel" && context.isPrivate)),
        )
        .map((context) => ({ scopeId: context.scopeId, name: context.name || context.scopeId })),
    ].filter((scope) => scope.scopeId);
  } catch (e) {
    if (!skillsRefreshes.isCurrent(request) || seq !== appState.viewRenderSeq || appState.currentView !== "skills")
      return;
    skillsNotice = errMessage(e, "Failed to load skills.");
  }
  if (skillsRefreshes.isCurrent(request)) drawSkills(false);
}
