import { randomUUID } from "node:crypto";
import type { AuditLog } from "../audit/audit-log.ts";
import { createKeyedQueue } from "../util/async.ts";
import { createMcpClient, mcpResultText, type McpAuth, type McpClient, type McpFetch } from "./mcp-client.ts";
import type { McpServer, McpServerStore } from "./mcp-server-store.ts";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 8_000;
const MAX_TOOLS_PER_SERVER = 64;
const MAX_RESULT_CHARS = 60_000;

export interface McpToolDescriptor {
  name: string;
  serverId: string;
  remoteName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
  capability: string;
}

type DiscoveredMcpTool = Omit<McpToolDescriptor, "capability">;

export interface McpToolService {
  toolDefs(): McpToolDescriptor[];
  call(capability: string, args: Record<string, unknown>, principalId?: string): Promise<string>;
  refresh(): Promise<void>;
  ready(): Promise<void>;
  probe(server: McpServer): Promise<string[]>;
  close(): Promise<void>;
}

function authOf(server: McpServer): McpAuth {
  if (server.auth === "bearer") return { mode: "bearer", token: server.bearerToken ?? "" };
  if (server.auth === "client-credentials")
    return { mode: "client-credentials", clientId: server.clientId ?? "", clientSecret: server.clientSecret ?? "" };
  return { mode: "none" };
}

