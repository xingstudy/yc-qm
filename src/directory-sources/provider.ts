import type {
  DirectoryProviderCapabilities,
  DirectoryEmailResolutionStatus,
  DirectorySourceProviderId,
  ExternalIdentityAssertion,
  NormalizedDirectoryMember,
  NormalizedDirectoryUnit,
} from "./types.ts";

export interface DirectoryProviderConfiguration {
  publicConfig: Record<string, string>;
  secretConfig: Record<string, string>;
}

export interface DirectoryConnectionResult {
  externalTenantId: string;
  capabilities: DirectoryProviderCapabilities;
}

export type DirectoryCorporateEmailLookupResult =
  | { status: "resolved"; externalSubjectId: string }
  | { status: Exclude<DirectoryEmailResolutionStatus, "resolved" | "conflict">; errorCode?: string };

export interface DirectoryProviderAdapter {
  readonly id: DirectorySourceProviderId;
  readonly displayName: string;
  readonly capabilities: DirectoryProviderCapabilities;
  readonly publicFields: readonly string[];
  readonly secretFields: readonly string[];
  readonly requiredSecretFields?: readonly string[];
  readonly legacySecretField?: string;
  normalizeSecretConfig?(secretConfig: Record<string, string>): Record<string, string>;
  configuredTenantId?(publicConfig: Record<string, string>): string | null;
  testConnection(config: DirectoryProviderConfiguration): Promise<DirectoryConnectionResult>;
  fullSync(
    config: DirectoryProviderConfiguration,
    context: { orgId: string; sourceId: string },
  ): AsyncIterable<NormalizedDirectoryMember>;
  targetedLookup(
    config: DirectoryProviderConfiguration,
    context: { orgId: string; sourceId: string; externalSubjectId: string },
  ): Promise<NormalizedDirectoryMember | null>;
  lookupByCorporateEmail?(
    config: DirectoryProviderConfiguration,
    input: { email: string },
  ): Promise<DirectoryCorporateEmailLookupResult>;
  organizationUnits?(
    config: DirectoryProviderConfiguration,
    context: { orgId: string; sourceId: string },
  ): AsyncIterable<NormalizedDirectoryUnit>;
  resolveLoginCode(
    config: DirectoryProviderConfiguration,
    input: { sourceId: string; code: string },
  ): Promise<ExternalIdentityAssertion>;
  authorizeUrl(config: Record<string, string>, input: { sourceId: string; state: string }): string;
}

export interface DirectoryProviderCatalogEntry {
  id: DirectorySourceProviderId;
  displayName: string;
  capabilities: DirectoryProviderCapabilities;
  publicFields: readonly string[];
  secretFields: readonly string[];
  requiredSecretFields: readonly string[];
}

export interface DirectoryProviderRegistry {
  get(id: string): DirectoryProviderAdapter | null;
  catalog(): DirectoryProviderCatalogEntry[];
}
