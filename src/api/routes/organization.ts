import { once } from "node:events";
import { sendJson } from "../http.ts";
import { currentPortalActor } from "../portal-actor.ts";
import { adminActorFrom, authorizeAdmin, isObj, orgScope } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { adminStatusFromGrants } from "../../admin/admin-service.ts";
import {
  changeManagedStatusWithAdminProtection,
  isLastActiveOrganizationAdmin,
} from "../../organization/admin-liveness.ts";
import { orgId as configOrgId } from "../../config.ts";
import type { OrganizationService } from "../../organization/organization-service.ts";
import type { OrganizationMemberBatchAction } from "../../organization/member-batch-service.ts";
import { createOrganizationMemberCsvHeader, createOrganizationMemberCsvRow } from "../../organization/member-csv.ts";
import {
  OrganizationMemberJobConflictError,
  type OrganizationMemberJobDetail,
} from "../../organization/member-job-store.ts";
import {
  type AccessGroup,
  type AccessGroupMember,
  type DirectorySubjectKind,
  type DirectoryUserCursor,
  type DirectoryViewMode,
  type OrganizationUser,
  type OrganizationUserStatus,
  type OrgMemberRole,
  type OrgUnit,
  type OrgUnitKind,
  type OrgUnitMember,
} from "../../organization/organization-store.ts";

const ORG_UNIT_KINDS: ReadonlyArray<OrgUnitKind> = ["organization", "department", "team"];
const ORG_MEMBER_ROLES: ReadonlyArray<OrgMemberRole> = ["member", "manager"];
const DIRECTORY_SUBJECT_KINDS: ReadonlyArray<DirectorySubjectKind> = ["user", "org_unit", "access_group"];
const DIRECTORY_VIEW_MODES: ReadonlyArray<DirectoryViewMode> = ["all", "limited", "none"];

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function principalIdsFrom(body: Record<string, unknown>): string[] | null {
  const values = Array.isArray(body.principalIds) ? body.principalIds : [body.principalId];
  if (values.length === 0 || values.length > 100) return null;
  const normalized = values.map(trimmedString);
  if (normalized.some((value) => value === null)) return null;
  return [...new Set(normalized as string[])];
}

function serializeUser(user: OrganizationUser): Record<string, unknown> {
  return {
    principalId: user.principalId,
    email: user.email,
    displayName: user.displayName,
    jobTitle: user.jobTitle,
    mobile: user.mobile,
    employeeNumber: user.employeeNumber,
    status: user.status,
    sessionVersion: user.sessionVersion,
    profileRevision: user.profileRevision,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
    createdBy: user.createdBy,
    updatedBy: user.updatedBy,
  };
}

function serializeUnit(unit: OrgUnit): Record<string, unknown> {
  return {
    id: unit.id,
    parentId: unit.parentId,
    name: unit.name,
    kind: unit.kind,
    status: unit.status,
    sortOrder: unit.sortOrder,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
    createdBy: unit.createdBy,
    updatedBy: unit.updatedBy,
  };
}

function serializeUnitMember(member: OrgUnitMember): Record<string, unknown> {
  return {
    unitId: member.unitId,
    principalId: member.principalId,
    role: member.role,
    isPrimary: member.isPrimary === true,
    createdAt: member.createdAt,
    createdBy: member.createdBy,
  };
}

function serializeMemberProfile(user: OrganizationUser | undefined): Record<string, unknown> | null {
  if (!user) return null;
  return {
    principalId: user.principalId,
    displayName: user.displayName,
    email: user.email,
    jobTitle: user.jobTitle,
    status: user.status,
  };
}

function serializeGroup(group: AccessGroup): Record<string, unknown> {
  return {
    id: group.id,
    name: group.name,
    status: group.status,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    createdBy: group.createdBy,
    updatedBy: group.updatedBy,
  };
}

function serializeGroupMember(member: AccessGroupMember): Record<string, unknown> {
  return {
    groupId: member.groupId,
    principalId: member.principalId,
    role: member.role,
    createdAt: member.createdAt,
    createdBy: member.createdBy,
  };
}

function serializeDirectoryUser(user: OrganizationUser): Record<string, unknown> {
  return {
    principalId: user.principalId,
    email: user.email,
    displayName: user.displayName,
  };
}

function cursorFrom(value: string | null): DirectoryUserCursor | null | undefined {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof decoded.displayName === "string" && typeof decoded.principalId === "string"
      ? { displayName: decoded.displayName, principalId: decoded.principalId }
      : undefined;
  } catch {
    return undefined;
  }
}

function cursorTo(value: DirectoryUserCursor | null): string | null {
  return value ? Buffer.from(JSON.stringify(value)).toString("base64url") : null;
}

async function currentDirectoryActor(ctx: ApiCtx): Promise<{
  organization: OrganizationService;
  principalId: string;
  isAdmin: boolean;
} | null> {
  const organization = ctx.deps.organization;
  if (!organization) {
    sendJson(ctx.res, 503, { error: "not_configured", message: "organization service is not configured" });
    return null;
  }
  const principalId = ctx.actor?.p ?? ctx.capability?.actorId;
  if (!principalId || (await organization.checkActive(principalId))?.status !== "active") {
    sendJson(ctx.res, 401, { error: "unauthorized", message: "active organization user required" });
    return null;
  }
  const actor = adminActorFrom(ctx);
  const grants = (await ctx.deps.admin?.listGrants()) ?? [];
  const allowAdminElevation = (ctx.actor !== null && ctx.actor !== undefined) || ctx.capability?.liveActor === true;
  return {
    organization,
    principalId,
    isAdmin: allowAdminElevation && actor ? adminStatusFromGrants(grants, actor.id).isAdmin : false,
  };
}

async function currentUser(ctx: ApiCtx): Promise<void> {
  const authz = await currentDirectoryActor(ctx);
  if (!authz) return;
  const user = await authz.organization.getUser(authz.principalId);
  if (!user) return sendJson(ctx.res, 404, { error: "not_found" });
  const [unitIds, groupIds, revision] = await Promise.all([
    authz.organization.directUnitIds(authz.principalId),
    authz.organization.directGroupIds(authz.principalId),
    authz.organization.authzRevision(),
  ]);
  return sendJson(ctx.res, 200, {
    user: serializeUser(user),
    unitIds,
    groupIds,
    authorizationRevision: revision,
  });
}

async function directoryTree(ctx: ApiCtx): Promise<void> {
  const authz = await currentDirectoryActor(ctx);
  if (!authz) return;
  const units = await authz.organization.directory.visibleUnits({
    principalId: authz.principalId,
    isAdmin: authz.isAdmin,
  });
  if (!units) return sendJson(ctx.res, 403, { error: "forbidden" });
  return sendJson(ctx.res, 200, { units: units.map(serializeUnit) });
}

async function directoryUnit(ctx: ApiCtx): Promise<void> {
  const authz = await currentDirectoryActor(ctx);
  if (!authz) return;
  const actor = { principalId: authz.principalId, isAdmin: authz.isAdmin };
  const unit = await authz.organization.directory.visibleUnit(actor, ctx.params.id ?? "");
  if (!unit) return sendJson(ctx.res, 404, { error: "not_found" });
  const members = await authz.organization.directory.unitMembers(actor, unit.id);
  if (!members) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, { unit: serializeUnit(unit), users: members.map(serializeDirectoryUser) });
}

