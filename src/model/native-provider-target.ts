import { normalizeProviderBaseUrl } from "./provider-endpoints.ts";

export function nativeProviderTarget(
  model: { api: string; baseUrl: string },
  harness: "claude" | "codex",
): { api: "anthropic-messages" | "openai-responses"; baseUrl: string; bearer: boolean } | undefined {
  const api = harness === "claude" ? "anthropic-messages" : "openai-responses";
  const url = URL.parse(model.baseUrl);
  const path = url?.pathname.replace(/\/+$/, "");
  const direct = url && !url.username && !url.password && !url.search && !url.hash;
  if (direct && url.origin === "https://openrouter.ai" && (path === "/api" || path === "/api/v1")) {
    return { api, baseUrl: `https://openrouter.ai/api${harness === "codex" ? "/v1" : ""}`, bearer: true };
  }
  if (
    harness === "claude" &&
    direct &&
    url.origin === "https://api.deepseek.com" &&
    (path === "" || path === "/v1" || path === "/anthropic")
  ) {
    return { api, baseUrl: "https://api.deepseek.com/anthropic", bearer: true };
  }
  if (model.api !== api) return undefined;
  return {
    api,
    baseUrl: normalizeProviderBaseUrl(harness === "claude" ? "anthropic" : "openai-responses", model.baseUrl),
    bearer: false,
  };
}
