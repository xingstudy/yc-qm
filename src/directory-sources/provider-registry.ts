import type { DirectoryProviderAdapter, DirectoryProviderCatalogEntry, DirectoryProviderRegistry } from "./provider.ts";

export function createDirectoryProviderRegistry(
  adapters: readonly DirectoryProviderAdapter[],
): DirectoryProviderRegistry {
  const byId = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  if (byId.size !== adapters.length) throw new Error("duplicate directory source provider id");
  for (const adapter of adapters) {
    if (adapter.capabilities.corporateEmailSubjectLookup === true && !adapter.lookupByCorporateEmail) {
      throw new Error("directory provider email lookup capability mismatch");
    }
    if (adapter.capabilities.organizationUnits === true && !adapter.organizationUnits) {
      throw new Error("directory provider organization unit capability mismatch");
    }
  }
  return {
    get(id) {
      return byId.get(id) ?? null;
    },
    catalog(): DirectoryProviderCatalogEntry[] {
      return adapters.map((adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        capabilities: adapter.capabilities,
        publicFields: adapter.publicFields,
        secretFields: adapter.secretFields,
        requiredSecretFields: adapter.requiredSecretFields ?? adapter.secretFields,
      }));
    },
  };
}
