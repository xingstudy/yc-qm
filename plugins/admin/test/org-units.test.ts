import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { mintPortalIdentity } from "../../chassis/src/portal-identity.ts";

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
    res.end(
      JSON.stringify(
        req.url === "/v1/admin/whoami"
          ? { isAdmin: true, role: "org_admin", scopeId: "org:acme", permissions: ["admin"] }
          : { ok: true },
      ),
    );
  });
});
await new Promise<void>((r) => core.listen(0, r));
const corePort = (core.address() as AddressInfo).port;

process.env.CORE_API_URL = `http://localhost:${corePort}`;
process.env.CORE_SIGNING_SECRET = "admin-org-units-proxy-secret";
process.env.PORTAL_IDENTITY_SECRET = "admin-org-units-portal-identity-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((r) => server.listen(0, r));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
test.after(() => {
  server.close();
  if (core.listening) core.close();
});

const ADMIN = mintPortalIdentity({ p: "U-admin", sv: 1, exp: Date.now() + 60_000 }, process.env.PORTAL_IDENTITY_SECRET);

test("GET /api/org-units forwards to /v1/admin/org/units signed with the actor header", async () => {
  const r = await fetch(`${base}/api/org-units`, { headers: { "x-portal-identity": ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/org/units");
  assert.equal(c.actor, "U-admin@acme");
  assert.equal(c.signed, true);
});

test("GET /api/org-units/:id forwards the unit detail path", async () => {
  const r = await fetch(`${base}/api/org-units/eng`, { headers: { "x-portal-identity": ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/org/units/eng");
  assert.equal(c.actor, "U-admin@acme");
});

test("GET /api/org-units/:id/impact forwards the move preview query", async () => {
  const r = await fetch(`${base}/api/org-units/eng/impact?newParentId=finance`, {
    headers: { "x-portal-identity": ADMIN },
  });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/org/units/eng/impact?newParentId=finance");
  assert.equal(c.actor, "U-admin@acme");
});

test("GET /api/org-users/search forwards the server-side member query", async () => {
  const r = await fetch(`${base}/api/org-users/search?q=ali`, { headers: { "x-portal-identity": ADMIN } });
  assert.equal(r.status, 200);
  const c = calls.at(-1)!;
  assert.equal(c.method, "GET");
  assert.equal(c.url, "/v1/admin/org/users/search?q=ali");
  assert.equal(c.actor, "U-admin@acme");
});

test("directory visibility policy reads and writes forward to the organization policy API", async () => {
  const read = await fetch(`${base}/api/org-directory/user/U1`, { headers: { "x-portal-identity": ADMIN } });
  assert.equal(read.status, 200);
  assert.equal(calls.at(-1)!.url, "/v1/admin/org/directory-visibility/user/U1");
  const write = await fetch(`${base}/api/org-directory/user/U1`, {
    method: "PUT",
    headers: { "x-portal-identity": ADMIN, "content-type": "application/json" },
    body: JSON.stringify({ mode: "none", roots: [], expectedRevision: 0 }),
  });
  assert.equal(write.status, 200);
  const request = calls.at(-1)!;
  assert.equal(request.method, "PUT");
  assert.equal(request.url, "/v1/admin/org/directory-visibility/user/U1");
});

test("POST /api/org-units forwards the create body", async () => {
  const r = await fetch(`${base}/api/org-units`, {
    method: "POST",
    headers: { "x-portal-identity": ADMIN, "content-type": "application/json" },
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
    headers: { "x-portal-identity": ADMIN, "content-type": "application/json" },
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
    headers: { "x-portal-identity": ADMIN, "content-type": "application/json" },
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
    headers: { "x-portal-identity": ADMIN },
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
  assert.match(html, /const archivedUnits = all\s*\.filter\(\(u\) => u\.status === "archived"\)/);
  assert.match(html, /actionBtn\("Restore unit", "primary"[\s\S]*?status: "active"/);
  assert.match(html, /if \(unit\.parentId !== null\) \{/);
  assert.match(html, /const principalIds = \[\s*\.\.\.new Set/);
  assert.match(html, /r\.data\.invalidPrincipalIds\.join\(", "\)/);
  assert.match(html, /No members were added\. Unavailable users:/);
  assert.match(html, /\[\["", adminTr\("Choose a new parent"\)\]/);
  assert.match(html, /Move "\$\{unit\.name\}" under "\$\{target\.name\}"/);
  assert.match(html, /Restore the parent unit first:/);
  assert.match(html, /Too many searches\. Try again in/);
  assert.match(html, /const selectUnit = \(unitId\) => \{[\s\S]*?setStatus\("st-org-units", "", ""\)/);
  assert.match(html, /function organizationUserSearch\(memberInput, currentPrincipalIds\)/);
  assert.match(html, /\/api\/org-users\/search\?q=/);
  assert.match(html, /\/impact\?newParentId=/);
  assert.match(html, /active units and \$\{preview\.data\.impact\.activeMembers\} active members will move/);
  assert.match(html, /adminTr\("Archive unit"\)/);
});

test("the SPA registers the directory visibility editor with CAS and multi-root controls", () => {
  assert.match(html, /"org-directory": "Directory visibility"/);
  assert.match(html, /"org-directory": renderOrgDirectory/);
  assert.match(html, /function renderOrgDirectory\(root, d\)/);
  assert.match(html, /includeDescendants/);
  assert.match(html, /expectedRevision: revision/);
  assert.match(html, /\/api\/org-directory\//);
  assert.match(html, /This subject will not see any organization members/);
});
