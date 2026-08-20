import { createServer } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { assertMcpUrlPublic, createMcpClient, mcpResultText, type McpFetch } from "../src/mcp/mcp-client.ts";
import {
  createMcpServerStore,
  isValidMcpServerId,
  type McpServer,
  type StoredMcpServer,
} from "../src/mcp/mcp-server-store.ts";
import { createMcpToolService } from "../src/mcp/mcp-tool-service.ts";
import { canReuseMcpCredentials, isMcpServerUrlAllowed, mcpReadOnly } from "../src/api/routes/admin/mcp-servers.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

function jsonResponse(body: unknown, status = 200, contentType = "application/json") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? contentType : null) },
  };
}

function jsonResponseWithHeaders(body: unknown, status: number, headers: Record<string, string>) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  };
}

const networkTestFetch: McpFetch = async (url, init) => {
  if (init.method !== "GET") return fetch(url, init);
  const { body: _body, ...request } = init;
  return fetch(url, request);
};

const TOOLS = [
  {
    name: "query",
    description: "Run a query",
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  { name: "update", description: "Write a record", inputSchema: { type: "object", properties: {} } },
];

function mcpStore(backing = createMemoryMap<StoredMcpServer>()) {
  return createMcpServerStore({ backing, keyMaterial: "test-mcp-server-key" });
}

function fakeServerFetch(opts?: {
  requireBearer?: string;
  sse?: boolean;
  tools?: () => unknown[] | Promise<unknown[]>;
}): {
  fetch: McpFetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: McpFetch = async (url, init) => {
    calls.push(url);
    if (opts?.requireBearer && init.headers.authorization !== `Bearer ${opts.requireBearer}`) {
      return jsonResponse({ error: "unauthorized" }, 401);
    }
    const req = JSON.parse(init.body) as { id: number; method: string; params: { name?: string } };
    let result: unknown;
    if (req.method === "initialize") {
      result = { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "fake", version: "1" } };
    } else if (req.method === "tools/list") {
      result = { tools: (await opts?.tools?.()) ?? TOOLS };
    } else if (req.method === "notifications/initialized") {
      result = {};
    } else {
      result = { content: [{ type: "text", text: `ran ${req.params.name}` }] };
    }
    const envelope = { jsonrpc: "2.0", id: req.id, result };
    if (opts?.sse) {
      return jsonResponse(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, 200, "text/event-stream");
    }
    return jsonResponse(envelope);
  };
  return { fetch, calls };
}

function server(partial?: Partial<McpServer>): McpServer {
  return {
    id: "crm",
    name: "CRM",
    url: "https://mcp.example.com/mcp",
    auth: "none",
    readOnly: true,
    enabled: true,
    updatedAt: 0,
    updatedBy: "internal:admin",
    ...partial,
  };
}

test("mcp client lists tools and calls one over plain JSON", async () => {
  const { fetch } = fakeServerFetch();
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["query", "update"],
  );
  assert.equal(tools.find((tool) => tool.name === "query")?.annotations?.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === "update")?.annotations, undefined);
  const result = await client.callTool("query", { q: "hi" });
  assert.equal(mcpResultText(result), "ran query");
});

test("mcp client interoperates with an official stateful Streamable HTTP server", async () => {
  const mcp = new Server({ name: "interop", version: "1" }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "query", description: "Query", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [{ type: "text", text: `official ${request.params.name}` }],
  }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "official-session" });
  await mcp.connect(transport);
  const http = createServer((req, res) => void transport.handleRequest(req, res));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  try {
    const address = http.address();
    assert.ok(address && typeof address !== "string");
    const client = createMcpClient({
      url: `http://127.0.0.1:${address.port}/mcp`,
      auth: { mode: "none" },
      fetchImpl: networkTestFetch,
    });
    assert.equal((await client.listTools())[0]?.name, "query");
    assert.equal(mcpResultText(await client.callTool("query", {})), "official query");
  } finally {
    await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    await transport.close();
  }
});

test("MCP default transport rejects metadata, loopback, link-local, and private destinations", async () => {
  for (const url of [
    "http://127.0.0.1/mcp",
    "http://[::1]/mcp",
    "http://[::ffff:127.0.0.1]/mcp",
    "http://169.254.169.254/mcp",
    "https://10.1.2.3/mcp",
    "https://metadata.google.internal/mcp",
    "http://localhost/mcp",
  ]) {
    await assert.rejects(assertMcpUrlPublic(url), /destination must be public/);
  }
  const client = createMcpClient({ url: "http://127.0.0.1/mcp", auth: { mode: "none" } });
  await assert.rejects(client.listTools(), (error: Error & { cause?: unknown }) => {
    assert.match(error.message, /fetch failed/);
    assert.match(error.cause instanceof Error ? error.cause.message : "", /destination must be public/);
    return true;
  });
  await client.close();
});

