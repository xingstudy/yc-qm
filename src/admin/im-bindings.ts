import type { PersistedUiState } from "../surfaces/ui-state.ts";

type AdminImProviderId = "wechat" | "feishu" | "work-wechat" | "qq" | "dingtalk";

export interface AdminImBinding {
  provider: AdminImProviderId;
  status: "pending" | "connected";
  botName: string | null;
  externalDisplayName: string | null;
  externalTenantId: string | null;
  externalTenantName: string | null;
  connectedAt: number | null;
}

const PROVIDERS = new Set<AdminImProviderId>(["wechat", "feishu", "work-wechat", "qq", "dingtalk"]);
const IM_BINDINGS_SUFFIX = "#im-bindings";

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return null;
}

function hasResource(rawResources: Record<string, unknown>, provider: AdminImProviderId): boolean {
  const raw = rawResources[provider];
  if (typeof raw !== "object" || raw === null) return false;
  const resource = raw as Record<string, unknown>;
  if (typeof resource.resourceId !== "string" || !resource.resourceId) return false;
  return provider !== "wechat" || (typeof resource.encryptedSecret === "string" && Boolean(resource.encryptedSecret));
}

export function parseAdminImBindings(value: unknown): AdminImBinding[] {
  const raw =
    typeof value === "object" && value !== null && typeof (value as { bindings?: unknown }).bindings === "object"
      ? ((value as { bindings: Record<string, unknown> }).bindings ?? {})
      : {};
  const rawResources =
    typeof value === "object" && value !== null && typeof (value as { resources?: unknown }).resources === "object"
      ? ((value as { resources: Record<string, unknown> }).resources ?? {})
      : {};
  const bindings: AdminImBinding[] = [];
  for (const [provider, record] of Object.entries(raw)) {
    if (!PROVIDERS.has(provider as AdminImProviderId) || typeof record !== "object" || record === null) continue;
    const binding = record as Record<string, unknown>;
    if (binding.status !== "pending" && binding.status !== "connected") continue;
    const providerId = provider as AdminImProviderId;
    if (binding.status === "connected" && !hasResource(rawResources, providerId)) continue;
    const resource =
      typeof rawResources[providerId] === "object" && rawResources[providerId] !== null
        ? (rawResources[providerId] as Record<string, unknown>)
        : {};
    if (
      binding.status === "pending" &&
      providerId === "wechat" &&
      (typeof binding.providerQrCode !== "string" ||
        typeof binding.providerBaseUrl !== "string" ||
        typeof binding.qrPayload !== "string")
    )
      continue;
    bindings.push({
      provider: providerId,
      status: binding.status,
      botName: typeof binding.botName === "string" ? binding.botName : null,
      externalDisplayName: typeof binding.externalDisplayName === "string" ? binding.externalDisplayName : null,
      externalTenantId: firstString(binding.externalTenantId, resource.externalTenantId),
      externalTenantName: firstString(binding.externalTenantName, resource.externalTenantName),
      connectedAt: typeof binding.connectedAt === "number" ? binding.connectedAt : null,
    });
  }
  return bindings;
}

export function adminImBindingsByPrincipal(
  entries: readonly (readonly [string, PersistedUiState])[],
): Map<string, AdminImBinding[]> {
  const result = new Map<string, AdminImBinding[]>();
  for (const [id, record] of entries) {
    if (!id.endsWith(IM_BINDINGS_SUFFIX)) continue;
    const principalId = id.slice(0, -IM_BINDINGS_SUFFIX.length);
    if (!principalId || principalId === "web-ui-im") continue;
    const bindings = parseAdminImBindings(record.value);
    if (bindings.length) result.set(principalId, bindings);
  }
  return result;
}
