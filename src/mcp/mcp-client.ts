import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import { isPrivateNetworkIp } from "../util/network.ts";

const TOKEN_SKEW_MS = 60_000;
const MCP_ACCEPT = "application/json, text/event-stream";
const MCP_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_MAX_BYTES = 64 * 1024;
const RPC_MAX_BYTES = 1024 * 1024;

interface McpHttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
}

export type McpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; redirect: "error"; signal: AbortSignal },
) => Promise<McpHttpResponse>;

const BLOCKED_MCP_HOSTS = ["metadata.google.internal", "metadata.goog"];

function normalizedHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1")
    .replace(/\.$/, "");
}

async function resolvePublicMcpAddress(hostname: string): Promise<string> {
  const normalized = normalizedHostname(hostname);
  if (
    !normalized ||
    BLOCKED_MCP_HOSTS.some((blocked) => normalized === blocked || normalized.endsWith(`.${blocked}`))
  ) {
    throw new Error("MCP server destination must be public");
  }
  if (isIP(normalized)) {
    if (isPrivateNetworkIp(normalized)) throw new Error("MCP server destination must be public");
    return normalized;
  }
  const addresses = await dnsLookup(normalized, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkIp(address))) {
    throw new Error("MCP server destination must be public");
  }
  return addresses[0]!.address;
}

export async function assertMcpUrlPublic(url: string): Promise<void> {
  await resolvePublicMcpAddress(new URL(url).hostname);
}

function createMcpDispatcher(): Agent {
  const connect = buildConnector({});
  return new Agent({
    connect(options, callback) {
      const servername = options.servername ?? normalizedHostname(options.hostname);
      void resolvePublicMcpAddress(options.hostname).then(
        (address) => connect({ ...options, hostname: address, host: address, servername }, callback),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
      );
    },
  });
}

function realFetch(dispatcher: Agent): McpFetch {
  return (url, init) => {
    if (init.method !== "GET") return undiciFetch(url, { ...init, dispatcher });
    const { body: _body, ...request } = init;
    return undiciFetch(url, { ...request, dispatcher });
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface McpEnvelope {
  jsonrpc?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id?: unknown;
}

function validMcpEnvelope(value: unknown, id: unknown): value is McpEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  const hasResult = Object.prototype.hasOwnProperty.call(envelope, "result");
  const hasError = Object.prototype.hasOwnProperty.call(envelope, "error");
  if (envelope.jsonrpc !== "2.0" || envelope.id !== id || hasResult === hasError) return false;
  if (!hasError) return true;
  const error = envelope.error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return false;
  const fields = error as Record<string, unknown>;
  return Number.isInteger(fields.code) && typeof fields.message === "string" && fields.message.length > 0;
}

function parseSseFrame(frame: string): { envelope?: unknown; eventId?: string } {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  const idLine = lines.find((line) => line.startsWith("id:"));
  const eventId = idLine?.slice(3).replace(/^ /, "");
  return {
    ...(data ? { envelope: safeJson(data) } : {}),
    ...(eventId !== undefined && !eventId.includes("\u0000") ? { eventId } : {}),
  };
}

function parseSseText(text: string, id: unknown): { envelope: McpEnvelope | null; eventId?: string } {
  let eventId: string | undefined;
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const parsed = parseSseFrame(frame);
    if (parsed.eventId !== undefined) eventId = parsed.eventId;
    if (validMcpEnvelope(parsed.envelope, id)) return { envelope: parsed.envelope, ...(eventId ? { eventId } : {}) };
  }
  return { envelope: null, ...(eventId ? { eventId } : {}) };
}

function parseMcpEnvelope(text: string, id: unknown): McpEnvelope | null {
  const envelope = safeJson(text);
  return validMcpEnvelope(envelope, id) ? envelope : null;
}

export interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export function mcpResultText(result: McpToolResult): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .filter((c) => c?.type === "text")
    .map((c) => String(c.text ?? ""))
    .join("\n")
    .trim();
}

interface McpToolAnnotations {
  readOnlyHint?: boolean;
}

interface McpRemoteTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export type McpAuth =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "client-credentials"; clientId: string; clientSecret: string };

