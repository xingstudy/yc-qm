import { sendJson } from "../http.ts";
import { adminActorFrom, authorizeAdmin, isObj, orgScope } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import { adminStatusFromGrants } from "../../admin/admin-service.ts";
import type { OrganizationService } from "../../organization/organization-service.ts";
import {
  ORGANIZATION_USER_STATUSES,
  type OrganizationUser,
  type OrganizationUserStatus,
  type OrgMemberRole,
  type OrgUnit,
  type OrgUnitKind,
  type OrgUnitMember,
} from "../../organization/organization-store.ts";

const ORG_UNIT_KINDS: ReadonlyArray<OrgUnitKind> = ["organization", "department", "team"];
const ORG_MEMBER_ROLES: ReadonlyArray<OrgMemberRole> = ["member", "manager"];

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function serializeUser(user: OrganizationUser): Record<string, unknown> {
  return {
    principalId: user.principalId,
    email: user.email,
    displayName: user.displayName,
    status: user.status,
    sessionVersion: user.sessionVersion,
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
    createdAt: member.createdAt,
    createdBy: member.createdBy,
  };
}

async function requireOrganizationAdmin(
  ctx: ApiCtx,
): Promise<{ organization: OrganizationService; actorId: string } | null> {
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
  return { organization, actorId: actor.id };
}

async function authorizeOrgMembershipWrite(
  ctx: ApiCtx,
  target: { kind: "unit"; unitId: string; role: OrgMemberRole },
): Promise<{ organization: OrganizationService; actorId: string } | null> {
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
    return { organization, actorId: principal.id };
  }
  const actorId = ctx.actor?.p;
  if (!actorId) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "admin grant required for this scope" });
    return null;
  }
  const unit = await organization.getUnit(target.unitId);
  if (!unit || unit.status !== "active") {
    sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
    return null;
  }
  const active = await organization.checkActive(actorId);
  if (!active || active.status !== "active" || target.role !== "member") {
    sendJson(ctx.res, 403, { error: "forbidden", message: "admin grant required for this scope" });
    return null;
  }
  const managed = await organization.listManagedSubtreeUnitIds(actorId);
  if (!managed.includes(target.unitId)) {
    sendJson(ctx.res, 403, { error: "forbidden", message: "unit is outside the managed subtree" });
    return null;
  }
  return { organization, actorId };
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

async function setUserStatus(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const principalId = trimmedString(ctx.params.principalId);
  const status = isObj(ctx.body) ? ctx.body.status : undefined;
  if (!principalId || typeof status !== "string" || !(ORGANIZATION_USER_STATUSES as ReadonlyArray<string>).includes(status)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "status must be one of invited, active, suspended, deprovisioned",
    });
  }
  const user = await authz.organization.setStatus({
    principalId,
    status: status as OrganizationUserStatus,
    actor: authz.actorId,
  });
  if (!user) return sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization user" });
  return sendJson(ctx.res, 200, { user: serializeUser(user) });
}

async function listUnits(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const units = await authz.organization.listUnits();
  return sendJson(ctx.res, 200, { units: units.map(serializeUnit) });
}

async function createUnit(ctx: ApiCtx): Promise<void> {
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const body = isObj(ctx.body) ? ctx.body : {};
  const parentId = trimmedString(body.parentId);
  const name = trimmedString(body.name);
  const kind = typeof body.kind === "string" && (ORG_UNIT_KINDS as ReadonlyArray<string>).includes(body.kind) ? body.kind : null;
  if (!parentId || !name || !kind || (body.sortOrder !== undefined && typeof body.sortOrder !== "number")) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "parentId and name must be non-empty strings, kind must be organization, department, or team, and sortOrder must be a number",
    });
  }
  const parent = await authz.organization.getUnit(parentId);
  if (!parent) return sendJson(ctx.res, 404, { error: "not_found", message: "unknown parent organization unit" });
  if (parent.status !== "active") return sendJson(ctx.res, 400, { error: "archived", message: "parent unit is archived" });
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
  const authz = await requireOrganizationAdmin(ctx);
  if (!authz) return;
  const unit = await authz.organization.getUnit(ctx.params.id ?? "");
  if (!unit) return sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
  const members = await authz.organization.listUnitMembers(unit.id);
  return sendJson(ctx.res, 200, { unit: serializeUnit(unit), members: members.map(serializeUnitMember) });
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
    await authz.organization.updateUnit({ unitId, status: "active", actor: authz.actorId });
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

async function unitWithMembers(
  organization: OrganizationService,
  unitId: string,
): Promise<{ unit: Record<string, unknown>; members: Array<Record<string, unknown>> } | null> {
  const unit = await organization.getUnit(unitId);
  if (!unit) return null;
  const members = await organization.listUnitMembers(unitId);
  return { unit: serializeUnit(unit), members: members.map(serializeUnitMember) };
}

async function addUnitMember(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalId = trimmedString(body.principalId);
  const role = typeof body.role === "string" && (ORG_MEMBER_ROLES as ReadonlyArray<string>).includes(body.role) ? body.role : null;
  if (!principalId || !role) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "principalId must be a non-empty string and role must be member or manager",
    });
  }
  const authz = await authorizeOrgMembershipWrite(ctx, { kind: "unit", unitId: ctx.params.id ?? "", role: role as OrgMemberRole });
  if (!authz) return;
  const unitId = ctx.params.id ?? "";
  const result = await authz.organization.addUnitMember({ unitId, principalId, role: role as OrgMemberRole, actor: authz.actorId });
  if (!result.ok) {
    if (result.reason === "missing_unit") {
      return sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
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
  const organization = ctx.deps.organization;
  const existing = organization
    ? (await organization.listUnitMembers(unitId)).find((m) => m.principalId === principalId)
    : undefined;
  const authz = await authorizeOrgMembershipWrite(ctx, {
    kind: "unit",
    unitId,
    role: existing?.role ?? "member",
  });
  if (!authz) return;
  const result = await authz.organization.removeUnitMember({ unitId, principalId, actor: authz.actorId });
  if (!result.ok) return sendJson(ctx.res, 404, { error: "not_found", message: "unknown organization unit" });
  return sendJson(ctx.res, 200, (await unitWithMembers(authz.organization, unitId))!);
}

export const organizationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/internal/auth/users/login", auth: "source", handle: loginUser },
  { method: "POST", path: "/v1/admin/org/users", auth: "either", handle: inviteUser },
  { method: "PATCH", path: "/v1/admin/org/users/:principalId", auth: "either", handle: setUserStatus },
  { method: "GET", path: "/v1/admin/org/units", auth: "either", handle: listUnits },
  { method: "POST", path: "/v1/admin/org/units", auth: "either", handle: createUnit },
  { method: "GET", path: "/v1/admin/org/units/:id", auth: "either", handle: getUnit },
  { method: "PATCH", path: "/v1/admin/org/units/:id", auth: "either", handle: patchUnit },
  { method: "POST", path: "/v1/admin/org/units/:id/members", auth: "either", handle: addUnitMember },
  { method: "DELETE", path: "/v1/admin/org/units/:id/members/:principalId", auth: "either", handle: removeUnitMember },
];
