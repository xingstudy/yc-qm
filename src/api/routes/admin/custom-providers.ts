import {
  CUSTOM_PROVIDER_PROTOCOLS,
  validateCustomProviderSpec,
  type CustomProviderSpec,
  type CustomProviderProtocol,
} from "../../../model/custom-providers.ts";
import { sendJson } from "../../http.ts";
import { normalizeProviderBaseUrl } from "../../../model/provider-endpoints.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

/**
 * Key validation against the registered endpoint, protocol-appropriate.
 * A gateway may not implement a models listing, so callers can skip
 * with {"validate": false} — the registration is admin-only either way.
 */
async function validateKey(
  ctx: ApiCtx,
  protocol: CustomProviderProtocol,
  baseUrl: string,
  apiKey: string,
): Promise<{ error: string; message: string } | undefined> {
  const url = protocol === "anthropic" ? `${baseUrl}/v1/models` : `${baseUrl}/models`;
  const headers: Record<string, string> =
    protocol === "anthropic"
      ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${apiKey}` };
  try {
    const response = await (ctx.deps.modelCredentialFetch ?? fetch)(url, {
      headers,
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const listing = (await response.json().catch(() => null)) as { data?: unknown } | null;
      if (listing && Array.isArray(listing.data)) return undefined;
      const hint =
        protocol !== "anthropic"
          ? "Use the API base URL, usually ending in /v1, rather than the website URL."
          : "Use the API base URL before /v1/messages.";
      return {
        error: "invalid_models_response",
        message: `${url} returned HTTP ${response.status}, but not a JSON model list. ${hint}`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        error: "invalid_api_key",
        message: `${url} rejected authentication (HTTP ${response.status}). Check the proxy API key and its authentication settings.`,
      };
    }
    if ([404, 405, 501].includes(response.status)) {
      return {
        error: "models_listing_unavailable",
        message: `${url} does not support model listing (HTTP ${response.status}). If this endpoint supports inference, uncheck "Validate key against the endpoint" (API: "validate": false) and save again.`,
      };
    }
    return {
      error: "endpoint_validation_failed",
      message: `${url} returned HTTP ${response.status} during model listing. Check the endpoint and retry.`,
    };
  } catch {
    return {
      error: "endpoint_validation_failed",
      message: `Could not reach ${url} for model listing. Check connectivity, TLS, and the endpoint's response time.`,
    };
  }
}

export async function getCustomProviders(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.read",
    resource: "custom-providers",
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { providers: await ctx.deps.customProviders.statuses() });
}

export async function putCustomProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.provider;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  const body = ctx.body as {
    name?: unknown;
    protocol?: unknown;
    baseUrl?: unknown;
    models?: unknown;
    apiKey?: unknown;
    validate?: unknown;
  };
  if (typeof body.name !== "string" || typeof body.protocol !== "string" || typeof body.baseUrl !== "string") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "name, protocol, and baseUrl are required" });
  }
  if (!(CUSTOM_PROVIDER_PROTOCOLS as readonly string[]).includes(body.protocol)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: `protocol must be one of ${CUSTOM_PROVIDER_PROTOCOLS.join(", ")}`,
    });
  }
  const spec: CustomProviderSpec = {
    id,
    name: body.name,
    protocol: body.protocol as CustomProviderProtocol,
    baseUrl: normalizeProviderBaseUrl(body.protocol, body.baseUrl),
    models: Array.isArray(body.models) ? (body.models as CustomProviderSpec["models"]) : [],
  };
  const apiKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
  try {
    validateCustomProviderSpec(spec);
  } catch (e) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (e as Error).message });
  }
  const shouldValidate = body.validate !== false && apiKey !== undefined;
  if (shouldValidate) {
    const failure = await validateKey(ctx, spec.protocol, spec.baseUrl, apiKey!);
    if (failure) return sendJson(ctx.res, 400, failure);
  }
  try {
    await ctx.deps.customProviders.upsert(spec, apiKey, authorized.id);
  } catch (e) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: (e as Error).message });
  }
  await ctx.deps.refreshCustomProviders?.();
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.update",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  const status = (await ctx.deps.customProviders.statuses()).find((item) => item.id === id);
  return sendJson(ctx.res, 200, { ok: true, status });
}

export async function deleteCustomProvider(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.customProviders) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.provider;
  if (!id) return sendJson(ctx.res, 404, { error: "not_found" });
  const removed = await ctx.deps.customProviders.delete(id, authorized.id);
  if (!removed) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.refreshCustomProviders?.();
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "custom-providers.delete",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