export interface McpClient {
  readonly base: string;
  readonly host: string;
  listTools(): Promise<McpRemoteTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  close(): Promise<void>;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

class McpHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

class McpConnectionChangedError extends Error {}

export function createMcpClient(opts: {
  url: string;
  auth: McpAuth;
  fetchImpl?: McpFetch;
  now?: () => number;
  requestTimeoutMs?: number;
}): McpClient {
  if (opts.auth.mode !== "none" && new URL(opts.url).protocol !== "https:") {
    throw new Error("MCP servers with credentials must use https");
  }
  const dispatcher = opts.fetchImpl ? undefined : createMcpDispatcher();
  const fetchImpl = opts.fetchImpl ?? realFetch(dispatcher!);
  const now = opts.now ?? (() => Date.now());
  const endpoint = opts.url.replace(/\/+$/g, "");
  const base = endpoint.replace(/\/mcp$/g, "");
  const host = hostOf(endpoint);
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let cached: CachedToken | null = null;
  let minting: Promise<string> | undefined;
  let rpcId = 0;
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  let initialized: Promise<void> | undefined;
  let epoch = 0;
  let closed = false;
  const controllers = new Set<AbortController>();

  async function readBody(response: McpHttpResponse, maxBytes: number): Promise<string> {
    const contentLength = Number(response.headers?.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes)
      throw new Error(`MCP response exceeds ${maxBytes} bytes`);
    if (!response.body) {
      const text = await response.text();
      if (Buffer.byteLength(text) > maxBytes) throw new Error(`MCP response exceeds ${maxBytes} bytes`);
      return text;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) throw new Error(`MCP response exceeds ${maxBytes} bytes`);
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  }

  async function readSseEnvelope(
    response: McpHttpResponse,
    id: unknown,
    maxBytes: number,
  ): Promise<{ envelope: McpEnvelope | null; eventId?: string }> {
    if (!response.body) {
      const text = await response.text();
      if (Buffer.byteLength(text) > maxBytes) throw new Error(`MCP response exceeds ${maxBytes} bytes`);
      return parseSseText(text, id);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let size = 0;
    let eventId: string | undefined;
    const consumeFrames = () => {
      while (true) {
        const boundary = /\r?\n\r?\n/.exec(buffer);
        if (!boundary) return null;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const parsed = parseSseFrame(frame);
        if (parsed.eventId !== undefined) eventId = parsed.eventId;
        if (validMcpEnvelope(parsed.envelope, id))
          return { envelope: parsed.envelope, ...(eventId ? { eventId } : {}) };
      }
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const parsed = consumeFrames();
          if (parsed) return parsed;
          const trailing = parseSseFrame(buffer);
          if (trailing.eventId !== undefined) eventId = trailing.eventId;
          if (validMcpEnvelope(trailing.envelope, id))
            return { envelope: trailing.envelope, ...(eventId ? { eventId } : {}) };
          return { envelope: null, ...(eventId ? { eventId } : {}) };
        }
        size += value.byteLength;
        if (size > maxBytes) throw new Error(`MCP response exceeds ${maxBytes} bytes`);
        buffer += decoder.decode(value, { stream: true });
        const parsed = consumeFrames();
        if (parsed) return parsed;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  async function request<T>(
    url: string,
    init: Omit<Parameters<McpFetch>[1], "signal">,
    consume: (response: McpHttpResponse) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    controllers.add(controller);
    let rejectTimeout = (_error: Error) => {};
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      controller.abort();
      rejectTimeout(new Error(`MCP request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    try {
      return await Promise.race([fetchImpl(url, { ...init, signal: controller.signal }).then(consume), timeout]);
    } finally {
      controller.abort();
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }

  async function mintToken(clientId: string, clientSecret: string): Promise<string> {
    const skew = cached ? Math.min(TOKEN_SKEW_MS, Math.max(1_000, (cached.expiresAt - now()) / 2)) : TOKEN_SKEW_MS;
    if (cached && now() < cached.expiresAt - skew) return cached.accessToken;
    if (minting) return minting;
    const mintEpoch = epoch;
    const pending = request(
      `${base}/token`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
        redirect: "error",
      },
      async (res) => {
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new McpHttpError(res.status, `mcp token mint failed (HTTP ${res.status})`);
        }
        const body = (safeJson(await readBody(res, TOKEN_MAX_BYTES)) ?? {}) as {
          access_token?: unknown;
          expires_in?: unknown;
        };
        const accessToken = typeof body.access_token === "string" ? body.access_token : "";
        if (!accessToken) throw new Error("mcp token mint returned no access_token");
        const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 0;
        if (mintEpoch === epoch)
          cached = { accessToken, expiresAt: expiresIn > 0 ? now() + expiresIn * 1000 : Infinity };
        return accessToken;
      },
    );
    minting = pending;
    try {
      return await pending;
    } finally {
      if (minting === pending) minting = undefined;
    }
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const auth = opts.auth;
    if (auth.mode === "none") return {};
    if (auth.mode === "bearer") return { authorization: `Bearer ${auth.token}` };
    return { authorization: `Bearer ${await mintToken(auth.clientId, auth.clientSecret)}` };
  }

  function resultOfEnvelope(envelope: McpEnvelope, method: string): unknown {
    if (Object.prototype.hasOwnProperty.call(envelope, "error")) throw new Error(`mcp ${method} returned an error`);
    return envelope.result ?? {};
  }

  async function resumeSse(
    method: string,
    id: unknown,
    eventId: string,
    requestEpoch: number,
    attempt = 0,
  ): Promise<unknown> {
    const authorization = await authHeaders();
    if (requestEpoch !== epoch) throw new McpConnectionChangedError();
    const resumeSessionId = sessionId;
    const resumeProtocolVersion = protocolVersion;
    return request(
      endpoint,
      {
        method: "GET",
        headers: {
          ...authorization,
          accept: "text/event-stream",
          "last-event-id": eventId,
          ...(resumeSessionId ? { "mcp-session-id": resumeSessionId } : {}),
          ...(resumeProtocolVersion ? { "mcp-protocol-version": resumeProtocolVersion } : {}),
        },
        body: "",
        redirect: "error",
      },
      async (res) => {
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(`mcp ${method} stream resumption failed (HTTP ${res.status})`);
        }
        if (!res.headers?.get("content-type")?.toLowerCase().includes("text/event-stream")) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(`mcp ${method} stream resumption returned non-SSE`);
        }
        const resumed = await readSseEnvelope(res, id, RPC_MAX_BYTES);
        if (resumed.envelope) return resultOfEnvelope(resumed.envelope, method);
        if (resumed.eventId && attempt < 2) return resumeSse(method, id, resumed.eventId, requestEpoch, attempt + 1);
        throw new Error(`mcp ${method} stream ended before its response`);
      },
    );
  }

  async function rpc(
    method: string,
    params: Record<string, unknown>,
    expectResponse = true,
    requestEpoch = epoch,
  ): Promise<unknown> {
    const id = expectResponse ? ++rpcId : undefined;
    const requestSessionId = sessionId;
    const requestProtocolVersion = protocolVersion;
    const authorization = await authHeaders();
    if (requestEpoch !== epoch) throw new McpConnectionChangedError();
    return request(
      endpoint,
      {
        method: "POST",
        headers: {
          ...authorization,
          "content-type": "application/json",
          accept: MCP_ACCEPT,
          ...(requestSessionId ? { "mcp-session-id": requestSessionId } : {}),
          ...(requestProtocolVersion ? { "mcp-protocol-version": requestProtocolVersion } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
        redirect: "error",
      },
      async (res) => {
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new McpHttpError(res.status, `mcp ${method} failed (HTTP ${res.status})`);
        }
        const nextSessionId = res.headers?.get("mcp-session-id");
        if (nextSessionId && requestEpoch === epoch) sessionId = nextSessionId;
        if (!expectResponse) {
          await readBody(res, RPC_MAX_BYTES);
          return {};
        }
        const isSse = res.headers?.get("content-type")?.toLowerCase().includes("text/event-stream") === true;
        if (isSse) {
          const streamed = await readSseEnvelope(res, id, RPC_MAX_BYTES);
          if (streamed.envelope) return resultOfEnvelope(streamed.envelope, method);
          if (streamed.eventId) return resumeSse(method, id, streamed.eventId, requestEpoch);
          throw new Error(`mcp ${method} returned non-JSON`);
        }
        const parsed = parseMcpEnvelope(await readBody(res, RPC_MAX_BYTES), id);
        if (!parsed) throw new Error(`mcp ${method} returned non-JSON`);
        return resultOfEnvelope(parsed, method);
      },
    );
  }

  async function initialize(): Promise<void> {
    const initializationEpoch = epoch;
    const result = (await rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "qm", version: "0.1.0" },
    })) as { protocolVersion?: unknown };
    if (result.protocolVersion !== MCP_PROTOCOL_VERSION)
      throw new Error("mcp initialize returned unsupported protocolVersion");
    if (initializationEpoch === epoch) protocolVersion = result.protocolVersion;
    await rpc("notifications/initialized", {}, false, initializationEpoch);
  }

  function ready(): Promise<void> {
    if (closed) throw new Error("MCP client is closed");
    if (!initialized) {
      const initializationEpoch = epoch;
      initialized = initialize().catch((error) => {
        if (initializationEpoch === epoch) {
          initialized = undefined;
          sessionId = undefined;
          protocolVersion = undefined;
        }
        throw error;
      });
    }
    return initialized;
  }

  function invalidate(connectionEpoch: number, clearToken: boolean): void {
    if (connectionEpoch !== epoch) return;
    epoch += 1;
    initialized = undefined;
    sessionId = undefined;
    protocolVersion = undefined;
    if (clearToken) cached = null;
    minting = undefined;
  }

  async function call(method: string, params: Record<string, unknown>, retry = true): Promise<unknown> {
    if (closed) throw new Error("MCP client is closed");
    const waiting = ready();
    const waitingEpoch = epoch;
    try {
      await waiting;
    } catch (error) {
      if (error instanceof McpConnectionChangedError && !closed) return call(method, params, retry);
      if (!retry || !(error instanceof McpHttpError) || (error.status !== 401 && error.status !== 404)) throw error;
      if (epoch === waitingEpoch) invalidate(waitingEpoch, error.status === 401);
      return call(method, params, false);
    }
    if (epoch !== waitingEpoch) return call(method, params, retry);
    const connection = initialized;
    const requestEpoch = epoch;
    try {
      return await rpc(method, params, true, requestEpoch);
    } catch (error) {
      if (error instanceof McpConnectionChangedError && !closed) return call(method, params, retry);
      if (!(error instanceof McpHttpError) || (error.status !== 401 && error.status !== 404)) throw error;
      if (!retry) throw error;
      if (initialized === connection) invalidate(requestEpoch, error.status === 401);
      return call(method, params, false);
    }
  }

  return {
    base,
    host,
    async listTools() {
      if (closed) throw new Error("MCP client is closed");
      const result = (await call("tools/list", {})) as { tools?: unknown };
      if (!Array.isArray(result.tools)) return [];
      const out: McpRemoteTool[] = [];
      for (const raw of result.tools) {
        const t = raw as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown };
        if (typeof t.name !== "string" || !t.name) continue;
        out.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : "",
          inputSchema:
            t.inputSchema && typeof t.inputSchema === "object"
              ? (t.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
          ...(t.annotations &&
          typeof t.annotations === "object" &&
          (t.annotations as { readOnlyHint?: unknown }).readOnlyHint === true
            ? { annotations: { readOnlyHint: true } }
            : {}),
        });
      }
      return out;
    },
    async callTool(name, args) {
      if (closed) throw new Error("MCP client is closed");
      const result = (await call("tools/call", { name, arguments: args })) as McpToolResult;
      if (result.isError) throw new Error(`mcp tool ${name} returned an error`);
      return result;
    },
    async close() {
      if (closed) return;
      closed = true;
      const closingSession = sessionId;
      const closingProtocolVersion = protocolVersion;
      epoch += 1;
      initialized = undefined;
      sessionId = undefined;
      protocolVersion = undefined;
      for (const controller of controllers) controller.abort();
      if (!closingSession) {
        await dispatcher?.close();
        return;
      }
      try {
        await request(
          endpoint,
          {
            method: "DELETE",
            headers: {
              ...(await authHeaders()),
              "mcp-session-id": closingSession,
              ...(closingProtocolVersion ? { "mcp-protocol-version": closingProtocolVersion } : {}),
            },
            body: "",
            redirect: "error",
          },
          async (response) => {
            await readBody(response, RPC_MAX_BYTES);
          },
        );
      } catch {
        return;
      } finally {
        await dispatcher?.close();
      }
    },
  };
}
