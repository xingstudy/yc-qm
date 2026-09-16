import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

const calls: { method: string; url: string; body: string; actor: string | null; signed: boolean }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (chunk) => {
    body += String(chunk);
  });
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      body,
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
    });
    if (req.url === "/v1/admin/whoami") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ isAdmin: true }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ scopeId: "org:acme", scopes: [] }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-scopes-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("GET /api/scopes (the scope directory) forwards to /v1/admin/scopes signed + attributed", async () => {
  const r = await fetch(`${base}/api/scopes`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/scopes");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/scopes/<id> still reaches the per-scope governance read", async () => {
  const r = await fetch(`${base}/api/scopes/${encodeURIComponent("org:acme")}`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  assert.equal(calls.at(-1)!.url, "/v1/admin/scopes/org%3Aacme");
  assert.deepEqual(await r.json(), { scopeId: "org:acme", scopes: [] });
});

test("GET /api/scopes/<id>/export forwards to the config-export endpoint, query intact", async () => {
  const r = await fetch(`${base}/api/scopes/${encodeURIComponent("org:acme")}/export?secrets=include`, {
    headers: { cookie: ADMIN },
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.url, "/v1/admin/scopes/org%3Aacme/export?secrets=include");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/resources forwards to the governable-resource manifest, signed + attributed", async () => {
  const r = await fetch(`${base}/api/resources`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/resources");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/connector-catalog forwards the live connector catalog signed + attributed", async () => {
  const r = await fetch(`${base}/api/connector-catalog`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/connectors/catalog");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("MCP server management forwards list, save, and delete requests signed + attributed", async () => {
  const list = await fetch(`${base}/api/mcp-servers`, { headers: { cookie: ADMIN } });
  assert.equal(list.status, 200);
  assert.equal(calls.at(-1)!.url, "/v1/admin/mcp-servers");

  const save = await fetch(`${base}/api/mcp-servers/acme-tools`, {
    method: "PUT",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme tools", url: "https://mcp.example.com", auth: "none" }),
  });
  assert.equal(save.status, 200);
  const saved = calls.at(-1)!;
  assert.equal(saved.method, "PUT");
  assert.equal(saved.url, "/v1/admin/mcp-servers/acme-tools");
  assert.equal(saved.body, '{"name":"Acme tools","url":"https://mcp.example.com","auth":"none"}');
  assert.equal(saved.actor, "U-admin@acme");
  assert.equal(saved.signed, true);

  const removed = await fetch(`${base}/api/mcp-servers/acme-tools`, {
    method: "DELETE",
    headers: { cookie: ADMIN },
  });
  assert.equal(removed.status, 200);
  assert.equal(calls.at(-1)!.method, "DELETE");
  assert.equal(calls.at(-1)!.url, "/v1/admin/mcp-servers/acme-tools");
});

test("the scope directory requires a signed-in cookie → 401 (no core hop)", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/scopes`)).status, 401);
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});
