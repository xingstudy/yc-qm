import { decryptSecret, deriveConnectorKey, encryptSecret } from "../connectors/connector-client-store.ts";
import type { DurableMap } from "../persistence/durable-map.ts";

export type McpServerAuthMode = "none" | "bearer" | "client-credentials";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: McpServerAuthMode;
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  readOnly: boolean;
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

export interface StoredMcpServer extends Omit<McpServer, "bearerToken" | "clientSecret"> {
  bearerTokenEnc?: string;
  clientSecretEnc?: string;
  bearerToken?: string;
  clientSecret?: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export function isValidMcpServerId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export interface McpServerStore {
  list(): Promise<McpServer[]>;
  get(id: string): Promise<McpServer | null>;
  put(server: McpServer): Promise<void>;
  delete(id: string): Promise<void>;
  onChange(listener: () => void): () => void;
}

function hasLegacySecret(server: StoredMcpServer): boolean {
  return typeof server.bearerToken === "string" || typeof server.clientSecret === "string";
}

function storedServer(server: McpServer, key: ReturnType<typeof deriveConnectorKey>): StoredMcpServer {
  const { bearerToken, clientSecret, ...rest } = server;
  return {
    ...rest,
    ...(bearerToken ? { bearerTokenEnc: encryptSecret(bearerToken, key) } : {}),
    ...(clientSecret ? { clientSecretEnc: encryptSecret(clientSecret, key) } : {}),
  };
}

function runtimeServer(server: StoredMcpServer, key: ReturnType<typeof deriveConnectorKey>): McpServer {
  const { bearerTokenEnc, clientSecretEnc, bearerToken, clientSecret, ...rest } = server;
  const resolvedBearerToken = bearerTokenEnc ? decryptSecret(bearerTokenEnc, key) : bearerToken;
  const resolvedClientSecret = clientSecretEnc ? decryptSecret(clientSecretEnc, key) : clientSecret;
  return {
    ...rest,
    ...(resolvedBearerToken ? { bearerToken: resolvedBearerToken } : {}),
    ...(resolvedClientSecret ? { clientSecret: resolvedClientSecret } : {}),
  };
}

export function createMcpServerStore(input: {
  backing: DurableMap<StoredMcpServer>;
  keyMaterial: string | Buffer;
}): McpServerStore {
  const key = deriveConnectorKey(input.keyMaterial, "mcp-server-secrets");
  const update = input.backing.update?.bind(input.backing);
  if (!update) throw new Error("MCP server storage requires atomic update operations");
  const migrate = async (id: string, server: StoredMcpServer): Promise<McpServer> => {
    if (!hasLegacySecret(server)) return runtimeServer(server, key);
    const migrated = await update(id, (current) =>
      hasLegacySecret(current) ? storedServer(runtimeServer(current, key), key) : current,
    );
    if (!migrated) throw new Error(`MCP server '${id}' disappeared during secret migration`);
    return runtimeServer(migrated, key);
  };
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    async list() {
      const entries = await input.backing.entries();
      const servers: McpServer[] = [];
      for (const [id, server] of entries) {
        try {
          servers.push(await migrate(id, server));
        } catch {
          continue;
        }
      }
      return servers.sort((a, b) => a.id.localeCompare(b.id));
    },
    async get(id) {
      const server = await input.backing.get(id);
      return server ? migrate(id, server) : null;
    },
    put: async (server) => {
      await input.backing.put(server.id, storedServer(server, key));
      emit();
    },
    delete: async (id) => {
      await input.backing.delete(id);
      emit();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
