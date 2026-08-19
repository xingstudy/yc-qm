import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";

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
  status: OrganizationUserStatus;
  sessionVersion: number;
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

export interface UnitImpact {
  activeChildUnits: number;
  activeMembers: number;
  directoryRoots: number;
  skillGrants: number;
}

export interface OrganizationTx {
  putUser(user: OrganizationUser): Promise<void>;
  putUnit(unit: OrgUnit): Promise<void>;
  moveUnitSubtree(orgId: string, unitId: string, newParentId: string): Promise<void>;
  putUnitMember(member: OrgUnitMember): Promise<void>;
  removeUnitMember(orgId: string, unitId: string, principalId: string): Promise<void>;
  putGroup(group: AccessGroup): Promise<void>;
  putGroupMember(member: AccessGroupMember): Promise<void>;
  removeGroupMember(orgId: string, groupId: string, principalId: string): Promise<void>;
  bumpRevision(orgId: string): Promise<number>;
  audit(event: AuditEvent): Promise<void>;
}

export interface OrganizationStore {
  getUser(orgId: string, principalId: string): Promise<OrganizationUser | null>;
  findUserByEmail(orgId: string, email: string): Promise<OrganizationUser | null>;
  listUsers(orgId: string): Promise<OrganizationUser[]>;
  putUser(user: OrganizationUser): Promise<void>;
  getIdentity(orgId: string, issuer: string, subject: string): Promise<AuthIdentity | null>;
  putIdentity(identity: AuthIdentity): Promise<void>;
  getUnit(orgId: string, id: string): Promise<OrgUnit | null>;
  listUnits(orgId: string): Promise<OrgUnit[]>;
  putUnit(unit: OrgUnit): Promise<void>;
  isDescendant(orgId: string, ancestorId: string, descendantId: string): Promise<boolean>;
  listSubtreeUnitIds(orgId: string, unitId: string): Promise<string[]>;
  listManagedSubtreeUnitIds(orgId: string, principalId: string): Promise<string[]>;
  unitImpact(orgId: string, unitId: string): Promise<UnitImpact>;
  listUnitMembers(orgId: string, unitId: string): Promise<OrgUnitMember[]>;
  putUnitMember(member: OrgUnitMember): Promise<void>;
  removeUnitMember(orgId: string, unitId: string, principalId: string): Promise<void>;
  getGroup(orgId: string, id: string): Promise<AccessGroup | null>;
  listGroups(orgId: string): Promise<AccessGroup[]>;
  putGroup(group: AccessGroup): Promise<void>;
  listGroupMembers(orgId: string, groupId: string): Promise<AccessGroupMember[]>;
  putGroupMember(member: AccessGroupMember): Promise<void>;
  removeGroupMember(orgId: string, groupId: string, principalId: string): Promise<void>;
  getAuthzRevision(orgId: string): Promise<number>;
  ensureOrgRoot(input: { orgId: string; name: string; actor: string; now: number }): Promise<void>;
  transact<T>(fn: (tx: OrganizationTx) => Promise<T>): Promise<T>;
}

const userKey = (orgId: string, principalId: string): string => `${orgId}\n${principalId}`;
const identityKey = (orgId: string, issuer: string, subject: string): string => `${orgId}\n${issuer}\n${subject}`;
const unitKey = (orgId: string, id: string): string => `${orgId}\n${id}`;
const groupKey = (orgId: string, id: string): string => `${orgId}\n${id}`;
const unitMemberKey = (orgId: string, unitId: string, principalId: string): string => `${orgId}\n${unitId}\n${principalId}`;
const groupMemberKey = (orgId: string, groupId: string, principalId: string): string => `${orgId}\n${groupId}\n${principalId}`;

const MAX_TREE_DEPTH = 1000;

