import { NonRetryableTurnError } from "../core/turn-error.ts";
import {
  customProviderApi,
  resolveCustomModel,
  type CustomProviderConnection,
  type CustomRuntimeModel,
} from "../model/custom-providers.ts";
import { resolveModel } from "../model/pi-models.ts";
import { normalizeProviderBaseUrl } from "../model/provider-endpoints.ts";

export type ResolveNativeProvider = (providerId: string) => Promise<CustomProviderConnection | null>;

export interface NativeProviderBinding {
  model: CustomRuntimeModel;
  apiKey: string;
}

export function nativeCustomModel(modelId: string): CustomRuntimeModel | undefined {
  const custom = resolveCustomModel(modelId);
  return custom && resolveModel(modelId)?.provider === custom.provider ? custom : undefined;
}

export async function resolveNativeProvider(
  modelId: string,
  harness: "claude" | "codex",
  resolveConnection?: ResolveNativeProvider,
): Promise<NativeProviderBinding | undefined> {
  const custom = nativeCustomModel(modelId);
  if (!custom) return undefined;
  const expectedApi = harness === "claude" ? "anthropic-messages" : "openai-responses";
  let connection: CustomProviderConnection | null | undefined;
  try {
    connection = await resolveConnection?.(custom.provider);
  } catch {
    throw new NonRetryableTurnError(`Custom provider ${custom.provider} credentials are unavailable`);
  }
  const specModel = connection?.spec.models.find((model) => model.id === custom.id);
  if (!connection?.apiKey.trim() || connection.spec.id !== custom.provider || !specModel) {
    throw new NonRetryableTurnError(`Custom provider ${custom.provider} or model ${custom.id} is unavailable`);
  }
  if (customProviderApi(connection.spec.protocol) !== expectedApi) {
    throw new NonRetryableTurnError(`Custom provider ${custom.provider} does not support ${harness} (${expectedApi})`);
  }
  return {
    model: {
      ...custom,
      api: expectedApi,
      baseUrl: normalizeProviderBaseUrl(connection.spec.protocol, connection.spec.baseUrl),
      contextWindow: specModel.contextWindow ?? 128_000,
      maxTokens: specModel.maxTokens ?? 8_192,
    },
    apiKey: connection.apiKey,
  };
}

export function nativeProviderEnv(
  harness: "claude" | "codex",
  source: NodeJS.ProcessEnv,
  binding?: NativeProviderBinding,
): NodeJS.ProcessEnv {
  if (!binding) return source;
  const env = { ...source };
  if (harness === "claude") {
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    env.ANTHROPIC_API_KEY = binding.apiKey;
    env.ANTHROPIC_BASE_URL = binding.model.baseUrl;
  } else {
    delete env.CODEX_ACCESS_TOKEN;
    env.OPENAI_API_KEY = binding.apiKey;
    env.OPENAI_BASE_URL = binding.model.baseUrl;
  }
  return env;
}
