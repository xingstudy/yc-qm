import type {
  AccessGroupSubject,
  OrganizationStore,
  OrganizationTx,
  OrganizationUser,
} from "../organization/organization-store.ts";

type GroupSubjectReader = Pick<OrganizationStore, "listGroupSubjects"> | Pick<OrganizationTx, "listGroupSubjects">;

export async function effectiveOrganizationUnitIdsForUser(
  store: OrganizationStore,
  orgId: string,
  principalId: string,
): Promise<Set<string>> {
  const units = (await store.listUnits(orgId)).filter((unit) => unit.status === "active");
  const effective = new Set(units.filter((unit) => unit.parentId === null).map((unit) => unit.id));
  for (const unitId of await store.listDirectUnitIdsForUser(orgId, principalId)) {
    for (const ancestorId of await store.listAncestorUnitIds(orgId, unitId)) effective.add(ancestorId);
  }
  return effective;
}

export async function effectiveAccessGroupIdsForUser(
  store: OrganizationStore,
  orgId: string,
  principalId: string,
): Promise<Set<string>> {
  const activeGroups = new Set(
    (await store.listGroups(orgId)).filter((group) => group.status === "active").map((group) => group.id),
  );
  const effective = new Set(
    (await store.listDirectGroupIdsForUser(orgId, principalId)).filter((groupId) => activeGroups.has(groupId)),
  );
  const unitIds = await effectiveOrganizationUnitIdsForUser(store, orgId, principalId);
  const subjects = await store.listGroupSubjects(orgId);
  let changed = true;
  while (changed) {
    changed = false;
    for (const subject of subjects) {
      if (!activeGroups.has(subject.groupId) || effective.has(subject.groupId)) continue;
      const included =
        subject.subjectKind === "org_unit"
          ? unitIds.has(subject.subjectId)
          : activeGroups.has(subject.subjectId) && effective.has(subject.subjectId);
      if (!included) continue;
      effective.add(subject.groupId);
      changed = true;
    }
  }
  return effective;
}

export async function effectiveAccessGroupUsers(
  store: OrganizationStore,
  orgId: string,
  groupId: string,
): Promise<OrganizationUser[]> {
  const activeGroups = new Set(
    (await store.listGroups(orgId)).filter((group) => group.status === "active").map((group) => group.id),
  );
  if (!activeGroups.has(groupId)) return [];
  const activeUsers = new Map(
    (await store.listUsers(orgId)).filter((user) => user.status === "active").map((user) => [user.principalId, user]),
  );
  const subjects = await store.listGroupSubjects(orgId);
  const byGroup = new Map<string, AccessGroupSubject[]>();
  for (const subject of subjects) {
    const current = byGroup.get(subject.groupId) ?? [];
    current.push(subject);
    byGroup.set(subject.groupId, current);
  }
  const result = new Map<string, OrganizationUser>();
  const visited = new Set<string>();
  const visit = async (currentGroupId: string): Promise<void> => {
    if (visited.has(currentGroupId) || !activeGroups.has(currentGroupId)) return;
    visited.add(currentGroupId);
    for (const member of await store.listGroupMembers(orgId, currentGroupId)) {
      const user = activeUsers.get(member.principalId);
      if (user) result.set(user.principalId, user);
    }
    for (const subject of byGroup.get(currentGroupId) ?? []) {
      if (subject.subjectKind === "access_group") {
        await visit(subject.subjectId);
        continue;
      }
      const unit = await store.getUnit(orgId, subject.subjectId);
      if (!unit || unit.status !== "active") continue;
      if (unit.parentId === null) {
        for (const user of activeUsers.values()) result.set(user.principalId, user);
        continue;
      }
      const subtree = await store.listSubtreeUnitIds(orgId, subject.subjectId);
      for (const member of await store.listUnitMembersForUnits(orgId, subtree)) {
        const user = activeUsers.get(member.principalId);
        if (user) result.set(user.principalId, user);
      }
    }
  };
  await visit(groupId);
  return [...result.values()].sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName) || left.principalId.localeCompare(right.principalId),
  );
}

export async function accessGroupSubjectWouldCycle(
  store: GroupSubjectReader,
  orgId: string,
  groupId: string,
  subjectGroupId: string,
): Promise<boolean> {
  if (groupId === subjectGroupId) return true;
  const nested = new Map<string, string[]>();
  for (const subject of await store.listGroupSubjects(orgId)) {
    if (subject.subjectKind !== "access_group") continue;
    const current = nested.get(subject.groupId) ?? [];
    current.push(subject.subjectId);
    nested.set(subject.groupId, current);
  }
  const pending = [subjectGroupId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === groupId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(nested.get(current) ?? []));
  }
  return false;
}
