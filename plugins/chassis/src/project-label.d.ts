export function projectIdFromScope(scopeId: string | null | undefined): string | null;
export function projectDisplayName(id: string, name?: string | null, unknownLabel?: string): string;
export function projectScopeName(
  scopeId: string | null | undefined,
  name?: string | null,
  unknownLabel?: string,
): string | null;
export function projectOptionName(
  project: { id: string; name?: string | null; creatorId?: string; creatorName?: string | null },
  projects: readonly { id: string; name?: string | null; creatorId?: string; creatorName?: string | null }[],
  unknownLabel?: string,
): string;
