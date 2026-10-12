import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

let coreUrl = "";
const core = createServer((req, res) => {
  coreUrl = req.url ?? "";
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ notifications: [], unread: 0, conversationUnread: {} }));
});
await new Promise<void>((resolve) => core.listen(0, resolve));
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "notifications-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "notifications-route-test"),
};
test.after(() => {
  surface.close();
  core.close();
});

test("notification filters and pagination preserve signed-in identity and only relay supported query fields", async () => {
  assert.equal((await fetch(`${base}/api/notifications?status=unread`)).status, 401);
  for (const query of ["", "&status=unread", "&status=read&kind=mention&limit=20&page=3"]) {
    const response = await fetch(`${base}/api/notifications?principalId=other&unknown=ignored${query}`, { headers });
    assert.equal(response.status, 200);
    const relayed = new URL(coreUrl, "http://core");
    assert.equal(relayed.pathname, "/v1/notifications");
    assert.equal(relayed.searchParams.get("principalId"), "alice");
    assert.equal(relayed.searchParams.get("unknown"), null);
    const requested = new URLSearchParams(query.replace(/^&/, ""));
    for (const key of ["status", "kind", "limit", "page"])
      assert.equal(relayed.searchParams.get(key), requested.get(key));
  }
});