test("an expired MCP session initializes again before retrying", async () => {
  let initializes = 0;
  let lists = 0;
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id?: number; method: string };
      if (request.method === "initialize") {
        initializes += 1;
        return jsonResponseWithHeaders(
          { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } },
          200,
          { "mcp-session-id": `session-${initializes}`, "content-type": "application/json" },
        );
      }
      if (request.method === "notifications/initialized") {
        assert.equal(request.id, undefined);
        return jsonResponse({}, 202);
      }
      lists += 1;
      if (lists === 1) {
        assert.equal(init.headers["mcp-session-id"], "session-1");
        return jsonResponse({}, 404);
      }
      assert.equal(init.headers["mcp-session-id"], "session-2");
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: TOOLS } });
    },
  });
  assert.equal((await client.listTools()).length, 2);
  assert.equal(initializes, 2);
});

test("mcp client parses SSE-framed responses", async () => {
  const { fetch } = fakeServerFetch({ sse: true });
  const client = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  const tools = await client.listTools();
  assert.equal(tools.length, 2);
});

test("mcp client sends bearer auth", async () => {
  const { fetch } = fakeServerFetch({ requireBearer: "sekret" });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "bearer", token: "sekret" },
    fetchImpl: fetch,
  });
  assert.equal((await client.listTools()).length, 2);
  const bad = createMcpClient({ url: "https://mcp.example.com/mcp", auth: { mode: "none" }, fetchImpl: fetch });
  await assert.rejects(() => bad.listTools(), /HTTP 401/);
});

test("MCP credentials require HTTPS", () => {
  assert.throws(
    () => createMcpClient({ url: "http://mcp.example.com/mcp", auth: { mode: "bearer", token: "sekret" } }),
    /must use https/,
  );
  assert.doesNotThrow(() => createMcpClient({ url: "http://mcp.example.com/mcp", auth: { mode: "none" } }));
  assert.equal(isMcpServerUrlAllowed(new URL("https://mcp.example.com/mcp"), "bearer"), true);
  assert.equal(isMcpServerUrlAllowed(new URL("http://mcp.example.com/mcp"), "client-credentials"), false);
  assert.equal(mcpReadOnly(undefined), false);
  assert.equal(mcpReadOnly(undefined, server({ readOnly: true })), true);
  assert.equal(mcpReadOnly("true"), false);
  const existing = server({ auth: "bearer", bearerToken: "secret" });
  assert.equal(canReuseMcpCredentials(existing, existing.url, "bearer"), true);
  assert.equal(canReuseMcpCredentials(existing, "https://mcp.example.com/other", "bearer"), false);
  assert.equal(canReuseMcpCredentials(existing, existing.url, "client-credentials"), false);
});

test("MCP requests reject every redirect status", async () => {
  for (const status of [301, 302, 307, 308]) {
    const requests: Array<{ url: string; redirect: string }> = [];
    const client = createMcpClient({
      url: "https://mcp.example.com/mcp",
      auth: { mode: "bearer", token: "sekret" },
      fetchImpl: async (url, init) => {
        requests.push({ url, redirect: init.redirect });
        return jsonResponse({ location: "http://other.example.com/mcp" }, status);
      },
    });
    await assert.rejects(() => client.listTools(), new RegExp(`HTTP ${status}`));
    assert.deepEqual(requests, [{ url: "https://mcp.example.com/mcp", redirect: "error" }]);
  }
});

test("MCP client-credential token requests reject redirects", async () => {
  const requests: Array<{ url: string; redirect: string }> = [];
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "client-credentials", clientId: "client", clientSecret: "secret" },
    fetchImpl: async (url, init) => {
      requests.push({ url, redirect: init.redirect });
      return jsonResponse({ location: "http://other.example.com/token" }, 307);
    },
  });
  await assert.rejects(() => client.listTools(), /token mint failed \(HTTP 307\)/);
  assert.deepEqual(requests, [{ url: "https://mcp.example.com/token", redirect: "error" }]);
});

