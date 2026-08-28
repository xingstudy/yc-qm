import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity } from "../../chassis/src/portal-identity.ts";

interface Call {
  method: string;
  url: string;
  portalIdentity?: string;
}
const calls: Call[] = [];
const acceptedSessionTokens = new Set<string>();
const core = createServer((req: IncomingMessage, res) => {
  req.resume();
  req.on("end", () => {
    const pid = req.headers["x-portal-identity"];
    const portalIdentity = Array.isArray(pid) ? pid[0] : pid;
    calls.push({ method: req.method ?? "GET", url: req.url ?? "", portalIdentity });
    const url = req.url ?? "";
    if (url.startsWith("/v1/internal/auth/session")) {
      const accepted = portalIdentity !== undefined && acceptedSessionTokens.has(portalIdentity);
      res.writeHead(accepted ? 200 : 401, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify(accepted ? { principalId: "alice", sessionVersion: 4 } : { error: "unauthorized" }),
      );
    }
    if (url.startsWith("/v1/files/missing/content")) {
      res.writeHead(404, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "not_found" }));
    }
    if (!portalIdentity) {
      res.writeHead(401, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "unauthorized", message: "portal identity required" }));
    }
    res.writeHead(200, { "content-type": "image/png", "content-length": "4" });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
const coreSigningSecret = "file-content-portal-identity-test";
process.env.CORE_SIGNING_SECRET = coreSigningSecret;
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const portalIdentity = mintPortalIdentity({ p: "alice", sv: 4, exp: Date.now() + 60_000 }, coreSigningSecret);
acceptedSessionTokens.add(portalIdentity);
const headers = { "x-portal-identity": portalIdentity };

test.after(() => {
  surface.close();
  core.close();
});

test("file content forwards the portal identity so core's viewer gate is satisfied", async () => {
  const before = calls.length;
  const r = await fetch(`${base}/api/files/f1/content`, { headers });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /image\/png/);
  assert.equal((await r.arrayBuffer()).byteLength, 4);
  const coreCall = calls.slice(before).find((c) => c.method === "GET" && c.url.startsWith("/v1/files/f1/content"));
  assert.equal(
    coreCall?.portalIdentity,
    portalIdentity,
    "web-ui must forward x-portal-identity — dropping it 401s and breaks every inline image",
  );
  assert.match(coreCall?.url ?? "", /[?&]viewer=alice(&|$)/, "web-ui must send viewer alongside the token");
});

test("a missing file is still relayed as not_found (404), not upstream_error", async () => {
  const r = await fetch(`${base}/api/files/missing/content`, { headers });
  assert.equal(r.status, 404);
  assert.equal(((await r.json()) as { error?: string }).error, "not_found");
});

test("a stale portal session is rejected before the requested API call reaches core", async () => {
  const stale = mintPortalIdentity({ p: "alice", sv: 3, exp: Date.now() + 60_000 }, coreSigningSecret);
  const before = calls.length;
  const r = await fetch(`${base}/api/files/f1/content`, { headers: { "x-portal-identity": stale } });
  assert.equal(r.status, 401);
  const attempted = calls.slice(before);
  assert.equal(attempted.filter((call) => call.url.startsWith("/v1/internal/auth/session")).length, 1);
  assert.equal(
    attempted.some((call) => call.url.startsWith("/v1/files/f1/content")),
    false,
  );
});

test("an impersonated browser session is preflighted and forwarded with the same signed identity", async () => {
  const impersonated = mintPortalIdentity(
    { p: "alice", sv: 4, imp: "admin", isv: 7, exp: Date.now() + 60_000 },
    coreSigningSecret,
  );
  acceptedSessionTokens.add(impersonated);
  const before = calls.length;
  const r = await fetch(`${base}/api/files/f1/content`, { headers: { "x-portal-identity": impersonated } });
  assert.equal(r.status, 200);
  const attempted = calls.slice(before);
  assert.equal(
    attempted.find((call) => call.url.startsWith("/v1/internal/auth/session"))?.portalIdentity,
    impersonated,
  );
  assert.equal(attempted.find((call) => call.url.startsWith("/v1/files/f1/content"))?.portalIdentity, impersonated);
});
