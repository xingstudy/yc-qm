import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditLog } from "../audit/audit-log.ts";
import { personKey } from "../directory/person.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { personalScope, type ScopeId } from "../types.ts";
import {
  createDirectoryVisibilityResolver,
  type DirectoryVisibilityResolver,
} from "../authorization/directory-visibility.ts";
import {
  organizationAccessSubjectFromScope,
  type OrganizationAccessSubject,
} from "../authorization/organization-access-subject.ts";
import type {
  AccessGroup,
  AccessGroupMember,
  AccessGroupStatus,
  DirectorySubjectKind,
  DirectoryViewMode,
  DirectoryViewPolicy,
  DirectoryViewRoot,
  OrganizationStore,
  OrganizationTx,
  OrganizationUser,
  OrganizationUserDetail,
  OrganizationUserListQuery,
  OrganizationUserPage,
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

export type MoveUnitResult =
  { ok: true } | { ok: false; reason: "root" | "self_or_descendant" | "missing_parent" | "archived" };

export type MoveUnitPreviewResult =
  | {
      ok: true;
      impact: {
        activeUnits: number;
        activeMembers: number;
      };
    }
  | { ok: false; reason: "root" | "self_or_descendant" | "missing_parent" | "archived" };

export type ArchiveUnitResult = { ok: true } | { ok: false; reason: "root" | "conflict"; impact?: UnitImpact };

export type AddUnitMemberResult =
  | { ok: true }
  | { ok: false; reason: "missing_unit" | "archived" | "forbidden" }
  | { ok: false; reason: "missing_user"; invalidPrincipalIds: string[] };

export type RemoveUnitMemberResult =
  { ok: true } | { ok: false; reason: "missing_unit" | "forbidden" | "primary_unit" };

export interface OrganizationUserProfilePatch {
  displayName?: string;
  email?: string | null;
  jobTitle?: string | null;
  mobile?: string | null;
  employeeNumber?: string | null;
}

export type UpdateUserProfileResult =
  | { ok: true; user: OrganizationUser }
  | { ok: false; reason: "missing_user" | "duplicate_email" | "duplicate_employee_number" }
  | { ok: false; reason: "invalid_profile"; field: keyof OrganizationUserProfilePatch }
  | { ok: false; reason: "revision_conflict"; current: OrganizationUser };

export type SetPrimaryUnitResult =
  | { ok: true; detail: OrganizationUserDetail }
  | { ok: false; reason: "missing_user" | "missing_unit" | "archived" | "root" | "deprovisioned" };

export interface OrganizationUserStatusImpact {
  primaryUnitId: string | null;
  unitCount: number;
  unitManagerCount: number;
  groupCount: number;
  groupManagerCount: number;
  directAuthorizationCount: number;
}

export type ManagedStatusResult =
  | { ok: true; user: OrganizationUser }
  | { ok: false; reason: "missing_user" | "invalid_transition"; current?: OrganizationUserStatus };

export interface OrganizationMemberMutation {
  principalId: string;
  expectedProfileRevision: number;
  profile?: OrganizationUserProfilePatch;
  primaryUnit?: { unitId: string | null; keepPreviousMembership: boolean };
  addUnitIds?: string[];
  removeUnitIds?: string[];
  addGroupIds?: string[];
  removeGroupIds?: string[];
  status?: "active" | "suspended" | "deprovisioned";
}

export type ApplyOrganizationMemberMutationsResult =
  | { ok: true; users: OrganizationUser[]; authorizationRevision: number }
  | {
      ok: false;
      reason:
        | "authorization_revision_conflict"
        | "profile_revision_conflict"
        | "missing_user"
        | "invalid_profile"
        | "duplicate_email"
        | "duplicate_employee_number"
        | "missing_unit"
        | "archived_unit"
        | "root_unit"
        | "missing_group"
        | "archived_group"
        | "manager_conflict"
        | "primary_unit_conflict"
        | "invalid_transition";
      principalId?: string;
    };

export type AddGroupMemberResult =
  | { ok: true }
  | { ok: false; reason: "missing_group" | "archived" | "forbidden" }
  | { ok: false; reason: "missing_user"; invalidPrincipalIds: string[] };

export type RemoveGroupMemberResult = { ok: true } | { ok: false; reason: "missing_group" | "forbidden" };
export type ArchiveGroupResult = { ok: true } | { ok: false; reason: "conflict" };

export type DirectoryPolicyResult =
  | { ok: true; policy: DirectoryViewPolicy; roots: DirectoryViewRoot[]; authzRevision: number }
  | { ok: false; reason: "missing_subject" | "missing_root" }
  | {
      ok: false;
      reason: "revision_conflict";
      currentRevision: number;
      policy: DirectoryViewPolicy | null;
      roots: DirectoryViewRoot[];
    };

export type DeleteDirectoryPolicyResult =
  | { ok: true; authzRevision: number }
  | {
      ok: false;
      reason: "revision_conflict";
      currentRevision: number;
      policy: DirectoryViewPolicy | null;
      roots: DirectoryViewRoot[];
    };

export interface OrganizationService {
  directory: DirectoryVisibilityResolver;
  login(input: LoginInput): Promise<LoginResult>;
  provisionPlayground(principalId: string): Promise<OrganizationUser | null>;
  backfillUser(input: {
    principalId: string;
    email: string | null;
    displayName: string;
  }): Promise<{ created: boolean; user: OrganizationUser }>;
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
  changeManagedStatus(input: {
    principalId: string;
    status: "active" | "suspended" | "deprovisioned";
    actor: string;
  }): Promise<ManagedStatusResult>;
  statusImpact(principalId: string): Promise<OrganizationUserStatusImpact | null>;
  listOrganizationUsers(query: OrganizationUserListQuery): Promise<OrganizationUserPage>;
  getOrganizationUserDetail(principalId: string): Promise<OrganizationUserDetail | null>;
  getOrganizationUsersByIds(principalIds: readonly string[]): Promise<OrganizationUser[]>;
  updateUserProfile(input: {
    principalId: string;
    patch: OrganizationUserProfilePatch;
    expectedProfileRevision: number;
    actor: string;
  }): Promise<UpdateUserProfileResult>;
  setPrimaryUnit(input: {
    principalId: string;
    unitId: string | null;
    keepPreviousMembership: boolean;
    actor: string;
  }): Promise<SetPrimaryUnitResult>;
  applyMemberMutations(input: {
    mutations: readonly OrganizationMemberMutation[];
    expectedAuthzRevision: number;
    actor: string;
    idempotencyKey: string;
  }): Promise<ApplyOrganizationMemberMutationsResult>;
  checkActive(principalId: string): Promise<ActiveCheck | null>;
  checkRuntimeActive(principalId: string): Promise<ActiveCheck | null>;
  deactivatePrincipal(input: { principalId: string; actor: string }): Promise<ManagedStatusResult>;
  getUser(principalId: string): Promise<OrganizationUser | null>;
  directUnitIds(principalId: string): Promise<string[]>;
  directGroupIds(principalId: string): Promise<string[]>;
  resolveAccessSubject(scopeId: ScopeId): Promise<OrganizationAccessSubject | null>;
  accessSubjectIncludes(scopeId: ScopeId, principalId: string): Promise<boolean>;
  authzRevision(): Promise<number>;
  searchUsers(query: string, limit?: number): Promise<OrganizationUser[]>;
  createUnit(input: {
    parentId: string | null;
    name: string;
    kind: OrgUnitKind;
    sortOrder?: number;
    actor: string;
  }): Promise<OrgUnit>;
  updateUnit(input: {
    unitId: string;
    name?: string;
    sortOrder?: number;
    status?: OrgUnitStatus;
    actor: string;
  }): Promise<OrgUnit | null>;
  moveUnit(input: { unitId: string; newParentId: string; actor: string }): Promise<MoveUnitResult>;
  previewMoveUnit(input: { unitId: string; newParentId: string }): Promise<MoveUnitPreviewResult>;
  archiveUnit(input: { unitId: string; actor: string }): Promise<ArchiveUnitResult>;
  addUnitMember(input: {
    unitId: string;
    principalId: string;
    role: OrgMemberRole;
    actor: string;
    asManager?: boolean;
  }): Promise<AddUnitMemberResult>;
  addUnitMembers(input: {
    unitId: string;
    principalIds: string[];
    role: OrgMemberRole;
    actor: string;
    asManager?: boolean;
  }): Promise<AddUnitMemberResult>;
  removeUnitMember(input: {
    unitId: string;
    principalId: string;
    actor: string;
    asManager?: boolean;
  }): Promise<RemoveUnitMemberResult>;
  createGroup(input: { name: string; actor: string }): Promise<AccessGroup>;
  updateGroup(input: {
    groupId: string;
    name?: string;
    status?: AccessGroupStatus;
    actor: string;
  }): Promise<AccessGroup | null>;
  archiveGroup(input: { groupId: string; actor: string }): Promise<ArchiveGroupResult>;
  addGroupMember(input: {
    groupId: string;
    principalId: string;
    role: OrgMemberRole;
    actor: string;
    asManager?: boolean;
  }): Promise<AddGroupMemberResult>;
  addGroupMembers(input: {
    groupId: string;
    principalIds: string[];
    role: OrgMemberRole;
    actor: string;
    asManager?: boolean;
  }): Promise<AddGroupMemberResult>;
  removeGroupMember(input: {
    groupId: string;
    principalId: string;
    actor: string;
    asManager?: boolean;
  }): Promise<RemoveGroupMemberResult>;
  unitImpact(unitId: string): Promise<UnitImpact>;
  listManagedSubtreeUnitIds(principalId: string): Promise<string[]>;
  listManagedGroupIds(principalId: string): Promise<string[]>;
  getUnit(unitId: string): Promise<OrgUnit | null>;
  listUnits(): Promise<OrgUnit[]>;
  listUnitMembers(unitId: string): Promise<OrgUnitMember[]>;
  getGroup(groupId: string): Promise<AccessGroup | null>;
  listGroups(): Promise<AccessGroup[]>;
  listGroupMembers(groupId: string): Promise<AccessGroupMember[]>;
  getDirectoryPolicy(
    subjectKind: DirectorySubjectKind,
    subjectId: string,
  ): Promise<{ policy: DirectoryViewPolicy; roots: DirectoryViewRoot[] } | null>;
  setDirectoryPolicy(input: {
    subjectKind: DirectorySubjectKind;
    subjectId: string;
    mode: DirectoryViewMode;
    roots: Array<{ unitId: string; includeDescendants: boolean }>;
    expectedRevision: number;
    actor: string;
  }): Promise<DirectoryPolicyResult>;
  deleteDirectoryPolicy(input: {
    subjectKind: DirectorySubjectKind;
    subjectId: string;
    expectedRevision: number;
    actor: string;
  }): Promise<DeleteDirectoryPolicyResult>;
  refresh(): Promise<void>;
  hydrate(): Promise<void>;
}

const LOGIN_ACTOR = "system:login";

function sanitizeDisplayName(name: string): string {
  return name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 200);
}