async function directoryUsers(ctx: ApiCtx): Promise<void> {
  const authz = await currentDirectoryActor(ctx);
  if (!authz) return;
  const query = ctx.url.searchParams.get("q")?.trim() ?? "";
  if (query.length > 100) return sendJson(ctx.res, 400, { error: "bad_request", message: "q is too long" });
  const limit = Math.max(1, Math.min(100, Number(ctx.url.searchParams.get("limit") ?? "20") || 20));
  const after = cursorFrom(ctx.url.searchParams.get("cursor"));
  if (after === undefined) return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid cursor" });
  const rate = await ctx.deps.rateLimiter?.check(`org-directory-search:${authz.principalId}`);
  if (rate && !rate.allowed) {
    return sendJson(ctx.res, 429, { error: "rate_limited", retryAfterMs: rate.retryAfterMs });
  }
  const unitId = ctx.url.searchParams.get("unitId")?.trim();
  const page = await authz.organization.directory.searchUsers(
    { principalId: authz.principalId, isAdmin: authz.isAdmin },
    { query, ...(unitId ? { unitId } : {}), after, limit },
  );
  if (!page) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, { users: page.users.map(serializeDirectoryUser), cursor: cursorTo(page.next) });
}

async function directoryGroups(ctx: ApiCtx): Promise<void> {
  const authz = await currentDirectoryActor(ctx);
  if (!authz) return;
  const groups = await authz.organization.directory.visibleGroups({
    principalId: authz.principalId,
    isAdmin: authz.isAdmin,
  });
  if (!groups) return sendJson(ctx.res, 403, { error: "forbidden" });
  const query = ctx.url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  return sendJson(ctx.res, 200, {
    groups: groups.filter((group) => !query || group.name.toLowerCase().includes(query)).map(serializeGroup),
  });
}

async function directoryGroupMembers(ctx: ApiCtx): Promise<void> {
  const authz = await currentDirectoryActor(ctx);
  if (!authz) return;
  const users = await authz.organization.directory.groupMembers(
    { principalId: authz.principalId, isAdmin: authz.isAdmin },
    ctx.params.id ?? "",
  );
  if (!users) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, { users: users.map(serializeDirectoryUser) });
}

function serializeDirectoryPolicy(
  value: Awaited<ReturnType<OrganizationService["getDirectoryPolicy"]>>,
): Record<string, unknown> | null {
  if (!value) return null;
  return {
    mode: value.policy.mode,
    revision: value.policy.revision,
    updatedAt: value.policy.updatedAt,
    updatedBy: value.policy.updatedBy,
    roots: value.roots.map((root) => ({ unitId: root.unitId, includeDescendants: root.includeDescendants })),
  };
}

function directorySubject(ctx: ApiCtx): { kind: DirectorySubjectKind; id: string } | null {
  const kind = ctx.params.subjectKind;
  const id = trimmedString(ctx.params.subjectId);
  return kind && (DIRECTORY_SUBJECT_KINDS as ReadonlyArray<string>).includes(kind) && id
    ? { kind: kind as DirectorySubjectKind, id }
    : null;
}

async function getDirectoryPolicy(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const subject = directorySubject(ctx);
  if (!subject) return sendJson(ctx.res, 400, { error: "bad_request" });
  return sendJson(ctx.res, 200, {
    policy: serializeDirectoryPolicy(await authz.organization.getDirectoryPolicy(subject.kind, subject.id)),
  });
}

async function directoryPolicySubjects(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const [units, groups, authorizationRevision] = await Promise.all([
    authz.organization.listUnits(),
    authz.organization.listGroups(),
    authz.organization.authzRevision(),
  ]);
  return sendJson(ctx.res, 200, {
    units: units.filter((unit) => unit.status === "active").map(serializeUnit),
    groups: groups.filter((group) => group.status === "active").map(serializeGroup),
    authorizationRevision,
  });
}

async function putDirectoryPolicy(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const subject = directorySubject(ctx);
  const body = isObj(ctx.body) ? ctx.body : {};
  const mode = typeof body.mode === "string" ? body.mode : "";
  const expectedRevision = Number(body.expectedRevision);
  const roots = Array.isArray(body.roots) ? body.roots : [];
  if (
    !subject ||
    !(DIRECTORY_VIEW_MODES as ReadonlyArray<string>).includes(mode) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    roots.length > 100 ||
    roots.some(
      (root) => !isObj(root) || typeof root.unitId !== "string" || typeof root.includeDescendants !== "boolean",
    )
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const result = await authz.organization.setDirectoryPolicy({
    subjectKind: subject.kind,
    subjectId: subject.id,
    mode: mode as DirectoryViewMode,
    roots: roots.map((root) => ({
      unitId: (root as Record<string, unknown>).unitId as string,
      includeDescendants: (root as Record<string, unknown>).includeDescendants as boolean,
    })),
    expectedRevision,
    actor: authz.actorId,
  });
  if (!result.ok) {
    if (result.reason === "revision_conflict") {
      return sendJson(ctx.res, 409, {
        error: "revision_conflict",
        currentRevision: result.currentRevision,
        policy: serializeDirectoryPolicy(result.policy ? { policy: result.policy, roots: result.roots } : null),
      });
    }
    return sendJson(ctx.res, 404, { error: "not_found" });
  }
  return sendJson(ctx.res, 200, {
    policy: serializeDirectoryPolicy({ policy: result.policy, roots: result.roots }),
    authorizationRevision: result.authzRevision,
  });
}

async function deleteDirectoryPolicy(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const subject = directorySubject(ctx);
  const expectedRevision = Number(ctx.url.searchParams.get("expectedRevision"));
  if (!subject || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const result = await authz.organization.deleteDirectoryPolicy({
    subjectKind: subject.kind,
    subjectId: subject.id,
    expectedRevision,
    actor: authz.actorId,
  });
  if (!result.ok) {
    return sendJson(ctx.res, 409, {
      error: "revision_conflict",
      currentRevision: result.currentRevision,
      policy: serializeDirectoryPolicy(result.policy ? { policy: result.policy, roots: result.roots } : null),
    });
  }
  return sendJson(ctx.res, 200, { policy: null, authorizationRevision: result.authzRevision });
}

async function requireOrganizationAdmin(
  ctx: ApiCtx,
): Promise<{ organization: OrganizationService; actorId: string; asManager: boolean } | null> {
  const organization = ctx.deps.organization;
  if (!organization) {
    sendJson(ctx.res, 503, {
      error: "not_configured",
      message: "organization service is not configured",
    });
    return null;
  }
  const actor = await authorizeAdmin(ctx, orgScope(ctx.deps));
  if (!actor) return null;
  return { organization, actorId: actor.id, asManager: false };
}

async function authorizeOrganizationRead(ctx: ApiCtx): Promise<{
  organization: OrganizationService;
  actorId: string;
  asManager: boolean;
  unitIds: ReadonlySet<string>;
  groupIds: ReadonlySet<string>;
} | null> {
  const organization = ctx.deps.organization;
  if (!organization) {
    sendJson(ctx.res, 503, { error: "not_configured", message: "organization service is not configured" });
    return null;
  }
  if (!ctx.deps.admin) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  const principal = adminActorFrom(ctx);
  const grants = await ctx.deps.admin.listGrants();
  if (principal && adminStatusFromGrants(grants, principal.id).isAdmin) {
    return { organization, actorId: principal.id, asManager: false, unitIds: new Set(), groupIds: new Set() };
  }
  const actorId = ctx.actor?.p;
  const active = actorId ? await organization.checkActive(actorId) : null;
  if (!actorId || active?.status !== "active") {
    sendJson(ctx.res, 403, { error: "forbidden", message: "organization manager access required" });
    return null;
  }
  const [unitIds, groupIds] = await Promise.all([
    organization.listManagedSubtreeUnitIds(actorId),
    organization.listManagedGroupIds(actorId),
  ]);
  if (unitIds.length === 0 && groupIds.length === 0) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "organization manager access required" });
    return null;
  }
  return {
    organization,
    actorId,
    asManager: true,
    unitIds: new Set(unitIds),
    groupIds: new Set(groupIds),
  };
}

