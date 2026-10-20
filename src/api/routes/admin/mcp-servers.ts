import {
  isValidMcpServerId,
  usesMcpUserCredentials,
  validMcpTokenHeader,
  type McpOAuthSettings,
  type McpServer,
  type McpServerAuthMode,
} from "../../../mcp/mcp-server-store.ts";
import { assertMcpUrlPublic } from "../../../mcp/mcp-client.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const AUTH_MODES: McpServerAuthMode[] = ["none", "bearer", "client-credentials", "user-oauth", "user-token"];

async function oauthSettings(value: unknown): Promise<McpOAuthSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("oauth must be an object");
  const input = value as Record<string, unknown>;
  const allowed = [
    "registrationMode",
    "authorizationUrl",
    "tokenUrl",
    "scopes",
    "tokenEndpointAuthMethod",
    "clientMetadataUrl",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new Error("unsupported OAuth setting");
  const result: McpOAuthSettings = {};
  if (input.registrationMode !== undefined) {
    if (typeof input.registrationMode !== "string" || !["auto", "dynamic", "metadata"].includes(input.registrationMode))
      throw new Error("unsupported OAuth registration mode");
    result.registrationMode = input.registrationMode as McpOAuthSettings["registrationMode"];
  }
  for (const field of ["authorizationUrl", "tokenUrl", "clientMetadataUrl"] as const) {
    if (input[field] === undefined || input[field] === "") continue;
    if (typeof input[field] !== "string" || input[field].length > 2048) throw new Error(`invalid ${field}`);
    const url = new URL(input[field]);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error(`${field} must use public HTTPS`);
    if (field === "clientMetadataUrl" && (url.pathname === "/" || url.search))
      throw new Error("clientMetadataUrl requires a path without query");
    await assertMcpUrlPublic(url.toString());
    result[field] = url.toString();
  }
  if (!!result.authorizationUrl !== !!result.tokenUrl)
    throw new Error("authorizationUrl and tokenUrl must be configured together");
  if (input.scopes !== undefined) {
    if (
      !Array.isArray(input.scopes) ||
      input.scopes.length > 100 ||
      input.scopes.some((scope) => typeof scope !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(scope))
    )
      throw new Error("scopes must be an array of OAuth scope strings");
    result.scopes = [...new Set(input.scopes as string[])];
  }
  if (input.tokenEndpointAuthMethod !== undefined) {
    if (!["none", "client_secret_basic", "client_secret_post"].includes(String(input.tokenEndpointAuthMethod)))
      throw new Error("unsupported token endpoint authentication method");
    result.tokenEndpointAuthMethod = input.tokenEndpointAuthMethod as McpOAuthSettings["tokenEndpointAuthMethod"];
  }
  return result;
}

export function isMcpServerUrlAllowed(url: URL): boolean {
  return url.protocol === "https:";
}

export function mcpReadOnly(value: unknown, existing?: McpServer): boolean {
  return typeof value === "boolean" ? value : existing?.readOnly === true;
}

export function canReuseMcpCredentials(existing: McpServer | null, url: string, auth: McpServerAuthMode): boolean {
  return existing?.auth === auth && existing.url === url;
}

function credentialValue(value: unknown, existing: string | undefined, reuse: boolean): string | undefined {
  if (typeof value === "string" && value) return value;
  return reuse ? existing : undefined;
}

async function actor(ctx: ApiCtx) {
  const scope = orgScope(ctx.deps);
  return authorizeAdmin(ctx, scope);
}

function redact(server: McpServer): Omit<McpServer, "bearerToken" | "clientSecret"> & {
  hasBearerToken: boolean;
  hasClientSecret: boolean;
} {
  const { bearerToken, clientSecret, ...rest } = server;
  return { ...rest, hasBearerToken: !!bearerToken, hasClientSecret: !!clientSecret };
}

export async function getMcpServers(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.read",
    resource: "mcp-servers",
    scopeLabel: orgScope(ctx.deps),
  });
  const servers = await ctx.deps.mcpServers.list();
  return sendJson(ctx.res, 200, {
    servers: servers.map(redact),
    tools: ctx.deps.mcpToolService?.toolDefs().map(({ name, serverId, description, readOnly }) => ({
      name,
      serverId,
      description,
      readOnly,
    })),
  });
}

