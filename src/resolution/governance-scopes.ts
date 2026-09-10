import type { OrganizationStore, OrgUnit } from "../organization/organization-store.ts";
import { organizationAccessSubjectFromScope } from "../authorization/organization-access-subject.ts";

export async function organizationGovernanceAncestors(
  store: OrganizationStore,
  orgId: string,
  scope: string,
): Promise<string[]> {
  const subject = organizationAccessSubjectFromScope(scope);
  if (!subject || subject.kind === "access_group") return [];
  if (subject.kind === "user" && (await store.getUser(orgId, subject.id))?.status !== "active") return [];
  const [units, directUnits, directGroups] = await Promise.all([
    store.listUnits(orgId),
    subject.kind === "user" ? store.listDirectUnitIdsForUser(orgId, subject.id) : [subject.id],
    subject.kind === "user" ? store.listDirectGroupIdsForUser(orgId, subject.id) : [],
  ]);
  const byId = new Map(units.filter((unit) => unit.status === "active").map((unit) => [unit.id, unit]));
  const included = new Map<string, OrgUnit>();
  const depth = (unit: OrgUnit): number => {
    const visited = new Set([unit.id]);
    let parent = unit.parentId;
    while (parent && byId.has(parent)) {
      if (visited.has(parent)) throw new Error("organization governance hierarchy contains a cycle");
      visited.add(parent);
      parent = byId.get(parent)!.parentId;
    }
    return visited.size;
  };
  for (const id of directUnits) {
    let current = byId.get(id);
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current.id)) throw new Error("organization governance hierarchy contains a cycle");
      visited.add(current.id);
      included.set(current.id, current);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  const groups = await Promise.all(directGroups.map((id) => store.getGroup(orgId, id)));
  return [
    ...[...included.values()]
      .sort((a, b) => depth(a) - depth(b) || a.id.localeCompare(b.id))
      .map((unit) => `org-unit:${unit.id}`),
    ...groups
      .filter((group) => group?.status === "active")
      .map((group) => `access-group:${group!.id}`)
      .sort(),
  ].filter((id) => id !== scope);
}
