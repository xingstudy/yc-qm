import { NonRetryableTurnError } from "../core/turn-error.ts";
import {
  customProviderApi,
  resolveCustomModel,
  type CustomProviderConnection,
  type CustomRuntimeModel,
} from "../model/custom-providers.ts";
import { isModelProvider, resolveModel, type ModelProvider } from "../model/pi-models.ts";
import { nativeProviderTarget } from "../model/native-provider-target.ts";

export type ResolveNativeProvider = (providerId: string) => Promise<CustomProviderConnection | null>;
export type ResolveNativeCredential = (provider: ModelProvider) => Promise<string | null>;

export interface NativeProviderBinding {
  model: CustomRuntimeModel;
  apiKey: string;
  bearer?: boolean;
}

export function nativeCustomModel(modelId: string): CustomRuntimeModel | undefined {
  const custom = resolveCustomModel(modelId);
  return custom && resolveModel(modelId)?.provider === custom.provider ? custom : undefined;
}

export function nativeUtilityModel(modelId: string, harness: "claude" | "codex"): string {
  const provider = resolveModel(modelId)?.provider;
  if (harness === "claude" && provider === "anthropic") return "claude-haiku-4-5";
  if (harness === "codex" && provider === "openai") return "gpt-5.4-mini";
  return modelId;
}

export async function resolveNativeProvider(
  modelId: string,
  harness: "claude" | "codex",
  resolveConnection?: ResolveNativeProvider,
  resolveCredential?: ResolveNativeCredential,
): Promise<NativeProviderBinding | undefined> {
  const custom = nativeCustomModel(modelId);
  if (!custom) {
    if (!resolveCredential) return undefined;
    const model = resolveModel(modelId);
    const target = model && nativeProviderTarget(model, harness);
    if (!model || !target || !isModelProvider(model.provider))
      throw new NonRetryableTurnError(`Model ${modelId} is unavailable for ${harness}`);
    let apiKey: string | null;
    try {
      apiKey = await resolveCredential(model.provider);
    } catch {
      throw new NonRetryableTurnError(`Model provider ${model.provider} credentials are unavailable`);
    }
    if (!apiKey?.trim()) throw new NonRetryableTurnError(`Model provider ${model.provider} is not configured`);
    return {
      model: { ...model, ...target } as CustomRuntimeModel,
      apiKey,
      bearer: target.bearer,
    };
  }
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
  const target = nativeProviderTarget(
    { api: customProviderApi(connection.spec.protocol), baseUrl: connection.spec.baseUrl },
    harness,
  );
  if (!target) {
    throw new NonRetryableTurnError(`Custom provider ${custom.provider} does not support ${harness} (${expectedApi})`);
  }
  return {
    model: {
      ...custom,
      api: expectedApi,
      baseUrl: target.baseUrl,
      contextWindow: specModel.contextWindow ?? 128_000,
      maxTokens: specModel.maxTokens ?? 8_192,
    },
    apiKey: connection.apiKey,
    bearer: target.bearer,
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
    if (binding.bearer) {
      env.ANTHROPIC_API_KEY = "";
      env.ANTHROPIC_AUTH_TOKEN = binding.apiKey;
    }
    env.ANTHROPIC_BASE_URL = binding.model.baseUrl;
  } else {
    delete env.CODEX_ACCESS_TOKEN;
    env.OPENAI_API_KEY = binding.apiKey;
    env.OPENAI_BASE_URL = binding.model.baseUrl;
  }
  return env;
}