async function authorizeOrgMembershipWrite(
  ctx: ApiCtx,
  target: { kind: "unit"; unitId: string } | { kind: "group"; groupId: string },
): Promise<{ organization: OrganizationService; actorId: string; asManager: boolean } | null> {
  const organization = ctx.deps.organization;
  if (!organization) {
    sendJson(ctx.res, 503, {
      error: "not_configured",
      message: "organization service is not configured",
    });
    return null;
  }
  if (!ctx.deps.admin) {
    sendJson(ctx.res, 404, { error: "not_found" });
    return null;
  }
  const grants = await ctx.deps.admin.listGrants();
  const principal = adminActorFrom(ctx);
  if (principal && adminStatusFromGrants(grants, principal.id).isAdmin) {
    return { organization, actorId: principal.id, asManager: false };
  }
  const actorId = ctx.actor?.p;
  if (!actorId) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "admin grant required for this scope" });
    return null;
  }
  const active = await organization.checkActive(actorId);
  if (target.kind === "unit") {
    const unit = await organization.getUnit(target.unitId);
    if (!unit || unit.status !== "active") {
      sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
      return null;
    }
    if (!active || active.status !== "active") {
      sendJson(ctx.res, 403, { error: "forbidden", message: "admin grant required for this scope" });
      return null;
    }
    const managed = await organization.listManagedSubtreeUnitIds(actorId);
    if (!managed.includes(target.unitId)) {
      sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
      return null;
    }
    return { organization, actorId, asManager: true };
  }
  const group = await organization.getGroup(target.groupId);
  if (!group || group.status !== "active") {
    sendJson(ctx.res, 404, { error: "not_found", message: "unknown access group" });
    return null;
  }
  if (!active || active.status !== "active") {
    sendJson(ctx.res, 403, { error: "forbidden", message: "admin grant required for this scope" });
    return null;
  }
  const manages = (await organization.listGroupMembers(target.groupId)).some(
    (member) => member.principalId === actorId && member.role === "manager",
  );
  if (!manages) {
    sendJson(ctx.res, 404, { error: "not_found", message: "unknown access group" });
    return null;
  }
  return { organization, actorId, asManager: true };
}

async function loginUser(ctx: ApiCtx): Promise<void> {
  const organization = ctx.deps.organization;
  if (!organization) {
    return sendJson(ctx.res, 503, {
      error: "not_configured",
      message: "organization service is not configured",
    });
  }
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalId = trimmedString(body.principalId);
  const issuer = trimmedString(body.issuer);
  const subject = trimmedString(body.subject);
  const emailVerified = body.emailVerified;
  if (!principalId || !issuer || !subject || (emailVerified !== undefined && typeof emailVerified !== "boolean")) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "principalId, issuer, and subject must be non-empty strings and emailVerified must be a boolean",
    });
  }
  if (principalId.startsWith("system:")) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "system: principal ids cannot log in as organization users",
    });
  }
  const email = trimmedString(body.email);
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const result = await organization.login({
    principalId,
    issuer,
    subject,
    email: email ? email.toLowerCase() : null,
    emailVerified: emailVerified === true,
    displayName,
  });
  if (result.status === "denied") return sendJson(ctx.res, 200, result);
  const { user } = result;
  return sendJson(ctx.res, 200, {
    status: "ok",
    user: {
      principalId: user.principalId,
      status: user.status,
      sessionVersion: user.sessionVersion,
      displayName: user.displayName,
    },
  });
}

async function activeSessionVersion(ctx: ApiCtx): Promise<void> {
  const organization = ctx.deps.organization;
  if (!organization) {
    return sendJson(ctx.res, 503, {
      error: "not_configured",
      message: "organization service is not configured",
    });
  }
  const principalId = trimmedString(ctx.params.principalId);
  const user = principalId ? await organization.checkActive(principalId) : null;
  if (!user || user.status !== "active") return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, { principalId, sessionVersion: user.sessionVersion });
}

async function activePortalSession(ctx: ApiCtx): Promise<void> {
  const actor = await currentPortalActor(ctx.req, ctx.deps, ctx.secret);
  if (!actor) return sendJson(ctx.res, 401, { error: "invalid_session" });
  return sendJson(ctx.res, 200, { principalId: actor.p, sessionVersion: actor.sv });
}

async function searchOrganizationUsers(ctx: ApiCtx): Promise<void> {
  const authz = await authorizeOrganizationRead(ctx);
  if (!authz) return;
  const query = ctx.url.searchParams.get("q")?.trim() ?? "";
  if (query.length < 2 || query.length > 100) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "q must contain 2 to 100 characters" });
  }
  const rate = await ctx.deps.rateLimiter?.check(`org-user-search:${authz.actorId}`);
  if (rate && !rate.allowed) {
    return sendJson(ctx.res, 429, {
      error: "rate_limited",
      message: "too many organization user searches; try again later",
      retryAfterMs: rate.retryAfterMs,
    });
  }
  const page = await authz.organization.directory.searchUsers(
    { principalId: authz.actorId, isAdmin: !authz.asManager },
    { query, after: null, limit: 50 },
  );
  if (!page) return sendJson(ctx.res, 403, { error: "forbidden" });
  return sendJson(ctx.res, 200, {
    users: page.users.map((user) => ({
      principalId: user.principalId,
      email: user.email,
      displayName: user.displayName,
      status: user.status,
    })),
  });
}

async function provisionPlaygroundUser(ctx: ApiCtx): Promise<void> {
  const organization = ctx.deps.organization;
  if (!organization) return sendJson(ctx.res, 503, { error: "not_configured" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalId = trimmedString(body.principalId);
  if (!principalId || !/^playground-[0-9a-f]{16}$/.test(principalId)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid playground principal" });
  }
  const user = await organization.provisionPlayground(principalId);
  if (!user) return sendJson(ctx.res, 409, { error: "conflict" });
  return sendJson(ctx.res, 200, { principalId: user.principalId, sessionVersion: user.sessionVersion });
}

async function inviteUser(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalId = trimmedString(body.principalId);
  if (!principalId) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId must be a non-empty string" });
  }
  if (principalId.startsWith("system:")) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "system: principal ids cannot be invited as organization users",
    });
  }
  const email = trimmedString(body.email);
  if (!email || !email.includes("@")) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "email must be a string containing @" });
  }
  if (body.displayName !== undefined && typeof body.displayName !== "string") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "displayName must be a string" });
  }
  const user = await authz.organization.invite({
    principalId,
    email: email.toLowerCase(),
    displayName: typeof body.displayName === "string" ? body.displayName : "",
    actor: authz.actorId,
  });
  return sendJson(ctx.res, 200, { user: serializeUser(user) });
}

