import type { OrganizationStore } from "../organization/organization-store.ts";
import type { DirectorySourceService } from "./directory-source-service.ts";
import type { DirectorySourceStore } from "./directory-source-store.ts";
import { matchDirectoryMember } from "./identity-match.ts";

type DirectoryMigrationCategory =
  "stable_binding" | "unique_corporate_email_candidate" | "suspected_duplicate_account" | "conflict" | "unmatched";

interface DirectoryMigrationPreviewRow {
  sourceId: string;
  externalSubjectId: string;
  displayName: string;
  category: DirectoryMigrationCategory;
  reason: string;
  principalId: string | null;
  candidateCount: number;
}

interface DirectoryMigrationPreview {
  generatedAt: number;
  rows: DirectoryMigrationPreviewRow[];
  counts: Record<DirectoryMigrationCategory, number>;
  truncated: boolean;
}

export interface DirectoryIdentityMigrationService {
  preview(sourceId?: string): Promise<DirectoryMigrationPreview>;
}

const MAX_PREVIEW_MEMBERS = 10_000;

function category(reason: string, state: string): DirectoryMigrationCategory {
  if (reason === "stable_binding") return "stable_binding";
  if (reason === "unique_corporate_email") return "unique_corporate_email_candidate";
  if (reason === "duplicate_corporate_email") return "suspected_duplicate_account";
  if (state === "conflict") return "conflict";
  return "unmatched";
}

export function createDirectoryIdentityMigrationService(options: {
  orgId: string;
  organizationStore: OrganizationStore;
  directoryStore: DirectorySourceStore;
  sources: DirectorySourceService;
  now?: () => number;
}): DirectoryIdentityMigrationService {
  const { orgId, organizationStore, directoryStore, sources } = options;
  const now = options.now ?? Date.now;
  return {
    async preview(sourceId) {
      const [users, identities, available] = await Promise.all([
        organizationStore.listUsers(orgId),
        organizationStore.listIdentities(orgId),
        sources.list(),
      ]);
      const selected = sourceId ? available.filter((source) => source.id === sourceId) : available;
      if (sourceId && selected.length === 0) throw new Error("directory_source_not_found");
      const rows: DirectoryMigrationPreviewRow[] = [];
      let truncated = false;
      for (const source of selected) {
        let after = null;
        for (;;) {
          const page = await directoryStore.listMembers(orgId, source.id, { limit: 100, after });
          for (const member of page.members) {
            if (rows.length >= MAX_PREVIEW_MEMBERS) {
              truncated = true;
              break;
            }
            const match = matchDirectoryMember({ member, policy: source.matchPolicy, users, identities });
            rows.push({
              sourceId: source.id,
              externalSubjectId: member.externalSubjectId,
              displayName: member.displayName,
              category: category(match.reason, match.state),
              reason: match.reason,
              principalId: match.principalId,
              candidateCount: match.candidates.length,
            });
          }
          if (truncated || !page.next) break;
          after = page.next;
        }
        if (truncated) break;
      }
      const counts: Record<DirectoryMigrationCategory, number> = {
        stable_binding: 0,
        unique_corporate_email_candidate: 0,
        suspected_duplicate_account: 0,
        conflict: 0,
        unmatched: 0,
      };
      for (const row of rows) counts[row.category]++;
      return { generatedAt: now(), rows, counts, truncated };
    },
  };
}
