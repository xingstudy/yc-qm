import type {
  AccessGroup,
  DirectorySubjectKind,
  DirectoryUserCursor,
  DirectoryUserPage,
  DirectoryViewPolicy,
  DirectoryViewRoot,
  OrganizationStore,
  OrganizationUser,
  OrgUnit,
} from "../organization/organization-store.ts";
import { normDirectoryQuery } from "../directory/directory-store.ts";
import {
  effectiveAccessGroupIdsForUser,
  effectiveAccessGroupUsers,
  effectiveOrganizationUnitIdsForUser,
} from "./access-group-membership.ts";

export interface DirectoryActor {
  principalId: string;
  isAdmin: boolean;
}

export interface ResolvedDirectoryVisibility {
  mode: "all" | "limited" | "none";
  roots: DirectoryViewRoot[];
  unitIds: ReadonlySet<string> | null;
  revision: number;
}

interface DirectoryVisibilityExplanation {
  visibility: ResolvedDirectoryVisibility;
  winningPriority: number | null;
  policies: Array<{
    policy: DirectoryViewPolicy;
    roots: DirectoryViewRoot[];
    effective: boolean;
  }>;
}

export interface DirectoryVisibilityResolver {
  resolve(actor: DirectoryActor): Promise<ResolvedDirectoryVisibility | null>;
  explain(actor: DirectoryActor): Promise<DirectoryVisibilityExplanation | null>;
  visibleUnits(actor: DirectoryActor): Promise<OrgUnit[] | null>;
  visibleUnit(actor: DirectoryActor, unitId: string): Promise<OrgUnit | null>;
  visibleUser(actor: DirectoryActor, principalId: string): Promise<OrganizationUser | null>;
  searchUsers(
    actor: DirectoryActor,
    input: {
      query: string;
      unitId?: string;
      excludePrincipalIds?: readonly string[];
      after: DirectoryUserCursor | null;
      limit: number;
    },
  ): Promise<DirectoryUserPage | null>;
  resolveUser(
    actor: DirectoryActor,
    query: string,
  ): Promise<
    { kind: "one"; user: OrganizationUser } | { kind: "ambiguous"; users: OrganizationUser[] } | { kind: "none" } | null
  >;
  visibleGroups(actor: DirectoryActor): Promise<AccessGroup[] | null>;
  visibleGroup(actor: DirectoryActor, groupId: string): Promise<AccessGroup | null>;
  unitMembers(actor: DirectoryActor, unitId: string): Promise<OrganizationUser[] | null>;
  groupMembers(actor: DirectoryActor, groupId: string): Promise<OrganizationUser[] | null>;
}

async function subjectPolicies(
  store: OrganizationStore,
  orgId: string,
  principalId: string,
): Promise<DirectoryViewPolicy[]> {
  const personal = await store.getDirectoryPolicy(orgId, "user", principalId);
  const [effectiveUnits, effectiveGroups] = await Promise.all([
    effectiveOrganizationUnitIdsForUser(store, orgId, principalId),
    effectiveAccessGroupIdsForUser(store, orgId, principalId),
  ]);
  const subjects: Array<{ kind: DirectorySubjectKind; id: string }> = [
    ...[...effectiveUnits].sort().map((id) => ({ kind: "org_unit" as const, id })),
    ...[...effectiveGroups].sort().map((id) => ({ kind: "access_group" as const, id })),
  ];
  const policies = await Promise.all(
    subjects.map((subject) => store.getDirectoryPolicy(orgId, subject.kind, subject.id)),
  );
  return [personal, ...policies].filter((policy): policy is DirectoryViewPolicy => policy !== null);
}

async function normalizeRoots(
  store: OrganizationStore,
  orgId: string,
  roots: readonly DirectoryViewRoot[],
): Promise<DirectoryViewRoot[] | null> {
  const byUnit = new Map<string, DirectoryViewRoot>();
  for (const root of roots) {
    const unit = await store.getUnit(orgId, root.unitId);
    if (!unit || unit.status !== "active") return null;
    const existing = byUnit.get(root.unitId);
    byUnit.set(root.unitId, {
      ...root,
      includeDescendants: root.includeDescendants || existing?.includeDescendants === true,
    });
  }
  const candidates = [...byUnit.values()].sort((left, right) => left.unitId.localeCompare(right.unitId));
  const normalized: DirectoryViewRoot[] = [];
  for (const candidate of candidates) {
    let covered = false;
    for (const other of candidates) {
      if (
        other.unitId !== candidate.unitId &&
        other.includeDescendants &&
        (await store.isDescendant(orgId, other.unitId, candidate.unitId))
      ) {
        covered = true;
        break;
      }
    }
    if (!covered) normalized.push(candidate);
  }
  return normalized;
}

