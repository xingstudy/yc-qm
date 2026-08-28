import type { AdminService } from "../admin/admin-service.ts";
import { adminLivenessLockKey } from "../admin/admin-service.ts";
import { personKey } from "../directory/person.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { scopeId } from "../types.ts";
import type { ManagedStatusResult, OrganizationMemberMutation, OrganizationService } from "./organization-service.ts";

interface OrganizationAdminLivenessDeps {
  orgId: string;
  organization: OrganizationService;
  admin?: AdminService;
  advisoryLock?: AdvisoryLock;
}

async function activeAdminKeys(deps: OrganizationAdminLivenessDeps): Promise<Set<string>> {
  const grants = (await deps.admin?.listGrants()) ?? [];
  const admins = new Map(
    grants
      .filter((grant) => grant.role === "org_admin" && grant.scopeId === scopeId("org", deps.orgId))
      .map((grant) => [personKey(grant.principalId), grant.principalId]),
  );
  const users = await Promise.all(
    [...admins].map(async ([key, principalId]) => ({ key, user: await deps.organization.getUser(principalId) })),
  );
  return new Set(users.filter(({ user }) => user?.status === "active").map(({ key }) => key));
}

export async function validateAdminStatusTargets(
  deps: OrganizationAdminLivenessDeps,
  mutations: readonly Pick<OrganizationMemberMutation, "principalId" | "status">[],
): Promise<{ ok: true } | { ok: false; reason: "last_active_admin" }> {
  const deactivating = new Set(
    mutations
      .filter((mutation) => mutation.status === "suspended" || mutation.status === "deprovisioned")
      .map((mutation) => personKey(mutation.principalId)),
  );
  if (deactivating.size === 0) return { ok: true };
  const active = await activeAdminKeys(deps);
  if (![...active].some((key) => deactivating.has(key))) return { ok: true };
  return [...active].some((key) => !deactivating.has(key)) ? { ok: true } : { ok: false, reason: "last_active_admin" };
}

export async function isLastActiveOrganizationAdmin(
  deps: OrganizationAdminLivenessDeps,
  principalId: string,
): Promise<boolean> {
  const active = await activeAdminKeys(deps);
  const target = personKey(principalId);
  return active.has(target) && active.size === 1;
}

export async function changeManagedStatusWithAdminProtection(
  deps: OrganizationAdminLivenessDeps,
  input: {
    principalId: string;
    status: "active" | "suspended" | "deprovisioned";
    actor: string;
  },
): Promise<ManagedStatusResult | { ok: false; reason: "last_active_admin" }> {
  const apply = async () => {
    const valid = await validateAdminStatusTargets(deps, [input]);
    return valid.ok ? deps.organization.changeManagedStatus(input) : valid;
  };
  return deps.advisoryLock?.withLock(adminLivenessLockKey(deps.orgId), apply) ?? apply();
}

export async function deactivatePrincipalWithAdminProtection(
  deps: OrganizationAdminLivenessDeps,
  input: { principalId: string; actor: string },
): Promise<ManagedStatusResult | { ok: false; reason: "last_active_admin" }> {
  const apply = async () => {
    const valid = await validateAdminStatusTargets(deps, [{ ...input, status: "suspended" }]);
    return valid.ok ? deps.organization.deactivatePrincipal(input) : valid;
  };
  return deps.advisoryLock?.withLock(adminLivenessLockKey(deps.orgId), apply) ?? apply();
}