async function listOrganizationMembers(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const query = ctx.url.searchParams.get("q")?.trim() ?? "";
  if (query.length > 200) return sendJson(ctx.res, 400, { error: "bad_request", message: "q is too long" });
  const rawStatuses = ctx.url.searchParams
    .getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const statuses = rawStatuses.length === 0 ? ["active", "suspended"] : rawStatuses;
  if (statuses.some((status) => !["active", "suspended", "deprovisioned"].includes(status))) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid member status" });
  }
  const after = cursorFrom(ctx.url.searchParams.get("cursor"));
  if (after === undefined) return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid cursor" });
  const limitValue = Number(ctx.url.searchParams.get("limit") ?? "50");
  if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > 100) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "limit must be between 1 and 100" });
  }
  const includeDescendants = ctx.url.searchParams.get("includeDescendants");
  const missingPrimaryUnit = ctx.url.searchParams.get("missingPrimaryUnit");
  if (
    (includeDescendants !== null && includeDescendants !== "true" && includeDescendants !== "false") ||
    (missingPrimaryUnit !== null && missingPrimaryUnit !== "true" && missingPrimaryUnit !== "false")
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid boolean filter" });
  }
  const unitId = trimmedString(ctx.url.searchParams.get("unitId"));
  const groupId = trimmedString(ctx.url.searchParams.get("groupId"));
  const page = await authz.organization.listOrganizationUsers({
    query,
    statuses: statuses as OrganizationUserStatus[],
    ...(unitId ? { unitId, includeDescendants: includeDescendants === "true" } : {}),
    ...(groupId ? { groupId } : {}),
    ...(missingPrimaryUnit === "true" ? { missingPrimaryUnit: true } : {}),
    after,
    limit: limitValue,
  });
  return sendJson(ctx.res, 200, {
    users: page.users.map(serializeUser),
    unitMembers: page.unitMembers.map(serializeUnitMember),
    groupMembers: page.groupMembers.map(serializeGroupMember),
    cursor: cursorTo(page.next),
  });
}

async function getOrganizationMember(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const principalId = trimmedString(ctx.params.principalId);
  const detail = principalId ? await authz.organization.getOrganizationUserDetail(principalId) : null;
  if (!detail) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, {
    user: serializeUser(detail.user),
    unitMembers: detail.unitMembers.map(serializeUnitMember),
    groupMembers: detail.groupMembers.map(serializeGroupMember),
    identities: detail.identities.map((identity) => ({
      issuer: identity.issuer,
      subject: identity.subject,
      emailAtLink: identity.emailAtLink,
      createdAt: identity.createdAt,
      updatedAt: identity.updatedAt,
    })),
    auditEvents: detail.auditEvents.map((event) => ({
      at: event.at,
      principalId: event.principalId,
      action: event.action,
      status: event.status,
      result: event.result,
      detail: event.detail,
    })),
  });
}

async function patchOrganizationMember(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  if (ctx.capability) return sendJson(ctx.res, 403, { error: "forbidden" });
  const principalId = trimmedString(ctx.params.principalId);
  const body = isObj(ctx.body) ? ctx.body : {};
  if (!principalId) return sendJson(ctx.res, 400, { error: "bad_request" });
  if (typeof body.status === "string" && Object.keys(body).length === 1) {
    if (!["active", "suspended", "deprovisioned"].includes(body.status)) {
      return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid managed status" });
    }
    const changed = await changeManagedStatusWithAdminProtection(
      {
        orgId: configOrgId(),
        organization: authz.organization,
        admin: ctx.deps.admin,
        advisoryLock: ctx.deps.advisoryLock,
      },
      {
        principalId,
        status: body.status as "active" | "suspended" | "deprovisioned",
        actor: authz.actorId,
      },
    );
    if (!changed.ok) {
      return sendJson(ctx.res, changed.reason === "missing_user" ? 404 : 409, {
        error: changed.reason,
        ...("current" in changed ? { current: changed.current } : {}),
      });
    }
    return sendJson(ctx.res, 200, { user: serializeUser(changed.user) });
  }
  const allowed = new Set(["displayName", "email", "jobTitle", "mobile", "employeeNumber", "expectedProfileRevision"]);
  const fields = Object.keys(body);
  const profileFields = fields.filter((field) => field !== "expectedProfileRevision");
  if (
    fields.some((field) => !allowed.has(field)) ||
    profileFields.length === 0 ||
    !Number.isSafeInteger(body.expectedProfileRevision) ||
    Number(body.expectedProfileRevision) < 1 ||
    profileFields.some(
      (field) =>
        (field === "displayName" && typeof body[field] !== "string") ||
        (field !== "displayName" && body[field] !== null && typeof body[field] !== "string"),
    )
  ) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "invalid organization member profile patch",
    });
  }
  const patch = Object.fromEntries(profileFields.map((field) => [field, body[field]]));
  const result = await authz.organization.updateUserProfile({
    principalId,
    patch,
    expectedProfileRevision: Number(body.expectedProfileRevision),
    actor: authz.actorId,
  });
  if (!result.ok) {
    let code = 409;
    if (result.reason === "missing_user") code = 404;
    if (result.reason === "invalid_profile") code = 400;
    return sendJson(ctx.res, code, {
      error: result.reason,
      ...(result.reason === "invalid_profile" ? { field: result.field } : {}),
      ...(result.reason === "revision_conflict" ? { user: serializeUser(result.current) } : {}),
    });
  }
  return sendJson(ctx.res, 200, { user: serializeUser(result.user) });
}

async function organizationMemberImpact(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const principalId = trimmedString(ctx.params.principalId);
  const impact = principalId ? await authz.organization.statusImpact(principalId) : null;
  if (!impact) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, {
    impact: {
      ...impact,
      lastActiveAdmin: await isLastActiveOrganizationAdmin(
        {
          orgId: configOrgId(),
          organization: authz.organization,
          admin: ctx.deps.admin,
          advisoryLock: ctx.deps.advisoryLock,
        },
        principalId!,
      ),
    },
  });
}

async function changeOrganizationMemberStatus(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  if (ctx.capability) return sendJson(ctx.res, 403, { error: "forbidden" });
  const principalId = trimmedString(ctx.params.principalId);
  const status = isObj(ctx.body) ? ctx.body.status : undefined;
  if (!principalId || typeof status !== "string" || !["active", "suspended", "deprovisioned"].includes(status)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid managed status" });
  }
  const result = await changeManagedStatusWithAdminProtection(
    {
      orgId: configOrgId(),
      organization: authz.organization,
      admin: ctx.deps.admin,
      advisoryLock: ctx.deps.advisoryLock,
    },
    {
      principalId,
      status: status as "active" | "suspended" | "deprovisioned",
      actor: authz.actorId,
    },
  );
  if (!result.ok) {
    return sendJson(ctx.res, result.reason === "missing_user" ? 404 : 409, {
      error: result.reason,
      ...("current" in result ? { current: result.current } : {}),
    });
  }
  return sendJson(ctx.res, 200, { user: serializeUser(result.user) });
}

