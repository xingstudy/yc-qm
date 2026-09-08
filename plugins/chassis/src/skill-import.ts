export const SKILL_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
export const SKILL_IMPORT_BODY_MAX_BYTES = 12 * 1024 * 1024;

export interface SkillUpload {
  name: string;
  base64: string;
}

export type SkillImportSource = { kind: "git"; url: string; ref?: string } | { kind: "upload"; upload: SkillUpload };

export interface SkillImportPreview {
  fingerprint: string;
  candidates: Array<{
    path: string;
    name: string;
    description: string;
    body: string;
    files: string[];
    eligible: boolean;
    reason?: string;
  }>;
  imported?: string[];
}
