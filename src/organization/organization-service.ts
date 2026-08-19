import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import { personKey } from "../directory/person.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import type {
  AccessGroup,
  AccessGroupMember,
  AccessGroupStatus,
  OrganizationStore,
  OrganizationUser,
  OrganizationUserStatus,
  OrgMemberRole,
  OrgUnit,
  OrgUnitKind,
  OrgUnitMember,
  OrgUnitStatus,
  UnitImpact,
} from "./organization-store.ts";

export type OrgAdmission = "invite_only" | "domain_auto_join";

export interface LoginInput {
  principalId: string;
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string;
}

export type LoginResult =
  | { status: "ok"; user: OrganizationUser }
  | { status: "denied"; reason: "unknown" | "suspended" | "deprovisioned" | "not_invited" | "email_unverified" };

export interface ActiveCheck {
  status: OrganizationUserStatus;
  sessionVersion: number;
}

export type MoveUnitResult = { ok: true } | { ok: false; reason: "root" | "self_or_descendant" | "missing_parent" | "archived" };

export type ArchiveUnitResult = { ok: true } | { ok: false; reason: "root" | "conflict"; impact?: UnitImpact };

export type AddUnitMemberResult = { ok: true } | { ok: false; reason: "missing_unit" | "missing_user" | "archived" };

export type RemoveUnitMemberResult = { ok: true } | { ok: false; reason: "missing_unit" };

export type AddGroupMemberResult = { ok: true } | { ok: false; reason: "missing_group" | "missing_user" | "archived" };

export type RemoveGroupMemberResult = { ok: true } | { ok: false; reason: "missing_group" };

export interface OrganizationService {
  login(input: LoginInput): Promise<LoginResult>;
  invite(input: {
    principalId: string;
    email: string | null;
    displayName: string;
    actor: string;
  }): Promise<OrganizationUser>;
  setStatus(input: {
    principalId: string;
    status: OrganizationUserStatus;
    actor: string;
  }): Promise<OrganizationUser | null>;
  checkActive(principalId: string): Promise<ActiveCheck | null>;
  createUnit(input: { parentId: string | null; name: string; kind: OrgUnitKind; sortOrder?: number; actor: string }): Promise<OrgUnit>;
  updateUnit(input: {
    unitId: string;
    name?: string;
    sortOrder?: number;
    status?: OrgUnitStatus;
    actor: string;
  }): Promise<OrgUnit | null>;
  moveUnit(input: { unitId: string; newParentId: string; actor: string }): Promise<MoveUnitResult>;
  archiveUnit(input: { unitId: string; actor: string }): Promise<ArchiveUnitResult>;
  addUnitMember(input: { unitId: string; principalId: string; role: OrgMemberRole; actor: string }): Promise<AddUnitMemberResult>;
  removeUnitMember(input: { unitId: string; principalId: string; actor: string }): Promise<RemoveUnitMemberResult>;
  createGroup(input: { name: string; actor: string }): Promise<AccessGroup>;
  updateGroup(input: { groupId: string; name?: string; status?: AccessGroupStatus; actor: string }): Promise<AccessGroup | null>;
  archiveGroup(input: { groupId: string; actor: string }): Promise<{ ok: true }>;
  addGroupMember(input: { groupId: string; principalId: string; role: OrgMemberRole; actor: string }): Promise<AddGroupMemberResult>;
  removeGroupMember(input: { groupId: string; principalId: string; actor: string }): Promise<RemoveGroupMemberResult>;
  unitImpact(orgId: string, unitId: string): Promise<UnitImpact>;
  listManagedSubtreeUnitIds(principalId: string): Promise<string[]>;
  getUnit(unitId: string): Promise<OrgUnit | null>;
  listUnits(): Promise<OrgUnit[]>;
  listUnitMembers(unitId: string): Promise<OrgUnitMember[]>;
  getGroup(groupId: string): Promise<AccessGroup | null>;
  listGroups(): Promise<AccessGroup[]>;
  listGroupMembers(groupId: string): Promise<AccessGroupMember[]>;
  refresh(): Promise<void>;
  hydrate(): Promise<void>;
}

const REFRESH_TTL_MS = 5_000;
const LOGIN_ACTOR = "system:login";

function sanitizeDisplayName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
}

function sanitizeUnitName(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 200);
}

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

