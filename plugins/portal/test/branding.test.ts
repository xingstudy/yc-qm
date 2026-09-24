import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

const core = createServer((req, res) => {
  if (req.url?.startsWith("/v1/surface-config")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(
      JSON.stringify({ branding: { accent: "#123456", markUrl: "https://cdn.example.com/icon.png" } }),
    );
  }
  if (req.url?.startsWith("/v1/connectors/oauth/consent/redeem/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ status: "expired" }));
  }
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.PORTAL_PUBLIC_URL = "http://portal.test";
process.env.PORTAL_SESSION_SECRET = "portal-branding-test-session-secret";
process.env.CORE_SIGNING_SECRET = "portal-branding-test-core-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;

const { server } = await import("../src/index.ts");
const { deriveKey, seal } = await import("../src/session.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const sessionKey = deriveKey("portal-branding-test-session-secret", "portal.session.v1");

function sessionCookie(): string {
  const now = Math.floor(Date.now() / 1000);
  return `portal_session=${encodeURIComponent(seal({ k: "session", sub: "U1", org: "acme", iat: now, exp: now + 3600 }, sessionKey))}`;
}

test.after(() => {
  server.close();
  core.close();
});

test("the first portal page waits for and renders the configured accent", async () => {
  const response = await fetch(`${base}/connect/redeem/test`, {
    headers: { accept: "text/html", cookie: sessionCookie() },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /--brand:#123456/);
});

test("the portal favicon follows the configured brand icon", async () => {
  const response = await fetch(`${base}/favicon.svg`, { redirect: "manual" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://cdn.example.com/icon.png");
});
