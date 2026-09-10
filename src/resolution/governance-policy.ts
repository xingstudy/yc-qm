import type { CommandPolicy } from "../types.ts";
import { composePolicy, defaultOrgPolicy } from "../policy/command-policy.ts";
import type { ScopedConfigStore } from "./config-store.ts";

export function governanceCommandPolicy(
  config: ScopedConfigStore,
  org: string,
  scope: string,
  scopes: readonly string[],
  override?: CommandPolicy,
): CommandPolicy {
  const orgPolicy = config.getCommandPolicy(org) ?? defaultOrgPolicy();
  const own = override ?? config.getCommandPolicy(scope) ?? undefined;
  const groupTarget = scope.startsWith("org-unit:") || scope.startsWith("access-group:");
  let base = scope === org ? (own ?? orgPolicy) : composePolicy(orgPolicy, own);
  if (groupTarget) base = orgPolicy;
  const constraints = [...new Set([...scopes, ...(groupTarget ? [scope] : [])])].flatMap((id) => {
    if (id === org || (id === scope && !groupTarget)) return [];
    const policy = id === scope ? own : config.getCommandPolicy(id);
    return policy ? [{ scopeId: id, policy }] : [];
  });
  return constraints.length ? { ...base, constraints } : base;
}
