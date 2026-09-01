import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { ServerDeps } from "./deps.ts";

export async function currentCapabilityActor(deps: ServerDeps, claims: CapabilityClaims): Promise<boolean> {
  if (deps.identity) {
    await deps.identity.refresh();
    if (deps.identity.classify(claims.actorId).type !== "internal") return false;
  }
  if (!deps.organization || claims.actorId.startsWith("system:") || claims.botActor) return true;
  const user = await deps.organization.checkRuntimeActive(claims.actorId);
  return (
    user?.status === "active" &&
    Number.isInteger(claims.sessionVersion) &&
    claims.sessionVersion === user.sessionVersion
  );
}