export function createOrganizationService(deps: {
  store: OrganizationStore;
  orgId: string;
  admission: OrgAdmission;
  autoJoinDomains: readonly string[];
  auditLog: AuditLog;
  identity: IdentityService;
  now?: () => number;
}): OrganizationService {
  const { store, orgId, admission, auditLog, identity } = deps;
  const now = deps.now ?? Date.now;
  const autoJoinDomains = deps.autoJoinDomains.map((d) => d.toLowerCase());
  const scopeLabel = `org:${orgId}`;
  const cache = new Map<string, ActiveCheck>();
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  function userEvent(action: string, principalId: string, status?: string): AuditEvent {
    return { at: now(), principalId, action, resource: principalId, scopeLabel, ...(status ? { status } : {}) };
  }

  function record(action: string, principalId: string, status?: string): void {
    auditLog.record(userEvent(action, principalId, status));
  }

  function orgEvent(action: string, resource: string, actor: string, detail: Record<string, string | null>): AuditEvent {
    return {
      at: now(),
      principalId: actor,
      action,
      resource,
      scopeLabel,
      orgId,
      detail: JSON.stringify(detail),
    };
  }

  function cacheUser(user: OrganizationUser): void {
    cache.set(personKey(user.principalId), { status: user.status, sessionVersion: user.sessionVersion });
  }

  async function persistUser(user: OrganizationUser): Promise<void> {
    await store.putUser(user);
    cacheUser(user);
  }

  async function linkIdentity(input: LoginInput, principalId: string): Promise<void> {
    const at = now();
    await store.putIdentity({
      orgId,
      issuer: input.issuer,
      subject: input.subject,
      principalId,
      emailAtLink: input.email,
      createdAt: at,
      updatedAt: at,
    });
  }

  function withLoginProfile(user: OrganizationUser, input: LoginInput): OrganizationUser {
    const at = now();
    return {
      ...user,
      displayName: input.displayName ? sanitizeDisplayName(input.displayName) : user.displayName,
      email: input.email ?? user.email,
      lastLoginAt: at,
      updatedAt: at,
      updatedBy: LOGIN_ACTOR,
    };
  }

  async function activate(user: OrganizationUser, input: LoginInput): Promise<OrganizationUser> {
    const next = withLoginProfile({ ...user, status: "active", sessionVersion: user.sessionVersion + 1 }, input);
    await store.transact(async (tx) => {
      await tx.putUser(next);
      await tx.bumpRevision(orgId);
      await tx.audit(userEvent("org.user.activate", next.principalId));
    });
    cacheUser(next);
    await identity.reactivate(next.principalId);
    return next;
  }

  function autoJoinAdmits(input: LoginInput): boolean {
    if (admission !== "domain_auto_join") return false;
    if (input.email === null) return false;
    return autoJoinDomains.length === 0 || autoJoinDomains.includes(emailDomain(input.email));
  }

  async function login(input: LoginInput): Promise<LoginResult> {
    const bound = await store.getIdentity(orgId, input.issuer, input.subject);
    if (bound) {
      const user = await store.getUser(orgId, bound.principalId);
      if (!user) {
        record("org.user.login_denied", bound.principalId, "unknown");
        return { status: "denied", reason: "unknown" };
      }
      if (user.status === "active") {
        const next = withLoginProfile(user, input);
        await persistUser(next);
        record("org.user.login", next.principalId);
        return { status: "ok", user: next };
      }
      if (user.status === "invited") {
        const next = await activate(user, input);
        record("org.user.login", next.principalId);
        return { status: "ok", user: next };
      }
      record("org.user.login_denied", user.principalId, user.status);
      return { status: "denied", reason: user.status };
    }
    if (input.email !== null && input.emailVerified) {
      const matched = await store.findUserByEmail(orgId, input.email);
      if (matched) {
        if (matched.status === "invited") {
          await linkIdentity(input, matched.principalId);
          const next = await activate(matched, input);
          return { status: "ok", user: next };
        }
        const reason = matched.status === "active" ? "unknown" : matched.status;
        record("org.user.login_denied", matched.principalId, reason);
        return { status: "denied", reason };
      }
    }
    if (autoJoinAdmits(input) && input.emailVerified) {
      const at = now();
      const user: OrganizationUser = {
        orgId,
        principalId: input.principalId,
        email: input.email,
        displayName: sanitizeDisplayName(input.displayName),
        status: "active",
        sessionVersion: 1,
        createdAt: at,
        updatedAt: at,
        lastLoginAt: at,
        createdBy: LOGIN_ACTOR,
        updatedBy: LOGIN_ACTOR,
      };
      await store.transact(async (tx) => {
        await tx.putUser(user);
        await tx.bumpRevision(orgId);
        await tx.audit(userEvent("org.user.auto_join", user.principalId));
      });
      cacheUser(user);
      await linkIdentity(input, user.principalId);
      return { status: "ok", user };
    }
    const reason = autoJoinAdmits(input) && !input.emailVerified ? "email_unverified" : "not_invited";
    record("org.user.login_denied", input.principalId, reason);
    return { status: "denied", reason };
  }

  async function invite(input: {
    principalId: string;
    email: string | null;
    displayName: string;
    actor: string;
  }): Promise<OrganizationUser> {
    const existing = await store.getUser(orgId, input.principalId);
    if (existing) return existing;
    const at = now();
    const user: OrganizationUser = {
      orgId,
      principalId: input.principalId,
      email: input.email,
      displayName: sanitizeDisplayName(input.displayName),
      status: "invited",
      sessionVersion: 1,
      createdAt: at,
      updatedAt: at,
      lastLoginAt: null,
      createdBy: input.actor,
      updatedBy: input.actor,
    };
    await persistUser(user);
    record("org.user.invite", user.principalId);
    return user;
  }

  async function setStatus(input: {
    principalId: string;
    status: OrganizationUserStatus;
    actor: string;
  }): Promise<OrganizationUser | null> {
    const user = await store.getUser(orgId, input.principalId);
    if (!user) return null;
    if (user.status === input.status) return user;
    const next: OrganizationUser = {
      ...user,
      status: input.status,
      sessionVersion: user.sessionVersion + 1,
      updatedAt: now(),
      updatedBy: input.actor,
    };
    await store.transact(async (tx) => {
      await tx.putUser(next);
      await tx.bumpRevision(orgId);
      await tx.audit(userEvent("org.user.status", next.principalId, input.status));
    });
    cacheUser(next);
    if (input.status === "suspended" || input.status === "deprovisioned") {
      await identity.deactivate(input.principalId, "manual");
    } else if (input.status === "active") {
      await identity.reactivate(input.principalId);
    }
    return next;
  }

  async function createUnit(input: {
    parentId: string | null;
    name: string;
    kind: OrgUnitKind;
    sortOrder?: number;
    actor: string;
  }): Promise<OrgUnit> {
    if (input.parentId === null) {
      const units = await store.listUnits(orgId);
      if (units.some((u) => u.parentId === null && u.status === "active")) {
        throw new Error("org root already exists");
      }
    } else {
      const parent = await store.getUnit(orgId, input.parentId);
      if (!parent) throw new Error(`org unit parent not found: ${input.parentId}`);
      if (parent.status !== "active") throw new Error(`org unit parent archived: ${input.parentId}`);
    }
    const at = now();
    const unit: OrgUnit = {
      orgId,
      id: `unit-${randomUUID()}`,
      parentId: input.parentId,
      name: sanitizeUnitName(input.name),
      kind: input.kind,
      status: "active",
      sortOrder: input.sortOrder ?? 0,
      createdAt: at,
      updatedAt: at,
      createdBy: input.actor,
      updatedBy: input.actor,
    };
    await store.transact(async (tx) => {
      await tx.putUnit(unit);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.unit.create", `unit:${unit.id}`, input.actor, { unitId: unit.id, parentId: unit.parentId }));
    });
    return unit;
  }

  async function updateUnit(input: {
    unitId: string;
    name?: string;
    sortOrder?: number;
    status?: OrgUnitStatus;
    actor: string;
  }): Promise<OrgUnit | null> {
    const unit = await store.getUnit(orgId, input.unitId);
    if (!unit) return null;
    const next: OrgUnit = {
      ...unit,
      name: input.name !== undefined ? sanitizeUnitName(input.name) : unit.name,
      sortOrder: input.sortOrder ?? unit.sortOrder,
      status: input.status ?? unit.status,
      updatedAt: now(),
      updatedBy: input.actor,
    };
    await store.transact(async (tx) => {
      await tx.putUnit(next);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.unit.update", `unit:${next.id}`, input.actor, { unitId: next.id }));
    });
    return next;
  }

  async function moveUnit(input: { unitId: string; newParentId: string; actor: string }): Promise<MoveUnitResult> {
    const unit = await store.getUnit(orgId, input.unitId);
    if (!unit || unit.status !== "active") return { ok: false, reason: "archived" };
    if (unit.parentId === null) return { ok: false, reason: "root" };
    const parent = await store.getUnit(orgId, input.newParentId);
    if (!parent) return { ok: false, reason: "missing_parent" };
    if (parent.status !== "active") return { ok: false, reason: "archived" };
    if (input.newParentId === input.unitId || (await store.isDescendant(orgId, input.unitId, input.newParentId))) {
      return { ok: false, reason: "self_or_descendant" };
    }
    await store.transact(async (tx) => {
      await tx.moveUnitSubtree(orgId, input.unitId, input.newParentId);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.unit.move", `unit:${input.unitId}`, input.actor, { unitId: input.unitId, parentId: input.newParentId }));
    });
    return { ok: true };
  }

  async function archiveUnit(input: { unitId: string; actor: string }): Promise<ArchiveUnitResult> {
    const unit = await store.getUnit(orgId, input.unitId);
    if (!unit || unit.parentId === null) return { ok: false, reason: "root" };
    const impact = await store.unitImpact(orgId, input.unitId);
    if (impact.activeChildUnits > 0 || impact.activeMembers > 0) return { ok: false, reason: "conflict", impact };
    const next: OrgUnit = { ...unit, status: "archived", updatedAt: now(), updatedBy: input.actor };
    await store.transact(async (tx) => {
      await tx.putUnit(next);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.unit.archive", `unit:${next.id}`, input.actor, { unitId: next.id }));
    });
    return { ok: true };
  }

  async function addUnitMember(input: {
    unitId: string;
    principalId: string;
    role: OrgMemberRole;
    actor: string;
  }): Promise<AddUnitMemberResult> {
    const unit = await store.getUnit(orgId, input.unitId);
    if (!unit) return { ok: false, reason: "missing_unit" };
    if (unit.status !== "active") return { ok: false, reason: "archived" };
    const user = await store.getUser(orgId, input.principalId);
    if (!user || user.status === "deprovisioned") return { ok: false, reason: "missing_user" };
    const existing = (await store.listUnitMembers(orgId, input.unitId)).find((m) => m.principalId === input.principalId);
    if (existing?.role === input.role) return { ok: true };
    const member: OrgUnitMember = existing
      ? { ...existing, role: input.role }
      : {
          orgId,
          unitId: input.unitId,
          principalId: input.principalId,
          role: input.role,
          createdAt: now(),
          createdBy: input.actor,
        };
    await store.transact(async (tx) => {
      await tx.putUnitMember(member);
      await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.unit.member.add", `unit:${input.unitId}`, input.actor, {
          unitId: input.unitId,
          principalId: input.principalId,
          role: input.role,
        }),
      );
    });
    return { ok: true };
  }

  async function removeUnitMember(input: { unitId: string; principalId: string; actor: string }): Promise<RemoveUnitMemberResult> {
    const unit = await store.getUnit(orgId, input.unitId);
    if (!unit) return { ok: false, reason: "missing_unit" };
    const existing = (await store.listUnitMembers(orgId, input.unitId)).some((m) => m.principalId === input.principalId);
    if (!existing) return { ok: true };
    await store.transact(async (tx) => {
      await tx.removeUnitMember(orgId, input.unitId, input.principalId);
      await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.unit.member.remove", `unit:${input.unitId}`, input.actor, { unitId: input.unitId, principalId: input.principalId }),
      );
    });
    return { ok: true };
  }

  async function createGroup(input: { name: string; actor: string }): Promise<AccessGroup> {
    const at = now();
    const group: AccessGroup = {
      orgId,
      id: `grp-${randomUUID()}`,
      name: sanitizeDisplayName(input.name),
      status: "active",
      createdAt: at,
      updatedAt: at,
      createdBy: input.actor,
      updatedBy: input.actor,
    };
    await store.transact(async (tx) => {
      await tx.putGroup(group);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.group.create", `group:${group.id}`, input.actor, { groupId: group.id }));
    });
    return group;
  }

  async function updateGroup(input: {
    groupId: string;
    name?: string;
    status?: AccessGroupStatus;
    actor: string;
  }): Promise<AccessGroup | null> {
    const group = await store.getGroup(orgId, input.groupId);
    if (!group) return null;
    const next: AccessGroup = {
      ...group,
      name: input.name !== undefined ? sanitizeDisplayName(input.name) : group.name,
      status: input.status ?? group.status,
      updatedAt: now(),
      updatedBy: input.actor,
    };
    await store.transact(async (tx) => {
      await tx.putGroup(next);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.group.update", `group:${next.id}`, input.actor, { groupId: next.id }));
    });
    return next;
  }

  async function archiveGroup(input: { groupId: string; actor: string }): Promise<{ ok: true }> {
    const group = await store.getGroup(orgId, input.groupId);
    if (!group || group.status === "archived") return { ok: true };
    const next: AccessGroup = { ...group, status: "archived", updatedAt: now(), updatedBy: input.actor };
    await store.transact(async (tx) => {
      await tx.putGroup(next);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.group.archive", `group:${next.id}`, input.actor, { groupId: next.id }));
    });
    return { ok: true };
  }

  async function addGroupMember(input: {
    groupId: string;
    principalId: string;
    role: OrgMemberRole;
    actor: string;
  }): Promise<AddGroupMemberResult> {
    const group = await store.getGroup(orgId, input.groupId);
    if (!group) return { ok: false, reason: "missing_group" };
    if (group.status !== "active") return { ok: false, reason: "archived" };
    const user = await store.getUser(orgId, input.principalId);
    if (!user || user.status === "deprovisioned") return { ok: false, reason: "missing_user" };
    const existing = (await store.listGroupMembers(orgId, input.groupId)).find((m) => m.principalId === input.principalId);
    if (existing?.role === input.role) return { ok: true };
    const member: AccessGroupMember = existing
      ? { ...existing, role: input.role }
      : {
          orgId,
          groupId: input.groupId,
          principalId: input.principalId,
          role: input.role,
          createdAt: now(),
          createdBy: input.actor,
        };
    await store.transact(async (tx) => {
      await tx.putGroupMember(member);
      await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.group.member.add", `group:${input.groupId}`, input.actor, {
          groupId: input.groupId,
          principalId: input.principalId,
          role: input.role,
        }),
      );
    });
    return { ok: true };
  }

  async function removeGroupMember(input: { groupId: string; principalId: string; actor: string }): Promise<RemoveGroupMemberResult> {
    const group = await store.getGroup(orgId, input.groupId);
    if (!group) return { ok: false, reason: "missing_group" };
    const existing = (await store.listGroupMembers(orgId, input.groupId)).some((m) => m.principalId === input.principalId);
    if (!existing) return { ok: true };
    await store.transact(async (tx) => {
      await tx.removeGroupMember(orgId, input.groupId, input.principalId);
      await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.group.member.remove", `group:${input.groupId}`, input.actor, { groupId: input.groupId, principalId: input.principalId }),
      );
    });
    return { ok: true };
  }

  async function refresh(): Promise<void> {
    const at = now();
    if (refreshP) return refreshP;
    if (at - refreshedAt < REFRESH_TTL_MS) return;
    refreshP = store
      .listUsers(orgId)
      .then((users) => {
        cache.clear();
        for (const user of users) cacheUser(user);
        refreshedAt = now();
      })
      .finally(() => {
        refreshP = null;
      });
    return refreshP;
  }

  return {
    login,
    invite,
    setStatus,
    createUnit,
    updateUnit,
    moveUnit,
    archiveUnit,
    addUnitMember,
    removeUnitMember,
    createGroup,
    updateGroup,
    archiveGroup,
    addGroupMember,
    removeGroupMember,
    unitImpact: (scopeOrgId, unitId) => store.unitImpact(scopeOrgId, unitId),
    listManagedSubtreeUnitIds: (principalId) => store.listManagedSubtreeUnitIds(orgId, principalId),
    getUnit: (unitId) => store.getUnit(orgId, unitId),
    listUnits: () => store.listUnits(orgId),
    listUnitMembers: (unitId) => store.listUnitMembers(orgId, unitId),
    getGroup: (groupId) => store.getGroup(orgId, groupId),
    listGroups: () => store.listGroups(orgId),
    listGroupMembers: (groupId) => store.listGroupMembers(orgId, groupId),
    async checkActive(principalId: string): Promise<ActiveCheck | null> {
      await refresh();
      return cache.get(personKey(principalId)) ?? null;
    },
    refresh,
    hydrate(): Promise<void> {
      if (!hydrateP) {
        hydrateP = store.listUsers(orgId).then((users) => {
          for (const user of users) {
            if (!cache.has(personKey(user.principalId))) cacheUser(user);
          }
        });
      }
      return hydrateP;
    },
  };
}
