import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import test from "node:test";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

const piCodingAgentTarball = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-1.0.1.tgz";
const piLicensePath = "licenses/earendil-works-pi-coding-agent.LICENSE";

function installedVersion(path: string): string {
  const manifestUrl = new URL(`../node_modules/${path}/package.json`, import.meta.url);
  const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string") throw new Error(`${path} has no package version`);
  return manifest.version;
}

function dependencyVersion(parentManifest: URL | string, dependency: string): string {
  const requireFromParent = createRequire(parentManifest);
  const manifest = JSON.parse(readFileSync(requireFromParent.resolve(`${dependency}/package.json`), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string") throw new Error(`${dependency} has no package version`);
  return manifest.version;
}

function lockedVersions(packages: Record<string, { version?: unknown }>, dependency: string): unknown[] {
  return [
    ...new Set(
      Object.entries(packages)
        .filter(([path]) => path === `node_modules/${dependency}` || path.endsWith(`/node_modules/${dependency}`))
        .map(([, manifest]) => manifest.version),
    ),
  ];
}

test("Pi and MCP security overrides are materialized by the root lockfile", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")) as {
    packages?: Record<string, { resolved?: unknown; version?: unknown; hasShrinkwrap?: unknown; license?: unknown }>;
  };
  const webUiLock = JSON.parse(
    readFileSync(new URL("../plugins/web-ui/package-lock.json", import.meta.url), "utf8"),
  ) as {
    packages?: Record<string, { version?: unknown }>;
  };
  const packages = lock.packages ?? {};
  const pi = packages["node_modules/@earendil-works/pi-coding-agent"];
  const piManifest = new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url);
  const minimatchManifest = createRequire(piManifest).resolve("minimatch/package.json");

  assert.equal(pi?.resolved, piCodingAgentTarball);
  assert.notEqual(pi?.hasShrinkwrap, true);
  assert.equal(pi?.license, "MIT");

  assert.deepEqual(lockedVersions(packages, "brace-expansion"), ["5.0.12"]);
  assert.deepEqual(lockedVersions(packages, "fast-uri").sort(), ["3.1.8", "4.1.5"]);
  assert.deepEqual(lockedVersions(packages, "hono"), ["4.13.8"]);
  assert.deepEqual(lockedVersions(packages, "protobufjs"), ["7.6.5"]);
  assert.deepEqual(lockedVersions(packages, "undici"), ["8.10.2"]);
  assert.deepEqual(lockedVersions(packages, "undici8"), ["8.10.2"]);
  assert.deepEqual(lockedVersions(packages, "@grpc/grpc-js"), ["1.14.5"]);
  assert.deepEqual(lockedVersions(packages, "@modelcontextprotocol/sdk"), ["1.31.0"]);
  assert.deepEqual(lockedVersions(packages, "axios"), ["1.20.0"]);
  assert.deepEqual(lockedVersions(packages, "ip-address"), ["10.7.1"]);
  assert.deepEqual(lockedVersions(packages, "proxy-addr"), ["2.0.8"]);
  assert.deepEqual(lockedVersions(packages, "smol-toml"), ["1.9.0"]);
  assert.match(
    readFileSync(new URL(`../${piLicensePath}`, import.meta.url), "utf8"),
    /Copyright \(c\) 2025 Mario Zechner/,
  );
  for (const dockerfile of ["deploy/core/Dockerfile", "deploy/egress-proxy/Dockerfile"]) {
    assert.match(
      readFileSync(new URL(`../${dockerfile}`, import.meta.url), "utf8"),
      new RegExp(`COPY ${piLicensePath}`),
    );
  }
  assert.deepEqual(lockedVersions(packages, "brace-expansion"), ["5.0.12"]);
  assert.deepEqual(lockedVersions(packages, "fast-uri").sort(), ["3.1.8", "4.1.5"]);
  assert.deepEqual(lockedVersions(packages, "fastify"), ["5.12.5"]);
  assert.deepEqual(lockedVersions(packages, "protobufjs"), ["7.6.5"]);
  assert.deepEqual(lockedVersions(packages, "qs"), ["6.16.0"]);
  assert.deepEqual(lockedVersions(webUiLock.packages ?? {}, "qs"), ["6.16.0"]);
  assert.deepEqual(lockedVersions(packages, "@hono/node-server"), ["2.0.10"]);
  assert.equal(dependencyVersion(minimatchManifest, "brace-expansion"), "5.0.12");
  assert.equal(dependencyVersion(piManifest, "undici"), "8.10.2");
  assert.equal(dependencyVersion(piManifest, "protobufjs"), "7.6.5");
  assert.equal(installedVersion("@hono/node-server"), "2.0.10");
  assert.equal(installedVersion("hono"), "4.13.8");
});

test("MCP Streamable HTTP works through the patched Hono major", async (t) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await transport.start();
  const server = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await transport.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  const address = server.address();
  assert(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: "{}",
  });
  const body = (await response.json()) as { error?: { code?: number } };
  assert.equal(response.status, 400);
  assert.equal(body.error?.code, -32700);
});

test("Fastify rejects malformed URLs before invoking a protected not-found handler", async (t) => {
  const app = Fastify();
  t.after(async () => app.close());
  app.register(
    async (api) => {
      api.setNotFoundHandler(async () => ({ error: "not_found" }));
    },
    { prefix: "/public" },
  );
  app.register(
    async (api) => {
      api.setNotFoundHandler(
        {
          preHandler: async (_request: FastifyRequest, reply: FastifyReply) => {
            reply.code(401).send({ error: "unauthorized" });
          },
        },
        async () => ({ secret: "private" }),
      );
    },
    { prefix: "/private" },
  );

  const unauthorized = await app.inject({ method: "GET", url: "/private/missing" });
  assert.equal(unauthorized.statusCode, 401);
  const malformed = await app.inject({ method: "GET", url: "/public/%zz" });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.body.includes("private"), false);
});

test("proxy trust cannot admit public IPv4 addresses through an IPv6 subnet", () => {
  const proxyAddress = createRequire(import.meta.url)("proxy-addr") as {
    compile(subnets: string[]): (address: string) => boolean;
  };
  const malformed = proxyAddress.compile(["::ffff:10.0.0.0/8"]);
  assert.equal(malformed("203.0.113.1"), false);
  const trusted = proxyAddress.compile(["::ffff:10.0.0.0/104"]);
  assert.equal(trusted("10.0.0.1"), true);
  assert.equal(trusted("203.0.113.1"), false);
});

test("package lockfiles use portable public tarball URLs without private registry credentials", () => {
  for (const path of [
    "package-lock.json",
    "cli/package-lock.json",
    "plugins/admin/package-lock.json",
    "plugins/auth/package-lock.json",
    "plugins/portal/package-lock.json",
    "plugins/web-ui/package-lock.json",
  ]) {
    const lock = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as {
      packages: Record<string, { resolved?: string }>;
    };
    for (const [name, entry] of Object.entries(lock.packages)) {
      if (!entry.resolved?.startsWith("http")) continue;
      const url = new URL(entry.resolved);
      const origin =
        path === "plugins/web-ui/package-lock.json" && name === "node_modules/xlsx"
          ? "https://cdn.sheetjs.com"
          : "https://registry.npmjs.org";
      assert.equal(url.origin, origin, `${path}: ${name}`);
      assert.equal(url.username, "");
      assert.equal(url.password, "");
    }
  }
});