test("MCP cancels non-success token and RPC response bodies", async () => {
  let cancellations = 0;
  const failedResponse = () => ({
    ok: false,
    status: 503,
    text: async () => new Promise<string>(() => {}),
    body: new ReadableStream<Uint8Array>({
      cancel() {
        cancellations += 1;
      },
    }),
    headers: { get: () => null },
  });
  const tokenClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "client-credentials", clientId: "client", clientSecret: "secret" },
    fetchImpl: async () => failedResponse(),
  });
  await assert.rejects(() => tokenClient.listTools(), /HTTP 503/);
  const rpcClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async () => failedResponse(),
  });
  await assert.rejects(() => rpcClient.listTools(), /HTTP 503/);
  assert.equal(cancellations, 2);
});

test("MCP retries initialization once with a fresh client-credential token after 401", async () => {
  let tokenMints = 0;
  let initializations = 0;
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "client-credentials", clientId: "client", clientSecret: "secret" },
    fetchImpl: async (url, init) => {
      if (url.endsWith("/token")) {
        tokenMints += 1;
        return jsonResponse({ access_token: `token-${tokenMints}`, expires_in: 3600 });
      }
      const request = JSON.parse(init.body) as { id?: number; method: string };
      if (request.method === "initialize") {
        initializations += 1;
        if (init.headers.authorization === "Bearer token-1") return jsonResponse({}, 401);
        assert.equal(init.headers.authorization, "Bearer token-2");
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-11-25", capabilities: {} },
        });
      }
      if (request.method === "notifications/initialized") return jsonResponse({}, 202);
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    },
  });
  assert.deepEqual(await client.listTools(), []);
  assert.equal(tokenMints, 2);
  assert.equal(initializations, 2);
});

test("concurrent MCP callers share one failed initialization and one recovery", async () => {
  let tokenMints = 0;
  let initializations = 0;
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "client-credentials", clientId: "client", clientSecret: "secret" },
    fetchImpl: async (url, init) => {
      if (url.endsWith("/token")) {
        tokenMints += 1;
        return jsonResponse({ access_token: `token-${tokenMints}`, expires_in: 3600 });
      }
      const request = JSON.parse(init.body) as { id?: number; method: string };
      if (request.method === "initialize") {
        initializations += 1;
        if (init.headers.authorization === "Bearer token-1") return jsonResponse({}, 401);
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-11-25", capabilities: {} },
        });
      }
      if (request.method === "notifications/initialized") return jsonResponse({}, 202);
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    },
  });
  const [first, second] = await Promise.all([client.listTools(), client.listTools()]);
  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(tokenMints, 2);
  assert.equal(initializations, 2);
});

test("short-lived client-credential tokens cache and refresh single-flight", async () => {
  let clock = 0;
  let tokenMints = 0;
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "client-credentials", clientId: "client", clientSecret: "secret" },
    now: () => clock,
    fetchImpl: async (url, init) => {
      if (url.endsWith("/token")) {
        tokenMints += 1;
        return jsonResponse({ access_token: `token-${tokenMints}`, expires_in: 30 });
      }
      const request = JSON.parse(init.body) as { id?: number; method: string; params?: { name?: string } };
      let result: unknown = {};
      if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {} };
      if (request.method === "tools/list") result = { tools: TOOLS };
      if (request.method === "tools/call")
        result = { content: [{ type: "text", text: `ran ${request.params?.name}` }] };
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
    },
  });
  await client.listTools();
  clock = 1_000;
  await client.listTools();
  assert.equal(tokenMints, 1);
  clock = 30_000;
  await Promise.all([client.callTool("query", {}), client.callTool("update", {})]);
  assert.equal(tokenMints, 2);
});

test("MCP resumes a primed SSE response without repeating the tool call", async () => {
  let callId: number | undefined;
  let toolPosts = 0;
  let resumes = 0;
  let streamCancelled = false;
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async (_url, init) => {
      if (init.method === "GET") {
        resumes += 1;
        assert.equal(init.headers["last-event-id"], "event-1");
        assert.equal(init.headers["mcp-session-id"], "session-1");
        return {
          ok: true,
          status: 200,
          text: async () => "",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `id: event-2\ndata: ${JSON.stringify({
                    jsonrpc: "2.0",
                    id: callId,
                    result: { content: [{ type: "text", text: "resumed" }] },
                  })}\n\n`,
                ),
              );
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
        };
      }
      const request = JSON.parse(init.body) as { id?: number; method: string };
      if (request.method === "notifications/initialized") return jsonResponse({}, 202);
      if (request.method === "tools/call") {
        toolPosts += 1;
        callId = request.id;
        return jsonResponseWithHeaders("id: event-1\n\n", 200, {
          "content-type": "text/event-stream",
          "mcp-session-id": "session-1",
        });
      }
      const result =
        request.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: {} } : { tools: TOOLS };
      return jsonResponseWithHeaders({ jsonrpc: "2.0", id: request.id, result }, 200, {
        "content-type": "application/json",
        "mcp-session-id": "session-1",
      });
    },
  });
  await client.listTools();
  assert.equal(mcpResultText(await client.callTool("query", {})), "resumed");
  assert.equal(toolPosts, 1);
  assert.equal(resumes, 1);
  assert.equal(streamCancelled, true);
});