function sanitizeUnitName(name: string): string {
  return name
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim()
    .slice(0, 200);
}

function normalizeNullableProfileValue(value: string | null, max: number): string | null | undefined {
  if (value === null) return null;
  const normalized = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (normalized.length === 0) return null;
  return normalized.length <= max ? normalized : undefined;
}

export function normalizeOrganizationUserProfilePatch(
  patch: OrganizationUserProfilePatch,
): { ok: true; patch: OrganizationUserProfilePatch } | { ok: false; field: keyof OrganizationUserProfilePatch } {
  const normalized: OrganizationUserProfilePatch = {};
  if (patch.displayName !== undefined) {
    const displayName = sanitizeDisplayName(patch.displayName);
    if (displayName.length === 0 || patch.displayName.replace(/[\x00-\x1f\x7f]/g, "").trim().length > 200) {
      return { ok: false, field: "displayName" };
    }
    normalized.displayName = displayName;
  }
  if (patch.email !== undefined) {
    const email = normalizeNullableProfileValue(patch.email, 254);
    if (email === undefined || (email !== null && (!email.includes("@") || /\s/.test(email)))) {
      return { ok: false, field: "email" };
    }
    normalized.email = email?.toLowerCase() ?? null;
  }
  for (const [field, max] of [
    ["jobTitle", 200],
    ["mobile", 32],
    ["employeeNumber", 100],
  ] as const) {
    if (patch[field] === undefined) continue;
    const value = normalizeNullableProfileValue(patch[field] ?? null, max);
    if (value === undefined) return { ok: false, field };
    normalized[field] = value;
  }
  return { ok: true, patch: normalized };
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
  resolveLegacyRuntimeUser?: (principalId: string) => Promise<boolean>;
}): OrganizationService {
  const { store, orgId, admission, identity, auditLog } = deps;
  const now = deps.now ?? Date.now;
  const autoJoinDomains = deps.autoJoinDomains.map((d) => d.toLowerCase());
  const scopeLabel = `org:${orgId}`;
  const directory = createDirectoryVisibilityResolver({ store, orgId });
  const cache = new Map<string, ActiveCheck>();
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  function userEvent(action: string, principalId: string, status?: string, actor = principalId): AuditEvent {
    return {
      at: now(),
      principalId: actor,
      action,
      resource: principalId,
      scopeLabel,
      orgId,
      actorKind: actor.startsWith("system:") ? "system" : "user",
      source: "organization",
      result: action.endsWith("denied") ? "denied" : "success",
      ...(status ? { status } : {}),
    };
  }

  function orgEvent(
    action: string,
    resource: string,
    actor: string,
    detail: Record<string, string | null>,
  ): AuditEvent {
    return {
      at: now(),
      principalId: actor,
      action,
      resource,
      scopeLabel,
      orgId,
      actorKind: actor.startsWith("system:") ? "system" : "user",
      source: "organization",
      result: "success",
      detail: JSON.stringify(detail),
    };
  }

  function cacheUser(user: OrganizationUser): void {
    cache.set(personKey(user.principalId), { status: user.status, sessionVersion: user.sessionVersion });
  }

  function linkedIdentity(input: LoginInput, principalId: string, at: number) {
    return {
      orgId,
      issuer: input.issuer,
      subject: input.subject,
      principalId,
      emailAtLink: input.email,
      createdAt: at,
      updatedAt: at,
    };
  }

  function withLoginProfile(user: OrganizationUser, input: LoginInput): OrganizationUser {
    const at = now();
    const loginAt = Math.max(at, user.lastLoginAt ?? at);
    const displayName = user.displayName.trim() ? user.displayName : sanitizeDisplayName(input.displayName);
    const email = user.email ?? (input.email?.trim().toLowerCase() || null);
    const profileChanged = displayName !== user.displayName || email !== user.email;
    return {
      ...user,
      displayName,
      email,
      profileRevision: user.profileRevision + (profileChanged ? 1 : 0),
      lastLoginAt: loginAt,
      updatedAt: Math.max(loginAt, user.updatedAt),
      updatedBy: LOGIN_ACTOR,
    };
  }

  function autoJoinAdmits(input: LoginInput): boolean {
    if (admission !== "domain_auto_join") return false;
    if (input.email === null) return false;
    return autoJoinDomains.length === 0 || autoJoinDomains.includes(emailDomain(input.email));
  }

  async function managerCanWriteUnit(tx: OrganizationTx, actor: string, unitId: string): Promise<boolean> {
    const actorUser = await tx.getUser(orgId, actor);
    if (!actorUser || actorUser.status !== "active") return false;
    return (await tx.listManagedSubtreeUnitIds(orgId, actor)).includes(unitId);
  }

  async function managerCanWriteGroup(tx: OrganizationTx, actor: string, groupId: string): Promise<boolean> {
    const actorUser = await tx.getUser(orgId, actor);
    if (!actorUser || actorUser.status !== "active") return false;
    return (await tx.listGroupMembers(orgId, groupId)).some(
      (member) => member.principalId === actor && member.role === "manager",
    );
  }

  async function login(input: LoginInput): Promise<LoginResult> {
    let reactivatePrincipal: string | null = null;
    const result = await store.transact(orgId, async (tx): Promise<LoginResult> => {
      const bound = await tx.getIdentity(orgId, input.issuer, input.subject);
      if (bound) {
        const user = await tx.getUser(orgId, bound.principalId);
        if (!user) {
          await tx.audit(userEvent("org.user.login_denied", bound.principalId, "unknown"));
          return { status: "denied", reason: "unknown" };
        }
        if (user.status === "active") {
          const next = withLoginProfile(user, input);
          await tx.putIdentity({
            ...bound,
            emailAtLink: input.email,
            updatedAt: now(),
          });
          await tx.putUser(next);
          await tx.audit(userEvent("org.user.login", next.principalId));
          reactivatePrincipal = next.principalId;
          return { status: "ok", user: next };
        }
        if (user.status === "invited") {
          const next = withLoginProfile({ ...user, status: "active", sessionVersion: user.sessionVersion + 1 }, input);
          await tx.putIdentity({
            ...bound,
            emailAtLink: input.email,
            updatedAt: now(),
          });
          await tx.putUser(next);
          await tx.bumpRevision(orgId);
          await tx.audit(userEvent("org.user.activate", next.principalId));
          await tx.audit(userEvent("org.user.login", next.principalId));
          reactivatePrincipal = next.principalId;
          return { status: "ok", user: next };
        }
        await tx.audit(userEvent("org.user.login_denied", user.principalId, user.status));
        return { status: "denied", reason: user.status };
      }
      if (input.email !== null && input.emailVerified) {
        const matched = await tx.findUserByEmail(orgId, input.email);
        if (matched) {
          const canBind =
            matched.status === "invited" ||
            (matched.status === "active" && (await tx.listIdentitiesForUser(orgId, matched.principalId)).length === 0);
          if (canBind) {
            const at = now();
            const next = withLoginProfile(
              matched.status === "invited"
                ? { ...matched, status: "active", sessionVersion: matched.sessionVersion + 1 }
                : matched,
              input,
            );
            await tx.putIdentity(linkedIdentity(input, matched.principalId, at));
            await tx.putUser(next);
            if (matched.status === "invited") {
              await tx.bumpRevision(orgId);
              await tx.audit(userEvent("org.user.activate", next.principalId));
            }
            await tx.audit(userEvent("org.user.login", next.principalId));
            reactivatePrincipal = next.principalId;
            return { status: "ok", user: next };
          }
          const reason =
            matched.status === "suspended" || matched.status === "deprovisioned" ? matched.status : "unknown";
          await tx.audit(userEvent("org.user.login_denied", matched.principalId, reason));
          return { status: "denied", reason };
        }
      }
      if (autoJoinAdmits(input) && input.emailVerified) {
        const conflicting = await tx.getUser(orgId, input.principalId);
        if (conflicting) {
          const reason =
            conflicting.status === "suspended" || conflicting.status === "deprovisioned"
              ? conflicting.status
              : "unknown";
          await tx.audit(userEvent("org.user.login_denied", conflicting.principalId, reason));
          return { status: "denied", reason };
        }
        const at = now();
        const user: OrganizationUser = {
          orgId,
          principalId: input.principalId,
          email: input.email,
          displayName: sanitizeDisplayName(input.displayName),
          jobTitle: null,
          mobile: null,
          employeeNumber: null,
          status: "active",
          sessionVersion: 1,
          profileRevision: 1,
          createdAt: at,
          updatedAt: at,
          lastLoginAt: at,
          createdBy: LOGIN_ACTOR,
          updatedBy: LOGIN_ACTOR,
        };
        if (!(await tx.insertUser(user))) {
          await tx.audit(userEvent("org.user.login_denied", user.principalId, "unknown"));
          return { status: "denied", reason: "unknown" };
        }
        await tx.putIdentity(linkedIdentity(input, user.principalId, at));
        await tx.bumpRevision(orgId);
        await tx.audit(userEvent("org.user.auto_join", user.principalId));
        reactivatePrincipal = user.principalId;
        return { status: "ok", user };
      }
      const reason = autoJoinAdmits(input) && !input.emailVerified ? "email_unverified" : "not_invited";
      await tx.audit(userEvent("org.user.login_denied", input.principalId, reason));
      return { status: "denied", reason };
    });
    if (result.status === "ok") cacheUser(result.user);
    if (reactivatePrincipal && result.status === "ok") {
      await identity.reactivate(reactivatePrincipal, result.user.sessionVersion);
    }
    return result;
  }

  async function invite(input: {
    principalId: string;
    email: string | null;
    displayName: string;
    actor: string;
  }): Promise<OrganizationUser> {
    const user = await store.transact(orgId, async (tx) => {
      const existing = await tx.getUser(orgId, input.principalId);
      if (existing) return existing;
      const at = now();
      const created: OrganizationUser = {
        orgId,
        principalId: input.principalId,
        email: input.email,
        displayName: sanitizeDisplayName(input.displayName),
        jobTitle: null,
        mobile: null,
        employeeNumber: null,
        status: "invited",
        sessionVersion: 1,
        profileRevision: 1,
        createdAt: at,
        updatedAt: at,
        lastLoginAt: null,
        createdBy: input.actor,
        updatedBy: input.actor,
      };
      if (!(await tx.insertUser(created))) {
        const concurrent = await tx.getUser(orgId, input.principalId);
        if (concurrent) return concurrent;
        throw new Error(`organization user insert failed: ${input.principalId}`);
      }
      await tx.bumpRevision(orgId);
      await tx.audit(userEvent("org.user.invite", created.principalId, undefined, input.actor));
      return created;
    });
    cacheUser(user);
    if (user.status !== "active") await identity.deactivate(user.principalId, "manual", user.sessionVersion);
    return user;
  }

  async function provisionPlayground(principalId: string): Promise<OrganizationUser | null> {
    const user = await store.transact(orgId, async (tx) => {
      const existing = await tx.getUser(orgId, principalId);
      if (existing) return existing.status === "active" ? existing : null;
      const at = now();
      const created: OrganizationUser = {
        orgId,
        principalId,
        email: null,
        displayName: "Guest",
        jobTitle: null,
        mobile: null,
        employeeNumber: null,
        status: "active",
        sessionVersion: 1,
        profileRevision: 1,
        createdAt: at,
        updatedAt: at,
        lastLoginAt: at,
        createdBy: "system:playground",
        updatedBy: "system:playground",
      };
      if (!(await tx.insertUser(created))) {
        const concurrent = await tx.getUser(orgId, principalId);
        return concurrent?.status === "active" ? concurrent : null;
      }
      await tx.bumpRevision(orgId);
      await tx.audit(userEvent("org.user.playground_provision", principalId, "active", "system:playground"));
      return created;
    });
    if (!user) return null;
    cacheUser(user);
    await identity.reactivate(user.principalId, user.sessionVersion);
    return user;
  }

  async function backfillUser(input: {
    principalId: string;
    email: string | null;
    displayName: string;
  }): Promise<{ created: boolean; user: OrganizationUser }> {
    const result = await store.transact(orgId, async (tx) => {
      const existing =
        (await tx.getUser(orgId, input.principalId)) ??
        (input.email ? await tx.findUserByEmail(orgId, input.email) : null);
      if (existing) return { created: false, user: existing };
      const at = now();
      const user: OrganizationUser = {
        orgId,
        principalId: input.principalId,
        email: input.email,
        displayName: sanitizeDisplayName(input.displayName),
        jobTitle: null,
        mobile: null,
        employeeNumber: null,
        status: "active",
        sessionVersion: 1,
        profileRevision: 1,
        createdAt: at,
        updatedAt: at,
        lastLoginAt: null,
        createdBy: "system:migration",
        updatedBy: "system:migration",
      };
      if (!(await tx.insertUser(user))) {
        const concurrent =
          (await tx.getUser(orgId, input.principalId)) ??
          (input.email ? await tx.findUserByEmail(orgId, input.email) : null);
        if (concurrent) return { created: false, user: concurrent };
        throw new Error(`organization user backfill failed: ${input.principalId}`);
      }
      await tx.bumpRevision(orgId);
      await tx.audit(userEvent("org.user.backfill", user.principalId, "active", "system:migration"));
      return { created: true, user };
    });
    if (result.created) {
      cacheUser(result.user);
      await identity.reactivate(result.user.principalId, result.user.sessionVersion);
    }
    return result;
  }

  async function setStatus(input: {
    principalId: string;
    status: OrganizationUserStatus;
    actor: string;
  }): Promise<OrganizationUser | null> {
    const next = await store.transact(orgId, async (tx) => {
      const user = await tx.getUser(orgId, input.principalId);
      if (!user) return null;
      if (user.status === input.status) return user;
      const changed: OrganizationUser = {
        ...user,
        status: input.status,
        sessionVersion: user.sessionVersion + 1,
        updatedAt: Math.max(now(), user.updatedAt),
        updatedBy: input.actor,
      };
      await tx.putUser(changed);
      await tx.bumpRevision(orgId);
      await tx.audit(userEvent("org.user.status", changed.principalId, input.status, input.actor));
      return changed;
    });
    if (!next) return null;
    cacheUser(next);
    if (input.status !== "active") {
      await identity.deactivate(input.principalId, "manual", next.sessionVersion);
    } else {
      await identity.reactivate(input.principalId, next.sessionVersion);
    }
    return next;
  }

  async function changeManagedStatus(input: {
    principalId: string;
    status: "active" | "suspended" | "deprovisioned";
    actor: string;
  }): Promise<ManagedStatusResult> {
    const result = await store.transact(orgId, async (tx): Promise<ManagedStatusResult> => {
      const user = await tx.getUser(orgId, input.principalId);
      if (!user) return { ok: false, reason: "missing_user" };
      if (user.status === input.status) return { ok: true, user };
      const allowed =
        (user.status === "active" && (input.status === "suspended" || input.status === "deprovisioned")) ||
        (user.status === "suspended" && (input.status === "active" || input.status === "deprovisioned"));
      if (!allowed) return { ok: false, reason: "invalid_transition", current: user.status };
      const changed: OrganizationUser = {
        ...user,
        status: input.status,
        sessionVersion: user.sessionVersion + 1,
        updatedAt: Math.max(now(), user.updatedAt),
        updatedBy: input.actor,
      };
      await tx.putUser(changed);
      await tx.bumpRevision(orgId);
      await tx.audit(userEvent("org.user.status", changed.principalId, input.status, input.actor));
      return { ok: true, user: changed };
    });
    return finalizeManagedStatus(result);
  }

  async function finalizeManagedStatus(result: ManagedStatusResult): Promise<ManagedStatusResult> {
    if (!result.ok) return result;
    cacheUser(result.user);
    if (result.user.status === "active") {
      await identity.reactivate(result.user.principalId, result.user.sessionVersion);
    } else {
      await identity.deactivate(result.user.principalId, "manual", result.user.sessionVersion);
    }
    return result;
  }

  async function listOrganizationUsers(query: OrganizationUserListQuery): Promise<OrganizationUserPage> {
    return store.listOrganizationUsers(orgId, {
      ...query,
      query: query.query.trim(),
      limit: Math.max(1, Math.min(100, Math.floor(query.limit))),
    });
  }

  async function getOrganizationUserDetail(principalId: string): Promise<OrganizationUserDetail | null> {
    const user = await store.getUser(orgId, principalId);
    if (!user) return null;
    const [unitMembers, groupMembers, identities, recent] = await Promise.all([
      store.listUnitMembersForUsers(orgId, [principalId]),
      store.listGroupMembersForUsers(orgId, [principalId]),
      store.listIdentitiesForUser(orgId, principalId),
      auditLog.tail({ limit: 200, scopeLabel }),
    ]);
    return {
      user,
      unitMembers,
      groupMembers,
      identities,
      auditEvents: recent
        .filter((event) => event.resource === principalId || event.detail?.includes(`"principalId":"${principalId}"`))
        .slice(0, 20)
        .map((event) => ({ ...event })),
    };
  }

  async function updateUserProfile(input: {
    principalId: string;
    patch: OrganizationUserProfilePatch;
    expectedProfileRevision: number;
    actor: string;
  }): Promise<UpdateUserProfileResult> {
    const normalized = normalizeOrganizationUserProfilePatch(input.patch);
    if (!normalized.ok) return { ok: false, reason: "invalid_profile", field: normalized.field };
    return store.transact(orgId, async (tx): Promise<UpdateUserProfileResult> => {
      const user = await tx.getUser(orgId, input.principalId);
      if (!user) return { ok: false, reason: "missing_user" };
      if (user.profileRevision !== input.expectedProfileRevision) {
        await tx.audit({
          ...userEvent("org.user.profile_denied", user.principalId, "revision_conflict", input.actor),
          result: "denied",
        });
        return { ok: false, reason: "revision_conflict", current: user };
      }
      if (normalized.patch.email) {
        const duplicate = await tx.findUserByEmail(orgId, normalized.patch.email);
        if (duplicate && duplicate.principalId !== user.principalId) {
          return { ok: false, reason: "duplicate_email" };
        }
      }
      if (normalized.patch.employeeNumber) {
        const duplicate = await tx.findUserByEmployeeNumber(orgId, normalized.patch.employeeNumber);
        if (duplicate && duplicate.principalId !== user.principalId) {
          return { ok: false, reason: "duplicate_employee_number" };
        }
      }
      const changedFields = (Object.keys(normalized.patch) as Array<keyof OrganizationUserProfilePatch>).filter(
        (field) => normalized.patch[field] !== user[field],
      );
      if (changedFields.length === 0) return { ok: true, user };
      const changed: OrganizationUser = {
        ...user,
        ...normalized.patch,
        profileRevision: user.profileRevision + 1,
        updatedAt: Math.max(now(), user.updatedAt),
        updatedBy: input.actor,
      };
      await tx.putUser(changed);
      await tx.audit(
        orgEvent("org.user.profile", changed.principalId, input.actor, {
          principalId: changed.principalId,
          fields: changedFields.join(","),
        }),
      );
      return { ok: true, user: changed };
    });
  }

  async function setPrimaryUnit(input: {
    principalId: string;
    unitId: string | null;
    keepPreviousMembership: boolean;
    actor: string;
  }): Promise<SetPrimaryUnitResult> {
    const result = await store.transact(
      orgId,
      async (
        tx,
      ): Promise<
        { ok: true } | { ok: false; reason: "missing_user" | "missing_unit" | "archived" | "root" | "deprovisioned" }
      > => {
        const user = await tx.getUser(orgId, input.principalId);
        if (!user) return { ok: false, reason: "missing_user" };
        if (user.status === "deprovisioned") return { ok: false, reason: "deprovisioned" };
        if (input.unitId !== null) {
          const unit = await tx.getUnit(orgId, input.unitId);
          if (!unit) return { ok: false, reason: "missing_unit" };
          if (unit.status !== "active") return { ok: false, reason: "archived" };
          if (unit.kind === "organization") return { ok: false, reason: "root" };
        }
        const members = await tx.listUnitMembersForUser(orgId, input.principalId);
        const current = members.find((member) => member.isPrimary === true);
        if ((current?.unitId ?? null) === input.unitId) return { ok: true };
        if (current) {
          if (input.keepPreviousMembership) {
            await tx.putUnitMember({ ...current, isPrimary: false });
          } else {
            await tx.removeUnitMember(orgId, current.unitId, input.principalId);
          }
        }
        if (input.unitId !== null) {
          const target = members.find((member) => member.unitId === input.unitId);
          await tx.putUnitMember(
            target
              ? { ...target, isPrimary: true }
              : {
                  orgId,
                  unitId: input.unitId,
                  principalId: input.principalId,
                  role: "member",
                  isPrimary: true,
                  createdAt: now(),
                  createdBy: input.actor,
                },
          );
        }
        await tx.bumpRevision(orgId);
        await tx.audit(
          orgEvent("org.user.primary_unit", input.principalId, input.actor, {
            principalId: input.principalId,
            beforeUnitId: current?.unitId ?? null,
            afterUnitId: input.unitId,
            keepPreviousMembership: String(input.keepPreviousMembership),
          }),
        );
        return { ok: true };
      },
    );
    if (!result.ok) return result;
    const detail = await getOrganizationUserDetail(input.principalId);
    return detail ? { ok: true, detail } : { ok: false, reason: "missing_user" };
  }

  async function statusImpact(principalId: string): Promise<OrganizationUserStatusImpact | null> {
    return store.transact(orgId, async (tx) => {
      if (!(await tx.getUser(orgId, principalId))) return null;
      const [unitMembers, groupMembers, directoryPolicy, directSkillGrants] = await Promise.all([
        tx.listUnitMembersForUser(orgId, principalId),
        tx.listGroupMembersForUser(orgId, principalId),
        tx.getDirectoryPolicy(orgId, "user", principalId),
        tx.countSkillAccessGrantsForSubject(orgId, personalScope(principalId)),
      ]);
      return {
        primaryUnitId: unitMembers.find((member) => member.isPrimary === true)?.unitId ?? null,
        unitCount: unitMembers.length,
        unitManagerCount: unitMembers.filter((member) => member.role === "manager").length,
        groupCount: groupMembers.length,
        groupManagerCount: groupMembers.filter((member) => member.role === "manager").length,
        directAuthorizationCount: directSkillGrants + (directoryPolicy ? 1 : 0),
      };
    });
  }

  async function applyMemberMutations(input: {
    mutations: readonly OrganizationMemberMutation[];
    expectedAuthzRevision: number;
    actor: string;
    idempotencyKey: string;
  }): Promise<ApplyOrganizationMemberMutationsResult> {
    const transactionResult = await store.transact(
      orgId,
      async (tx): Promise<ApplyOrganizationMemberMutationsResult & { replayed?: boolean }> => {
        const currentAuthzRevision = await tx.getAuthzRevision(orgId);
        const summaryAuditKey = `${input.idempotencyKey}:summary`;
        const storedResult = await tx.getOperationResult(summaryAuditKey);
        if (storedResult) {
          return {
            ok: true,
            users: (storedResult.users ?? []) as OrganizationUser[],
            authorizationRevision: Number(storedResult.authorizationRevision),
            replayed: true,
          };
        }
        if (await tx.hasAudit(summaryAuditKey)) {
          const users = (
            await Promise.all(input.mutations.map((mutation) => tx.getUser(orgId, mutation.principalId)))
          ).filter((user): user is OrganizationUser => user !== null);
          return { ok: true, users, authorizationRevision: currentAuthzRevision, replayed: true };
        }
        if (currentAuthzRevision !== input.expectedAuthzRevision) {
          return { ok: false, reason: "authorization_revision_conflict" };
        }
        const allUsers = await tx.listUsers(orgId);
        const users = new Map(allUsers.map((user) => [user.principalId, user]));
        const normalizedProfiles = new Map<string, OrganizationUserProfilePatch>();
        for (const mutation of input.mutations) {
          const user = users.get(mutation.principalId);
          if (!user) return { ok: false, reason: "missing_user", principalId: mutation.principalId };
          if (user.profileRevision !== mutation.expectedProfileRevision) {
            return { ok: false, reason: "profile_revision_conflict", principalId: mutation.principalId };
          }
          if (mutation.profile) {
            const normalized = normalizeOrganizationUserProfilePatch(mutation.profile);
            if (!normalized.ok) return { ok: false, reason: "invalid_profile", principalId: mutation.principalId };
            normalizedProfiles.set(mutation.principalId, normalized.patch);
          }
        }
        const finalUsers = allUsers.map((user) => ({ ...user, ...(normalizedProfiles.get(user.principalId) ?? {}) }));
        const emails = new Map<string, string>();
        const employeeNumbers = new Map<string, string>();
        for (const user of finalUsers) {
          if (user.email) {
            const key = user.email.toLowerCase();
            const existing = emails.get(key);
            if (existing && existing !== user.principalId) {
              return { ok: false, reason: "duplicate_email", principalId: user.principalId };
            }
            emails.set(key, user.principalId);
          }
          if (user.employeeNumber) {
            const key = user.employeeNumber.toLowerCase();
            const existing = employeeNumbers.get(key);
            if (existing && existing !== user.principalId) {
              return { ok: false, reason: "duplicate_employee_number", principalId: user.principalId };
            }
            employeeNumbers.set(key, user.principalId);
          }
        }
        const unitIds = new Set(
          input.mutations.flatMap((mutation) => [
            ...(mutation.primaryUnit?.unitId ? [mutation.primaryUnit.unitId] : []),
            ...(mutation.addUnitIds ?? []),
            ...(mutation.removeUnitIds ?? []),
          ]),
        );
        const groupIds = new Set(
          input.mutations.flatMap((mutation) => [...(mutation.addGroupIds ?? []), ...(mutation.removeGroupIds ?? [])]),
        );
        const units = new Map<string, OrgUnit>();
        for (const unitId of unitIds) {
          const unit = await tx.getUnit(orgId, unitId);
          if (!unit) return { ok: false, reason: "missing_unit" };
          if (unit.status !== "active") return { ok: false, reason: "archived_unit" };
          if (
            unit.kind === "organization" &&
            input.mutations.some((mutation) => mutation.primaryUnit?.unitId === unitId)
          ) {
            return { ok: false, reason: "root_unit" };
          }
          units.set(unitId, unit);
        }
        const groups = new Map<string, AccessGroup>();
        for (const groupId of groupIds) {
          const group = await tx.getGroup(orgId, groupId);
          if (!group) return { ok: false, reason: "missing_group" };
          if (group.status !== "active") return { ok: false, reason: "archived_group" };
          groups.set(groupId, group);
        }
        const unitMembers = new Map<string, OrgUnitMember[]>();
        const groupMembers = new Map<string, AccessGroupMember[]>();
        for (const mutation of input.mutations) {
          const directUnits = await tx.listUnitMembersForUser(orgId, mutation.principalId);
          const directGroups = await tx.listGroupMembersForUser(orgId, mutation.principalId);
          unitMembers.set(mutation.principalId, directUnits);
          groupMembers.set(mutation.principalId, directGroups);
          for (const unitId of mutation.removeUnitIds ?? []) {
            const member = directUnits.find((candidate) => candidate.unitId === unitId);
            if (member?.role === "manager") {
              return { ok: false, reason: "manager_conflict", principalId: mutation.principalId };
            }
            if (member?.isPrimary === true && mutation.primaryUnit === undefined) {
              return { ok: false, reason: "primary_unit_conflict", principalId: mutation.principalId };
            }
          }
          for (const groupId of mutation.removeGroupIds ?? []) {
            if (directGroups.find((candidate) => candidate.groupId === groupId)?.role === "manager") {
              return { ok: false, reason: "manager_conflict", principalId: mutation.principalId };
            }
          }
          if (mutation.status) {
            const user = users.get(mutation.principalId)!;
            const allowed =
              user.status === mutation.status ||
              (user.status === "active" && (mutation.status === "suspended" || mutation.status === "deprovisioned")) ||
              (user.status === "suspended" && (mutation.status === "active" || mutation.status === "deprovisioned"));
            if (!allowed) return { ok: false, reason: "invalid_transition", principalId: mutation.principalId };
          }
        }
        let authorizationChanged = false;
        const changedUsers: OrganizationUser[] = [];
        for (const mutation of input.mutations) {
          let memberAuthorizationChanged = false;
          let user = users.get(mutation.principalId)!;
          const profile = normalizedProfiles.get(mutation.principalId);
          const profileChanged =
            profile !== undefined &&
            (Object.keys(profile) as Array<keyof OrganizationUserProfilePatch>).some(
              (field) => profile[field] !== user[field],
            );
          if (profileChanged) {
            user = {
              ...user,
              ...profile,
              profileRevision: user.profileRevision + 1,
              updatedAt: Math.max(now(), user.updatedAt),
              updatedBy: input.actor,
            };
            await tx.putUser(user);
          }
          let directUnits = [...(unitMembers.get(mutation.principalId) ?? [])];
          if (mutation.primaryUnit !== undefined) {
            const current = directUnits.find((member) => member.isPrimary === true);
            if ((current?.unitId ?? null) !== mutation.primaryUnit.unitId) {
              memberAuthorizationChanged = true;
              authorizationChanged = true;
              if (current) {
                if (mutation.primaryUnit.keepPreviousMembership) {
                  const cleared = { ...current, isPrimary: false };
                  await tx.putUnitMember(cleared);
                  directUnits = directUnits.map((member) => (member.unitId === current.unitId ? cleared : member));
                } else {
                  await tx.removeUnitMember(orgId, current.unitId, mutation.principalId);
                  directUnits = directUnits.filter((member) => member.unitId !== current.unitId);
                }
              }
              if (mutation.primaryUnit.unitId !== null) {
                const existing = directUnits.find((member) => member.unitId === mutation.primaryUnit!.unitId);
                const primary: OrgUnitMember = existing
                  ? { ...existing, isPrimary: true }
                  : {
                      orgId,
                      unitId: mutation.primaryUnit.unitId,
                      principalId: mutation.principalId,
                      role: "member",
                      isPrimary: true,
                      createdAt: now(),
                      createdBy: input.actor,
                    };
                await tx.putUnitMember(primary);
                directUnits = [...directUnits.filter((member) => member.unitId !== primary.unitId), primary];
              }
            }
          }
          for (const unitId of mutation.addUnitIds ?? []) {
            if (directUnits.some((member) => member.unitId === unitId)) continue;
            const member: OrgUnitMember = {
              orgId,
              unitId,
              principalId: mutation.principalId,
              role: "member",
              isPrimary: false,
              createdAt: now(),
              createdBy: input.actor,
            };
            await tx.putUnitMember(member);
            directUnits.push(member);
            memberAuthorizationChanged = true;
            authorizationChanged = true;
          }
          for (const unitId of mutation.removeUnitIds ?? []) {
            const existing = directUnits.find((member) => member.unitId === unitId);
            if (!existing || existing.role === "manager") continue;
            await tx.removeUnitMember(orgId, unitId, mutation.principalId);
            directUnits = directUnits.filter((member) => member.unitId !== unitId);
            memberAuthorizationChanged = true;
            authorizationChanged = true;
          }
          let directGroups = [...(groupMembers.get(mutation.principalId) ?? [])];
          for (const groupId of mutation.addGroupIds ?? []) {
            if (directGroups.some((member) => member.groupId === groupId)) continue;
            const member: AccessGroupMember = {
              orgId,
              groupId,
              principalId: mutation.principalId,
              role: "member",
              createdAt: now(),
              createdBy: input.actor,
            };
            await tx.putGroupMember(member);
            directGroups.push(member);
            memberAuthorizationChanged = true;
            authorizationChanged = true;
          }
          for (const groupId of mutation.removeGroupIds ?? []) {
            const existing = directGroups.find((member) => member.groupId === groupId);
            if (!existing || existing.role === "manager") continue;
            await tx.removeGroupMember(orgId, groupId, mutation.principalId);
            directGroups = directGroups.filter((member) => member.groupId !== groupId);
            memberAuthorizationChanged = true;
            authorizationChanged = true;
          }
          if (mutation.status && mutation.status !== user.status) {
            user = {
              ...user,
              status: mutation.status,
              sessionVersion: user.sessionVersion + 1,
              updatedAt: Math.max(now(), user.updatedAt),
              updatedBy: input.actor,
            };
            await tx.putUser(user);
            memberAuthorizationChanged = true;
            authorizationChanged = true;
          }
          if (profileChanged || memberAuthorizationChanged) {
            await tx.audit({
              ...orgEvent("org.user.batch", mutation.principalId, input.actor, {
                principalId: mutation.principalId,
                profile: String(profileChanged),
                status: mutation.status ?? null,
              }),
              idempotencyKey: `${input.idempotencyKey}:member:${mutation.principalId}`,
            });
          }
          changedUsers.push(user);
        }
        const authorizationRevision = authorizationChanged ? await tx.bumpRevision(orgId) : currentAuthzRevision;
        await tx.audit({
          ...orgEvent("org.user.batch.summary", `member-job:${input.idempotencyKey}`, input.actor, {
            count: String(input.mutations.length),
            authorizationChanged: String(authorizationChanged),
          }),
          idempotencyKey: summaryAuditKey,
        });
        await tx.putOperationResult(summaryAuditKey, {
          users: changedUsers,
          authorizationRevision,
        });
        return { ok: true, users: changedUsers, authorizationRevision };
      },
    );
    if (!transactionResult.ok) return transactionResult;
    const { replayed = false, ...result } = transactionResult;
    if (replayed) return result;
    const changedById = new Map(result.users.map((user) => [user.principalId, user]));
    for (const mutation of input.mutations) {
      if (!mutation.status) continue;
      const user = changedById.get(mutation.principalId);
      if (!user) continue;
      cacheUser(user);
      if (user.status === "active") await identity.reactivate(user.principalId, user.sessionVersion);
      else await identity.deactivate(user.principalId, "manual", user.sessionVersion);
    }
    return result;
  }

  async function createUnit(input: {
    parentId: string | null;
    name: string;
    kind: OrgUnitKind;
    sortOrder?: number;
    actor: string;
  }): Promise<OrgUnit> {
    return store.transact(orgId, async (tx) => {
      if (input.parentId === null) {
        const units = await tx.listUnits(orgId);
        if (units.some((u) => u.parentId === null && u.status === "active")) {
          throw new Error("org root already exists");
        }
      } else {
        const parent = await tx.getUnit(orgId, input.parentId);
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
      await tx.putUnit(unit);
      await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.unit.create", `unit:${unit.id}`, input.actor, { unitId: unit.id, parentId: unit.parentId }),
      );
      return unit;
    });
  }

  async function updateUnit(input: {
    unitId: string;
    name?: string;
    sortOrder?: number;
    status?: OrgUnitStatus;
    actor: string;
  }): Promise<OrgUnit | null> {
    return store.transact(orgId, async (tx) => {
      const unit = await tx.getUnit(orgId, input.unitId);
      if (!unit) return null;
      if (unit.parentId === null && input.status === "archived") throw new Error("org root must remain active");
      if (input.status === "active" && unit.parentId !== null) {
        const parent = await tx.getUnit(orgId, unit.parentId);
        if (!parent || parent.status !== "active") return null;
      }
      const next: OrgUnit = {
        ...unit,
        name: input.name !== undefined ? sanitizeUnitName(input.name) : unit.name,
        sortOrder: input.sortOrder ?? unit.sortOrder,
        status: input.status ?? unit.status,
        updatedAt: Math.max(now(), unit.updatedAt),
        updatedBy: input.actor,
      };
      await tx.putUnit(next);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.unit.update", `unit:${next.id}`, input.actor, { unitId: next.id }));
      return next;
    });
  }

  async function moveUnit(input: { unitId: string; newParentId: string; actor: string }): Promise<MoveUnitResult> {
    return store.transact(orgId, async (tx): Promise<MoveUnitResult> => {
      const unit = await tx.getUnit(orgId, input.unitId);
      if (!unit || unit.status !== "active") return { ok: false, reason: "archived" };
      if (unit.parentId === null) return { ok: false, reason: "root" };
      if (unit.parentId === input.newParentId) return { ok: true };
      const parent = await tx.getUnit(orgId, input.newParentId);
      if (!parent) return { ok: false, reason: "missing_parent" };
      if (parent.status !== "active") return { ok: false, reason: "archived" };
      if (input.newParentId === input.unitId || (await tx.isDescendant(orgId, input.unitId, input.newParentId))) {
        return { ok: false, reason: "self_or_descendant" };
      }
      await tx.moveUnitSubtree(orgId, input.unitId, input.newParentId);
      await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.unit.move", `unit:${input.unitId}`, input.actor, {
          unitId: input.unitId,
          parentId: input.newParentId,
        }),
      );
      return { ok: true };
    });
  }

  async function previewMoveUnit(input: { unitId: string; newParentId: string }): Promise<MoveUnitPreviewResult> {
    return store.transact(orgId, async (tx): Promise<MoveUnitPreviewResult> => {
      const unit = await tx.getUnit(orgId, input.unitId);
      if (!unit || unit.status !== "active") return { ok: false, reason: "archived" };
      if (unit.parentId === null) return { ok: false, reason: "root" };
      if (unit.parentId === input.newParentId) {
        return { ok: true, impact: { activeUnits: 0, activeMembers: 0 } };
      }
      const parent = await tx.getUnit(orgId, input.newParentId);
      if (!parent) return { ok: false, reason: "missing_parent" };
      if (parent.status !== "active") return { ok: false, reason: "archived" };
      if (input.newParentId === input.unitId || (await tx.isDescendant(orgId, input.unitId, input.newParentId))) {
        return { ok: false, reason: "self_or_descendant" };
      }
      return { ok: true, impact: await tx.subtreeImpact(orgId, input.unitId) };
    });
  }

  async function archiveUnit(input: { unitId: string; actor: string }): Promise<ArchiveUnitResult> {
    return store.transact(orgId, async (tx): Promise<ArchiveUnitResult> => {
      const unit = await tx.getUnit(orgId, input.unitId);
      if (!unit || unit.parentId === null) return { ok: false, reason: "root" };
      const impact = await tx.unitImpact(orgId, input.unitId);
      if (
        impact.activeChildUnits > 0 ||
        impact.activeMembers > 0 ||
        impact.directoryRoots > 0 ||
        impact.skillGrants > 0
      ) {
        return { ok: false, reason: "conflict", impact };
      }
      const next: OrgUnit = {
        ...unit,
        status: "archived",
        updatedAt: Math.max(now(), unit.updatedAt),
        updatedBy: input.actor,
      };
      await tx.putUnit(next);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.unit.archive", `unit:${next.id}`, input.actor, { unitId: next.id }));
      return { ok: true };
    });
  }

  async function addUnitMembers(input: {
    unitId: string;
    principalIds: string[];
    role: OrgMemberRole;
    actor: string;
    asManager?: boolean;
  }): Promise<AddUnitMemberResult> {
    return store.transact(orgId, async (tx): Promise<AddUnitMemberResult> => {
      const unit = await tx.getUnit(orgId, input.unitId);
      if (!unit) return { ok: false, reason: "missing_unit" };
      if (input.asManager && unit.status !== "active") return { ok: false, reason: "missing_unit" };
      if (unit.status !== "active") return { ok: false, reason: "archived" };
      const existing = new Map(
        (await tx.listUnitMembers(orgId, input.unitId)).map((member) => [member.principalId, member]),
      );
      if (
        input.asManager &&
        (input.role !== "member" ||
          input.principalIds.some((principalId) => existing.get(principalId)?.role === "manager") ||
          !(await managerCanWriteUnit(tx, input.actor, input.unitId)))
      ) {
        return { ok: false, reason: "forbidden" };
      }
      const invalidPrincipalIds: string[] = [];
      for (const principalId of input.principalIds) {
        const user = await tx.getUser(orgId, principalId);
        if (!user || user.status !== "active") invalidPrincipalIds.push(principalId);
      }
      if (invalidPrincipalIds.length > 0) return { ok: false, reason: "missing_user", invalidPrincipalIds };
      const changed = input.principalIds.filter((principalId) => existing.get(principalId)?.role !== input.role);
      if (changed.length === 0) return { ok: true };
      for (const principalId of changed) {
        const prior = existing.get(principalId);
        const member: OrgUnitMember = prior
          ? { ...prior, role: input.role }
          : {
              orgId,
              unitId: input.unitId,
              principalId,
              role: input.role,
              isPrimary: false,
              createdAt: now(),
              createdBy: input.actor,
            };
        await tx.putUnitMember(member);
      }
      await tx.bumpRevision(orgId);
      for (const principalId of changed) {
        await tx.audit(
          orgEvent("org.unit.member.add", `unit:${input.unitId}`, input.actor, {
            unitId: input.unitId,
            principalId,
            role: input.role,
          }),
        );
      }
      return { ok: true };
    });
  }

  async function addUnitMember(input: {
    unitId: string;
    principalId: string;
    role: OrgMemberRole;
    actor: string;
    asManager?: boolean;
  }): Promise<AddUnitMemberResult> {
    return addUnitMembers({ ...input, principalIds: [input.principalId] });
  }

  async function removeUnitMember(input: {
    unitId: string;
    principalId: string;
    actor: string;
    asManager?: boolean;
  }): Promise<RemoveUnitMemberResult> {
    return store.transact(orgId, async (tx): Promise<RemoveUnitMemberResult> => {
      const unit = await tx.getUnit(orgId, input.unitId);
      if (!unit) return { ok: false, reason: "missing_unit" };
      if (input.asManager && unit.status !== "active") return { ok: false, reason: "missing_unit" };
      const existing = (await tx.listUnitMembers(orgId, input.unitId)).find(
        (member) => member.principalId === input.principalId,
      );
      if (
        input.asManager &&
        (existing?.role === "manager" || !(await managerCanWriteUnit(tx, input.actor, input.unitId)))
      ) {
        return { ok: false, reason: "forbidden" };
      }
      if (!existing) return { ok: true };
      if (existing.isPrimary === true) return { ok: false, reason: "primary_unit" };
      await tx.removeUnitMember(orgId, input.unitId, input.principalId);
      await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.unit.member.remove", `unit:${input.unitId}`, input.actor, {
          unitId: input.unitId,
          principalId: input.principalId,
        }),
      );
      return { ok: true };
    });
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
    await store.transact(orgId, async (tx) => {
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
    return store.transact(orgId, async (tx) => {
      const group = await tx.getGroup(orgId, input.groupId);
      if (!group) return null;
      const next: AccessGroup = {
        ...group,
        name: input.name !== undefined ? sanitizeDisplayName(input.name) : group.name,
        status: input.status ?? group.status,
        updatedAt: Math.max(now(), group.updatedAt),
        updatedBy: input.actor,
      };
      await tx.putGroup(next);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.group.update", `group:${next.id}`, input.actor, { groupId: next.id }));
      return next;
    });
  }

  async function archiveGroup(input: { groupId: string; actor: string }): Promise<ArchiveGroupResult> {
    return store.transact(orgId, async (tx): Promise<ArchiveGroupResult> => {
      const group = await tx.getGroup(orgId, input.groupId);
      if (!group || group.status === "archived") return { ok: true };
      if (
        (await tx.getDirectoryPolicy(orgId, "access_group", input.groupId)) ||
        (await tx.countSkillAccessGrantsForSubject(orgId, `access-group:${input.groupId}` as ScopeId)) > 0
      ) {
        return { ok: false, reason: "conflict" };
      }
      const next: AccessGroup = {
        ...group,
        status: "archived",
        updatedAt: Math.max(now(), group.updatedAt),
        updatedBy: input.actor,
      };
      await tx.putGroup(next);
      await tx.bumpRevision(orgId);
      await tx.audit(orgEvent("org.group.archive", `group:${next.id}`, input.actor, { groupId: next.id }));
      return { ok: true };
    });
  }

  async function addGroupMembers(input: {
    groupId: string;
    principalIds: string[];
    role: OrgMemberRole;
    actor: string;
    asManager?: boolean;
  }): Promise<AddGroupMemberResult> {
    return store.transact(orgId, async (tx): Promise<AddGroupMemberResult> => {
      const group = await tx.getGroup(orgId, input.groupId);
      if (!group || (input.asManager && group.status !== "active")) return { ok: false, reason: "missing_group" };
      if (group.status !== "active") return { ok: false, reason: "archived" };
      const existing = new Map(
        (await tx.listGroupMembers(orgId, input.groupId)).map((member) => [member.principalId, member]),
      );
      if (
        input.asManager &&
        (input.role !== "member" ||
          input.principalIds.some((principalId) => existing.get(principalId)?.role === "manager") ||
          !(await managerCanWriteGroup(tx, input.actor, input.groupId)))
      ) {
        return { ok: false, reason: "forbidden" };
      }
      const invalidPrincipalIds: string[] = [];
      for (const principalId of input.principalIds) {
        const user = await tx.getUser(orgId, principalId);
        if (!user || user.status !== "active") invalidPrincipalIds.push(principalId);
      }
      if (invalidPrincipalIds.length > 0) return { ok: false, reason: "missing_user", invalidPrincipalIds };
      const changed = input.principalIds.filter((principalId) => existing.get(principalId)?.role !== input.role);
      if (changed.length === 0) return { ok: true };
      for (const principalId of changed) {
        const prior = existing.get(principalId);
        const member: AccessGroupMember = prior
          ? { ...prior, role: input.role }
          : {
              orgId,
              groupId: input.groupId,
              principalId,
              role: input.role,
              createdAt: now(),
              createdBy: input.actor,
            };
        await tx.putGroupMember(member);
      }
      await tx.bumpRevision(orgId);
      for (const principalId of changed) {
        await tx.audit(
          orgEvent("org.group.member.add", `group:${input.groupId}`, input.actor, {
            groupId: input.groupId,
            principalId,
            role: input.role,
          }),
        );
      }
      return { ok: true };
    });
  }

  async function addGroupMember(input: {
    groupId: string;
    principalId: string;
    role: OrgMemberRole;
    actor: string;
    asManager?: boolean;
  }): Promise<AddGroupMemberResult> {
    return addGroupMembers({ ...input, principalIds: [input.principalId] });
  }

  async function removeGroupMember(input: {
    groupId: string;
    principalId: string;
    actor: string;
    asManager?: boolean;
  }): Promise<RemoveGroupMemberResult> {
    return store.transact(orgId, async (tx): Promise<RemoveGroupMemberResult> => {
      const group = await tx.getGroup(orgId, input.groupId);
      if (!group) return { ok: false, reason: "missing_group" };
      if (input.asManager && group.status !== "active") return { ok: false, reason: "missing_group" };
      const existing = (await tx.listGroupMembers(orgId, input.groupId)).find(
        (member) => member.principalId === input.principalId,
      );
      if (
        input.asManager &&
        (existing?.role === "manager" || !(await managerCanWriteGroup(tx, input.actor, input.groupId)))
      ) {
        return { ok: false, reason: "forbidden" };
      }
      if (!existing) return { ok: true };
      await tx.removeGroupMember(orgId, input.groupId, input.principalId);
      await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.group.member.remove", `group:${input.groupId}`, input.actor, {
          groupId: input.groupId,
          principalId: input.principalId,
        }),
      );
      return { ok: true };
    });
  }

  async function refresh(): Promise<void> {
    if (refreshP) return refreshP;
    refreshP = store
      .listUsers(orgId)
      .then((users) => {
        cache.clear();
        for (const user of users) cacheUser(user);
      })
      .finally(() => {
        refreshP = null;
      });
    return refreshP;
  }

  async function directoryPolicy(
    subjectKind: DirectorySubjectKind,
    subjectId: string,
  ): Promise<{ policy: DirectoryViewPolicy; roots: DirectoryViewRoot[] } | null> {
    const policy = await store.getDirectoryPolicy(orgId, subjectKind, subjectId);
    if (!policy) return null;
    return { policy, roots: await store.listDirectoryRoots(orgId, policy.id) };
  }

  async function subjectExists(
    tx: OrganizationTx,
    subjectKind: DirectorySubjectKind,
    subjectId: string,
  ): Promise<boolean> {
    if (subjectKind === "user") return (await tx.getUser(orgId, subjectId))?.status === "active";
    if (subjectKind === "org_unit") return (await tx.getUnit(orgId, subjectId))?.status === "active";
    return (await tx.getGroup(orgId, subjectId))?.status === "active";
  }

  async function normalizedPolicyRoots(
    tx: OrganizationTx,
    policyId: string,
    roots: Array<{ unitId: string; includeDescendants: boolean }>,
  ): Promise<DirectoryViewRoot[] | null> {
    const byUnit = new Map<string, boolean>();
    for (const root of roots) {
      const unit = await tx.getUnit(orgId, root.unitId);
      if (!unit || unit.status !== "active") return null;
      byUnit.set(root.unitId, root.includeDescendants || byUnit.get(root.unitId) === true);
    }
    const values = [...byUnit].sort(([left], [right]) => left.localeCompare(right));
    const normalized: DirectoryViewRoot[] = [];
    for (const [unitId, includeDescendants] of values) {
      let covered = false;
      for (const [otherId, otherIncludesDescendants] of values) {
        if (otherId !== unitId && otherIncludesDescendants && (await tx.isDescendant(orgId, otherId, unitId))) {
          covered = true;
          break;
        }
      }
      if (!covered) normalized.push({ orgId, policyId, unitId, includeDescendants });
    }
    return normalized;
  }

  async function setDirectoryPolicy(input: {
    subjectKind: DirectorySubjectKind;
    subjectId: string;
    mode: DirectoryViewMode;
    roots: Array<{ unitId: string; includeDescendants: boolean }>;
    expectedRevision: number;
    actor: string;
  }): Promise<DirectoryPolicyResult> {
    return store.transact(orgId, async (tx): Promise<DirectoryPolicyResult> => {
      if (!(await subjectExists(tx, input.subjectKind, input.subjectId))) {
        return { ok: false, reason: "missing_subject" };
      }
      const current = await tx.getDirectoryPolicy(orgId, input.subjectKind, input.subjectId);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        return {
          ok: false,
          reason: "revision_conflict",
          currentRevision,
          policy: current,
          roots: current ? await tx.listDirectoryRoots(orgId, current.id) : [],
        };
      }
      const at = now();
      const policy: DirectoryViewPolicy = {
        id: current?.id ?? `dir-${randomUUID()}`,
        orgId,
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        mode: input.mode,
        revision: currentRevision + 1,
        createdAt: current?.createdAt ?? at,
        updatedAt: at,
        updatedBy: input.actor,
      };
      const roots =
        input.mode === "limited"
          ? await normalizedPolicyRoots(tx, policy.id, input.roots)
          : ([] as DirectoryViewRoot[]);
      if (roots === null) return { ok: false, reason: "missing_root" };
      await tx.putDirectoryPolicy(policy);
      await tx.replaceDirectoryRoots(orgId, policy.id, roots);
      const authzRevision = await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.directory_visibility.update", `directory-policy:${policy.id}`, input.actor, {
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          mode: input.mode,
        }),
      );
      return { ok: true, policy, roots, authzRevision };
    });
  }

  async function deleteDirectoryPolicy(input: {
    subjectKind: DirectorySubjectKind;
    subjectId: string;
    expectedRevision: number;
    actor: string;
  }): Promise<DeleteDirectoryPolicyResult> {
    return store.transact(orgId, async (tx): Promise<DeleteDirectoryPolicyResult> => {
      const current = await tx.getDirectoryPolicy(orgId, input.subjectKind, input.subjectId);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== input.expectedRevision) {
        return {
          ok: false,
          reason: "revision_conflict",
          currentRevision,
          policy: current,
          roots: current ? await tx.listDirectoryRoots(orgId, current.id) : [],
        };
      }
      if (!current) return { ok: true, authzRevision: await tx.getAuthzRevision(orgId) };
      await tx.deleteDirectoryPolicy(orgId, input.subjectKind, input.subjectId);
      const authzRevision = await tx.bumpRevision(orgId);
      await tx.audit(
        orgEvent("org.directory_visibility.delete", `directory-policy:${current.id}`, input.actor, {
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          mode: null,
        }),
      );
      return { ok: true, authzRevision };
    });
  }

  async function resolveAccessSubject(scopeId: ScopeId): Promise<OrganizationAccessSubject | null> {
    const subject = organizationAccessSubjectFromScope(scopeId);
    if (!subject) return null;
    if (subject.kind === "user") {
      const user = await store.getUser(orgId, subject.id);
      return user?.status === "active" ? { ...subject, name: user.displayName } : null;
    }
    if (subject.kind === "org_unit") {
      const unit = await store.getUnit(orgId, subject.id);
      return unit?.status === "active" ? { ...subject, name: unit.name } : null;
    }
    const group = await store.getGroup(orgId, subject.id);
    return group?.status === "active" ? { ...subject, name: group.name } : null;
  }

  async function accessSubjectIncludes(scopeId: ScopeId, principalId: string): Promise<boolean> {
    if ((await store.getUser(orgId, principalId))?.status !== "active") return false;
    const subject = await resolveAccessSubject(scopeId);
    if (!subject) return false;
    if (subject.kind === "user") return subject.id === principalId;
    if (subject.kind === "access_group") {
      return (await store.listDirectGroupIdsForUser(orgId, principalId)).includes(subject.id);
    }
    const directUnits = await store.listDirectUnitIdsForUser(orgId, principalId);
    for (const unitId of directUnits) {
      if ((await store.listAncestorUnitIds(orgId, unitId)).includes(subject.id)) return true;
    }
    return false;
  }

  return {
    directory,
    login,
    provisionPlayground,
    backfillUser,
    invite,
    setStatus,
    changeManagedStatus,
    statusImpact,
    listOrganizationUsers,
    getOrganizationUserDetail,
    getOrganizationUsersByIds: (principalIds) => store.getUsersByPrincipalIds(orgId, principalIds),
    updateUserProfile,
    setPrimaryUnit,
    applyMemberMutations,
    createUnit,
    updateUnit,
    moveUnit,
    previewMoveUnit,
    archiveUnit,
    addUnitMember,
    addUnitMembers,
    removeUnitMember,
    createGroup,
    updateGroup,
    archiveGroup,
    addGroupMember,
    addGroupMembers,
    removeGroupMember,
    unitImpact: (unitId) => store.unitImpact(orgId, unitId),
    listManagedSubtreeUnitIds: (principalId) => store.listManagedSubtreeUnitIds(orgId, principalId),
    listManagedGroupIds: (principalId) => store.listManagedGroupIds(orgId, principalId),
    getUnit: (unitId) => store.getUnit(orgId, unitId),
    listUnits: () => store.listUnits(orgId),
    listUnitMembers: (unitId) => store.listUnitMembers(orgId, unitId),
    getGroup: (groupId) => store.getGroup(orgId, groupId),
    listGroups: () => store.listGroups(orgId),
    listGroupMembers: (groupId) => store.listGroupMembers(orgId, groupId),
    getDirectoryPolicy: directoryPolicy,
    setDirectoryPolicy,
    deleteDirectoryPolicy,
    getUser: (principalId) => store.getUser(orgId, principalId),
    directUnitIds: (principalId) => store.listDirectUnitIdsForUser(orgId, principalId),
    directGroupIds: (principalId) => store.listDirectGroupIdsForUser(orgId, principalId),
    resolveAccessSubject,
    accessSubjectIncludes,
    authzRevision: () => store.getAuthzRevision(orgId),
    async checkActive(principalId: string): Promise<ActiveCheck | null> {
      const user = await store.getUser(orgId, principalId);
      if (!user) return null;
      const active = { status: user.status, sessionVersion: user.sessionVersion };
      cache.set(personKey(principalId), active);
      return active;
    },
    async checkRuntimeActive(principalId: string): Promise<ActiveCheck | null> {
      const user = await store.getUser(orgId, principalId);
      if (user) {
        const active = { status: user.status, sessionVersion: user.sessionVersion };
        cache.set(personKey(principalId), active);
        return active;
      }
      return (await deps.resolveLegacyRuntimeUser?.(principalId)) ? { status: "active", sessionVersion: 0 } : null;
    },
    async deactivatePrincipal(input: { principalId: string; actor: string }): Promise<ManagedStatusResult> {
      const result = await store.transact(orgId, async (tx): Promise<ManagedStatusResult> => {
        let user = await tx.getUser(orgId, input.principalId);
        if (!user) {
          const at = now();
          const tombstone: OrganizationUser = {
            orgId,
            principalId: input.principalId,
            email: null,
            displayName: input.principalId,
            jobTitle: null,
            mobile: null,
            employeeNumber: null,
            status: "deprovisioned",
            sessionVersion: 1,
            profileRevision: 1,
            createdAt: at,
            updatedAt: at,
            lastLoginAt: null,
            createdBy: "system:migration",
            updatedBy: input.actor,
          };
          if (await tx.insertUser(tombstone)) {
            await tx.bumpRevision(orgId);
            await tx.audit(userEvent("org.user.source_deactivate", input.principalId, "deprovisioned", input.actor));
            return { ok: true, user: tombstone };
          }
          user = await tx.getUser(orgId, input.principalId);
          if (!user) return { ok: false, reason: "missing_user" };
        }
        if (user.status === "suspended" || user.status === "deprovisioned") return { ok: true, user };
        const status = user.status === "invited" ? "deprovisioned" : "suspended";
        const changed: OrganizationUser = {
          ...user,
          status,
          sessionVersion: user.sessionVersion + 1,
          updatedAt: Math.max(now(), user.updatedAt),
          updatedBy: input.actor,
        };
        await tx.putUser(changed);
        await tx.bumpRevision(orgId);
        await tx.audit(userEvent("org.user.status", changed.principalId, status, input.actor));
        return { ok: true, user: changed };
      });
      return finalizeManagedStatus(result);
    },
    searchUsers(query: string, limit = 20): Promise<OrganizationUser[]> {
      return store.searchUsers(orgId, query.trim(), Math.max(1, Math.min(50, Math.floor(limit))));
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