export async function putMcpServer(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.id ?? "";
  if (!isValidMcpServerId(id)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "id must be 2-40 chars: lowercase letters, digits, hyphens, starting with a letter",
    });
  }
  const b = ctx.body as Partial<McpServer> & { validate?: boolean };
  const url = typeof b.url === "string" ? b.url.trim() : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "url must be a valid URL" });
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "url must not carry credentials, query, or fragment",
    });
  }
  const auth = (b.auth ?? "none") as McpServerAuthMode;
  if (!AUTH_MODES.includes(auth)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: `auth must be one of ${AUTH_MODES.join(", ")}` });
  }
  if (!isMcpServerUrlAllowed(parsed)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "MCP servers must use https" });
  }
  try {
    await assertMcpUrlPublic(url);
  } catch {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "MCP server destination must be public" });
  }
  const existing = await ctx.deps.mcpServers.get(id);
  const reuseCredentials = canReuseMcpCredentials(existing, url, auth);
  let oauth: McpOAuthSettings | undefined;
  if (auth === "user-oauth") {
    try {
      if (b.oauth !== undefined) oauth = await oauthSettings(b.oauth);
      else if (reuseCredentials) oauth = existing?.oauth;
      if (oauth && Object.keys(oauth).length === 0) oauth = undefined;
    } catch (error) {
      return sendJson(ctx.res, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : "invalid OAuth settings",
      });
    }
  }
  const credentialScope = b.credentialScope ?? existing?.credentialScope ?? "shared";
  if (credentialScope !== "shared" && credentialScope !== "per-user") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "credentialScope must be shared or per-user" });
  }
  const credentialHost = b.credentialHost ?? existing?.credentialHost;
  const credentialAccountType = b.credentialAccountType ?? existing?.credentialAccountType ?? "default";
  if (!["default", "personal", "company"].includes(credentialAccountType)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "credentialAccountType must be default, personal, or company",
    });
  }
  if (
    credentialScope === "per-user" &&
    (typeof credentialHost !== "string" ||
      !credentialHost ||
      credentialHost !== credentialHost.trim() ||
      credentialHost.length > 253 ||
      /[\s/\\?#@]/.test(credentialHost))
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "per-user credentials require a credentialHost" });
  }
  if (
    credentialScope === "per-user" &&
    parsed.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  ) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "per-user credentials require HTTPS (except loopback)",
    });
  }
  const tokenHeader = b.tokenHeader ?? (reuseCredentials ? existing?.tokenHeader : undefined);
  const tokenPrefix = b.tokenPrefix ?? (reuseCredentials ? existing?.tokenPrefix : undefined);
  if (
    (tokenHeader !== undefined && (typeof tokenHeader !== "string" || !validMcpTokenHeader(tokenHeader))) ||
    (tokenPrefix !== undefined &&
      (typeof tokenPrefix !== "string" || tokenPrefix.length > 80 || /[\r\n\x00]/.test(tokenPrefix)))
  )
    return sendJson(ctx.res, 400, { error: "bad_request", message: "invalid token header or prefix" });
  const server: McpServer = {
    id,
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : id,
    url,
    auth,
    credentialScope,
    ...(credentialScope === "per-user" ? { credentialHost, credentialAccountType } : {}),
    ...(auth === "bearer"
      ? {
          bearerToken: credentialValue(b.bearerToken, existing?.bearerToken, reuseCredentials),
        }
      : {}),
    ...(auth === "client-credentials" || auth === "user-oauth"
      ? {
          clientId:
            auth === "user-oauth" && b.clientId === ""
              ? undefined
              : credentialValue(b.clientId, existing?.clientId, reuseCredentials),
          clientSecret: credentialValue(
            b.clientSecret,
            existing?.clientSecret,
            reuseCredentials && (b.clientId === undefined || b.clientId === existing?.clientId),
          ),
        }
      : {}),
    ...(oauth ? { oauth } : {}),
    ...(auth === "bearer" || auth === "user-token" ? { tokenHeader, tokenPrefix } : {}),
    readOnly: mcpReadOnly(b.readOnly, existing ?? undefined),
    enabled: b.enabled !== false,
    updatedAt: Date.now(),
    updatedBy: authorized.id,
  };
  if (auth === "bearer" && !server.bearerToken) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "bearer auth requires bearerToken" });
  }
  if (auth === "client-credentials" && (!server.clientId || !server.clientSecret)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "client-credentials auth requires clientId and clientSecret",
    });
  }
  if (
    auth === "user-oauth" &&
    ((server.clientId !== undefined && (server.clientId.length > 2048 || /[\s\x00-\x1f\x7f]/.test(server.clientId))) ||
      (server.clientSecret && !server.clientId) ||
      (oauth?.clientMetadataUrl && server.clientId) ||
      (oauth?.registrationMode && oauth.registrationMode !== "auto" && server.clientId) ||
      (oauth?.registrationMode === "dynamic" && oauth.clientMetadataUrl) ||
      (oauth?.authorizationUrl && !server.clientId) ||
      (oauth?.tokenEndpointAuthMethod &&
        oauth.tokenEndpointAuthMethod !== "none" &&
        (!server.clientId || !server.clientSecret)))
  )
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "OAuth settings require a valid Client ID and matching client authentication credentials",
    });
  let toolNames: string[] | undefined;
  if (!usesMcpUserCredentials(server) && b.validate !== false && ctx.deps.mcpToolService) {
    try {
      toolNames = await ctx.deps.mcpToolService.probe(server);
    } catch {
      return sendJson(ctx.res, 400, {
        error: "unreachable",
        message: "MCP server validation failed",
      });
    }
  }
  await ctx.deps.mcpServers.put(server);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.update",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true, server: redact(server), ...(toolNames ? { tools: toolNames } : {}) });
}

export async function deleteMcpServer(ctx: ApiCtx): Promise<void> {
  const authorized = await actor(ctx);
  if (!authorized) return;
  if (!ctx.deps.mcpServers) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = ctx.params.id ?? "";
  if (!isValidMcpServerId(id)) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "id must be 2-40 chars: lowercase letters, digits, hyphens, starting with a letter",
    });
  }
  await ctx.deps.mcpServers.delete(id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.delete",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
