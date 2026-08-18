import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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

export const organizationRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/internal/auth/users/login", auth: "source", handle: loginUser },
];