test("MCP token and initialized notification bodies honor request timeout", async () => {
  const hanging = {
    ok: true,
    status: 200,
    text: async () => new Promise<string>(() => {}),
    headers: { get: () => null },
  };
  const tokenClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "client-credentials", clientId: "client", clientSecret: "secret" },
    requestTimeoutMs: 10,
    fetchImpl: async () => hanging,
  });
  await assert.rejects(() => tokenClient.listTools(), /timed out/);
  const notificationClient = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    requestTimeoutMs: 10,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id?: number; method: string };
      if (request.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-11-25", capabilities: {} },
        });
      }
      return hanging;
    },
  });
  await assert.rejects(() => notificationClient.listTools(), /timed out/);
});

test("MCP rejects a chunked response that exceeds its byte limit", async () => {
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id?: number; method: string };
      if (request.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-11-25", capabilities: {} },
        });
      }
      if (request.method === "notifications/initialized") return jsonResponse({}, 202);
      return {
        ok: true,
        status: 200,
        text: async () => "",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
            controller.close();
          },
        }),
        headers: { get: () => null },
      };
    },
  });
  await assert.rejects(() => client.listTools(), /exceeds/);
});

test("MCP rejects JSON and SSE responses with the wrong protocol envelope", async () => {
  for (const contentType of ["application/json", "text/event-stream"]) {
    for (const corruption of ["version", "id"]) {
      const client = createMcpClient({
        url: "https://mcp.example.com/mcp",
        auth: { mode: "none" },
        fetchImpl: async (_url, init) => {
          const request = JSON.parse(init.body) as { id?: number; method: string };
          let result: unknown = { tools: [] };
          if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {} };
          if (request.method === "notifications/initialized") result = {};
          const envelope = {
            jsonrpc: request.method === "tools/list" && corruption === "version" ? "1.0" : "2.0",
            id: request.method === "tools/list" && corruption === "id" ? -1 : request.id,
            result,
          };
          const body = contentType === "text/event-stream" ? `data: ${JSON.stringify(envelope)}\n\n` : envelope;
          return jsonResponse(body, 200, contentType);
        },
      });
      await assert.rejects(() => client.listTools(), /non-JSON/);
    }
  }
});

test("MCP rejects ambiguous and malformed JSON-RPC envelopes", async () => {
  const malformed = [
    { error: null },
    { error: 0 },
    { result: {}, error: { code: -1, message: "bad" } },
    {},
    { error: { code: "-1", message: "bad" } },
    { error: { code: -1, message: "" } },
  ];
  for (const contentType of ["application/json", "text/event-stream"]) {
    for (const fields of malformed) {
      const client = createMcpClient({
        url: "https://mcp.example.com/mcp",
        auth: { mode: "none" },
        fetchImpl: async (_url, init) => {
          const request = JSON.parse(init.body) as { id?: number; method: string };
          if (request.method === "notifications/initialized") return jsonResponse({}, 202);
          const envelope = {
            jsonrpc: "2.0",
            id: request.id,
            ...(request.method === "initialize"
              ? { result: { protocolVersion: "2025-11-25", capabilities: {} } }
              : fields),
          };
          return jsonResponse(
            contentType === "text/event-stream" ? `data: ${JSON.stringify(envelope)}\n\n` : envelope,
            200,
            contentType,
          );
        },
      });
      await assert.rejects(() => client.listTools(), /non-JSON/);
    }
  }
});

test("MCP rejects an unsupported negotiated protocol version", async () => {
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id?: number; method: string };
      return jsonResponse({
        jsonrpc: "2.0",
        id: request.id,
        result: { protocolVersion: "2024-11-05", capabilities: {} },
      });
    },
  });
  await assert.rejects(() => client.listTools(), /unsupported protocolVersion/);
});

