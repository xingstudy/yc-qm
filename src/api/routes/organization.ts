import { sendJson } from "../http.ts";
import { authorizeAdmin, isObj, orgScope } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import type { OrganizationService } from "../../organization/organization-service.ts";
import {
  ORGANIZATION_USER_STATUSES,
  type OrganizationUser,
  type OrganizationUserStatus,
} from "../../organization/organization-store.ts";

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

export const organizationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/internal/auth/users/login", auth: "source", handle: loginUser },
  { method: "POST", path: "/v1/admin/org/users", auth: "either", handle: inviteUser },
  { method: "PATCH", path: "/v1/admin/org/users/:principalId", auth: "either", handle: setUserStatus },
];