async function unitsForRoots(
  store: OrganizationStore,
  orgId: string,
  roots: readonly DirectoryViewRoot[],
): Promise<Set<string>> {
  const unitIds = new Set<string>();
  for (const root of roots) {
    unitIds.add(root.unitId);
    if (!root.includeDescendants) continue;
    for (const unitId of await store.listSubtreeUnitIds(orgId, root.unitId)) unitIds.add(unitId);
  }
  return unitIds;
}

export function createDirectoryVisibilityResolver(deps: {
  store: OrganizationStore;
  orgId: string;
}): DirectoryVisibilityResolver {
  const { store, orgId } = deps;

  async function evaluate(
    policies: readonly DirectoryViewPolicy[],
    revision: number,
  ): Promise<{ visibility: ResolvedDirectoryVisibility; winningPriority: number | null }> {
    if (policies.length === 0) {
      return { visibility: { mode: "all", roots: [], unitIds: null, revision }, winningPriority: null };
    }
    const winningPriority = Math.max(...policies.map((policy) => policy.priority));
    const effective = policies.filter((policy) => policy.priority === winningPriority);
    if (effective.some((policy) => policy.mode === "none")) {
      return {
        visibility: { mode: "none", roots: [], unitIds: new Set(), revision },
        winningPriority,
      };
    }
    const limited = effective.filter((policy) => policy.mode === "limited");
    if (limited.length === 0) {
      return { visibility: { mode: "all", roots: [], unitIds: null, revision }, winningPriority };
    }
    const rootSets = await Promise.all(limited.map((policy) => store.listDirectoryRoots(orgId, policy.id)));
    const roots = await normalizeRoots(store, orgId, rootSets.flat());
    if (roots === null || roots.length === 0) {
      return {
        visibility: { mode: "none", roots: [], unitIds: new Set(), revision },
        winningPriority,
      };
    }
    return {
      visibility: { mode: "limited", roots, unitIds: await unitsForRoots(store, orgId, roots), revision },
      winningPriority,
    };
  }

  async function resolve(actor: DirectoryActor): Promise<ResolvedDirectoryVisibility | null> {
    const user = await store.getUser(orgId, actor.principalId);
    if (!user || user.status !== "active") return null;
    const revision = await store.getAuthzRevision(orgId);
    if (actor.isAdmin) return { mode: "all", roots: [], unitIds: null, revision };
    const policies = await subjectPolicies(store, orgId, actor.principalId);
    return (await evaluate(policies, revision)).visibility;
  }

  async function explain(actor: DirectoryActor): Promise<DirectoryVisibilityExplanation | null> {
    const user = await store.getUser(orgId, actor.principalId);
    if (!user || user.status !== "active") return null;
    const revision = await store.getAuthzRevision(orgId);
    if (actor.isAdmin) {
      return {
        visibility: { mode: "all", roots: [], unitIds: null, revision },
        winningPriority: null,
        policies: [],
      };
    }
    const matched = await subjectPolicies(store, orgId, actor.principalId);
    const { visibility, winningPriority } = await evaluate(matched, revision);
    const policies = await Promise.all(
      matched
        .slice()
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            left.subjectKind.localeCompare(right.subjectKind) ||
            left.subjectId.localeCompare(right.subjectId),
        )
        .map(async (policy) => ({
          policy,
          roots: await store.listDirectoryRoots(orgId, policy.id),
          effective: policy.priority === winningPriority,
        })),
    );
    return { visibility, winningPriority, policies };
  }

  async function visibleUnits(actor: DirectoryActor): Promise<OrgUnit[] | null> {
    const visibility = await resolve(actor);
    if (!visibility) return null;
    return (await store.listUnits(orgId))
      .filter((unit) => unit.status === "active" && (visibility.unitIds === null || visibility.unitIds.has(unit.id)))
      .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id));
  }

  async function visibleUnit(actor: DirectoryActor, unitId: string): Promise<OrgUnit | null> {
    const visibility = await resolve(actor);
    if (!visibility || (visibility.unitIds !== null && !visibility.unitIds.has(unitId))) return null;
    const unit = await store.getUnit(orgId, unitId);
    return unit?.status === "active" ? unit : null;
  }

  async function visibleUser(actor: DirectoryActor, principalId: string): Promise<OrganizationUser | null> {
    const visibility = await resolve(actor);
    if (!visibility) return null;
    const user = await store.getUser(orgId, principalId);
    if (!user || user.status !== "active") return null;
    if (visibility.unitIds === null) return user;
    const directUnits = await store.listDirectUnitIdsForUser(orgId, principalId);
    return directUnits.some((unitId) => visibility.unitIds?.has(unitId)) ? user : null;
  }

  async function searchUsers(
    actor: DirectoryActor,
    input: {
      query: string;
      unitId?: string;
      excludePrincipalIds?: readonly string[];
      after: DirectoryUserCursor | null;
      limit: number;
    },
  ): Promise<DirectoryUserPage | null> {
    const visibility = await resolve(actor);
    if (!visibility) return null;
    let unitIds = visibility.unitIds === null ? null : [...visibility.unitIds];
    if (input.unitId !== undefined) {
      if (visibility.unitIds !== null && !visibility.unitIds.has(input.unitId)) return null;
      const unit = await store.getUnit(orgId, input.unitId);
      if (!unit || unit.status !== "active") return null;
      const subtree = new Set(await store.listSubtreeUnitIds(orgId, input.unitId));
      unitIds = unitIds === null ? [...subtree] : unitIds.filter((unitId) => subtree.has(unitId));
    }
    return store.searchDirectoryUsers(orgId, {
      query: input.query.trim(),
      unitIds,
      excludePrincipalIds: input.excludePrincipalIds,
      after: input.after,
      limit: Math.max(1, Math.min(100, Math.floor(input.limit))),
    });
  }

  async function resolveUser(actor: DirectoryActor, query: string) {
    const normalized = normDirectoryQuery(query);
    if (!normalized) return { kind: "none" as const };
    const page = await searchUsers(actor, { query, after: null, limit: 100 });
    if (!page) return null;
    const exact = page.users.find(
      (user) =>
        normDirectoryQuery(user.principalId) === normalized ||
        normDirectoryQuery(user.email ?? "") === normalized ||
        normDirectoryQuery(user.displayName) === normalized,
    );
    if (exact) return { kind: "one" as const, user: exact };
    if (page.users.length === 1) return { kind: "one" as const, user: page.users[0]! };
    if (page.users.length > 1) return { kind: "ambiguous" as const, users: page.users.slice(0, 10) };
    return { kind: "none" as const };
  }

  async function userVisibleInScope(
    visibility: ResolvedDirectoryVisibility,
    principalId: string,
  ): Promise<OrganizationUser | null> {
    const user = await store.getUser(orgId, principalId);
    if (!user || user.status !== "active") return null;
    if (visibility.unitIds === null) return user;
    const directUnits = await store.listDirectUnitIdsForUser(orgId, principalId);
    return directUnits.some((unitId) => visibility.unitIds?.has(unitId)) ? user : null;
  }

  async function visibleGroupWithScope(visibility: ResolvedDirectoryVisibility, group: AccessGroup): Promise<boolean> {
    if (group.status !== "active") return false;
    if (visibility.unitIds === null) return true;
    const members = await effectiveAccessGroupUsers(store, orgId, group.id);
    for (const user of members) {
      if (!(await userVisibleInScope(visibility, user.principalId))) return false;
    }
    return members.length > 0;
  }

  async function visibleGroups(actor: DirectoryActor): Promise<AccessGroup[] | null> {
    const visibility = await resolve(actor);
    if (!visibility) return null;
    const groups: AccessGroup[] = [];
    for (const group of await store.listGroups(orgId)) {
      if (await visibleGroupWithScope(visibility, group)) groups.push(group);
    }
    return groups.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  async function visibleGroup(actor: DirectoryActor, groupId: string): Promise<AccessGroup | null> {
    const visibility = await resolve(actor);
    if (!visibility) return null;
    const group = await store.getGroup(orgId, groupId);
    if (!group || !(await visibleGroupWithScope(visibility, group))) return null;
    return group;
  }

  async function unitMembers(actor: DirectoryActor, unitId: string): Promise<OrganizationUser[] | null> {
    const visibility = await resolve(actor);
    if (!visibility || (visibility.unitIds !== null && !visibility.unitIds.has(unitId))) return null;
    const unit = await store.getUnit(orgId, unitId);
    if (!unit || unit.status !== "active") return null;
    const users: OrganizationUser[] = [];
    for (const member of await store.listUnitMembers(orgId, unitId)) {
      const user = await userVisibleInScope(visibility, member.principalId);
      if (user) users.push(user);
    }
    return users.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async function groupMembers(actor: DirectoryActor, groupId: string): Promise<OrganizationUser[] | null> {
    const visibility = await resolve(actor);
    if (!visibility) return null;
    const group = await store.getGroup(orgId, groupId);
    if (!group || !(await visibleGroupWithScope(visibility, group))) return null;
    const users: OrganizationUser[] = [];
    for (const member of await effectiveAccessGroupUsers(store, orgId, groupId)) {
      const user = await userVisibleInScope(visibility, member.principalId);
      if (user) users.push(user);
    }
    return users.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  return {
    resolve,
    explain,
    visibleUnits,
    visibleUnit,
    visibleUser,
    searchUsers,
    resolveUser,
    visibleGroups,
    visibleGroup,
    unitMembers,
    groupMembers,
  };
}