test("MCP close deletes the active session", async () => {
  const methods: string[] = [];
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async (_url, init) => {
      methods.push(init.method);
      const request = init.method === "POST" ? (JSON.parse(init.body) as { id?: number; method: string }) : undefined;
      if (init.method === "DELETE") return jsonResponse({}, 204);
      let result: unknown = {};
      if (request?.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {} };
      if (request?.method === "tools/list") result = { tools: [] };
      return jsonResponseWithHeaders({ jsonrpc: "2.0", id: request?.id, result }, 200, {
        "mcp-session-id": "closing-session",
        "content-type": "application/json",
      });
    },
  });
  await client.listTools();
  await client.close();
  assert.ok(methods.includes("DELETE"));
});

test("MCP close aborts initialization and permanently seals the client", async () => {
  let started: (() => void) | undefined;
  const initializationStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async (_url, init) => {
      started!();
      return await new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  });
  const listing = client.listTools();
  await initializationStarted;
  await client.close();
  await assert.rejects(listing, /aborted|closed/);
  await assert.rejects(() => client.listTools(), /closed/);
});

test("a stale concurrent session response cannot replace a rebuilt session", async () => {
  let resolveOld: (() => void) | undefined;
  const old = new Promise<void>((resolve) => {
    resolveOld = resolve;
  });
  let initializes = 0;
  const sessions: string[] = [];
  let calls = 0;
  const client = createMcpClient({
    url: "https://mcp.example.com/mcp",
    auth: { mode: "none" },
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id?: number; method: string };
      if (request.method === "initialize") {
        initializes += 1;
        return jsonResponseWithHeaders(
          { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-11-25", capabilities: {} } },
          200,
          { "mcp-session-id": `S${initializes}`, "content-type": "application/json" },
        );
      }
      if (request.method === "notifications/initialized") return jsonResponse({}, 202);
      sessions.push(init.headers["mcp-session-id"] ?? "");
      calls += 1;
      if (calls === 1) return jsonResponse({}, 404);
      if (calls === 2) {
        await old;
        return jsonResponseWithHeaders({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }, 200, {
          "mcp-session-id": "S1",
          "content-type": "application/json",
        });
      }
      return jsonResponseWithHeaders({ jsonrpc: "2.0", id: request.id, result: { tools: [] } }, 200, {
        "mcp-session-id": "S2",
        "content-type": "application/json",
      });
    },
  });
  const first = client.listTools();
  const second = client.listTools();
  await first;
  resolveOld!();
  await second;
  await client.listTools();
  assert.equal(sessions.at(-1), "S2");
});

test("server id validation", () => {
  assert.ok(isValidMcpServerId("salesforce"));
  assert.ok(isValidMcpServerId("crm-2"));
  assert.ok(!isValidMcpServerId("Nope"));
  assert.ok(!isValidMcpServerId("x"));
  assert.ok(!isValidMcpServerId("has space"));
});

test("tool service readiness waits for the initial registry hydration", async () => {
  const store = mcpStore();
  await store.put(server());
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const discoveryStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { fetch } = fakeServerFetch({
    tools: async () => {
      started!();
      await gate;
      return TOOLS;
    },
  });
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await discoveryStarted;
  assert.deepEqual(service.toolDefs(), []);
  release!();
  await service.ready();
  assert.equal(service.toolDefs().length, 2);
  await service.close();
});

