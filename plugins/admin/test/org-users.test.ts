import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { mintPortalIdentity } from "../../chassis/src/portal-identity.ts";

const calls: Array<{
  method: string;
  url: string;
  actor: string | null;
  body: string;
  contentType: string | null;
  idempotencyKey: string | null;
}> = [];
const core = createServer((req: IncomingMessage, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const actor = (req.headers["x-admin-actor"] as string) ?? null;
    calls.push({
      method: req.method ?? "",
      url: req.url ?? "",
      actor,
      body,
      contentType: (req.headers["content-type"] as string) ?? null,
      idempotencyKey: (req.headers["idempotency-key"] as string) ?? null,
    });
    if (req.url === "/v1/admin/whoami") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify(
          actor?.startsWith("U-manager@")
            ? { isAdmin: false, isManager: true, permissions: ["org_manager"] }
            : { isAdmin: true, role: "org_admin", scopeId: "org:acme", permissions: ["admin"] },
        ),
      );
    }
    if (req.url?.startsWith("/v1/admin/org/users/export")) {
      res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=members.csv" });
      return void res.end("principalId\r\nU1\r\n");
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "admin-org-users-proxy-secret";
process.env.PORTAL_IDENTITY_SECRET = "admin-org-users-portal-identity-secret";

const { server } = await import("../src/index.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const ADMIN = mintPortalIdentity({ p: "U-admin", sv: 1, exp: Date.now() + 60_000 }, process.env.PORTAL_IDENTITY_SECRET);
const MANAGER = mintPortalIdentity(
  { p: "U-manager", sv: 1, exp: Date.now() + 60_000 },
  process.env.PORTAL_IDENTITY_SECRET,
);

test.after(() => {
  server.close();
  core.close();
});

const adminFetch = (path: string, init: RequestInit = {}) =>
  fetch(base + path, { ...init, headers: { "x-portal-identity": ADMIN, ...(init.headers ?? {}) } });

test("organization member list, detail, profile, status, and primary-unit paths forward exactly", async () => {
  for (const [method, path, expected] of [
    ["GET", "/api/org-users?status=active", "/v1/admin/org/users?status=active"],
    ["GET", "/api/org-users/U1", "/v1/admin/org/users/U1"],
    ["GET", "/api/org-users/U1/impact", "/v1/admin/org/users/U1/impact"],
    ["PATCH", "/api/org-users/U1", "/v1/admin/org/users/U1"],
    ["POST", "/api/org-users/U1/status", "/v1/admin/org/users/U1/status"],
    ["PUT", "/api/org-users/U1/primary-unit", "/v1/admin/org/users/U1/primary-unit"],
  ] as const) {
    const response = await adminFetch(path, {
      method,
      ...(method === "GET" ? {} : { headers: { "content-type": "application/json" }, body: "{}" }),
    });
    assert.equal(response.status, 200);
    const call = calls.at(-1)!;
    assert.equal(call.method, method);
    assert.equal(call.url, expected);
    assert.equal(call.actor, "U-admin@acme");
  }
});

test("the Admin proxy never exposes the legacy invite POST", async () => {
  const before = calls.length;
  const response = await adminFetch("/api/org-users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "U2" }),
  });
  assert.equal(response.status, 404);
  assert.equal(calls.length, before + 1, "only whoami is called before the exact route is rejected");
  assert.equal(calls.at(-1)?.url, "/v1/admin/whoami");
});

test("CSV export streams and import/batch requests preserve content type and idempotency", async () => {
  const exported = await adminFetch("/api/org-users/export?status=active");
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /principalId/);
  assert.equal(calls.at(-1)?.url, "/v1/admin/org/users/export?status=active");
  const preview = await adminFetch("/api/org-users/imports/preview", {
    method: "POST",
    headers: { "content-type": "text/csv", "idempotency-key": "import-1" },
    body: "principalId,displayName\nU1,Alice",
  });
  assert.equal(preview.status, 200);
  assert.equal(calls.at(-1)?.contentType, "text/csv");
  assert.equal(calls.at(-1)?.idempotencyKey, "import-1");
  const batch = await adminFetch("/api/org-users/batches/preview", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "batch-1" },
    body: JSON.stringify({ principalIds: ["U1"], action: { type: "suspend" } }),
  });
  assert.equal(batch.status, 200);
  assert.equal(calls.at(-1)?.url, "/v1/admin/org/users/batches/preview");
  assert.equal(calls.at(-1)?.idempotencyKey, "batch-1");
});

test("CSV import rejects bodies above 5 MiB before proxying to Core", async () => {
  const before = calls.length;
  const response = await adminFetch("/api/org-users/imports/preview", {
    method: "POST",
    headers: { "content-type": "text/csv", "idempotency-key": "oversized" },
    body: "x".repeat(5 * 1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error, "payload_too_large");
  assert.equal(calls.length, before + 1, "only whoami is called before the oversized body is rejected");
  assert.equal(calls.at(-1)?.url, "/v1/admin/whoami");
});

test("a manager can search candidates but cannot access member master data or batch APIs", async () => {
  const headers = { "x-portal-identity": MANAGER };
  assert.equal((await fetch(base + "/api/org-users/search?q=ali", { headers })).status, 200);
  assert.equal((await fetch(base + "/api/org-users", { headers })).status, 403);
  assert.equal(
    (
      await fetch(base + "/api/org-users/batches/preview", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
});

test("the organization members SPA is syntactically valid and includes phase-one and phase-two controls", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new Function(script));
  assert.match(html, /"org-members": "Organization members"/);
  assert.match(html, /function renderOrgMembers\(root, initial\)/);
  assert.match(html, /Import CSV/);
  assert.match(html, /Preview batch/);
  assert.match(html, /expectedProfileRevision/);
  assert.match(html, /primary-unit/);
  assert.match(html, /summary\.action/);
  assert.match(html, /itemOffset/);
  assert.match(html, /This action removes active access and invalidates existing sessions/);
  assert.match(html, /Deprovisioning cannot be restored in this release/);
  assert.match(html, /impact\.groupManagerCount/);
  assert.match(html, /impact\.directAuthorizationCount/);
  assert.match(html, /impact\.lastActiveAdmin/);
  assert.match(html, /summary\.target/);
  assert.match(html, /previewValue/);
  assert.match(html, /unit\.kind !== "organization"/);
  assert.match(html, /orgMemberSelectionMode === "filter"/);
  assert.match(html, /missingPrimaryUnit: true/);
  assert.match(html, /Lifecycle: "生命周期"/);
  assert.match(html, /"Save profile": "保存资料"/);
  assert.match(html, /"Organization units": "组织节点"/);
  assert.match(html, /adminTr\("Current status:"\)/);
  assert.match(html, /"Identity and audit": "身份与审计"/);
  assert.match(html, /\["Row", "Member", "Changes", "Status", "Errors", "Warnings"\]/);
});