export function createMcpToolService(opts: {
  servers: McpServerStore;
  audit?: AuditLog;
  fetchImpl?: McpFetch;
  now?: () => number;
  refreshIntervalMs?: number;
  requestTimeoutMs?: number;
  readyTimeoutMs?: number;
}): McpToolService {
  const now = opts.now ?? (() => Date.now());
  const clients = new Map<string, { client: McpClient; server: McpServer }>();
  let snapshot: McpToolDescriptor[] = [];
  let capabilities = new Map<string, { descriptor: McpToolDescriptor; server: McpServer; identity: string }>();
  let closed = false;
  let refreshGeneration = 0;
  let activeCalls = 0;
  const callDrains = new Set<() => void>();
  const cleanups = new Set<Promise<void>>();
  const queue = createKeyedQueue<string>();
  const readyTimeoutMs = opts.readyTimeoutMs ?? READY_TIMEOUT_MS;

  function record(action: string, resource: string, status: string, principalId?: string): void {
    opts.audit?.record({
      at: now(),
      principalId: principalId || "system",
      action: `mcp.${action}`,
      resource,
      scopeLabel: "mcp-connectors",
      status,
    });
  }

  function clientFor(server: McpServer): McpClient {
    if (closed) throw new Error("MCP tool service is closed");
    const cached = clients.get(server.id);
    if (cached && JSON.stringify(cached.server) === JSON.stringify(server)) return cached.client;
    if (cached) retire(cached.client);
    const client = createMcpClient({
      url: server.url,
      auth: authOf(server),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      now,
      ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    });
    clients.set(server.id, { client, server });
    return client;
  }

  function retire(client: McpClient): void {
    const cleanup = client.close().finally(() => cleanups.delete(cleanup));
    cleanups.add(cleanup);
  }

  async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
    const remaining = Math.max(1, deadline - Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("MCP discovery timed out")), remaining);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function identity(server: McpServer, descriptor: DiscoveredMcpTool): string {
    const { capability: _capability, ...stableDescriptor } = descriptor as McpToolDescriptor;
    return JSON.stringify({ server, descriptor: stableDescriptor });
  }

  async function refresh(): Promise<void> {
    if (closed) return;
    const generation = ++refreshGeneration;
    await queue("mcp-tools", async () => {
      if (closed || generation !== refreshGeneration) return;
      const deadline = Date.now() + readyTimeoutMs;
      let servers: McpServer[];
      try {
        servers = (await beforeDeadline(opts.servers.list(), deadline)).filter((s) => s.enabled);
      } catch {
        record("list", "registry", "error");
        throw new Error("MCP registry is unavailable");
      }
      for (const [id, cached] of clients) {
        const server = servers.find((candidate) => candidate.id === id);
        if (!server || JSON.stringify(server) !== JSON.stringify(cached.server)) {
          retire(cached.client);
          clients.delete(id);
        }
      }
      const discovered = await Promise.all(
        servers.map(async (server): Promise<DiscoveredMcpTool[]> => {
          const client = clientFor(server);
          try {
            const tools = (await beforeDeadline(client.listTools(), deadline)).slice(0, MAX_TOOLS_PER_SERVER);
            record("list", server.id, `ok tools=${tools.length}`);
            return tools.map((tool) => ({
              name: `${server.id}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
              serverId: server.id,
              remoteName: tool.name,
              description: tool.description || `${tool.name} on ${server.name}`,
              inputSchema: tool.inputSchema,
              readOnly: server.readOnly === true && tool.annotations?.readOnlyHint === true,
            }));
          } catch {
            if (clients.get(server.id)?.client === client) clients.delete(server.id);
            retire(client);
            record("list", server.id, "error");
            return [];
          }
        }),
      );
      const next = discovered.flat();
      if (generation !== refreshGeneration) return;
      const seen = new Set<string>();
      const previous = new Map(
        [...capabilities.values()].map((entry) => [entry.identity, entry.descriptor.capability]),
      );
      const serverById = new Map(servers.map((server) => [server.id, server]));
      snapshot = next
        .filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)))
        .map((descriptor) => {
          const server = serverById.get(descriptor.serverId)!;
          const stableIdentity = identity(server, descriptor);
          return { ...descriptor, capability: previous.get(stableIdentity) ?? randomUUID() };
        });
      capabilities = new Map(
        snapshot.map((descriptor) => [
          descriptor.capability,
          {
            descriptor,
            server: serverById.get(descriptor.serverId)!,
            identity: identity(serverById.get(descriptor.serverId)!, descriptor),
          },
        ]),
      );
    });
  }

  let latestRefresh = Promise.resolve();
  const trackedRefresh = () => {
    const pending = refresh();
    latestRefresh = pending;
    return pending;
  };
  const scheduleRefresh = () => {
    void trackedRefresh().catch(() => record("list", "registry", "error"));
  };
  const unsubscribe = opts.servers.onChange(scheduleRefresh);
  const timer = setInterval(() => {
    if (!closed) scheduleRefresh();
  }, opts.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
  timer.unref?.();
  const initialRefresh = trackedRefresh();
  void initialRefresh.catch(() => record("list", "registry", "error"));

  return {
    toolDefs: () => snapshot.map((descriptor) => ({ ...descriptor })),
    async call(capability, args, principalId) {
      if (closed) throw new Error("MCP tool service is closed");
      activeCalls += 1;
      try {
        const exposed = capabilities.get(capability);
        if (!exposed) throw new Error("unknown MCP tool capability");
        const { descriptor: def, server: exposedServer } = exposed;
        const server = await beforeDeadline(opts.servers.get(def.serverId), Date.now() + readyTimeoutMs);
        if (closed) throw new Error("MCP tool service is closed");
        if (
          capabilities.get(capability) !== exposed ||
          !server ||
          !server.enabled ||
          JSON.stringify(server) !== JSON.stringify(exposedServer)
        ) {
          throw new Error(`MCP server ${def.serverId} is not available`);
        }
        try {
          const result = await clientFor(server).callTool(def.remoteName, args);
          record("call", `${def.serverId}/${def.remoteName}`, "ok", principalId);
          const text = mcpResultText(result) || JSON.stringify(result.structuredContent ?? "") || "";
          return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]` : text;
        } catch {
          record("call", `${def.serverId}/${def.remoteName}`, "error", principalId);
          throw new Error(`MCP tool ${def.serverId}/${def.remoteName} failed`);
        }
      } finally {
        activeCalls -= 1;
        if (activeCalls === 0) {
          for (const drain of callDrains) drain();
          callDrains.clear();
        }
      }
    },
    refresh: trackedRefresh,
    async ready() {
      let pending = latestRefresh;
      while (true) {
        try {
          await pending;
        } catch (error) {
          if (pending === latestRefresh) throw error;
        }
        if (pending === latestRefresh) return;
        pending = latestRefresh;
      }
    },
    async probe(server) {
      const client = createMcpClient({
        url: server.url,
        auth: authOf(server),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        now,
        ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
      });
      try {
        const tools = await client.listTools();
        return tools.map((t) => t.name);
      } finally {
        await client.close();
      }
    },
    async close() {
      closed = true;
      clearInterval(timer);
      unsubscribe();
      await queue("mcp-tools", async () => undefined);
      if (activeCalls > 0) await new Promise<void>((resolve) => callDrains.add(resolve));
      await Promise.all([...clients.values()].map((cached) => cached.client.close()));
      clients.clear();
      await Promise.all([...cleanups]);
    },
  };
}
