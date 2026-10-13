import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";

test("dev proxy translates same-origin writes and preserves rejected origins", async (t) => {
  const upstream = createHttpServer((req, res) => {
    res.writeHead(req.headers.origin === upstreamUrl ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify({ origin: req.headers.origin, host: req.headers.host }));
  });
  upstream.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => upstream.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => upstream.close(() => resolve())));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const previous = process.env.WEB_UI_SERVER_URL;
  process.env.WEB_UI_SERVER_URL = upstreamUrl;
  t.after(() => {
    if (previous === undefined) delete process.env.WEB_UI_SERVER_URL;
    else process.env.WEB_UI_SERVER_URL = previous;
  });
  const { default: config } = await import("../vite.config.ts");
  const vite = await createServer({
    configFile: false,
    server: { middlewareMode: true, hmr: false, watch: null, proxy: config.server?.proxy },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => vite.close());
  const frontend = createHttpServer(vite.middlewares);
  frontend.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => frontend.once("listening", resolve));
  t.after(() => new Promise<void>((resolve) => frontend.close(() => resolve())));
  const frontendUrl = `http://127.0.0.1:${(frontend.address() as AddressInfo).port}`;

  for (const path of ["/signin", "/share", "/me", "/api/turn"]) {
    const response = await fetch(`${frontendUrl}${path}`, { method: "POST", headers: { origin: frontendUrl } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { origin: upstreamUrl, host: new URL(upstreamUrl).host });
  }
  for (const origin of [undefined, "https://evil.example", "https://127.0.0.1", `${frontendUrl}0`]) {
    const response = await fetch(`${frontendUrl}/api/turn`, {
      method: "POST",
      headers: origin === undefined ? {} : { origin },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).origin, origin);
  }
});
