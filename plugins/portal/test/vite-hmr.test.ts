import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, request, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { deriveKey, seal } from "../src/session.ts";

test(
  "Vite HMR relays through the authenticated dev portal and stays closed in production",
  { timeout: 10_000 },
  async (t) => {
    let upgrades = 0;
    let forwarded: IncomingMessage | undefined;
    const upstream = createServer();
    upstream.on("upgrade", (req, socket, head) => {
      upgrades++;
      forwarded = req;
      if (req.url?.includes("token=invalid")) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (req.url?.includes("token=unavailable")) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      const accept = createHash("sha1")
        .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}\r\nSet-Cookie: unexpected=value\r\n\r\nconnected`,
      );
      if (head.length) socket.write(head);
      socket.on("error", () => socket.destroy());
      socket.pipe(socket);
      t.after(() => socket.destroy());
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    t.after(() => upstream.close());
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    const origin = "http://localhost:8088";
    const secret = "vite-hmr-test-secret";
    process.env.NODE_ENV = "development";
    process.env.PORTAL_PUBLIC_URL = origin;
    process.env.PORTAL_SESSION_SECRET = secret;
    process.env.CORE_ORG_ID = "acme";
    process.env.CORE_API_URL = upstreamUrl;
    process.env.WEB_UI_UPSTREAM = upstreamUrl;
    process.env.PORTAL_LOCAL_AUTH_BYPASS = "0";
    const { server } = await import("../src/index.ts");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const now = Math.floor(Date.now() / 1000);
    const claims = { k: "session", sub: "alice", org: "acme", iat: now, exp: now + 60 };
    const key = deriveKey(secret, "portal.session.v1");
    const headers = {
      origin,
      cookie: `portal_session=${seal(claims, key)}`,
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      "sec-websocket-version": "13",
      "sec-websocket-protocol": "vite-hmr",
      authorization: "must-not-forward",
      "x-portal-identity": "must-not-forward",
    };
    function connect(url: string, overrides: Record<string, string> = {}): Promise<number> {
      return new Promise((resolve, reject) => {
        const req = request(url, { headers: { ...headers, ...overrides }, timeout: 2_000 });
        req.on("timeout", () => req.destroy(new Error("upgrade timed out")));
        req.on("error", reject);
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
        req.on("upgrade", (res, socket, head) => {
          assert.equal(res.headers["sec-websocket-accept"], "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
          assert.equal(res.headers["sec-websocket-protocol"], overrides["sec-websocket-protocol"] ?? "vite-hmr");
          assert.equal(res.headers["set-cookie"], undefined);
          let received = head.toString();
          socket.on("error", reject);
          socket.on("data", (chunk) => {
            received += chunk.toString();
            if (received === "connectedclient-message") {
              socket.destroy();
              resolve(res.statusCode!);
            }
          });
          socket.write("client-message");
          t.after(() => socket.destroy());
        });
        req.end();
      });
    }
    assert.equal(await connect(`${base}/?token=valid`), 101);
    assert.equal(forwarded?.url, "/?token=valid");
    assert.equal(forwarded?.headers.origin, origin);
    assert.equal(forwarded?.headers.cookie, undefined);
    assert.equal(forwarded?.headers.authorization, undefined);
    assert.equal(forwarded?.headers["x-portal-identity"], undefined);
    assert.equal(await connect(`${base}/dev-base/?token=valid`, { "sec-websocket-protocol": "vite-ping" }), 101);
    const beforeDenials = upgrades;
    for (const cookie of ["", "portal_session=forged", `portal_session=${seal({ ...claims, exp: now - 1 }, key)}`]) {
      assert.equal(await connect(`${base}/`, { cookie }), 401);
    }
    for (const badOrigin of ["", "null", "https://evil.example", "http://localhost:5173"]) {
      assert.equal(await connect(`${base}/`, { origin: badOrigin }), 403);
    }
    assert.equal(await connect(`${base}/`, { "sec-websocket-protocol": "other" }), 404);
    assert.equal(upgrades, beforeDenials);
    assert.equal(await connect(`${base}/?token=invalid`), 403);
    assert.equal(await connect(`${base}/?token=unavailable`), 502);

    process.env.NODE_ENV = "production";
    const productionModule = new URL("../src/index.ts?production", import.meta.url).href;
    const { server: production } = (await import(productionModule)) as typeof import("../src/index.ts");
    await new Promise<void>((resolve) => production.listen(0, "127.0.0.1", resolve));
    t.after(() => production.close());
    assert.equal(await connect(`http://127.0.0.1:${(production.address() as AddressInfo).port}/`), 404);
  },
);