export function createMemoryOrganizationStore(opts: { auditLog?: AuditLog } = {}): OrganizationStore {
  const users = new Map<string, OrganizationUser>();
  const identities = new Map<string, AuthIdentity>();
  const units = new Map<string, OrgUnit>();
  const closure = new Map<string, Map<string, Set<string>>>();
  const unitMembers = new Map<string, OrgUnitMember>();
  const groups = new Map<string, AccessGroup>();
  const groupMembers = new Map<string, AccessGroupMember>();
  const revisions = new Map<string, number>();

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

  const putUnit = async (unit: OrgUnit): Promise<void> => {
    units.set(unitKey(unit.orgId, unit.id), { ...unit });
    rebuildClosure(unit.orgId, unit.id);
  };

  const moveUnitSubtree = async (orgId: string, unitId: string, newParentId: string): Promise<void> => {
    const key = unitKey(orgId, unitId);
    const found = units.get(key);
    if (!found) throw new Error(`org unit not found: ${unitId}`);
    units.set(key, { ...found, parentId: newParentId });
    rebuildClosure(orgId, unitId);
  };

  const putUnitMember = async (member: OrgUnitMember): Promise<void> => {
    unitMembers.set(unitMemberKey(member.orgId, member.unitId, member.principalId), { ...member });
  };

  const removeUnitMember = async (orgId: string, unitId: string, principalId: string): Promise<void> => {
    unitMembers.delete(unitMemberKey(orgId, unitId, principalId));
  };

  const putGroup = async (group: AccessGroup): Promise<void> => {
    groups.set(groupKey(group.orgId, group.id), { ...group });
  };

  const putGroupMember = async (member: AccessGroupMember): Promise<void> => {
    groupMembers.set(groupMemberKey(member.orgId, member.groupId, member.principalId), { ...member });
  };

  const removeGroupMember = async (orgId: string, groupId: string, principalId: string): Promise<void> => {
    groupMembers.delete(groupMemberKey(orgId, groupId, principalId));
  };

  const bumpRevision = async (orgId: string): Promise<number> => {
    const next = (revisions.get(orgId) ?? 1) + 1;
    revisions.set(orgId, next);
    return next;
  };

  const store: OrganizationStore = {
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
    async listUsers(orgId) {
      const out: OrganizationUser[] = [];
      for (const u of users.values()) {
        if (u.orgId === orgId) out.push({ ...u });
      }
      return out;
    },
    async putUser(user) {
      users.set(userKey(user.orgId, user.principalId), { ...user });
    },
    async getIdentity(orgId, issuer, subject) {
      const found = identities.get(identityKey(orgId, issuer, subject));
      return found ? { ...found } : null;
    },
    async putIdentity(identity) {
      identities.set(identityKey(identity.orgId, identity.issuer, identity.subject), { ...identity });
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
    putUnit,
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
    async listManagedSubtreeUnitIds(orgId, principalId) {
      const out = new Set<string>();
      for (const m of unitMembers.values()) {
        if (m.orgId !== orgId || m.principalId !== principalId || m.role !== "manager") continue;
        out.add(m.unitId);
        for (const [id, ancestors] of closure.get(orgId) ?? []) {
          if (ancestors.has(m.unitId)) out.add(id);
        }
      }
      return [...out];
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
      return { activeChildUnits, activeMembers, directoryRoots: 0, skillGrants: 0 };
    },
    async listUnitMembers(orgId, unitId) {
      const out: OrgUnitMember[] = [];
      for (const m of unitMembers.values()) {
        if (m.orgId === orgId && m.unitId === unitId) out.push({ ...m });
      }
      return out;
    },
    putUnitMember,
    removeUnitMember,
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
    putGroup,
    async listGroupMembers(orgId, groupId) {
      const out: AccessGroupMember[] = [];
      for (const m of groupMembers.values()) {
        if (m.orgId === orgId && m.groupId === groupId) out.push({ ...m });
      }
      return out;
    },
    putGroupMember,
    removeGroupMember,
    async getAuthzRevision(orgId) {
      return revisions.get(orgId) ?? 0;
    },
    async ensureOrgRoot({ orgId, name, actor, now }) {
      for (const u of units.values()) {
        if (u.orgId === orgId && u.parentId === null && u.status === "active") return;
      }
      await putUnit({
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
    },
    async transact(fn) {
      const audits: AuditEvent[] = [];
      const tx: OrganizationTx = {
        putUser: (user) => store.putUser(user),
        putUnit,
        moveUnitSubtree,
        putUnitMember,
        removeUnitMember,
        putGroup,
        putGroupMember,
        removeGroupMember,
        bumpRevision,
        audit: async (event) => {
          audits.push(event);
        },
      };
      const result = await fn(tx);
      for (const event of audits) opts.auditLog?.record(event);
      return result;
    },
  };

  return store;
}
