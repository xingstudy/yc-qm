import { nothing } from "lit";
import { html, t } from "./i18n.ts";
import { api } from "./core-bridge.ts";
import { errMessage } from "../../chassis/src/errors.ts";
import {
  SKILL_UPLOAD_MAX_BYTES,
  type SkillImportPreview,
  type SkillImportSource,
  type SkillUpload,
} from "../../chassis/src/skill-import.ts";

export class SkillImportForm {
  mode: "git" | "upload" | "manual" = "git";
  url = "";
  ref = "";
  upload: SkillUpload | null = null;
  preview: SkillImportPreview | null = null;
  selected = new Set<string>();
  busy = false;
  error = "";
  private sequence = 0;

  get hasEligibleSkills(): boolean {
    return this.preview?.candidates.some((candidate) => candidate.eligible) ?? false;
  }

  invalidate(): void {
    this.sequence++;
    this.preview = null;
    this.selected.clear();
    this.error = "";
    this.busy = false;
  }

  source(): SkillImportSource {
    if (this.mode === "upload" && this.upload) return { kind: "upload", upload: this.upload };
    return { kind: "git", url: this.url.trim(), ref: this.ref.trim() };
  }

  async chooseFile(file: File | undefined, redraw: () => void): Promise<void> {
    this.invalidate();
    this.upload = null;
    if (!file) return redraw();
    if (file.size > SKILL_UPLOAD_MAX_BYTES) {
      this.error = t("Choose a file of at most 8 MiB.");
      return redraw();
    }
    const sequence = this.sequence;
    this.busy = true;
    redraw();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let raw = "";
      for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
      if (this.sequence !== sequence) return;
      this.upload = { name: file.name, base64: btoa(raw) };
    } catch (error) {
      if (this.sequence !== sequence) return;
      this.error = errMessage(error);
    } finally {
      if (this.sequence === sequence) {
        this.busy = false;
        redraw();
      }
    }
  }

  async submit(scopeId: string, redraw: () => void, done: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    const importing = this.preview !== null && this.hasEligibleSkills;
    if (importing && !this.selected.size) {
      this.error = t("Select at least one available skill.");
      redraw();
      return;
    }
    const sequence = ++this.sequence;
    this.busy = true;
    this.error = "";
    redraw();
    try {
      const result = await api<SkillImportPreview>("/api/skills/import", {
        method: "POST",
        body: JSON.stringify({
          source: this.source(),
          scopeId,
          ...(importing ? { selected: [...this.selected], fingerprint: this.preview!.fingerprint } : {}),
        }),
      });
      if (this.sequence !== sequence) return;
      if (importing) await done();
      else {
        this.preview = result;
        this.selected = new Set(
          result.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.path),
        );
      }
    } catch (error) {
      if (this.sequence !== sequence) return;
      this.error = errMessage(error, t("Failed to import skills."));
      if (importing) this.preview = null;
    } finally {
      if (this.sequence === sequence) {
        this.busy = false;
        redraw();
      }
    }
  }

  render(redraw: () => void) {
    const changed = (field: "url" | "ref") => (event: Event) => {
      this[field] = (event.target as HTMLInputElement).value;
      this.invalidate();
      redraw();
    };
    const reasons: Record<string, string> = {
      collision: "A skill with this name already exists in this context.",
      "duplicate-name": "Multiple skills in this source use the same name.",
      "binary-asset": "This skill has unreadable files or unsafe paths.",
      malformed: "Invalid skill name or empty instructions.",
      private: "Private skills cannot be imported into a shared context.",
      scope: "This skill declares a personal scope.",
    };
    return html`
      ${
        this.mode === "git"
          ? html` <label class="skill-field"
                ><span>Project URL</span>
                <input
                  class="skill-desc-input"
                  type="url"
                  placeholder="https://github.com/owner/repository"
                  .value=${this.url}
                  ?disabled=${this.busy}
                  @input=${changed("url")}
                  data-focus-key="skill-import-url"
                />
                <small class="card-meta">Use an HTTPS Git repository containing one or more SKILL.md files.</small>
              </label>
              <label class="skill-field"
                ><span>Branch, tag or commit (optional)</span>
                <input
                  class="skill-desc-input"
                  .value=${this.ref}
                  ?disabled=${this.busy}
                  @input=${changed("ref")}
                  data-focus-key="skill-import-ref"
                />
              </label>`
          : html` <label class="skill-field"
              ><span>Skill file or archive</span>
              <input
                type="file"
                accept=".zip,.tar.gz,.tgz,.tar,.md"
                ?disabled=${this.busy}
                @click=${(event: Event) => {
                  (event.target as HTMLInputElement).value = "";
                }}
                @change=${(event: Event) => void this.chooseFile((event.target as HTMLInputElement).files?.[0], redraw)}
              />
              <small class="card-meta">ZIP, tar.gz, tgz, tar or Markdown · maximum 8 MiB</small>
              ${this.upload ? html`<span>${this.upload.name}</span>` : nothing}
            </label>`
      }
      <p class="card-meta">
        Import preserves instructions, scripts, references and binary assets inside each skill directory.
      </p>
      ${
        this.preview
          ? html` <div class="skill-impact" role="status">
              <strong
                >${t(this.hasEligibleSkills ? "Review skills before importing" : "No skills available to import")}</strong
              >
              <p class="card-meta">
                ${t(
                  this.hasEligibleSkills
                    ? "Selected skills will be published to the context above. Review the instructions and files before confirming."
                    : "All skills are unavailable. Check the reasons below, choose another file or source, then preview again.",
                )}
              </p>
              ${this.hasEligibleSkills && !this.selected.size ? html`<p role="status">Select at least one available skill.</p>` : nothing}
              ${!this.preview.candidates.length ? html`<p>No SKILL.md files found.</p>` : nothing}
              ${this.preview.candidates.map(
                (candidate) =>
                  html` <div class="card">
                    <label
                      ><input
                        type="checkbox"
                        .checked=${this.selected.has(candidate.path)}
                        ?disabled=${this.busy || !candidate.eligible}
                        @change=${(event: Event) => {
                          if ((event.target as HTMLInputElement).checked) this.selected.add(candidate.path);
                          else this.selected.delete(candidate.path);
                          redraw();
                        }}
                      />
                      ${candidate.name}</label
                    >
                    <p>${candidate.description}</p>
                    <div class="card-meta">${candidate.path}</div>
                    ${candidate.reason ? html`<p class="skill-shadowed">${t(reasons[candidate.reason] ?? candidate.reason)}</p>` : nothing}
                    <details>
                      <summary>Instructions and files</summary>
                      <pre style="white-space:pre-wrap;overflow-wrap:anywhere">${candidate.body}</pre>
                      ${candidate.files.map((path) => html`<div class="card-meta">${path}</div>`)}
                    </details>
                  </div>`,
              )}
            </div>`
          : nothing
      }
      ${this.error ? html`<div class="skill-shadowed" role="alert">${this.error}</div>` : nothing}
    `;
  }
}
