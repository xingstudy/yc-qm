import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";

const calls: { method: string; url: string; actor: string | null; signed: boolean; body: string }[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      actor: (req.headers["x-admin-actor"] as string) ?? null,
      signed: Boolean(req.headers["x-timestamp"] && req.headers["x-signature"]),
      body,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-org-units-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("GET /api/org-units forwards to /v1/admin/org/units signed with the actor header", async () => {
  const r = await fetch(`${base}/api/org-units`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/org/units");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/org-units/:id forwards the unit detail path", async () => {
  const r = await fetch(`${base}/api/org-units/eng`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/org/units/eng");
  assert.equal(c.actor, "U-admin@acme");
});

test("POST /api/org-units forwards the create body", async () => {
  const r = await fetch(`${base}/api/org-units`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ parentId: "root", name: "Engineering", kind: "department", sortOrder: 1 }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/org/units");
  assert.equal(c.actor, "U-admin@acme");
  assert.deepEqual(JSON.parse(c.body), { parentId: "root", name: "Engineering", kind: "department", sortOrder: 1 });
});

test("PATCH /api/org-units/:id forwards rename, move, and archive bodies", async () => {
  const r = await fetch(`${base}/api/org-units/eng`, {
    method: "PATCH",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ status: "archived" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "PATCH");
  assert.equal(c.url, "/v1/admin/org/units/eng");
  assert.equal(c.actor, "U-admin@acme");
  assert.deepEqual(JSON.parse(c.body), { status: "archived" });
});

test("POST /api/org-units/:id/members forwards the member body", async () => {
  const r = await fetch(`${base}/api/org-units/eng/members`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ principalId: "U1", role: "manager" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/org/units/eng/members");
  assert.deepEqual(JSON.parse(c.body), { principalId: "U1", role: "manager" });
});

test("DELETE /api/org-units/:id/members/:principalId forwards the parameterized path", async () => {
  const r = await fetch(`${base}/api/org-units/eng/members/U1`, {
    method: "DELETE",
    headers: { cookie: ADMIN },
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "DELETE");
  assert.equal(c.url, "/v1/admin/org/units/eng/members/U1");
  assert.equal(c.actor, "U-admin@acme");
});

test("org-units endpoints require a signed-in cookie → 401 when absent (no core hop)", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/org-units`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/org-units`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/org-units/eng`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal((await fetch(`${base}/api/org-units/eng/members/U1`, { method: "DELETE" })).status, 401);
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("the SPA registers the org-units view", () => {
  assert.match(html, /label: "Admin",\s*views: \[[^\]]*"org-units"/);
  assert.match(html, /"org-units": "Org tree"/);
  assert.match(html, /"org-units": renderOrgUnits,/);
  assert.match(html, /const ORG_WIDE = new Set\(\[[^\]]*"org-units"/);
  assert.match(html, /function renderOrgUnits\(root, d\)/);
});
