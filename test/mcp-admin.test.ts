import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createMcpServerStore, type StoredMcpServer } from "../src/mcp/mcp-server-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };

test("MCP admin validates and preserves credential scope, without returning secrets", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-admin-"));
  const built = buildApp(testConfig({ dataDir: dir }));
  const backing = createMemoryMap<StoredMcpServer>();
  const store = createMcpServerStore({
    backing,
    keyMaterial: "mcp-admin-test-key",
  });
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    mcpServers: store,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/admin/mcp-servers/crm`;
  const put = (body: object, headers = ADMIN) =>
    fetch(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ url: "https://8.8.8.8/mcp", validate: false, ...body }),
    });
  for (const endpoint of ["https://8.8.8.8/trello", "https://8.8.8.8/custom/mcp"]) {
    const response = await put({ url: endpoint, auth: "user-oauth" });
    assert.equal(response.status, 200);
    assert.equal((await store.get("crm"))?.url, endpoint);
    assert.equal((await store.get("crm"))?.auth, "user-oauth");
  }
  assert.equal((await put({ url: "http://8.8.8.8/mcp", auth: "user-oauth" })).status, 400);
  assert.equal((await put({ url: "https://127.0.0.1/mcp", auth: "user-oauth" })).status, 400);
  assert.equal((await put({ credentialScope: "other" })).status, 400);
  assert.equal((await put({ credentialScope: "per-user" })).status, 400);
  assert.equal(
    (await put({ credentialScope: "per-user", credentialHost: "accounts.example.com", credentialAccountType: "other" }))
      .status,
    400,
  );
  for (const credentialHost of ["", " accounts.example.com", "accounts.example.com/path", "host@evil", 1]) {
    assert.equal((await put({ credentialScope: "per-user", credentialHost })).status, 400);
  }
  assert.equal(
    (
      await put({
        credentialScope: "per-user",
        credentialHost: "accounts.example.com",
        url: "http://tools.example.com/mcp",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await put(
        { credentialScope: "per-user", credentialHost: "accounts.example.com" },
        { ...ADMIN, "x-admin-actor": "nobody@default-org" },
      )
    ).status,
    403,
  );
  const saved = await put({
    credentialScope: "per-user",
    credentialHost: "accounts.example.com",
    auth: "bearer",
    bearerToken: "catalog-secret",
    credentialAccountType: "personal",
  });
  assert.equal(saved.status, 200);
  const body = await saved.text();
  assert.doesNotMatch(body, /catalog-secret/);
  assert.equal(JSON.parse(body).server.credentialScope, "per-user");
  assert.equal((await put({ auth: "bearer" })).status, 200);
  assert.equal((await store.get("crm"))?.credentialScope, "per-user");
  assert.equal((await store.get("crm"))?.credentialHost, "accounts.example.com");
  assert.equal((await store.get("crm"))?.credentialAccountType, "personal");
  assert.equal((await store.get("crm"))?.bearerToken, "catalog-secret");
  assert.equal((await put({ credentialScope: "shared" })).status, 200);
  assert.equal((await store.get("crm"))?.credentialScope, "shared");
  assert.equal((await store.get("crm"))?.credentialHost, undefined);
  assert.equal((await store.get("crm"))?.credentialAccountType, undefined);
  const oauth = {
    authorizationUrl: "https://8.8.8.8/authorize",
    tokenUrl: "https://8.8.8.8/token",
    scopes: ["read"],
    tokenEndpointAuthMethod: "client_secret_basic",
  };
  const configured = await put({
    auth: "user-oauth",
    clientId: "registered-app",
    clientSecret: "oauth-app-secret",
    oauth,
  });
  assert.equal(configured.status, 200);
  assert.doesNotMatch(await configured.text(), /oauth-app-secret/);
  assert.doesNotMatch(JSON.stringify(await backing.get("crm")), /oauth-app-secret/);
  assert.ok((await backing.get("crm"))?.clientSecretEnc);
  assert.equal((await store.get("crm"))?.clientSecret, "oauth-app-secret");
  assert.equal((await put({ auth: "user-oauth" })).status, 200);
  assert.deepEqual((await store.get("crm"))?.oauth, oauth);
  assert.equal((await put({ auth: "user-oauth", clientId: "different-app" })).status, 400);
  for (const invalid of [
    { authorizationUrl: "https://8.8.8.8/authorize" },
    { authorizationUrl: "http://8.8.8.8/authorize", tokenUrl: "https://8.8.8.8/token" },
    { authorizationUrl: "https://127.0.0.1/authorize", tokenUrl: "https://8.8.8.8/token" },
    { scopes: ["read write"] },
    { tokenEndpointAuthMethod: "private_key_jwt" },
    { clientSecret: "plaintext-must-not-be-persisted" },
  ])
    assert.equal((await put({ auth: "user-oauth", oauth: invalid })).status, 400);
  assert.equal((await put({ auth: "user-oauth", clientId: "", oauth: {} })).status, 200);
  assert.equal((await store.get("crm"))?.clientId, undefined);
  assert.equal((await store.get("crm"))?.clientSecret, undefined);
  assert.equal((await put({ auth: "user-token", tokenHeader: "X-API-Key", tokenPrefix: "" })).status, 200);
  assert.equal((await store.get("crm"))?.tokenPrefix, "");
  assert.equal((await put({ auth: "user-token", tokenHeader: "Cookie" })).status, 400);
  assert.equal((await put({ auth: "user-token", tokenPrefix: "bad\r\nheader" })).status, 400);
});

test("production wiring keeps strict per-user tokens separate from operator fallbacks", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-wiring-"));
  const previous = process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
  process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = "operator-token";
  const built = buildApp(testConfig({ dataDir: dir, egressServiceHosts: ["accounts.example.com"] }));
  t.after(async () => {
    await built.mcpToolService.close();
    if (previous === undefined) delete process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM;
    else process.env.VAULT_TOKEN_ACCOUNTS_EXAMPLE_COM = previous;
    await rm(dir, { recursive: true, force: true });
  });
  await built.migrationsReady;
  assert.ok(built.keychain);
  assert.equal(await built.keychain.connectorAccessToken("accounts.example.com", "internal:alice"), null);
  assert.equal(
    await built.connectorTokens.connectorAccessToken("accounts.example.com", "internal:alice"),
    "operator-token",
  );
});