async function putOrganizationMemberPrimaryUnit(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  if (ctx.capability) return sendJson(ctx.res, 403, { error: "forbidden" });
  const principalId = trimmedString(ctx.params.principalId);
  const body = isObj(ctx.body) ? ctx.body : {};
  const unitId = body.unitId === null ? null : trimmedString(body.unitId);
  if (!principalId || (body.unitId !== null && !unitId) || typeof body.keepPreviousMembership !== "boolean") {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const result = await authz.organization.setPrimaryUnit({
    principalId,
    unitId,
    keepPreviousMembership: body.keepPreviousMembership,
    actor: authz.actorId,
  });
  if (!result.ok) {
    return sendJson(ctx.res, result.reason === "missing_user" || result.reason === "missing_unit" ? 404 : 409, {
      error: result.reason,
    });
  }
  return sendJson(ctx.res, 200, {
    user: serializeUser(result.detail.user),
    unitMembers: result.detail.unitMembers.map(serializeUnitMember),
  });
}

function serializeMemberJob(
  detail: OrganizationMemberJobDetail,
  offset = 0,
  limit = 100,
  itemTotal = detail.items.length,
  itemsArePage = false,
): Record<string, unknown> {
  return {
    job: {
      id: detail.job.id,
      kind: detail.job.kind,
      status: detail.job.status,
      inputHash: detail.job.inputHash,
      expectedAuthzRevision: detail.job.expectedAuthzRevision,
      summary: detail.job.summary,
      createdAt: detail.job.createdAt,
      startedAt: detail.job.startedAt,
      completedAt: detail.job.completedAt,
      expiresAt: detail.job.expiresAt,
      error: detail.job.error,
    },
    items: (itemsArePage ? detail.items : detail.items.slice(offset, offset + limit)).map((item) => ({
      itemIndex: item.itemIndex,
      principalId: item.principalId,
      status: item.status,
      changes: item.changes,
      errors: item.errors,
      warnings: item.warnings,
    })),
    itemOffset: offset,
    itemLimit: limit,
    itemTotal,
  };
}

async function exportOrganizationMembers(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const query = ctx.url.searchParams.get("q")?.trim() ?? "";
  if (query.length > 200) return sendJson(ctx.res, 400, { error: "bad_request" });
  const rawStatuses = ctx.url.searchParams
    .getAll("status")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const all = ctx.url.searchParams.get("all") === "true";
  let statuses = rawStatuses;
  if (statuses.length === 0) statuses = all ? ["active", "suspended", "deprovisioned"] : ["active", "suspended"];
  if (statuses.some((status) => !["active", "suspended", "deprovisioned"].includes(status))) {
    return sendJson(ctx.res, 400, { error: "bad_request" });
  }
  const unitId = trimmedString(ctx.url.searchParams.get("unitId"));
  const groupId = trimmedString(ctx.url.searchParams.get("groupId"));
  const includeDescendants = ctx.url.searchParams.get("includeDescendants") === "true";
  const missingPrimaryUnit = ctx.url.searchParams.get("missingPrimaryUnit") === "true";
  const units = await authz.organization.listUnits();
  const unitsById = new Map(units.map((unit) => [unit.id, unit]));
  const pathOf = (unitId: string): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current = unitsById.get(unitId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? unitsById.get(current.parentId) : undefined;
    }
    return names.join("/");
  };
  const date = new Date().toISOString().slice(0, 10);
  ctx.res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="organization-members-${date}.csv"`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  ctx.res.write(createOrganizationMemberCsvHeader());
  let rowCount = 0;
  let after: DirectoryUserCursor | null = null;
  do {
    const page = await authz.organization.listOrganizationUsers({
      query,
      statuses: statuses as OrganizationUserStatus[],
      ...(unitId ? { unitId, includeDescendants } : {}),
      ...(groupId ? { groupId } : {}),
      ...(missingPrimaryUnit ? { missingPrimaryUnit: true } : {}),
      after,
      limit: 100,
    });
    for (const user of page.users) {
      const userUnits = page.unitMembers.filter((member) => member.principalId === user.principalId);
      const primary = userUnits.find((member) => member.isPrimary === true);
      const writable = ctx.res.write(
        createOrganizationMemberCsvRow({
          principalId: user.principalId,
          employeeNumber: user.employeeNumber,
          displayName: user.displayName,
          email: user.email,
          jobTitle: user.jobTitle,
          mobile: user.mobile,
          status: user.status,
          primaryUnitId: primary?.unitId ?? "",
          primaryUnitPath: primary ? pathOf(primary.unitId) : "",
          additionalUnitIds: userUnits
            .filter((member) => member.isPrimary !== true)
            .map((member) => member.unitId)
            .sort()
            .join(";"),
          accessGroupIds: page.groupMembers
            .filter((member) => member.principalId === user.principalId)
            .map((member) => member.groupId)
            .sort()
            .join(";"),
          lastLoginAt: user.lastLoginAt === null ? "" : new Date(user.lastLoginAt).toISOString(),
        }),
      );
      rowCount += 1;
      if (!writable) await once(ctx.res, "drain");
    }
    after = page.next;
  } while (after);
  ctx.deps.auditLog?.record({
    at: Date.now(),
    principalId: authz.actorId,
    action: "org.user.export",
    resource: "organization-members",
    scopeLabel: orgScope(ctx.deps),
    actorKind: "user",
    source: "organization",
    result: "success",
    detail: JSON.stringify({ rows: rowCount, filtered: String(!all) }),
  });
  ctx.res.end();
}

function memberBatchService(ctx: ApiCtx) {
  const service = ctx.deps.organizationMemberBatch;
  if (!service)
    sendJson(ctx.res, 503, { error: "not_configured", message: "member batch operations require PostgreSQL" });
  return service;
}

function idempotencyKeyFrom(ctx: ApiCtx): string | null {
  const value = ctx.req.headers["idempotency-key"];
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200 ? value.trim() : null;
}

async function previewOrganizationMemberImport(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  if (ctx.capability) return sendJson(ctx.res, 403, { error: "forbidden" });
  const service = memberBatchService(ctx);
  if (!service) return;
  const contentType = typeof ctx.req.headers["content-type"] === "string" ? ctx.req.headers["content-type"] : "";
  const idempotencyKey = idempotencyKeyFrom(ctx);
  if (!contentType.toLowerCase().startsWith("text/csv") || typeof ctx.body !== "string" || !idempotencyKey) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "text/csv and Idempotency-Key are required" });
  }
  try {
    const detail = await service.previewImport({ csv: ctx.body, actor: authz.actorId, idempotencyKey });
    return sendJson(ctx.res, 200, serializeMemberJob(detail));
  } catch (error) {
    if (error instanceof OrganizationMemberJobConflictError) {
      return sendJson(ctx.res, 409, { error: "idempotency_conflict", message: error.message });
    }
    const message = error instanceof Error ? error.message : "invalid CSV";
    return sendJson(ctx.res, 400, { error: "invalid_csv", message });
  }
}

async function getOrganizationMemberJob(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const service = memberBatchService(ctx);
  if (!service) return;
  const rawOffset = ctx.url.searchParams.get("offset") ?? "0";
  const rawLimit = ctx.url.searchParams.get("limit") ?? "100";
  const offset = Number(rawOffset);
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "offset and limit must be bounded integers" });
  }
  const page = await service.page(ctx.params.jobId ?? "", authz.actorId, offset, limit);
  if (!page) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, serializeMemberJob(page.detail, offset, limit, page.itemTotal, true));
}

async function commitOrganizationMemberJob(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  if (ctx.capability) return sendJson(ctx.res, 403, { error: "forbidden" });
  const service = memberBatchService(ctx);
  if (!service) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  if (typeof body.inputHash !== "string" || body.inputHash.length !== 64) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "inputHash is required" });
  }
  const result = await service.commit({
    jobId: ctx.params.jobId ?? "",
    actor: authz.actorId,
    inputHash: body.inputHash,
  });
  if (!result.ok) {
    return sendJson(ctx.res, result.reason === "not_found" ? 404 : 409, {
      error: result.reason,
      ...(result.detail ? serializeMemberJob(result.detail) : {}),
    });
  }
  return sendJson(ctx.res, 200, serializeMemberJob(result.detail));
}

function parseBatchAction(value: unknown): OrganizationMemberBatchAction | null {
  if (!isObj(value) || typeof value.type !== "string") return null;
  if (value.type === "set_job_title" && (typeof value.value === "string" || value.value === null)) {
    return { type: value.type, value: value.value };
  }
  if (
    value.type === "set_primary_unit" &&
    typeof value.unitId === "string" &&
    typeof value.keepPreviousMembership === "boolean"
  ) {
    return { type: value.type, unitId: value.unitId.trim(), keepPreviousMembership: value.keepPreviousMembership };
  }
  if (value.type === "clear_primary_unit" && typeof value.keepPreviousMembership === "boolean") {
    return { type: value.type, keepPreviousMembership: value.keepPreviousMembership };
  }
  if ((value.type === "add_unit" || value.type === "remove_unit") && typeof value.unitId === "string") {
    return { type: value.type, unitId: value.unitId.trim() };
  }
  if ((value.type === "add_group" || value.type === "remove_group") && typeof value.groupId === "string") {
    return { type: value.type, groupId: value.groupId.trim() };
  }
  if (value.type === "suspend" || value.type === "reactivate" || value.type === "deprovision") {
    return { type: value.type };
  }
  return null;
}

async function previewOrganizationMemberBatch(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  if (ctx.capability) return sendJson(ctx.res, 403, { error: "forbidden" });
  const service = memberBatchService(ctx);
  if (!service) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const idempotencyKey = idempotencyKeyFrom(ctx);
  const action = parseBatchAction(body.action);
  const principalIds = Array.isArray(body.principalIds)
    ? body.principalIds.filter((value): value is string => typeof value === "string")
    : undefined;
  const queryBody = isObj(body.query) ? body.query : null;
  const query = queryBody
    ? {
        query: typeof queryBody.q === "string" ? queryBody.q : "",
        statuses: Array.isArray(queryBody.statuses)
          ? (queryBody.statuses.filter(
              (value): value is OrganizationUserStatus =>
                typeof value === "string" && ["active", "suspended", "deprovisioned"].includes(value),
            ) as OrganizationUserStatus[])
          : (["active", "suspended"] as OrganizationUserStatus[]),
        ...(typeof queryBody.unitId === "string" ? { unitId: queryBody.unitId } : {}),
        ...(typeof queryBody.includeDescendants === "boolean"
          ? { includeDescendants: queryBody.includeDescendants }
          : {}),
        ...(typeof queryBody.groupId === "string" ? { groupId: queryBody.groupId } : {}),
        ...(queryBody.missingPrimaryUnit === true ? { missingPrimaryUnit: true } : {}),
      }
    : undefined;
  if (!idempotencyKey) return sendJson(ctx.res, 400, { error: "bad_request", message: "Idempotency-Key is required" });
  if (!action) return sendJson(ctx.res, 400, { error: "bad_request", message: "a valid batch action is required" });
  if ((!principalIds || principalIds.length === 0) && !query) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "principalIds or query is required" });
  }
  try {
    const detail = await service.previewBatch({
      ...(principalIds && principalIds.length > 0 ? { principalIds } : { query: query! }),
      action,
      actor: authz.actorId,
      idempotencyKey,
    });
    return sendJson(ctx.res, 200, serializeMemberJob(detail));
  } catch (error) {
    if (error instanceof OrganizationMemberJobConflictError) {
      return sendJson(ctx.res, 409, { error: "idempotency_conflict", message: error.message });
    }
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : "invalid batch operation",
    });
  }
}

async function listUnits(ctx: ApiCtx): Promise<void> {
  const authz = await authorizeOrganizationRead(ctx);
  if (!authz) return;
  const all = await authz.organization.listUnits();
  const units = authz.asManager ? all.filter((unit) => authz.unitIds.has(unit.id)) : all;
  return sendJson(ctx.res, 200, { units: units.map(serializeUnit) });
}

async function createUnit(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const parentId = trimmedString(body.parentId);
  const name = trimmedString(body.name);
  const kind =
    typeof body.kind === "string" && (ORG_UNIT_KINDS as ReadonlyArray<string>).includes(body.kind) ? body.kind : null;
  if (!parentId || !name || !kind || (body.sortOrder !== undefined && typeof body.sortOrder !== "number")) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message:
        "parentId and name must be non-empty strings, kind must be organization, department, or team, and sortOrder must be a number",
    });
  }
  const parent = await authz.organization.getUnit(parentId);
  if (!parent) return sendJson(ctx.res, 404, { error: "not_found", message: "unknown parent organization unit" });
  if (parent.status !== "active")
    return sendJson(ctx.res, 400, { error: "archived", message: "parent unit is archived" });
  const unit = await authz.organization.createUnit({
    parentId,
    name,
    kind: kind as OrgUnitKind,
    ...(typeof body.sortOrder === "number" ? { sortOrder: body.sortOrder } : {}),
    actor: authz.actorId,
  });
  return sendJson(ctx.res, 200, { unit: serializeUnit(unit) });
}

async function getUnit(ctx: ApiCtx): Promise<void> {
  const authz = await authorizeOrganizationRead(ctx);
  if (!authz) return;
  const unitId = ctx.params.id ?? "";
  if (authz.asManager && !authz.unitIds.has(unitId)) {
    return sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
  }
  const unit = await authz.organization.getUnit(unitId);
  if (!unit) return sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
  const members = await authz.organization.listUnitMembers(unit.id);
  const users = new Map(
    (await authz.organization.getOrganizationUsersByIds(members.map((member) => member.principalId))).map((user) => [
      user.principalId,
      user,
    ]),
  );
  return sendJson(ctx.res, 200, {
    unit: serializeUnit(unit),
    members: members.map((member) => ({
      ...serializeUnitMember(member),
      user: serializeMemberProfile(users.get(member.principalId)),
    })),
  });
}

async function patchUnit(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const unitId = ctx.params.id ?? "";
  const existing = await authz.organization.getUnit(unitId);
  if (!existing) return sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const hasName = body.name !== undefined;
  const hasSortOrder = body.sortOrder !== undefined;
  const hasParent = body.parentId !== undefined;
  const hasStatus = body.status !== undefined;
  const name = hasName ? trimmedString(body.name) : null;
  const parentId = hasParent ? trimmedString(body.parentId) : null;
  const status = hasStatus && typeof body.status === "string" ? body.status : null;
  if (
    (!hasName && !hasSortOrder && !hasParent && !hasStatus) ||
    (hasName && !name) ||
    (hasSortOrder && typeof body.sortOrder !== "number") ||
    (hasParent && !parentId) ||
    (hasStatus && status !== "active" && status !== "archived")
  ) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "provide name, sortOrder, parentId, or status (active or archived) with valid values",
    });
  }
  if (hasParent && hasStatus) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "parentId and status cannot be combined in one patch",
    });
  }
  if (status === "archived") {
    const archived = await authz.organization.archiveUnit({ unitId, actor: authz.actorId });
    if (!archived.ok) {
      if (archived.reason === "conflict") return sendJson(ctx.res, 409, { error: "conflict", impact: archived.impact });
      return sendJson(ctx.res, 400, { error: archived.reason });
    }
  } else if (status === "active") {
    const restored = await authz.organization.updateUnit({ unitId, status: "active", actor: authz.actorId });
    if (!restored) {
      return sendJson(ctx.res, 409, { error: "conflict", message: "restore the parent unit first" });
    }
  }
  if (hasParent && parentId) {
    const moved = await authz.organization.moveUnit({ unitId, newParentId: parentId, actor: authz.actorId });
    if (!moved.ok) return sendJson(ctx.res, 400, { error: moved.reason });
  }
  if (hasName || hasSortOrder) {
    await authz.organization.updateUnit({
      unitId,
      ...(name ? { name } : {}),
      ...(typeof body.sortOrder === "number" ? { sortOrder: body.sortOrder } : {}),
      actor: authz.actorId,
    });
  }
  const unit = await authz.organization.getUnit(unitId);
  return sendJson(ctx.res, 200, { unit: serializeUnit(unit!) });
}

async function previewUnitMove(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const unitId = ctx.params.id ?? "";
  const newParentId = trimmedString(ctx.url.searchParams.get("newParentId"));
  if (!newParentId) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "newParentId must be a non-empty string" });
  }
  const preview = await authz.organization.previewMoveUnit({ unitId, newParentId });
  if (!preview.ok) {
    const status = preview.reason === "missing_parent" ? 404 : 400;
    return sendJson(ctx.res, status, { error: preview.reason });
  }
  return sendJson(ctx.res, 200, { impact: preview.impact });
}

async function unitWithMembers(
  organization: OrganizationService,
  unitId: string,
): Promise<{ unit: Record<string, unknown>; members: Array<Record<string, unknown>> } | null> {
  const unit = await organization.getUnit(unitId);
  if (!unit) return null;
  const members = await organization.listUnitMembers(unitId);
  const users = new Map(
    (await organization.getOrganizationUsersByIds(members.map((member) => member.principalId))).map((user) => [
      user.principalId,
      user,
    ]),
  );
  return {
    unit: serializeUnit(unit),
    members: members.map((member) => ({
      ...serializeUnitMember(member),
      user: serializeMemberProfile(users.get(member.principalId)),
    })),
  };
}

async function addUnitMember(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalIds = principalIdsFrom(body);
  const role =
    typeof body.role === "string" && (ORG_MEMBER_ROLES as ReadonlyArray<string>).includes(body.role) ? body.role : null;
  if (!principalIds || !role) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "principalId or principalIds must contain 1 to 100 non-empty strings and role must be member or manager",
    });
  }
  const authz = await authorizeOrgMembershipWrite(ctx, {
    kind: "unit",
    unitId: ctx.params.id ?? "",
  });
  if (!authz) return;
  const unitId = ctx.params.id ?? "";
  const result = await authz.organization.addUnitMembers({
    unitId,
    principalIds,
    role: role as OrgMemberRole,
    actor: authz.actorId,
    asManager: authz.asManager,
  });
  if (!result.ok) {
    if (result.reason === "missing_unit") {
      return sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
    }
    if (result.reason === "forbidden") return sendJson(ctx.res, 403, { error: "forbidden" });
    if (result.reason === "missing_user") {
      return sendJson(ctx.res, 404, {
        error: "not_found",
        message: "one or more organization users are unavailable",
        invalidPrincipalIds: result.invalidPrincipalIds,
      });
    }
    return sendJson(ctx.res, 400, { error: result.reason });
  }
  return sendJson(ctx.res, 200, (await unitWithMembers(authz.organization, unitId))!);
}

async function removeUnitMember(ctx: ApiCtx): Promise<void> {
  const unitId = ctx.params.id ?? "";
  const principalId = trimmedString(ctx.params.principalId);
  if (!principalId) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId must be a non-empty string" });
  }
  const authz = await authorizeOrgMembershipWrite(ctx, {
    kind: "unit",
    unitId,
  });
  if (!authz) return;
  const result = await authz.organization.removeUnitMember({
    unitId,
    principalId,
    actor: authz.actorId,
    asManager: authz.asManager,
  });
  if (!result.ok) {
    if (result.reason === "forbidden") return sendJson(ctx.res, 403, { error: "forbidden" });
    if (result.reason === "primary_unit") {
      return sendJson(ctx.res, 409, { error: "primary_unit", message: "clear or replace the primary unit first" });
    }
    return sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
  }
  return sendJson(ctx.res, 200, (await unitWithMembers(authz.organization, unitId))!);
}

async function listGroups(ctx: ApiCtx): Promise<void> {
  const authz = await authorizeOrganizationRead(ctx);
  if (!authz) return;
  const all = await authz.organization.listGroups();
  const groups = authz.asManager ? all.filter((group) => authz.groupIds.has(group.id)) : all;
  return sendJson(ctx.res, 200, { groups: groups.map(serializeGroup) });
}

async function createGroup(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const name = trimmedString(body.name);
  if (!name) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "name must be a non-empty string" });
  }
  const group = await authz.organization.createGroup({ name, actor: authz.actorId });
  return sendJson(ctx.res, 200, { group: serializeGroup(group) });
}

async function groupWithMembers(
  organization: OrganizationService,
  groupId: string,
): Promise<{ group: Record<string, unknown>; members: Array<Record<string, unknown>> } | null> {
  const group = await organization.getGroup(groupId);
  if (!group) return null;
  const members = await organization.listGroupMembers(groupId);
  const users = new Map(
    (await organization.getOrganizationUsersByIds(members.map((member) => member.principalId))).map((user) => [
      user.principalId,
      user,
    ]),
  );
  return {
    group: serializeGroup(group),
    members: members.map((member) => ({
      ...serializeGroupMember(member),
      user: serializeMemberProfile(users.get(member.principalId)),
    })),
  };
}

async function getGroup(ctx: ApiCtx): Promise<void> {
  const authz = await authorizeOrganizationRead(ctx);
  if (!authz) return;
  const groupId = ctx.params.id ?? "";
  if (authz.asManager && !authz.groupIds.has(groupId)) {
    return sendJson(ctx.res, 404, { error: "not_found", message: "unknown access group" });
  }
  const detail = await groupWithMembers(authz.organization, groupId);
  if (!detail) return sendJson(ctx.res, 404, { error: "not_found", message: "unknown access group" });
  return sendJson(ctx.res, 200, detail);
}

async function patchGroup(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const groupId = ctx.params.id ?? "";
  const existing = await authz.organization.getGroup(groupId);
  if (!existing) return sendJson(ctx.res, 404, { error: "not_found", message: "unknown access group" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const hasName = body.name !== undefined;
  const hasStatus = body.status !== undefined;
  const name = hasName ? trimmedString(body.name) : null;
  const status = hasStatus && typeof body.status === "string" ? body.status : null;
  if ((!hasName && !hasStatus) || (hasName && !name) || (hasStatus && status !== "active" && status !== "archived")) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "provide name or status (active or archived) with valid values",
    });
  }
  if (status === "archived") {
    const archived = await authz.organization.archiveGroup({ groupId, actor: authz.actorId });
    if (!archived.ok) {
      return sendJson(ctx.res, 409, {
        error: "conflict",
        message: "access group is referenced by a directory visibility policy",
      });
    }
  } else if (status === "active") {
    await authz.organization.updateGroup({ groupId, status: "active", actor: authz.actorId });
  }
  if (name) {
    await authz.organization.updateGroup({ groupId, name, actor: authz.actorId });
  }
  return sendJson(ctx.res, 200, { group: serializeGroup((await authz.organization.getGroup(groupId))!) });
}

async function addGroupMember(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalIds = principalIdsFrom(body);
  const role =
    typeof body.role === "string" && (ORG_MEMBER_ROLES as ReadonlyArray<string>).includes(body.role) ? body.role : null;
  if (!principalIds || !role) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "principalId or principalIds must contain 1 to 100 non-empty strings and role must be member or manager",
    });
  }
  const authz = await authorizeOrgMembershipWrite(ctx, {
    kind: "group",
    groupId: ctx.params.id ?? "",
  });
  if (!authz) return;
  const groupId = ctx.params.id ?? "";
  const result = await authz.organization.addGroupMembers({
    groupId,
    principalIds,
    role: role as OrgMemberRole,
    actor: authz.actorId,
    asManager: authz.asManager,
  });
  if (!result.ok) {
    if (result.reason === "missing_group") {
      return sendJson(ctx.res, 404, { error: "not_found", message: "unknown access group" });
    }
    if (result.reason === "forbidden") return sendJson(ctx.res, 403, { error: "forbidden" });
    if (result.reason === "missing_user") {
      return sendJson(ctx.res, 404, {
        error: "not_found",
        message: "one or more organization users are unavailable",
        invalidPrincipalIds: result.invalidPrincipalIds,
      });
    }
    return sendJson(ctx.res, 400, { error: result.reason });
  }
  return sendJson(ctx.res, 200, (await groupWithMembers(authz.organization, groupId))!);
}

async function removeGroupMember(ctx: ApiCtx): Promise<void> {
  const groupId = ctx.params.id ?? "";
  const principalId = trimmedString(ctx.params.principalId);
  if (!principalId) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "principalId must be a non-empty string" });
  }
  const authz = await authorizeOrgMembershipWrite(ctx, {
    kind: "group",
    groupId,
  });
  if (!authz) return;
  const result = await authz.organization.removeGroupMember({
    groupId,
    principalId,
    actor: authz.actorId,
    asManager: authz.asManager,
  });
  if (!result.ok) {
    if (result.reason === "forbidden") return sendJson(ctx.res, 403, { error: "forbidden" });
    return sendJson(ctx.res, 404, { error: "not_found", message: "unknown access group" });
  }
  return sendJson(ctx.res, 200, (await groupWithMembers(authz.organization, groupId))!);
}

export const organizationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/me", auth: "either", handle: currentUser },
  { method: "GET", path: "/v1/org/tree", auth: "either", handle: directoryTree },
  { method: "GET", path: "/v1/org/units/:id", auth: "either", handle: directoryUnit },
  { method: "GET", path: "/v1/org/users", auth: "either", handle: directoryUsers },
  { method: "GET", path: "/v1/org/access-groups", auth: "either", handle: directoryGroups },
  { method: "GET", path: "/v1/org/access-groups/:id/members", auth: "either", handle: directoryGroupMembers },
  { method: "POST", path: "/v1/internal/auth/users/login", auth: "source", handle: loginUser },
  {
    method: "GET",
    path: "/v1/internal/auth/users/:principalId/session-version",
    auth: "source",
    handle: activeSessionVersion,
  },
  { method: "GET", path: "/v1/internal/auth/session", auth: "source", handle: activePortalSession },
  { method: "POST", path: "/v1/internal/auth/users/playground", auth: "source", handle: provisionPlaygroundUser },
  { method: "POST", path: "/v1/admin/org/users", auth: "either", handle: inviteUser },
  { method: "GET", path: "/v1/admin/org/users", auth: "either", handle: listOrganizationMembers },
  { method: "GET", path: "/v1/admin/org/users/search", auth: "either", handle: searchOrganizationUsers },
  { method: "GET", path: "/v1/admin/org/users/export", auth: "either", handle: exportOrganizationMembers },
  {
    method: "POST",
    path: "/v1/admin/org/users/imports/preview",
    auth: "either",
    handle: previewOrganizationMemberImport,
  },
  {
    method: "GET",
    path: "/v1/admin/org/users/imports/:jobId",
    auth: "either",
    handle: getOrganizationMemberJob,
  },
  {
    method: "POST",
    path: "/v1/admin/org/users/imports/:jobId/commit",
    auth: "either",
    handle: commitOrganizationMemberJob,
  },
  {
    method: "POST",
    path: "/v1/admin/org/users/batches/preview",
    auth: "either",
    handle: previewOrganizationMemberBatch,
  },
  {
    method: "GET",
    path: "/v1/admin/org/users/batches/:jobId",
    auth: "either",
    handle: getOrganizationMemberJob,
  },
  {
    method: "POST",
    path: "/v1/admin/org/users/batches/:jobId/commit",
    auth: "either",
    handle: commitOrganizationMemberJob,
  },
  {
    method: "GET",
    path: "/v1/admin/org/users/:principalId/impact",
    auth: "either",
    handle: organizationMemberImpact,
  },
  { method: "GET", path: "/v1/admin/org/users/:principalId", auth: "either", handle: getOrganizationMember },
  { method: "PATCH", path: "/v1/admin/org/users/:principalId", auth: "either", handle: patchOrganizationMember },
  {
    method: "POST",
    path: "/v1/admin/org/users/:principalId/status",
    auth: "either",
    handle: changeOrganizationMemberStatus,
  },
  {
    method: "PUT",
    path: "/v1/admin/org/users/:principalId/primary-unit",
    auth: "either",
    handle: putOrganizationMemberPrimaryUnit,
  },
  {
    method: "GET",
    path: "/v1/admin/org/directory-visibility",
    auth: "either",
    handle: directoryPolicySubjects,
  },
  {
    method: "GET",
    path: "/v1/admin/org/directory-visibility/:subjectKind/:subjectId",
    auth: "either",
    handle: getDirectoryPolicy,
  },
  {
    method: "PUT",
    path: "/v1/admin/org/directory-visibility/:subjectKind/:subjectId",
    auth: "either",
    handle: putDirectoryPolicy,
  },
  {
    method: "DELETE",
    path: "/v1/admin/org/directory-visibility/:subjectKind/:subjectId",
    auth: "either",
    handle: deleteDirectoryPolicy,
  },
  { method: "GET", path: "/v1/admin/org/units", auth: "either", handle: listUnits },
  { method: "POST", path: "/v1/admin/org/units", auth: "either", handle: createUnit },
  { method: "GET", path: "/v1/admin/org/units/:id/impact", auth: "either", handle: previewUnitMove },
  { method: "GET", path: "/v1/admin/org/units/:id", auth: "either", handle: getUnit },
  { method: "PATCH", path: "/v1/admin/org/units/:id", auth: "either", handle: patchUnit },
  { method: "POST", path: "/v1/admin/org/units/:id/members", auth: "either", handle: addUnitMember },
  { method: "DELETE", path: "/v1/admin/org/units/:id/members/:principalId", auth: "either", handle: removeUnitMember },
  { method: "GET", path: "/v1/admin/org/access-groups", auth: "either", handle: listGroups },
  { method: "POST", path: "/v1/admin/org/access-groups", auth: "either", handle: createGroup },
  { method: "GET", path: "/v1/admin/org/access-groups/:id", auth: "either", handle: getGroup },
  { method: "PATCH", path: "/v1/admin/org/access-groups/:id", auth: "either", handle: patchGroup },
  { method: "POST", path: "/v1/admin/org/access-groups/:id/members", auth: "either", handle: addGroupMember },
  {
    method: "DELETE",
    path: "/v1/admin/org/access-groups/:id/members/:principalId",
    auth: "either",
    handle: removeGroupMember,
  },
];
