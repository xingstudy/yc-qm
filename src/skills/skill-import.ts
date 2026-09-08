import { createHash } from "node:crypto";
import type { SkillImportSource, SkillImportPreview } from "../../plugins/chassis/src/skill-import.ts";
import { collectAssets, planIngest, type FetchedRepo } from "./ingest.ts";
import type { SkillManifest } from "./skill-store.ts";
import type { SkillPackFetcher } from "./pack-fetcher.ts";
import { readSkillUpload } from "./skill-upload.ts";

export class SkillImportError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export async function fetchSkillSource(
  source: SkillImportSource,
  principalId: string,
  fetcher: SkillPackFetcher | undefined,
): Promise<FetchedRepo> {
  if (!source || typeof source !== "object") throw new SkillImportError("Choose a skill source");
  if (source.kind === "upload") return readSkillUpload(source.upload);
  if (
    source.kind !== "git" ||
    typeof source.url !== "string" ||
    (source.ref !== undefined && typeof source.ref !== "string")
  ) {
    throw new SkillImportError("Enter an HTTPS Git repository URL");
  }
  if (!fetcher) throw new SkillImportError("Skill repository import is not configured", 503);
  return fetcher.fetch({
    id: "preview",
    kind: "git",
    url: source.url.trim(),
    ref: source.ref?.trim() ?? "",
    createdBy: principalId,
    createdAt: 0,
    targetScopeId: `personal:${principalId}`,
    syncMode: "pinned",
    trustTier: "third-party",
    subset: "all",
  });
}

export function previewSkillImport(
  repo: FetchedRepo,
  nativeNames: Set<string>,
  personal: boolean,
): { preview: SkillImportPreview; manifests: Map<string, SkillManifest> } {
  const plan = planIngest(repo, { nativeNames, personal });
  const names = new Map<string, number>();
  for (const candidate of plan.candidates) {
    const name = candidate.normalized?.manifest.name;
    if (name) names.set(name, (names.get(name) ?? 0) + 1);
  }
  const manifests = new Map<string, SkillManifest>();
  const candidates = plan.candidates.map((candidate) => {
    const manifest = candidate.normalized?.manifest;
    const name = manifest?.name ?? candidate.upstreamName;
    const directory = candidate.skillPath.includes("/")
      ? candidate.skillPath.slice(0, candidate.skillPath.lastIndexOf("/"))
      : "";
    const files = manifest ? (collectAssets(repo, directory) ?? []) : [];
    const reason = (names.get(name) ?? 0) > 1 ? "duplicate-name" : candidate.excludeReason;
    const eligible = candidate.eligible && !reason;
    if (eligible && manifest) manifests.set(candidate.skillPath, { ...manifest, files });
    return {
      path: candidate.skillPath,
      name,
      description: manifest?.description ?? "",
      body: manifest?.body ?? "",
      files: files.map((file) => file.path),
      eligible,
      ...(reason ? { reason } : {}),
    };
  });
  const fingerprint = createHash("sha256").update(JSON.stringify(repo)).digest("hex");
  return { preview: { fingerprint, candidates }, manifests };
}
