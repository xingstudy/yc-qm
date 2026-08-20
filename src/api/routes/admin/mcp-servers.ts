import { isValidMcpServerId, type McpServer, type McpServerAuthMode } from "../../../mcp/mcp-server-store.ts";
import { assertMcpUrlPublic } from "../../../mcp/mcp-client.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const AUTH_MODES: McpServerAuthMode[] = ["none", "bearer", "client-credentials"];

export function isMcpServerUrlAllowed(url: URL, auth: McpServerAuthMode): boolean {
  return auth === "none" || url.protocol === "https:";
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
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "url must be http(s)" });
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
  if (!isMcpServerUrlAllowed(parsed, auth)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "MCP servers with credentials must use https" });
  }
  try {
    await assertMcpUrlPublic(url);
  } catch {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "MCP server destination must be public" });
  }
  const existing = await ctx.deps.mcpServers.get(id);
  const reuseCredentials = canReuseMcpCredentials(existing, url, auth);
  const server: McpServer = {
    id,
    name: typeof b.name === "string" && b.name.trim() ? b.name.trim().slice(0, 80) : id,
    url,
    auth,
    ...(auth === "bearer"
      ? {
          bearerToken: credentialValue(b.bearerToken, existing?.bearerToken, reuseCredentials),
        }
      : {}),
    ...(auth === "client-credentials"
      ? {
          clientId: credentialValue(b.clientId, existing?.clientId, reuseCredentials),
          clientSecret: credentialValue(b.clientSecret, existing?.clientSecret, reuseCredentials),
        }
      : {}),
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
  let toolNames: string[] | undefined;
  if (b.validate !== false && ctx.deps.mcpToolService) {
    try {
      toolNames = await ctx.deps.mcpToolService.probe(server);
    } catch (_error) {
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
  if (!(await ctx.deps.mcpServers.get(id))) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.mcpServers.delete(id);
  audit(ctx.deps, {
    principalId: authorized.id,
    action: "mcp-servers.delete",
    resource: id,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