test("tool service discovers healthy servers in parallel within one startup budget", async () => {
  const store = mcpStore();
  await store.put(server({ id: "good", url: "https://good.example.com/mcp" }));
  await store.put(server({ id: "bad-one", url: "https://bad-one.example.com/mcp" }));
  await store.put(server({ id: "bad-two", url: "https://bad-two.example.com/mcp" }));
  const fetchImpl: McpFetch = async (url, init) => {
    if (url.includes("bad-")) {
      return await new Promise<never>((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    const request = JSON.parse(init.body) as { id?: number; method: string };
    let result: unknown = {};
    if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {} };
    if (request.method === "tools/list") result = { tools: TOOLS };
    return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
  };
  const startedAt = Date.now();
  const service = createMcpToolService({
    servers: store,
    fetchImpl,
    requestTimeoutMs: 1000,
    readyTimeoutMs: 40,
    refreshIntervalMs: 3600_000,
  });
  await service.ready();
  assert.ok(Date.now() - startedAt < 250);
  assert.deepEqual(
    service.toolDefs().map((tool) => tool.serverId),
    ["good", "good"],
  );
  await service.close();
});

test("tool service readiness bounds a stalled registry read", async () => {
  const backing = mcpStore();
  const store = {
    ...backing,
    list: async () => await new Promise<McpServer[]>(() => {}),
  };
  const startedAt = Date.now();
  const service = createMcpToolService({ servers: store, readyTimeoutMs: 20, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.ready(), /registry/);
  assert.ok(Date.now() - startedAt < 200);
  await service.close();
});

test("tool service closes sessions when servers change, disable, and the service stops", async () => {
  const store = mcpStore();
  await store.put(server({ url: "https://first.example.com/mcp" }));
  const deleted: string[] = [];
  let session = 0;
  const fetchImpl: McpFetch = async (url, init) => {
    if (init.method === "DELETE") {
      deleted.push(url);
      return jsonResponse({}, 204);
    }
    const request = JSON.parse(init.body) as { id?: number; method: string };
    let result: unknown = {};
    if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {} };
    if (request.method === "tools/list") result = { tools: TOOLS };
    return jsonResponseWithHeaders({ jsonrpc: "2.0", id: request.id, result }, 200, {
      "mcp-session-id": `session-${++session}`,
      "content-type": "application/json",
    });
  };
  const service = createMcpToolService({ servers: store, fetchImpl, refreshIntervalMs: 3600_000 });
  await service.ready();
  await store.put(server({ url: "https://second.example.com/mcp" }));
  await service.refresh();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.ok(deleted.includes("https://first.example.com/mcp"));
  await store.put(server({ url: "https://second.example.com/mcp", enabled: false }));
  await service.refresh();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.ok(deleted.includes("https://second.example.com/mcp"));
  await store.put(server({ url: "https://third.example.com/mcp" }));
  await service.refresh();
  await service.close();
  assert.ok(deleted.includes("https://third.example.com/mcp"));
});

test("tool service close drains a call paused in registry validation", async () => {
  const backing = mcpStore();
  await backing.put(server());
  let blockGet = false;
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const store = {
    ...backing,
    async get(id: string) {
      if (blockGet) {
        started!();
        await gate;
      }
      return backing.get(id);
    },
  };
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await service.ready();
  const capability = service.toolDefs()[0]!.capability;
  blockGet = true;
  const call = service.call(capability, {});
  await getStarted;
  const closing = service.close();
  release!();
  await assert.rejects(call, /closed/);
  await closing;
});

test("tool service bounds a call stalled in registry validation and closes", async () => {
  const backing = mcpStore();
  await backing.put(server());
  let blockGet = false;
  const store = {
    ...backing,
    async get(id: string): Promise<McpServer | null> {
      if (blockGet) return await new Promise<McpServer | null>(() => {});
      return backing.get(id);
    },
  };
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({
    servers: store,
    fetchImpl: fetch,
    readyTimeoutMs: 20,
    refreshIntervalMs: 3600_000,
  });
  await service.ready();
  const capability = service.toolDefs()[0]!.capability;
  blockGet = true;
  const startedAt = Date.now();
  const call = service.call(capability, {});
  const closing = service.close();
  await assert.rejects(call, /timed out|closed/);
  await closing;
  assert.ok(Date.now() - startedAt < 200);
});

test("remote MCP error content never enters errors or durable audit status", async () => {
  const store = mcpStore();
  await store.put(server());
  const secret = "remote-sensitive-body";
  const audit: Array<{ status?: string }> = [];
  const fetchImpl: McpFetch = async (_url, init) => {
    const request = JSON.parse(init.body) as { id?: number; method: string };
    let result: unknown = {};
    if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {} };
    if (request.method === "tools/list") result = { tools: TOOLS };
    if (request.method === "tools/call") result = { isError: true, content: [{ type: "text", text: secret }] };
    return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
  };
  const service = createMcpToolService({
    servers: store,
    fetchImpl,
    refreshIntervalMs: 3600_000,
    audit: {
      record(event) {
        audit.push({ status: event.status });
      },
      events: async () => [],
      tail: async () => [],
    },
  });
  await service.ready();
  const capability = service.toolDefs().find((tool) => tool.remoteName === "query")!.capability;
  await assert.rejects(service.call(capability, {}), (error: Error) => {
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.ok(!JSON.stringify(audit).includes(secret));
  await service.close();
});

test("MCP server storage encrypts secrets and migrates legacy records", async () => {
  const backing = createMemoryMap<StoredMcpServer>();
  const store = mcpStore(backing);
  await store.put(
    server({ auth: "client-credentials", clientId: "client", clientSecret: "client-secret", bearerToken: "token" }),
  );
  const stored = await backing.get("crm");
  assert.equal(stored?.bearerToken, undefined);
  assert.equal(stored?.clientSecret, undefined);
  assert.ok(stored?.bearerTokenEnc);
  assert.ok(stored?.clientSecretEnc);
  assert.equal(JSON.stringify(stored).includes("client-secret"), false);
  await backing.put("legacy", {
    ...server({ id: "legacy", auth: "bearer", bearerToken: "legacy-token" }),
  });
  assert.equal((await store.get("legacy"))?.bearerToken, "legacy-token");
  const migrated = await backing.get("legacy");
  assert.equal(migrated?.bearerToken, undefined);
  assert.equal(JSON.stringify(migrated).includes("legacy-token"), false);
});

test("tool service exposes only annotated read-only MCP tools during a read-only wake", async () => {
  const store = mcpStore();
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const defs = service.toolDefs();
  assert.deepEqual(defs.map((d) => d.name).sort(), ["crm_query", "crm_update"]);
  assert.equal(defs.find((d) => d.name === "crm_query")?.readOnly, true);
  assert.equal(defs.find((d) => d.name === "crm_update")?.readOnly, false);
  await store.put(server({ readOnly: false }));
  await service.refresh();
  const refreshedQuery = service.toolDefs().find((d) => d.name === "crm_query")!;
  assert.equal(refreshedQuery.readOnly, false);
  const out = await service.call(refreshedQuery.capability, { q: "hello" }, "internal:U1");
  assert.equal(out, "ran query");
  service.close();
});

test("missing or invalid persisted read-only state is fail-closed", async () => {
  const backing = createMemoryMap<StoredMcpServer>();
  const store = mcpStore(backing);
  const { readOnly: _readOnly, ...missingReadOnly } = server({ id: "missing" });
  await backing.put("missing", missingReadOnly as StoredMcpServer);
  await backing.put("invalid", { ...server({ id: "invalid" }), readOnly: "true" } as unknown as StoredMcpServer);
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await service.refresh();
  const defs = service.toolDefs().filter((descriptor) => descriptor.remoteName === "query");
  assert.equal(defs.length, 2);
  assert.ok(defs.every((descriptor) => descriptor.readOnly === false));
  service.close();
});

test("disabled server's tools disappear and calls fail", async () => {
  const store = mcpStore();
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  assert.equal(service.toolDefs().length, 2);
  await store.put(server({ enabled: false }));
  await service.refresh();
  assert.equal(service.toolDefs().length, 0);
  service.close();
});

test("unknown tool call rejects", async () => {
  const store = mcpStore();
  const service = createMcpToolService({ servers: store, refreshIntervalMs: 3600_000 });
  await assert.rejects(() => service.call("nope_tool", {}), /unknown MCP tool capability/);
  service.close();
});

test("a refreshed MCP snapshot rejects an earlier capability", async () => {
  let tools: unknown[] = [
    { name: "safe/tool", description: "Read data", inputSchema: {}, annotations: { readOnlyHint: true } },
  ];
  const store = mcpStore();
  const { fetch } = fakeServerFetch({ tools: () => tools });
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const old = service.toolDefs()[0]!;
  assert.equal(old.readOnly, true);
  tools = [{ name: "safe:tool", description: "Write data", inputSchema: {} }];
  await service.refresh();
  const current = service.toolDefs()[0]!;
  assert.equal(current.name, old.name);
  assert.equal(current.readOnly, false);
  await assert.rejects(() => service.call(old.capability, {}), /unknown MCP tool capability/);
  service.close();
});

test("a delayed registry read cannot revive a replaced MCP configuration", async () => {
  const backing = mcpStore();
  const oldServer = server({ url: "https://old.example.com/mcp" });
  await backing.put(oldServer);
  let delayGet = false;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const store = {
    ...backing,
    async get(id: string) {
      if (!delayGet) return backing.get(id);
      started();
      await gate;
      return oldServer;
    },
  };
  const toolCalls: string[] = [];
  const fetchImpl: McpFetch = async (url, init) => {
    const request = JSON.parse(init.body) as { id?: number; method: string; params?: { name?: string } };
    let result: unknown = {};
    if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: {} };
    if (request.method === "tools/list") result = { tools: TOOLS };
    if (request.method === "tools/call") {
      toolCalls.push(url);
      result = { content: [{ type: "text", text: `ran ${request.params?.name}` }] };
    }
    return jsonResponse({ jsonrpc: "2.0", id: request.id, result });
  };
  const service = createMcpToolService({ servers: store, fetchImpl, refreshIntervalMs: 3600_000 });
  await service.ready();
  const capability = service.toolDefs()[0]!.capability;
  delayGet = true;
  const call = service.call(capability, {});
  await getStarted;
  await backing.put(server({ url: "https://new.example.com/mcp" }));
  await service.refresh();
  release();
  await assert.rejects(call, /not available/);
  assert.deepEqual(toolCalls, []);
  await service.close();
});

test("a descriptor contract change retires its capability", async () => {
  let tools: unknown[] = [
    { name: "query", description: "Original", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  ];
  const store = mcpStore();
  const { fetch } = fakeServerFetch({ tools: () => tools });
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const original = service.toolDefs()[0]!;
  tools = [
    { name: "query", description: "Changed", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  ];
  await service.refresh();
  assert.notEqual(service.toolDefs()[0]!.capability, original.capability);
  await assert.rejects(() => service.call(original.capability, {}), /unknown MCP tool capability/);
  service.close();
});

test("an unchanged MCP snapshot preserves its capability", async () => {
  const store = mcpStore();
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await service.refresh();
  const original = service.toolDefs().find((descriptor) => descriptor.name === "crm_query")!;
  await service.refresh();
  const refreshed = service.toolDefs().find((descriptor) => descriptor.name === "crm_query")!;
  assert.equal(refreshed.capability, original.capability);
  assert.equal(await service.call(original.capability, { q: "still valid" }), "ran query");
  service.close();
});

test("a slower obsolete refresh cannot replace a newer snapshot", async () => {
  let tools: unknown[] = [{ name: "old", description: "Old", inputSchema: {} }];
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const didStart = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  const store = mcpStore();
  const { fetch } = fakeServerFetch({
    tools: async () => {
      const current = tools;
      if (first) {
        first = false;
        started!();
        await stalled;
      }
      return current;
    },
  });
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await store.put(server());
  await didStart;
  tools = [{ name: "new", description: "New", inputSchema: {} }];
  const readiness = service.ready();
  const latest = service.refresh();
  release!();
  await readiness;
  assert.deepEqual(
    service.toolDefs().map((descriptor) => descriptor.name),
    ["crm_new"],
  );
  await latest;
  await service.close();
});

test("obsolete queued refreshes are coalesced before discovery", async () => {
  const backing = mcpStore();
  await backing.put(server());
  let listCalls = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstList = new Promise<void>((resolve) => {
    started = resolve;
  });
  const store = {
    ...backing,
    async list() {
      listCalls += 1;
      if (listCalls === 1) {
        started();
        await gate;
      }
      return backing.list();
    },
  };
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({ servers: store, fetchImpl: fetch, refreshIntervalMs: 3600_000 });
  await firstList;
  const refreshes = Array.from({ length: 5 }, () => service.refresh());
  release();
  await Promise.all(refreshes);
  await service.ready();
  assert.equal(listCalls, 2);
  await service.close();
});

test("a response body timeout does not block disable recovery", async () => {
  const store = mcpStore();
  const service = createMcpToolService({
    servers: store,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body) as { id?: number; method: string };
      if (request.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: request.id,
          result: { protocolVersion: "2025-11-25", capabilities: {} },
        });
      }
      if (request.method === "notifications/initialized") return jsonResponse({}, 202);
      return { ok: true, status: 200, text: async () => new Promise<string>(() => {}), headers: { get: () => null } };
    },
    requestTimeoutMs: 10,
    refreshIntervalMs: 3600_000,
  });
  await store.put(server());
  await service.refresh();
  assert.deepEqual(service.toolDefs(), []);
  await store.put(server({ enabled: false }));
  await service.refresh();
  assert.deepEqual(service.toolDefs(), []);
  service.close();
});

test("a registry read failure preserves the previous snapshot without unhandled rejection", async () => {
  const backing = mcpStore();
  let fail = false;
  const audit: Array<{ resource: string; status: string }> = [];
  const store = {
    ...backing,
    async list() {
      if (fail) throw new Error("database unavailable");
      return backing.list();
    },
  };
  const { fetch } = fakeServerFetch();
  const service = createMcpToolService({
    servers: store,
    fetchImpl: fetch,
    refreshIntervalMs: 3600_000,
    audit: {
      record(event) {
        audit.push({ resource: event.resource, status: event.status ?? "" });
      },
      events: async () => [],
      tail: async () => [],
    },
  });
  await backing.put(server());
  await service.refresh();
  const previous = service.toolDefs().map((descriptor) => descriptor.name);
  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    fail = true;
    await assert.rejects(() => service.refresh(), /registry/);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(
      service.toolDefs().map((descriptor) => descriptor.name),
      previous,
    );
    assert.equal(unhandled, undefined);
    assert.ok(audit.some((event) => event.resource === "registry" && event.status === "error"));
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await service.close();
  }
});
