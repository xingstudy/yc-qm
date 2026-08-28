import type { IncomingMessage } from "node:http";
import { PORTAL_IDENTITY_HEADER, verifyPortalIdentity, type PortalIdentity } from "../auth/portal-identity.ts";
import type { ServerDeps } from "./deps.ts";

export async function currentPortalActor(
  req: IncomingMessage,
  deps: ServerDeps,
  sourceSecret: string | undefined,
): Promise<PortalIdentity | null> {
  const secret = deps.portalIdentitySecret ?? sourceSecret;
  const rawToken = req.headers[PORTAL_IDENTITY_HEADER];
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  let actor = token && secret ? await verifyPortalIdentity(token, secret, Date.now()) : null;
  if (actor && deps.identity && !deps.organization) {
    await deps.identity.refresh();
    if (deps.identity.classify(actor.p).type !== "internal") actor = null;
  }
  if (!actor || !deps.organization) return actor;
  const user = await deps.organization.checkActive(actor.p);
  if (!user || user.status !== "active" || !Number.isInteger(actor.sv) || actor.sv !== user.sessionVersion) return null;
  if (!actor.imp) return actor;
  const impersonator = await deps.organization.checkActive(actor.imp);
  const status = await deps.admin?.adminStatusOf({ id: actor.imp, type: "internal" });
  if (
    !impersonator ||
    impersonator.status !== "active" ||
    !Number.isInteger(actor.isv) ||
    actor.isv !== impersonator.sessionVersion ||
    status?.role !== "org_admin"
  ) {
    return null;
  }
  return actor;
}
