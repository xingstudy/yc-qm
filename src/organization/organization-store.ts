import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { Skill } from "../skills/skill-store.ts";
import type { Permission, ScopeId } from "../types.ts";
import { createKeyedQueue } from "../util/async.ts";
import { personKey } from "../directory/person.ts";

export type OrganizationUserStatus = "invited" | "active" | "suspended" | "deprovisioned";

export const ORGANIZATION_USER_STATUSES: ReadonlyArray<OrganizationUserStatus> = [
  "invited",
  "active",
  "suspended",
  "deprovisioned",
];

export interface OrganizationUser {
  orgId: string;
  principalId: string;
  email: string | null;
  displayName: string;
  jobTitle: string | null;
  mobile: string | null;
  employeeNumber: string | null;
  status: OrganizationUserStatus;
  sessionVersion: number;
  profileRevision: number;
  createdAt: number;
  updatedAt: number;
  lastLoginAt: number | null;
  createdBy: string;
  updatedBy: string;
}

export interface AuthIdentity {
  orgId: string;
  issuer: string;
  subject: string;
  principalId: string;
  emailAtLink: string | null;
  createdAt: number;
  updatedAt: number;
}

export type OrgUnitKind = "organization" | "department" | "team";
export type OrgUnitStatus = "active" | "archived";

export interface OrgUnit {
  orgId: string;
  id: string;
  parentId: string | null;
  name: string;
  kind: OrgUnitKind;
  status: OrgUnitStatus;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
}

export type OrgMemberRole = "member" | "manager";

export interface OrgUnitMember {
  orgId: string;
  unitId: string;
  principalId: string;
  role: OrgMemberRole;
  isPrimary?: boolean;
  createdAt: number;
  createdBy: string;
}

export type AccessGroupStatus = "active" | "archived";

export interface AccessGroup {
  orgId: string;
  id: string;
  name: string;
  status: AccessGroupStatus;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  updatedBy: string;
}

export interface AccessGroupMember {
  orgId: string;
  groupId: string;
  principalId: string;
  role: OrgMemberRole;
  createdAt: number;
  createdBy: string;
}

export type DirectorySubjectKind = "user" | "org_unit" | "access_group";
export type DirectoryViewMode = "all" | "limited" | "none";

