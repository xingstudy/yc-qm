/**
 * Durable, encrypted storage for custom model providers.
 *
 * Mirrors model-credential-store: specs live in a DurableMap, API keys
 * are encrypted at rest with a key derived from the connector secret,
 * and the store never hands the plaintext key to anything but the
 * per-call resolver.
 */

import { randomUUID } from "node:crypto";
import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { validateCustomProviderSpec, type CustomProviderSpec } from "./custom-providers.ts";

export interface StoredCustomProvider extends CustomProviderSpec {
  apiKeyEnc?: string;
  disabled?: boolean;
  revision?: string;
  updatedAt: number;
  updatedBy: string;
}

interface CustomProviderStatus extends CustomProviderSpec {
  disabled: boolean;
  hasKey: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface CustomProviderStore {
  /** Enabled specs only — what the runtime registry should serve. */
  enabled(): Promise<CustomProviderSpec[]>;
  /** Everything, for the admin surface (no secrets). */
  statuses(): Promise<CustomProviderStatus[]>;
  runtimeSnapshot(): Promise<{ providers: CustomProviderSpec[]; fingerprint: string }>;
  /** Plaintext key for one provider, or null when absent/disabled. */
  resolveKey(id: string): Promise<string | null>;
  upsert(spec: CustomProviderSpec, apiKey: string | undefined, updatedBy: string): Promise<void>;
  delete(id: string, updatedBy: string): Promise<boolean>;
}

function strip(saved: StoredCustomProvider): CustomProviderSpec {
  return {
    id: saved.id,
    name: saved.name,
    protocol: saved.protocol,
    baseUrl: saved.baseUrl,
    models: saved.models,
  };
}

export function createCustomProviderStore(input: {
  backing: DurableMap<StoredCustomProvider>;
  keyMaterial: string | Buffer;
}): CustomProviderStore {
  const key = deriveConnectorKey(input.keyMaterial, "custom-model-providers");
  const update = input.backing.update?.bind(input.backing);
  const insertIfAbsent = input.backing.insertIfAbsent?.bind(input.backing);
  if (!update || !insertIfAbsent) {
    throw new Error("custom provider storage requires atomic update and insert operations");
  }

  return {
    async enabled() {
      const all = await input.backing.all();
      return all.filter((p) => !p.disabled && p.apiKeyEnc).map(strip);
    },

    async statuses() {
      const all = await input.backing.all();
      return all
        .map((p) => ({
          ...strip(p),
          disabled: p.disabled ?? false,
          hasKey: Boolean(p.apiKeyEnc),
          updatedAt: p.updatedAt,
          updatedBy: p.updatedBy,
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async runtimeSnapshot() {
      const all = (await input.backing.all()).sort((a, b) => a.id.localeCompare(b.id));
      return {
        providers: all.filter((provider) => !provider.disabled && provider.apiKeyEnc).map(strip),
        fingerprint: JSON.stringify(
          all.map((provider) => ({
            id: provider.id,
            revision:
              provider.revision ??
              JSON.stringify({
                ...strip(provider),
                disabled: provider.disabled ?? false,
                hasKey: Boolean(provider.apiKeyEnc),
                updatedAt: provider.updatedAt,
                updatedBy: provider.updatedBy,
              }),
          })),
        ),
      };
    },

    async resolveKey(id) {
      const saved = await input.backing.get(id);
      if (!saved || saved.disabled || !saved.apiKeyEnc) return null;
      return decryptSecret(saved.apiKeyEnc, key);
    },

    async upsert(spec, apiKey, updatedBy) {
      validateCustomProviderSpec(spec);
      const actor = updatedBy.trim();
      if (!actor) throw new Error("updatedBy is required");
      const trimmedKey = apiKey?.trim();
      const saved = (apiKeyEnc: string): StoredCustomProvider => ({
        ...spec,
        apiKeyEnc,
        disabled: false,
        revision: randomUUID(),
        updatedAt: Date.now(),
        updatedBy: actor,
      });
      if (trimmedKey) {
        const next = saved(encryptSecret(trimmedKey, key));
        if (await insertIfAbsent(spec.id, next)) return;
        await update(spec.id, () => next);
        return;
      }
      const updated = await update(spec.id, (existing) => {
        const sameEndpoint =
          existing && !existing.disabled && existing.protocol === spec.protocol && existing.baseUrl === spec.baseUrl;
        if (!sameEndpoint || !existing.apiKeyEnc) {
          throw new Error("API key is required when creating, restoring, or changing the provider endpoint");
        }
        return saved(existing.apiKeyEnc);
      });
      if (!updated) throw new Error("API key is required when creating, restoring, or changing the provider endpoint");
    },

    async delete(id, updatedBy) {
      let removed = false;
      const updated = await update(id, (existing) => {
        if (existing.disabled) return existing;
        removed = true;
        return {
          ...strip(existing),
          disabled: true,
          revision: randomUUID(),
          updatedAt: Date.now(),
          updatedBy,
        };
      });
      return Boolean(updated && removed);
    },
  };
}
