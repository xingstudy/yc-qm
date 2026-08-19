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
process.env.CORE_SIGNING_SECRET = "admin-org-groups-proxy-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = "admin=U-admin";

test("GET /api/org-groups forwards to /v1/admin/org/access-groups signed with the actor header", async () => {
  const r = await fetch(`${base}/api/org-groups`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/org/access-groups");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/org-groups/:id forwards the group detail path", async () => {
  const r = await fetch(`${base}/api/org-groups/eng-oncall`, { headers: { cookie: ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/org/access-groups/eng-oncall");
  assert.equal(c.actor, "U-admin@acme");
});

test("POST /api/org-groups forwards the create body", async () => {
  const r = await fetch(`${base}/api/org-groups`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ name: "Eng on-call" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/org/access-groups");
  assert.equal(c.actor, "U-admin@acme");
  assert.deepEqual(JSON.parse(c.body), { name: "Eng on-call" });
});

test("PATCH /api/org-groups/:id forwards rename and archive bodies", async () => {
  const r = await fetch(`${base}/api/org-groups/eng-oncall`, {
    method: "PATCH",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ status: "archived" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "PATCH");
  assert.equal(c.url, "/v1/admin/org/access-groups/eng-oncall");
  assert.equal(c.actor, "U-admin@acme");
  assert.deepEqual(JSON.parse(c.body), { status: "archived" });
});

test("POST /api/org-groups/:id/members forwards the member body", async () => {
  const r = await fetch(`${base}/api/org-groups/eng-oncall/members`, {
    method: "POST",
    headers: { cookie: ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ principalId: "U1", role: "manager" }),
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "POST");
  assert.equal(c.url, "/v1/admin/org/access-groups/eng-oncall/members");
  assert.deepEqual(JSON.parse(c.body), { principalId: "U1", role: "manager" });
});

test("DELETE /api/org-groups/:id/members/:principalId forwards the parameterized path", async () => {
  const r = await fetch(`${base}/api/org-groups/eng-oncall/members/U1`, {
    method: "DELETE",
    headers: { cookie: ADMIN },
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "DELETE");
  assert.equal(c.url, "/v1/admin/org/access-groups/eng-oncall/members/U1");
  assert.equal(c.actor, "U-admin@acme");
});

test("org-groups endpoints require a signed-in cookie → 401 when absent (no core hop)", async () => {
  const before = calls.length;
  assert.equal((await fetch(`${base}/api/org-groups`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/org-groups`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${base}/api/org-groups/eng-oncall`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    401,
  );
  assert.equal((await fetch(`${base}/api/org-groups/eng-oncall/members/U1`, { method: "DELETE" })).status, 401);
  assert.equal(calls.length, before, "a signed-out request is rejected at the surface, never forwarded");
});

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("the SPA registers the org-groups view", () => {
  assert.match(html, /label: "Admin",\s*views: \[[^\]]*"org-groups"/);
  assert.match(html, /"org-groups": "Access groups"/);
  assert.match(html, /"org-groups": renderOrgGroups,/);
  assert.match(html, /ORG_WIDE = new Set\(\[[^\]]*"org-groups"/);
  assert.match(html, /function renderOrgGroups\(root, d\)/);
});