export interface DirectoryViewPolicy {
  id: string;
  orgId: string;
  subjectKind: DirectorySubjectKind;
  subjectId: string;
  mode: DirectoryViewMode;
  revision: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface DirectoryViewRoot {
  orgId: string;
  policyId: string;
  unitId: string;
  includeDescendants: boolean;
}

export interface DirectoryUserCursor {
  displayName: string;
  principalId: string;
}

export interface DirectoryUserPage {
  users: OrganizationUser[];
  next: DirectoryUserCursor | null;
}

export interface OrganizationUserCursor {
  displayName: string;
  principalId: string;
}

export interface OrganizationUserListQuery {
  query: string;
  statuses: readonly OrganizationUserStatus[];
  unitId?: string;
  includeDescendants?: boolean;
  groupId?: string;
  missingPrimaryUnit?: boolean;
  after: OrganizationUserCursor | null;
  limit: number;
}

export interface OrganizationUserPage {
  users: OrganizationUser[];
  unitMembers: OrgUnitMember[];
  groupMembers: AccessGroupMember[];
  next: OrganizationUserCursor | null;
}

export interface OrganizationUserDetail {
  user: OrganizationUser;
  unitMembers: OrgUnitMember[];
  groupMembers: AccessGroupMember[];
  identities: AuthIdentity[];
  auditEvents: AuditEvent[];
}

export type SkillAccessMode = "home" | "organization" | "restricted";

export interface SkillAccessPolicy {
  orgId: string;
  skillId: string;
  ownerScopeId: ScopeId;
  mode: SkillAccessMode;
  revision: number;
  createdAt: number;
  updatedAt: number;
  updatedBy: string;
}

export interface SkillAccessGrant {
  orgId: string;
  ownerScopeId: ScopeId;
  path: string;
  granteeScopeId: ScopeId;
  permission: Permission;
  grantedBy: string;
  grantedAt: number;
}

export interface UnitImpact {
  activeChildUnits: number;
  activeMembers: number;
  directoryRoots: number;
  skillGrants: number;
}

export interface SubtreeImpact {
  activeUnits: number;
  activeMembers: number;
}

export interface OrganizationTx {
  getUser(orgId: string, principalId: string): Promise<OrganizationUser | null>;
  findUserByEmail(orgId: string, email: string): Promise<OrganizationUser | null>;
  findUserByEmployeeNumber(orgId: string, employeeNumber: string): Promise<OrganizationUser | null>;
  listUsers(orgId: string): Promise<OrganizationUser[]>;
  insertUser(user: OrganizationUser): Promise<boolean>;
  putUser(user: OrganizationUser): Promise<void>;
  getIdentity(orgId: string, issuer: string, subject: string): Promise<AuthIdentity | null>;
  listIdentitiesForUser(orgId: string, principalId: string): Promise<AuthIdentity[]>;
  putIdentity(identity: AuthIdentity): Promise<void>;
  getUnit(orgId: string, id: string): Promise<OrgUnit | null>;
  listUnits(orgId: string): Promise<OrgUnit[]>;
  isDescendant(orgId: string, ancestorId: string, descendantId: string): Promise<boolean>;
  listManagedSubtreeUnitIds(orgId: string, principalId: string): Promise<string[]>;
  listManagedGroupIds(orgId: string, principalId: string): Promise<string[]>;
  unitImpact(orgId: string, unitId: string): Promise<UnitImpact>;
  subtreeImpact(orgId: string, unitId: string): Promise<SubtreeImpact>;
  listUnitMembers(orgId: string, unitId: string): Promise<OrgUnitMember[]>;
  listUnitMembersForUser(orgId: string, principalId: string): Promise<OrgUnitMember[]>;
  putUnit(unit: OrgUnit): Promise<void>;
  moveUnitSubtree(orgId: string, unitId: string, newParentId: string): Promise<void>;
  putUnitMember(member: OrgUnitMember): Promise<void>;
  removeUnitMember(orgId: string, unitId: string, principalId: string): Promise<void>;
  getGroup(orgId: string, id: string): Promise<AccessGroup | null>;
  listGroupMembers(orgId: string, groupId: string): Promise<AccessGroupMember[]>;
  listGroupMembersForUser(orgId: string, principalId: string): Promise<AccessGroupMember[]>;
  putGroup(group: AccessGroup): Promise<void>;
  putGroupMember(member: AccessGroupMember): Promise<void>;
  removeGroupMember(orgId: string, groupId: string, principalId: string): Promise<void>;
  getDirectoryPolicy(
    orgId: string,
    subjectKind: DirectorySubjectKind,
    subjectId: string,
  ): Promise<DirectoryViewPolicy | null>;
  putDirectoryPolicy(policy: DirectoryViewPolicy): Promise<void>;
  deleteDirectoryPolicy(orgId: string, subjectKind: DirectorySubjectKind, subjectId: string): Promise<void>;
  listDirectoryRoots(orgId: string, policyId: string): Promise<DirectoryViewRoot[]>;
  replaceDirectoryRoots(orgId: string, policyId: string, roots: readonly DirectoryViewRoot[]): Promise<void>;
  getSkill(orgId: string, skillId: string): Promise<Skill | null>;
  listSkills(orgId: string): Promise<Skill[]>;
  putSkill(skill: Skill): Promise<void>;
  deleteSkill(orgId: string, skillId: string): Promise<void>;
  getSkillAccessPolicy(orgId: string, skillId: string): Promise<SkillAccessPolicy | null>;
  listSkillAccessPolicies(orgId: string): Promise<SkillAccessPolicy[]>;
  putSkillAccessPolicy(policy: SkillAccessPolicy): Promise<void>;
  deleteSkillAccessPolicy(orgId: string, skillId: string): Promise<void>;
  listSkillAccessGrants(orgId: string, skillId: string): Promise<SkillAccessGrant[]>;
  replaceSkillAccessGrants(orgId: string, skillId: string, grants: readonly SkillAccessGrant[]): Promise<void>;
  countSkillAccessGrantsForSubject(orgId: string, granteeScopeId: ScopeId): Promise<number>;
  getSkillAccessPolicyVersion(orgId: string): Promise<number>;
  markSkillAccessEnforced(orgId: string, version: number, at: number): Promise<void>;
  getAuthzRevision(orgId: string): Promise<number>;
  bumpRevision(orgId: string): Promise<number>;
  getOperationResult(idempotencyKey: string): Promise<Record<string, unknown> | null>;
  putOperationResult(idempotencyKey: string, result: Record<string, unknown>): Promise<void>;
  hasAudit(idempotencyKey: string): Promise<boolean>;
  audit(event: AuditEvent): Promise<void>;
}

export interface OrganizationStore {
  legacyRuntimeAccessEligible(principalId: string): Promise<boolean>;
  getUser(orgId: string, principalId: string): Promise<OrganizationUser | null>;
  findUserByEmail(orgId: string, email: string): Promise<OrganizationUser | null>;
  findUserByEmployeeNumber(orgId: string, employeeNumber: string): Promise<OrganizationUser | null>;
  listUsers(orgId: string): Promise<OrganizationUser[]>;
  getUsersByPrincipalIds(orgId: string, principalIds: readonly string[]): Promise<OrganizationUser[]>;
  listOrganizationUsers(orgId: string, query: OrganizationUserListQuery): Promise<OrganizationUserPage>;
  searchUsers(orgId: string, query: string, limit: number): Promise<OrganizationUser[]>;
  putUser(user: OrganizationUser): Promise<void>;
  getIdentity(orgId: string, issuer: string, subject: string): Promise<AuthIdentity | null>;
  listIdentitiesForUser(orgId: string, principalId: string): Promise<AuthIdentity[]>;
  putIdentity(identity: AuthIdentity): Promise<void>;
  getUnit(orgId: string, id: string): Promise<OrgUnit | null>;
  listUnits(orgId: string): Promise<OrgUnit[]>;
  putUnit(unit: OrgUnit): Promise<void>;
  isDescendant(orgId: string, ancestorId: string, descendantId: string): Promise<boolean>;
  listSubtreeUnitIds(orgId: string, unitId: string): Promise<string[]>;
  listAncestorUnitIds(orgId: string, unitId: string): Promise<string[]>;
  listDirectUnitIdsForUser(orgId: string, principalId: string): Promise<string[]>;
  listManagedSubtreeUnitIds(orgId: string, principalId: string): Promise<string[]>;
  listDirectGroupIdsForUser(orgId: string, principalId: string): Promise<string[]>;
  listManagedGroupIds(orgId: string, principalId: string): Promise<string[]>;
  unitImpact(orgId: string, unitId: string): Promise<UnitImpact>;
  subtreeImpact(orgId: string, unitId: string): Promise<SubtreeImpact>;
  listUnitMembers(orgId: string, unitId: string): Promise<OrgUnitMember[]>;
  listUnitMembersForUnits(orgId: string, unitIds: readonly string[]): Promise<OrgUnitMember[]>;
  listUnitMembersForUsers(orgId: string, principalIds: readonly string[]): Promise<OrgUnitMember[]>;
  putUnitMember(member: OrgUnitMember): Promise<void>;
  removeUnitMember(orgId: string, unitId: string, principalId: string): Promise<void>;
  getGroup(orgId: string, id: string): Promise<AccessGroup | null>;
  listGroups(orgId: string): Promise<AccessGroup[]>;
  putGroup(group: AccessGroup): Promise<void>;
  listGroupMembers(orgId: string, groupId: string): Promise<AccessGroupMember[]>;
  listGroupMembersForUsers(orgId: string, principalIds: readonly string[]): Promise<AccessGroupMember[]>;
  putGroupMember(member: AccessGroupMember): Promise<void>;
  removeGroupMember(orgId: string, groupId: string, principalId: string): Promise<void>;
  getDirectoryPolicy(
    orgId: string,
    subjectKind: DirectorySubjectKind,
    subjectId: string,
  ): Promise<DirectoryViewPolicy | null>;
  listDirectoryRoots(orgId: string, policyId: string): Promise<DirectoryViewRoot[]>;
  searchDirectoryUsers(
    orgId: string,
    input: {
      query: string;
      unitIds: readonly string[] | null;
      excludePrincipalIds?: readonly string[];
      after: DirectoryUserCursor | null;
      limit: number;
    },
  ): Promise<DirectoryUserPage>;
  getSkillAccessPolicy(orgId: string, skillId: string): Promise<SkillAccessPolicy | null>;
  listSkillAccessPolicies(orgId: string): Promise<SkillAccessPolicy[]>;
  listSkillAccessGrants(orgId: string, skillId: string): Promise<SkillAccessGrant[]>;
  getSkillAccessPolicyVersion(orgId: string): Promise<number>;
  getAuthzRevision(orgId: string): Promise<number>;
  ensureOrgRoot(input: { orgId: string; name: string; actor: string; now: number }): Promise<void>;
  transact<T>(orgId: string, fn: (tx: OrganizationTx) => Promise<T>): Promise<T>;
}

const userKey = (orgId: string, principalId: string): string => `${orgId}\n${personKey(principalId)}`;
const identityKey = (orgId: string, issuer: string, subject: string): string => `${orgId}\n${issuer}\n${subject}`;
const unitKey = (orgId: string, id: string): string => `${orgId}\n${id}`;
const groupKey = (orgId: string, id: string): string => `${orgId}\n${id}`;
const unitMemberKey = (orgId: string, unitId: string, principalId: string): string =>
  `${orgId}\n${unitId}\n${principalId}`;
const groupMemberKey = (orgId: string, groupId: string, principalId: string): string =>
  `${orgId}\n${groupId}\n${principalId}`;
const directoryPolicyKey = (orgId: string, subjectKind: DirectorySubjectKind, subjectId: string): string =>
  `${orgId}\n${subjectKind}\n${subjectId}`;
const directoryRootKey = (orgId: string, policyId: string, unitId: string): string =>
  `${orgId}\n${policyId}\n${unitId}`;
const skillPolicyKey = (orgId: string, skillId: string): string => `${orgId}\n${skillId}`;
const skillGrantKey = (grant: SkillAccessGrant): string =>
  `${grant.orgId}\n${grant.ownerScopeId}\n${grant.path}\n${grant.granteeScopeId}\n${grant.permission}`;
const operationResultKey = (orgId: string, idempotencyKey: string): string => `${orgId}\n${idempotencyKey}`;

const MAX_TREE_DEPTH = 1000;

export function createMemoryOrganizationStore(
  opts: { auditLog?: AuditLog; skillBacking?: DurableMap<Skill> } = {},
): OrganizationStore {
  const users = new Map<string, OrganizationUser>();
  const identities = new Map<string, AuthIdentity>();
  const units = new Map<string, OrgUnit>();
  const closure = new Map<string, Map<string, Set<string>>>();
  const unitMembers = new Map<string, OrgUnitMember>();
  const groups = new Map<string, AccessGroup>();
  const groupMembers = new Map<string, AccessGroupMember>();
  const directoryPolicies = new Map<string, DirectoryViewPolicy>();
  const directoryRoots = new Map<string, DirectoryViewRoot>();
  const skillBacking = opts.skillBacking;
  const skillPolicies = new Map<string, SkillAccessPolicy>();
  const skillGrants = new Map<string, SkillAccessGrant>();
  const revisions = new Map<string, number>();
  const skillAccessVersions = new Map<string, { version: number; enforcedAt: number | null }>();
  const auditIdempotencyKeys = new Set<string>();
  const operationResults = new Map<string, Record<string, unknown>>();
  const enqueue = createKeyedQueue<string>();

  const snapshotOrgMap = <T extends { orgId: string }>(map: Map<string, T>, orgId: string): Map<string, T> => {
    const snapshot = new Map<string, T>();
    for (const [key, value] of map) {
      if (value.orgId === orgId) snapshot.set(key, { ...value });
    }
    return snapshot;
  };

  const restoreOrgMap = <T extends { orgId: string }>(
    map: Map<string, T>,
    orgId: string,
    snapshot: Map<string, T>,
  ): void => {
    for (const [key, value] of map) {
      if (value.orgId === orgId) map.delete(key);
    }
    for (const [key, value] of snapshot) map.set(key, value);
  };

  const cloneClosure = (value: Map<string, Set<string>> | undefined): Map<string, Set<string>> | undefined =>
    value === undefined ? undefined : new Map([...value].map(([key, ancestors]) => [key, new Set(ancestors)]));

  const closureFor = (orgId: string): Map<string, Set<string>> => {
    let found = closure.get(orgId);
    if (!found) {
      found = new Map();
      closure.set(orgId, found);
    }
    return found;
  };

  const computeAncestors = (orgId: string, unitId: string): Set<string> => {
    const ancestors = new Set<string>([unitId]);
    let current = units.get(unitKey(orgId, unitId));
    let depth = 0;
    while (current !== undefined && current.parentId !== null) {
      depth += 1;
      if (depth > MAX_TREE_DEPTH) throw new Error(`org unit tree cycle detected at ${unitId}`);
      ancestors.add(current.parentId);
      current = units.get(unitKey(orgId, current.parentId));
    }
    return ancestors;
  };

  const rebuildClosure = (orgId: string, unitId: string): void => {
    const pending = [unitId];
    const orgClosure = closureFor(orgId);
    while (pending.length > 0) {
      const id = pending.pop() as string;
      orgClosure.set(id, computeAncestors(orgId, id));
      for (const u of units.values()) {
        if (u.orgId === orgId && u.parentId === id) pending.push(u.id);
      }
    }
  };

  const putUnitRaw = async (unit: OrgUnit): Promise<void> => {
    if (unit.parentId === null && unit.status !== "active") throw new Error("org root must remain active");
    if (unit.parentId === null) {
      for (const existing of units.values()) {
        if (
          existing.orgId === unit.orgId &&
          existing.id !== unit.id &&
          existing.parentId === null &&
          existing.status === "active"
        ) {
          throw new Error("organization already has an active root");
        }
      }
    }
    units.set(unitKey(unit.orgId, unit.id), { ...unit });
    rebuildClosure(unit.orgId, unit.id);
  };

  const putUnitMemberRaw = async (member: OrgUnitMember): Promise<void> => {
    if (member.isPrimary) {
      for (const existing of unitMembers.values()) {
        if (
          existing.orgId === member.orgId &&
          existing.principalId === member.principalId &&
          existing.unitId !== member.unitId &&
          existing.isPrimary
        ) {
          throw new Error(`organization user already has a primary unit: ${member.principalId}`);
        }
      }
    }
    unitMembers.set(unitMemberKey(member.orgId, member.unitId, member.principalId), {
      ...member,
      isPrimary: member.isPrimary === true,
    });
  };

  const removeUnitMemberRaw = async (orgId: string, unitId: string, principalId: string): Promise<void> => {
    unitMembers.delete(unitMemberKey(orgId, unitId, principalId));
  };

  const putGroupRaw = async (group: AccessGroup): Promise<void> => {
    groups.set(groupKey(group.orgId, group.id), { ...group });
  };

  const putGroupMemberRaw = async (member: AccessGroupMember): Promise<void> => {
    groupMembers.set(groupMemberKey(member.orgId, member.groupId, member.principalId), { ...member });
  };

  const removeGroupMemberRaw = async (orgId: string, groupId: string, principalId: string): Promise<void> => {
    groupMembers.delete(groupMemberKey(orgId, groupId, principalId));
  };

  const store: OrganizationStore = {
    async legacyRuntimeAccessEligible() {
      return false;
    },
    async getUser(orgId, principalId) {
      const found = users.get(userKey(orgId, principalId));
      return found ? { ...found } : null;
    },
    async findUserByEmail(orgId, email) {
      const needle = email.toLowerCase();
      for (const u of users.values()) {
        if (u.orgId === orgId && u.email !== null && u.email.toLowerCase() === needle) {
          return { ...u };
        }
      }
      return null;
    },
    async findUserByEmployeeNumber(orgId, employeeNumber) {
      const needle = employeeNumber.toLowerCase();
      for (const user of users.values()) {
        if (user.orgId === orgId && user.employeeNumber?.toLowerCase() === needle) return { ...user };
      }
      return null;
    },
    async listUsers(orgId) {
      const out: OrganizationUser[] = [];
      for (const u of users.values()) {
        if (u.orgId === orgId) out.push({ ...u });
      }
      return out;
    },
    async getUsersByPrincipalIds(orgId, principalIds) {
      return principalIds
        .map((principalId) => users.get(userKey(orgId, principalId)))
        .filter((user): user is OrganizationUser => user !== undefined)
        .map((user) => ({ ...user }));
    },
    async listOrganizationUsers(orgId, input) {
      const statuses = new Set(input.statuses);
      const needle = input.query.trim().toLowerCase();
      let allowedUnits: Set<string> | null = null;
      if (input.unitId !== undefined) {
        allowedUnits = input.includeDescendants
          ? new Set(
              [...(closure.get(orgId) ?? [])]
                .filter(([, ancestors]) => ancestors.has(input.unitId as string))
                .map(([id]) => id),
            )
          : new Set([input.unitId]);
      }
      const filtered = [...users.values()].filter((user) => {
        if (user.orgId !== orgId || !statuses.has(user.status)) return false;
        if (
          needle &&
          ![
            user.principalId,
            user.displayName,
            user.email ?? "",
            user.jobTitle ?? "",
            user.mobile ?? "",
            user.employeeNumber ?? "",
          ].some((value) => value.toLowerCase().includes(needle))
        ) {
          return false;
        }
        const directUnits = [...unitMembers.values()].filter(
          (member) => member.orgId === orgId && member.principalId === user.principalId,
        );
        if (allowedUnits && !directUnits.some((member) => allowedUnits.has(member.unitId))) return false;
        if (input.missingPrimaryUnit === true && directUnits.some((member) => member.isPrimary)) return false;
        if (
          input.groupId !== undefined &&
          ![...groupMembers.values()].some(
            (member) =>
              member.orgId === orgId && member.principalId === user.principalId && member.groupId === input.groupId,
          )
        ) {
          return false;
        }
        if (input.after) {
          const byName = user.displayName.localeCompare(input.after.displayName, undefined, { sensitivity: "base" });
          if (byName < 0 || (byName === 0 && user.principalId <= input.after.principalId)) return false;
        }
        return true;
      });
      filtered.sort(
        (left, right) =>
          left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" }) ||
          left.principalId.localeCompare(right.principalId),
      );
      const window = filtered.slice(0, input.limit + 1);
      const pageUsers = window.slice(0, input.limit).map((user) => ({ ...user }));
      const principalIds = new Set(pageUsers.map((user) => user.principalId));
      const nextUser = window.length > input.limit ? pageUsers.at(-1) : undefined;
      return {
        users: pageUsers,
        unitMembers: [...unitMembers.values()]
          .filter((member) => member.orgId === orgId && principalIds.has(member.principalId))
          .map((member) => ({ ...member })),
        groupMembers: [...groupMembers.values()]
          .filter((member) => member.orgId === orgId && principalIds.has(member.principalId))
          .map((member) => ({ ...member })),
        next: nextUser ? { displayName: nextUser.displayName, principalId: nextUser.principalId } : null,
      };
    },
    async searchUsers(orgId, query, limit) {
      const needle = query.toLowerCase();
      const matches: OrganizationUser[] = [];
      for (const user of users.values()) {
        if (user.orgId !== orgId || user.status !== "active") continue;
        if (
          !user.principalId.toLowerCase().includes(needle) &&
          !user.displayName.toLowerCase().includes(needle) &&
          !user.email?.toLowerCase().includes(needle)
        ) {
          continue;
        }
        matches.push({ ...user });
      }
      return matches
        .sort(
          (left, right) =>
            left.displayName.localeCompare(right.displayName) || left.principalId.localeCompare(right.principalId),
        )
        .slice(0, limit);
    },
    async putUser(user) {
      await enqueue(user.orgId, async () => {
        users.set(userKey(user.orgId, user.principalId), { ...user });
      });
    },
    async getIdentity(orgId, issuer, subject) {
      const found = identities.get(identityKey(orgId, issuer, subject));
      return found ? { ...found } : null;
    },
    async listIdentitiesForUser(orgId, principalId) {
      return [...identities.values()]
        .filter((identity) => identity.orgId === orgId && identity.principalId === principalId)
        .map((identity) => ({ ...identity }))
        .sort((left, right) => left.issuer.localeCompare(right.issuer) || left.subject.localeCompare(right.subject));
    },
    async putIdentity(identity) {
      await enqueue(identity.orgId, async () => {
        identities.set(identityKey(identity.orgId, identity.issuer, identity.subject), { ...identity });
      });
    },
    async getUnit(orgId, id) {
      const found = units.get(unitKey(orgId, id));
      return found ? { ...found } : null;
    },
    async listUnits(orgId) {
      const out: OrgUnit[] = [];
      for (const u of units.values()) {
        if (u.orgId === orgId) out.push({ ...u });
      }
      return out;
    },
    async putUnit(unit) {
      await enqueue(unit.orgId, () => putUnitRaw(unit));
    },
    async isDescendant(orgId, ancestorId, descendantId) {
      return closure.get(orgId)?.get(descendantId)?.has(ancestorId) ?? false;
    },
    async listSubtreeUnitIds(orgId, unitId) {
      const out: string[] = [];
      for (const [id, ancestors] of closure.get(orgId) ?? []) {
        if (ancestors.has(unitId)) out.push(id);
      }
      return out;
    },
    async listAncestorUnitIds(orgId, unitId) {
      return [...(closure.get(orgId)?.get(unitId) ?? [])]
        .filter((id) => units.get(unitKey(orgId, id))?.status === "active")
        .sort();
    },
    async listDirectUnitIdsForUser(orgId, principalId) {
      return [...unitMembers.values()]
        .filter(
          (member) =>
            member.orgId === orgId &&
            member.principalId === principalId &&
            units.get(unitKey(orgId, member.unitId))?.status === "active",
        )
        .map((member) => member.unitId)
        .sort();
    },
    async listManagedSubtreeUnitIds(orgId, principalId) {
      const out = new Set<string>();
      for (const m of unitMembers.values()) {
        if (m.orgId !== orgId || m.principalId !== principalId || m.role !== "manager") continue;
        if (units.get(unitKey(orgId, m.unitId))?.status !== "active") continue;
        out.add(m.unitId);
        for (const [id, ancestors] of closure.get(orgId) ?? []) {
          if (ancestors.has(m.unitId) && units.get(unitKey(orgId, id))?.status === "active") out.add(id);
        }
      }
      return [...out];
    },
    async listManagedGroupIds(orgId, principalId) {
      const out: string[] = [];
      for (const member of groupMembers.values()) {
        if (
          member.orgId === orgId &&
          member.principalId === principalId &&
          member.role === "manager" &&
          groups.get(groupKey(orgId, member.groupId))?.status === "active"
        ) {
          out.push(member.groupId);
        }
      }
      return out.sort();
    },
    async listDirectGroupIdsForUser(orgId, principalId) {
      return [...groupMembers.values()]
        .filter(
          (member) =>
            member.orgId === orgId &&
            member.principalId === principalId &&
            groups.get(groupKey(orgId, member.groupId))?.status === "active",
        )
        .map((member) => member.groupId)
        .sort();
    },
    async unitImpact(orgId, unitId) {
      let activeChildUnits = 0;
      for (const u of units.values()) {
        if (u.orgId === orgId && u.parentId === unitId && u.status === "active") activeChildUnits += 1;
      }
      let activeMembers = 0;
      for (const m of unitMembers.values()) {
        if (m.orgId !== orgId || m.unitId !== unitId) continue;
        const u = users.get(userKey(orgId, m.principalId));
        if (u !== undefined && u.status !== "deprovisioned") activeMembers += 1;
      }
      let rootReferences = 0;
      for (const root of directoryRoots.values()) {
        if (root.orgId === orgId && root.unitId === unitId) rootReferences += 1;
      }
      for (const policy of directoryPolicies.values()) {
        if (policy.orgId === orgId && policy.subjectKind === "org_unit" && policy.subjectId === unitId)
          rootReferences += 1;
      }
      const skillGrantReferences = [...skillGrants.values()].filter(
        (grant) =>
          grant.orgId === orgId && grant.path.startsWith("skill:") && grant.granteeScopeId === `org-unit:${unitId}`,
      ).length;
      return {
        activeChildUnits,
        activeMembers,
        directoryRoots: rootReferences,
        skillGrants: skillGrantReferences,
      };
    },
    async subtreeImpact(orgId, unitId) {
      const subtree = new Set<string>();
      for (const [id, ancestors] of closure.get(orgId) ?? []) {
        if (ancestors.has(unitId)) subtree.add(id);
      }
      const principals = new Set<string>();
      for (const member of unitMembers.values()) {
        if (member.orgId !== orgId || !subtree.has(member.unitId)) continue;
        if (users.get(userKey(orgId, member.principalId))?.status === "active") principals.add(member.principalId);
      }
      return {
        activeUnits: [...subtree].filter((id) => units.get(unitKey(orgId, id))?.status === "active").length,
        activeMembers: principals.size,
      };
    },
    async listUnitMembers(orgId, unitId) {
      const out: OrgUnitMember[] = [];
      for (const m of unitMembers.values()) {
        if (m.orgId === orgId && m.unitId === unitId) out.push({ ...m });
      }
      return out;
    },
    async listUnitMembersForUnits(orgId, unitIds) {
      const selected = new Set(unitIds);
      return [...unitMembers.values()]
        .filter((member) => member.orgId === orgId && selected.has(member.unitId))
        .map((member) => ({ ...member }))
        .sort(
          (left, right) => left.unitId.localeCompare(right.unitId) || left.principalId.localeCompare(right.principalId),
        );
    },
    async listUnitMembersForUsers(orgId, principalIds) {
      const selected = new Set(principalIds);
      return [...unitMembers.values()]
        .filter((member) => member.orgId === orgId && selected.has(member.principalId))
        .map((member) => ({ ...member }))
        .sort(
          (left, right) => left.principalId.localeCompare(right.principalId) || left.unitId.localeCompare(right.unitId),
        );
    },
    async putUnitMember(member) {
      await enqueue(member.orgId, () => putUnitMemberRaw(member));
    },
    async removeUnitMember(orgId, unitId, principalId) {
      await enqueue(orgId, () => removeUnitMemberRaw(orgId, unitId, principalId));
    },
    async getGroup(orgId, id) {
      const found = groups.get(groupKey(orgId, id));
      return found ? { ...found } : null;
    },
    async listGroups(orgId) {
      const out: AccessGroup[] = [];
      for (const g of groups.values()) {
        if (g.orgId === orgId) out.push({ ...g });
      }
      return out;
    },
    async putGroup(group) {
      await enqueue(group.orgId, () => putGroupRaw(group));
    },
    async listGroupMembers(orgId, groupId) {
      const out: AccessGroupMember[] = [];
      for (const m of groupMembers.values()) {
        if (m.orgId === orgId && m.groupId === groupId) out.push({ ...m });
      }
      return out;
    },
    async listGroupMembersForUsers(orgId, principalIds) {
      const selected = new Set(principalIds);
      return [...groupMembers.values()]
        .filter((member) => member.orgId === orgId && selected.has(member.principalId))
        .map((member) => ({ ...member }))
        .sort(
          (left, right) =>
            left.principalId.localeCompare(right.principalId) || left.groupId.localeCompare(right.groupId),
        );
    },
    async putGroupMember(member) {
      await enqueue(member.orgId, () => putGroupMemberRaw(member));
    },
    async removeGroupMember(orgId, groupId, principalId) {
      await enqueue(orgId, () => removeGroupMemberRaw(orgId, groupId, principalId));
    },
    async getDirectoryPolicy(orgId, subjectKind, subjectId) {
      const found = directoryPolicies.get(directoryPolicyKey(orgId, subjectKind, subjectId));
      return found ? { ...found } : null;
    },
    async listDirectoryRoots(orgId, policyId) {
      return [...directoryRoots.values()]
        .filter((root) => root.orgId === orgId && root.policyId === policyId)
        .map((root) => ({ ...root }))
        .sort((left, right) => left.unitId.localeCompare(right.unitId));
    },
    async searchDirectoryUsers(orgId, input) {
      const needle = input.query.toLowerCase();
      const allowedUnits = input.unitIds === null ? null : new Set(input.unitIds);
      const excludedPrincipals = new Set(input.excludePrincipalIds ?? []);
      if (allowedUnits?.size === 0) return { users: [], next: null };
      const allowedPrincipals =
        allowedUnits === null
          ? null
          : new Set(
              [...unitMembers.values()]
                .filter((member) => member.orgId === orgId && allowedUnits.has(member.unitId))
                .map((member) => member.principalId),
            );
      const matches = [...users.values()]
        .filter(
          (user) =>
            user.orgId === orgId &&
            user.status === "active" &&
            !excludedPrincipals.has(user.principalId) &&
            (allowedPrincipals === null || allowedPrincipals.has(user.principalId)) &&
            (needle.length === 0 ||
              user.principalId.toLowerCase().includes(needle) ||
              user.displayName.toLowerCase().includes(needle) ||
              user.email?.toLowerCase().includes(needle)),
        )
        .sort(
          (left, right) =>
            left.displayName.localeCompare(right.displayName) || left.principalId.localeCompare(right.principalId),
        )
        .filter(
          (user) =>
            input.after === null ||
            user.displayName.localeCompare(input.after.displayName) > 0 ||
            (user.displayName === input.after.displayName && user.principalId > input.after.principalId),
        );
      const usersPage = matches.slice(0, input.limit);
      const last = usersPage.at(-1);
      return {
        users: usersPage.map((user) => ({ ...user })),
        next:
          matches.length > input.limit && last
            ? { displayName: last.displayName, principalId: last.principalId }
            : null,
      };
    },
    async getSkillAccessPolicy(orgId, skillId) {
      const found = skillPolicies.get(skillPolicyKey(orgId, skillId));
      return found ? { ...found } : null;
    },
    async listSkillAccessPolicies(orgId) {
      return [...skillPolicies.values()]
        .filter((policy) => policy.orgId === orgId)
        .map((policy) => ({ ...policy }))
        .sort((left, right) => left.skillId.localeCompare(right.skillId));
    },
    async listSkillAccessGrants(orgId, skillId) {
      const path = `skill:${skillId}`;
      return [...skillGrants.values()]
        .filter((grant) => grant.orgId === orgId && grant.path === path)
        .map((grant) => ({ ...grant }))
        .sort((left, right) => left.granteeScopeId.localeCompare(right.granteeScopeId));
    },
    async getSkillAccessPolicyVersion(orgId) {
      return skillAccessVersions.get(orgId)?.version ?? 0;
    },
    async getAuthzRevision(orgId) {
      return revisions.get(orgId) ?? 0;
    },
    async ensureOrgRoot({ orgId, name, actor, now }) {
      await enqueue(orgId, async () => {
        for (const u of units.values()) {
          if (u.orgId === orgId && u.parentId === null && u.status === "active") return;
        }
        await putUnitRaw({
          orgId,
          id: "root",
          parentId: null,
          name,
          kind: "organization",
          status: "active",
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
          createdBy: actor,
          updatedBy: actor,
        });
        if (!revisions.has(orgId)) revisions.set(orgId, 1);
      });
    },
    async transact(orgId, fn) {
      return enqueue(orgId, async () => {
        const draftUsers = snapshotOrgMap(users, orgId);
        const draftIdentities = snapshotOrgMap(identities, orgId);
        const draftUnits = snapshotOrgMap(units, orgId);
        const draftUnitMembers = snapshotOrgMap(unitMembers, orgId);
        const draftGroups = snapshotOrgMap(groups, orgId);
        const draftGroupMembers = snapshotOrgMap(groupMembers, orgId);
        const draftDirectoryPolicies = snapshotOrgMap(directoryPolicies, orgId);
        const draftDirectoryRoots = snapshotOrgMap(directoryRoots, orgId);
        const draftSkillPolicies = snapshotOrgMap(skillPolicies, orgId);
        const draftSkillGrants = snapshotOrgMap(skillGrants, orgId);
        const draftOperationResults = new Map(
          [...operationResults]
            .filter(([key]) => key.startsWith(`${orgId}\n`))
            .map(([key, value]) => [key, structuredClone(value)]),
        );
        const draftSkills = new Map<string, Skill>(
          (await skillBacking?.entries())
            ?.filter(([, skill]) => skill.orgId === orgId)
            .map(([id, skill]) => [id, structuredClone(skill)]) ?? [],
        );
        const draftClosure = cloneClosure(closure.get(orgId)) ?? new Map<string, Set<string>>();
        let draftRevision = revisions.get(orgId);
        let draftSkillAccessVersion = skillAccessVersions.get(orgId);
        const audits: AuditEvent[] = [];
        const assertOrg = (scopeOrgId: string): void => {
          if (scopeOrgId !== orgId) throw new Error(`organization transaction scope mismatch: ${scopeOrgId}`);
        };
        const draftAncestors = (unitId: string): Set<string> => {
          const ancestors = new Set<string>([unitId]);
          let current = draftUnits.get(unitKey(orgId, unitId));
          let depth = 0;
          while (current !== undefined && current.parentId !== null) {
            depth += 1;
            if (depth > MAX_TREE_DEPTH) throw new Error(`org unit tree cycle detected at ${unitId}`);
            ancestors.add(current.parentId);
            current = draftUnits.get(unitKey(orgId, current.parentId));
          }
          return ancestors;
        };
        const rebuildDraftClosure = (unitId: string): void => {
          const pending = [unitId];
          while (pending.length > 0) {
            const id = pending.pop() as string;
            draftClosure.set(id, draftAncestors(id));
            for (const unit of draftUnits.values()) {
              if (unit.parentId === id) pending.push(unit.id);
            }
          }
        };
        const putDraftUnit = (unit: OrgUnit): void => {
          if (unit.parentId === null && unit.status !== "active") throw new Error("org root must remain active");
          if (
            unit.parentId === null &&
            [...draftUnits.values()].some(
              (existing) => existing.id !== unit.id && existing.parentId === null && existing.status === "active",
            )
          ) {
            throw new Error("organization already has an active root");
          }
          draftUnits.set(unitKey(orgId, unit.id), { ...unit });
          rebuildDraftClosure(unit.id);
        };
        const tx: OrganizationTx = {
          async getUser(scopeOrgId, principalId) {
            assertOrg(scopeOrgId);
            const found = draftUsers.get(userKey(orgId, principalId));
            return found ? { ...found } : null;
          },
          async findUserByEmail(scopeOrgId, email) {
            assertOrg(scopeOrgId);
            const needle = email.toLowerCase();
            for (const user of draftUsers.values()) {
              if (user.email !== null && user.email.toLowerCase() === needle) return { ...user };
            }
            return null;
          },
          async findUserByEmployeeNumber(scopeOrgId, employeeNumber) {
            assertOrg(scopeOrgId);
            const needle = employeeNumber.toLowerCase();
            for (const user of draftUsers.values()) {
              if (user.employeeNumber?.toLowerCase() === needle) return { ...user };
            }
            return null;
          },
          async listUsers(scopeOrgId) {
            assertOrg(scopeOrgId);
            return [...draftUsers.values()].map((user) => ({ ...user }));
          },
          putUser: async (user) => {
            assertOrg(user.orgId);
            draftUsers.set(userKey(orgId, user.principalId), { ...user });
          },
          insertUser: async (user) => {
            assertOrg(user.orgId);
            const key = userKey(orgId, user.principalId);
            if (draftUsers.has(key)) return false;
            draftUsers.set(key, { ...user });
            return true;
          },
          async getIdentity(scopeOrgId, issuer, subject) {
            assertOrg(scopeOrgId);
            const found = draftIdentities.get(identityKey(orgId, issuer, subject));
            return found ? { ...found } : null;
          },
          async listIdentitiesForUser(scopeOrgId, principalId) {
            assertOrg(scopeOrgId);
            return [...draftIdentities.values()]
              .filter((identity) => identity.principalId === principalId)
              .map((identity) => ({ ...identity }))
              .sort(
                (left, right) => left.issuer.localeCompare(right.issuer) || left.subject.localeCompare(right.subject),
              );
          },
          putIdentity: async (identity) => {
            assertOrg(identity.orgId);
            draftIdentities.set(identityKey(orgId, identity.issuer, identity.subject), { ...identity });
          },
          async getUnit(scopeOrgId, id) {
            assertOrg(scopeOrgId);
            const found = draftUnits.get(unitKey(orgId, id));
            return found ? { ...found } : null;
          },
          async listUnits(scopeOrgId) {
            assertOrg(scopeOrgId);
            return [...draftUnits.values()].map((unit) => ({ ...unit }));
          },
          async isDescendant(scopeOrgId, ancestorId, descendantId) {
            assertOrg(scopeOrgId);
            return draftClosure.get(descendantId)?.has(ancestorId) ?? false;
          },
          async listManagedSubtreeUnitIds(scopeOrgId, principalId) {
            assertOrg(scopeOrgId);
            const out = new Set<string>();
            for (const member of draftUnitMembers.values()) {
              if (member.principalId !== principalId || member.role !== "manager") continue;
              if (draftUnits.get(unitKey(orgId, member.unitId))?.status !== "active") continue;
              out.add(member.unitId);
              for (const [id, ancestors] of draftClosure) {
                if (ancestors.has(member.unitId) && draftUnits.get(unitKey(orgId, id))?.status === "active")
                  out.add(id);
              }
            }
            return [...out];
          },
          async listManagedGroupIds(scopeOrgId, principalId) {
            assertOrg(scopeOrgId);
            return [...draftGroupMembers.values()]
              .filter(
                (member) =>
                  member.principalId === principalId &&
                  member.role === "manager" &&
                  draftGroups.get(groupKey(orgId, member.groupId))?.status === "active",
              )
              .map((member) => member.groupId)
              .sort();
          },
          async unitImpact(scopeOrgId, unitId) {
            assertOrg(scopeOrgId);
            let activeChildUnits = 0;
            for (const unit of draftUnits.values()) {
              if (unit.parentId === unitId && unit.status === "active") activeChildUnits += 1;
            }
            let activeMembers = 0;
            for (const member of draftUnitMembers.values()) {
              if (member.unitId !== unitId) continue;
              const user = draftUsers.get(userKey(orgId, member.principalId));
              if (user !== undefined && user.status !== "deprovisioned") activeMembers += 1;
            }
            const rootReferences =
              [...draftDirectoryRoots.values()].filter((root) => root.unitId === unitId).length +
              [...draftDirectoryPolicies.values()].filter(
                (policy) => policy.subjectKind === "org_unit" && policy.subjectId === unitId,
              ).length;
            const skillGrantReferences = [...draftSkillGrants.values()].filter(
              (grant) => grant.path.startsWith("skill:") && grant.granteeScopeId === `org-unit:${unitId}`,
            ).length;
            return {
              activeChildUnits,
              activeMembers,
              directoryRoots: rootReferences,
              skillGrants: skillGrantReferences,
            };
          },
          async subtreeImpact(scopeOrgId, unitId) {
            assertOrg(scopeOrgId);
            const subtree = new Set<string>();
            for (const [id, ancestors] of draftClosure) {
              if (ancestors.has(unitId)) subtree.add(id);
            }
            const principals = new Set<string>();
            for (const member of draftUnitMembers.values()) {
              if (!subtree.has(member.unitId)) continue;
              if (draftUsers.get(userKey(orgId, member.principalId))?.status === "active") {
                principals.add(member.principalId);
              }
            }
            return {
              activeUnits: [...subtree].filter((id) => draftUnits.get(unitKey(orgId, id))?.status === "active").length,
              activeMembers: principals.size,
            };
          },
          async listUnitMembers(scopeOrgId, unitId) {
            assertOrg(scopeOrgId);
            return [...draftUnitMembers.values()]
              .filter((member) => member.unitId === unitId)
              .map((member) => ({ ...member }));
          },
          async listUnitMembersForUser(scopeOrgId, principalId) {
            assertOrg(scopeOrgId);
            return [...draftUnitMembers.values()]
              .filter((member) => member.principalId === principalId)
              .map((member) => ({ ...member }));
          },
          putUnit: async (unit) => {
            assertOrg(unit.orgId);
            putDraftUnit(unit);
          },
          moveUnitSubtree: async (scopeOrgId, unitId, newParentId) => {
            assertOrg(scopeOrgId);
            const key = unitKey(orgId, unitId);
            const found = draftUnits.get(key);
            if (!found) throw new Error(`org unit not found: ${unitId}`);
            draftUnits.set(key, { ...found, parentId: newParentId });
            rebuildDraftClosure(unitId);
          },
          putUnitMember: async (member) => {
            assertOrg(member.orgId);
            if (member.isPrimary) {
              const conflict = [...draftUnitMembers.values()].find(
                (existing) =>
                  existing.principalId === member.principalId &&
                  existing.unitId !== member.unitId &&
                  existing.isPrimary,
              );
              if (conflict) throw new Error(`organization user already has a primary unit: ${member.principalId}`);
            }
            draftUnitMembers.set(unitMemberKey(orgId, member.unitId, member.principalId), { ...member });
          },
          removeUnitMember: async (scopeOrgId, unitId, principalId) => {
            assertOrg(scopeOrgId);
            draftUnitMembers.delete(unitMemberKey(orgId, unitId, principalId));
          },
          async getGroup(scopeOrgId, id) {
            assertOrg(scopeOrgId);
            const found = draftGroups.get(groupKey(orgId, id));
            return found ? { ...found } : null;
          },
          async listGroupMembers(scopeOrgId, groupId) {
            assertOrg(scopeOrgId);
            return [...draftGroupMembers.values()]
              .filter((member) => member.groupId === groupId)
              .map((member) => ({ ...member }));
          },
          async listGroupMembersForUser(scopeOrgId, principalId) {
            assertOrg(scopeOrgId);
            return [...draftGroupMembers.values()]
              .filter((member) => member.principalId === principalId)
              .map((member) => ({ ...member }));
          },
          putGroup: async (group) => {
            assertOrg(group.orgId);
            draftGroups.set(groupKey(orgId, group.id), { ...group });
          },
          putGroupMember: async (member) => {
            assertOrg(member.orgId);
            draftGroupMembers.set(groupMemberKey(orgId, member.groupId, member.principalId), { ...member });
          },
          removeGroupMember: async (scopeOrgId, groupId, principalId) => {
            assertOrg(scopeOrgId);
            draftGroupMembers.delete(groupMemberKey(orgId, groupId, principalId));
          },
          async getDirectoryPolicy(scopeOrgId, subjectKind, subjectId) {
            assertOrg(scopeOrgId);
            const found = draftDirectoryPolicies.get(directoryPolicyKey(orgId, subjectKind, subjectId));
            return found ? { ...found } : null;
          },
          putDirectoryPolicy: async (policy) => {
            assertOrg(policy.orgId);
            draftDirectoryPolicies.set(directoryPolicyKey(orgId, policy.subjectKind, policy.subjectId), {
              ...policy,
            });
          },
          deleteDirectoryPolicy: async (scopeOrgId, subjectKind, subjectId) => {
            assertOrg(scopeOrgId);
            const key = directoryPolicyKey(orgId, subjectKind, subjectId);
            const policy = draftDirectoryPolicies.get(key);
            if (!policy) return;
            draftDirectoryPolicies.delete(key);
            for (const [rootKey, root] of draftDirectoryRoots) {
              if (root.policyId === policy.id) draftDirectoryRoots.delete(rootKey);
            }
          },
          async listDirectoryRoots(scopeOrgId, policyId) {
            assertOrg(scopeOrgId);
            return [...draftDirectoryRoots.values()]
              .filter((root) => root.policyId === policyId)
              .map((root) => ({ ...root }))
              .sort((left, right) => left.unitId.localeCompare(right.unitId));
          },
          replaceDirectoryRoots: async (scopeOrgId, policyId, roots) => {
            assertOrg(scopeOrgId);
            for (const [rootKey, root] of draftDirectoryRoots) {
              if (root.policyId === policyId) draftDirectoryRoots.delete(rootKey);
            }
            for (const root of roots) {
              assertOrg(root.orgId);
              draftDirectoryRoots.set(directoryRootKey(orgId, policyId, root.unitId), { ...root });
            }
          },
          async getSkill(scopeOrgId, skillId) {
            assertOrg(scopeOrgId);
            const found = draftSkills.get(skillId);
            return found ? structuredClone(found) : null;
          },
          async listSkills(scopeOrgId) {
            assertOrg(scopeOrgId);
            return [...draftSkills.values()].map((skill) => structuredClone(skill));
          },
          putSkill: async (skill) => {
            assertOrg(skill.orgId);
            if (!skillBacking) throw new Error("memory organization store: skillBacking not configured");
            draftSkills.set(skill.id, structuredClone(skill));
          },
          deleteSkill: async (scopeOrgId, skillId) => {
            assertOrg(scopeOrgId);
            if (!skillBacking) throw new Error("memory organization store: skillBacking not configured");
            draftSkills.delete(skillId);
          },
          async getSkillAccessPolicy(scopeOrgId, skillId) {
            assertOrg(scopeOrgId);
            const found = draftSkillPolicies.get(skillPolicyKey(orgId, skillId));
            return found ? { ...found } : null;
          },
          async listSkillAccessPolicies(scopeOrgId) {
            assertOrg(scopeOrgId);
            return [...draftSkillPolicies.values()].map((policy) => ({ ...policy }));
          },
          putSkillAccessPolicy: async (policy) => {
            assertOrg(policy.orgId);
            draftSkillPolicies.set(skillPolicyKey(orgId, policy.skillId), { ...policy });
          },
          deleteSkillAccessPolicy: async (scopeOrgId, skillId) => {
            assertOrg(scopeOrgId);
            draftSkillPolicies.delete(skillPolicyKey(orgId, skillId));
          },
          async listSkillAccessGrants(scopeOrgId, skillId) {
            assertOrg(scopeOrgId);
            const path = `skill:${skillId}`;
            return [...draftSkillGrants.values()].filter((grant) => grant.path === path).map((grant) => ({ ...grant }));
          },
          replaceSkillAccessGrants: async (scopeOrgId, skillId, grants) => {
            assertOrg(scopeOrgId);
            const path = `skill:${skillId}`;
            for (const [key, grant] of draftSkillGrants) {
              if (grant.path === path) draftSkillGrants.delete(key);
            }
            for (const grant of grants) {
              assertOrg(grant.orgId);
              if (grant.path !== path) throw new Error("skill access grant path mismatch");
              draftSkillGrants.set(skillGrantKey(grant), { ...grant });
            }
          },
          countSkillAccessGrantsForSubject: async (scopeOrgId, granteeScopeId) => {
            assertOrg(scopeOrgId);
            return [...draftSkillGrants.values()].filter(
              (grant) => grant.path.startsWith("skill:") && grant.granteeScopeId === granteeScopeId,
            ).length;
          },
          getSkillAccessPolicyVersion: async (scopeOrgId) => {
            assertOrg(scopeOrgId);
            return draftSkillAccessVersion?.version ?? 0;
          },
          markSkillAccessEnforced: async (scopeOrgId, version, at) => {
            assertOrg(scopeOrgId);
            draftSkillAccessVersion = { version, enforcedAt: at };
          },
          getAuthzRevision: async (scopeOrgId) => {
            assertOrg(scopeOrgId);
            return draftRevision ?? 0;
          },
          bumpRevision: async (scopeOrgId) => {
            assertOrg(scopeOrgId);
            draftRevision = (draftRevision ?? 1) + 1;
            return draftRevision;
          },
          getOperationResult: async (idempotencyKey) => {
            const result = draftOperationResults.get(operationResultKey(orgId, idempotencyKey));
            return result ? structuredClone(result) : null;
          },
          putOperationResult: async (idempotencyKey, value) => {
            draftOperationResults.set(operationResultKey(orgId, idempotencyKey), structuredClone(value));
          },
          hasAudit: async (idempotencyKey) =>
            auditIdempotencyKeys.has(idempotencyKey) || audits.some((event) => event.idempotencyKey === idempotencyKey),
          audit: async (event) => {
            if (event.orgId !== undefined) assertOrg(event.orgId);
            audits.push(event);
          },
        };
        const result = await fn(tx);
        restoreOrgMap(users, orgId, draftUsers);
        restoreOrgMap(identities, orgId, draftIdentities);
        restoreOrgMap(units, orgId, draftUnits);
        restoreOrgMap(unitMembers, orgId, draftUnitMembers);
        restoreOrgMap(groups, orgId, draftGroups);
        restoreOrgMap(groupMembers, orgId, draftGroupMembers);
        restoreOrgMap(directoryPolicies, orgId, draftDirectoryPolicies);
        restoreOrgMap(directoryRoots, orgId, draftDirectoryRoots);
        restoreOrgMap(skillPolicies, orgId, draftSkillPolicies);
        restoreOrgMap(skillGrants, orgId, draftSkillGrants);
        for (const key of operationResults.keys()) if (key.startsWith(`${orgId}\n`)) operationResults.delete(key);
        for (const [key, value] of draftOperationResults) operationResults.set(key, value);
        if (skillBacking) {
          for (const [id, skill] of await skillBacking.entries()) {
            if (skill.orgId === orgId && !draftSkills.has(id)) await skillBacking.delete(id);
          }
          for (const [id, skill] of draftSkills) await skillBacking.put(id, skill);
        }
        closure.set(orgId, draftClosure);
        if (draftRevision === undefined) revisions.delete(orgId);
        else revisions.set(orgId, draftRevision);
        if (draftSkillAccessVersion === undefined) skillAccessVersions.delete(orgId);
        else skillAccessVersions.set(orgId, draftSkillAccessVersion);
        for (const event of audits) {
          opts.auditLog?.record(event);
          if (event.idempotencyKey) auditIdempotencyKeys.add(event.idempotencyKey);
        }
        return result;
      });
    },
  };

  return store;
}
