import { test } from "node:test";
import assert from "node:assert/strict";
import {
  oauthProviders,
  resolveMcpOAuthClient,
  exchangeCode,
  makeRefresh,
  mcpOAuthCredentialHost,
  type FetchLike,
} from "../src/connectors/oauth.ts";
import { connectorRawRoutes, connectorRoutes } from "../src/api/routes/connectors.ts";
import type { McpServer } from "../src/mcp/mcp-server-store.ts";

const server: McpServer = {
  id: "example",
  name: "Example",
  url: "https://mcp.example.test/mcp",
  auth: "user-oauth",
  enabled: true,
  readOnly: true,
  updatedAt: 0,
  updatedBy: "admin",
};
const callback = "https://qm.test/v1/connectors/oauth/mcp-example/callback";
const response = (data: unknown, status = 200) => ({ ok: status === 200, status, json: async () => data });
const metadata = {
  issuer: "https://auth.example.test/tenant",
  authorization_endpoint: "https://auth.example.test/authorize",
  token_endpoint: "https://auth.example.test/token",
  code_challenge_methods_supported: ["S256"],
};

for (const method of ["none", "client_secret_basic", "client_secret_post"] as const) {
  test(`configured OAuth ${method} exchanges and refreshes without DCR or discovery`, async () => {
    const configured = {
      ...server,
      clientId: "registered-app",
      ...(method === "none" ? {} : { clientSecret: "app-secret" }),
      oauth: {
        authorizationUrl: metadata.authorization_endpoint,
        tokenUrl: metadata.token_endpoint,
        scopes: ["read", "offline_access"],
        tokenEndpointAuthMethod: method,
      },
    };
    const servers = { list: async () => [configured] };
    const config = (await oauthProviders(servers))["mcp-example"]!;
    let calls = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      calls++;
      assert.equal(url, metadata.token_endpoint);
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("client_id"), "registered-app");
      assert.equal(body.get("resource"), server.url);
      if (method === "client_secret_basic") {
        assert.equal(
          init.headers.authorization,
          `Basic ${Buffer.from("registered-app:app-secret").toString("base64")}`,
        );
        assert.equal(body.get("client_secret"), null);
      } else {
        assert.equal(init.headers.authorization, undefined);
        assert.equal(body.get("client_secret"), method === "client_secret_post" ? "app-secret" : null);
      }
      if (body.get("grant_type") === "authorization_code") assert.equal(body.get("code_verifier"), "pkce-verifier");
      return response({ access_token: "user-token", refresh_token: "refresh-token" });
    };
    const client = await resolveMcpOAuthClient("mcp-example", config, { redirectUri: callback, fetchImpl });
    assert.equal(calls, 0);
    assert.deepEqual(client.scopes, ["read", "offline_access"]);
    const { token } = await exchangeCode("mcp-example", "code", callback, {
      providerConfig: config,
      client,
      fetchImpl,
      codeVerifier: "pkce-verifier",
    });
    const refresh = makeRefresh({
      mcpServers: servers,
      resolveClient: async () => {
        throw new Error("must not use built-in provider");
      },
      fetchImpl,
    });
    assert.equal(
      (await refresh(config.hosts[0]!, { ...token, clientRef: client.clientRef })).accessToken,
      "user-token",
    );
    assert.equal(calls, 2);
    await assert.rejects(
      resolveMcpOAuthClient(
        "mcp-example",
        { ...config, mcp: { ...config.mcp, clientId: "changed-app" } },
        { redirectUri: callback, clientRef: client.clientRef, fetchImpl },
      ),
      /client reference/,
    );
    assert.equal(calls, 2);
  });
}

test("MCP discovery handles challenges and OIDC discovery with a pre-registered app", async () => {
  const config = (
    await oauthProviders({
      list: async () => [{ ...server, clientId: "registered-app", oauth: { scopes: ["custom:read"] } }],
    })
  )["mcp-example"]!;
  const seen: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    seen.push(url);
    if (url === server.url)
      return {
        ...response({}, 401),
        headers: { get: () => 'Bearer resource_metadata="https://auth.example.test/resource", scope="read"' },
      };
    if (url === "https://auth.example.test/resource")
      return response({ resource: server.url, authorization_servers: [metadata.issuer] });
    if (url === "https://auth.example.test/tenant/.well-known/openid-configuration") return response(metadata);
    return response({}, 404);
  };
  const client = await resolveMcpOAuthClient("mcp-example", config, { redirectUri: callback, fetchImpl });
  assert.equal(client.id, "registered-app");
  assert.deepEqual(client.scopes, ["custom:read"]);
  assert.ok(seen.includes("https://auth.example.test/.well-known/openid-configuration/tenant"));
  await assert.rejects(
    resolveMcpOAuthClient("mcp-example", config, {
      redirectUri: callback,
      fetchImpl: async (url, init) =>
        url === "https://auth.example.test/tenant/.well-known/openid-configuration"
          ? response({ ...metadata, issuer: "https://wrong.example.test" })
          : fetchImpl(url, init),
    }),
    /issuer/,
  );
});

test("public client metadata is hosted without exposing secrets and replaces DCR when supported", async () => {
  const servers = { list: async () => [server] };
  const config = (await oauthProviders(servers, "https://qm.test"))["mcp-example"]!;
  let registrations = 0;
  const fetchImpl: FetchLike = async (url) => {
    if (url === server.url) return response({}, 401);
    if (url.includes("oauth-protected-resource"))
      return response({ resource: server.url, authorization_servers: [metadata.issuer] });
    if (url.includes("well-known")) return response({ ...metadata, client_id_metadata_document_supported: true });
    registrations++;
    throw new Error("must not dynamically register");
  };
  const client = await resolveMcpOAuthClient("mcp-example", config, { redirectUri: callback, fetchImpl });
  assert.equal(client.id, "https://qm.test/v1/connectors/oauth/mcp-example/client-metadata");
  const restored = await resolveMcpOAuthClient("mcp-example", config, {
    redirectUri: "",
    clientRef: client.clientRef,
    fetchImpl,
  });
  assert.equal(restored.id, client.id);
  await assert.rejects(
    resolveMcpOAuthClient("mcp-example", config, { redirectUri: "https://wrong.test/callback", fetchImpl }),
    /redirect URI/,
  );
  assert.equal(registrations, 0);
  const route = connectorRawRoutes.find(
    (entry) => "match" in entry && entry.match("GET", "/v1/connectors/oauth/mcp-example/client-metadata"),
  )!;
  let body = "";
  await route.handle({
    pathname: "/v1/connectors/oauth/mcp-example/client-metadata",
    deps: { mcpServers: servers, publicUrl: "https://qm.test" },
    res: {
      writeHead: (status: number) => assert.equal(status, 200),
      end: (value: string) => {
        body = value;
      },
    },
  } as never);
  assert.equal(JSON.parse(body).client_id, client.id);
  assert.deepEqual(JSON.parse(body).redirect_uris, [callback]);
  assert.doesNotMatch(body, /client_secret|access_token/);
});

test("external client metadata validates redirect registration before use", async () => {
  const metadataUrl = "https://clients.example.test/qm.json";
  const config = (
    await oauthProviders({ list: async () => [{ ...server, oauth: { clientMetadataUrl: metadataUrl } }] })
  )["mcp-example"]!;
  let valid = true;
  const fetchImpl: FetchLike = async (url) => {
    if (url === metadataUrl)
      return response({
        client_id: metadataUrl,
        client_name: "QM",
        redirect_uris: valid ? [callback] : ["https://wrong.test/callback"],
      });
    if (url === server.url) return response({}, 401);
    if (url.includes("oauth-protected-resource"))
      return response({ resource: server.url, authorization_servers: [metadata.issuer] });
    return response({ ...metadata, client_id_metadata_document_supported: true });
  };
  assert.equal(
    (await resolveMcpOAuthClient("mcp-example", config, { redirectUri: callback, fetchImpl })).id,
    metadataUrl,
  );
  valid = false;
  await assert.rejects(
    resolveMcpOAuthClient("mcp-example", config, { redirectUri: callback, fetchImpl }),
    /redirect URI/,
  );
});

test("per-user token routes isolate users and reject disabled or wrong-mode servers", async () => {
  let current = { ...server, auth: "user-token" as McpServer["auth"] };
  const saved = new Map<string, string>();
  const deps = {
    mcpServers: { list: async () => [current] },
    connectorTokens: {
      setConnectorToken: async (host: string, principal: string, token: { accessToken: string }) =>
        void saved.set(`${host}:${principal}`, token.accessToken),
      connectorTokenStatus: async (host: string, principal: string) => ({
        connected: saved.has(`${host}:${principal}`),
      }),
      deleteConnectorToken: async (host: string, principal: string) => void saved.delete(`${host}:${principal}`),
    },
  };
  const route = (path: string) => connectorRoutes.find((entry) => "path" in entry && entry.path === path)!;
  const call = async (path: string, principal: string, body: object = {}) => {
    let status = 0;
    let output = "";
    await route(path).handle({
      deps,
      body: { principalId: principal, ...body },
      params: { provider: "mcp-example" },
      url: new URL(`https://qm.test/status?principalId=${principal}`),
      res: {
        writeHead: (code: number) => {
          status = code;
        },
        end: (value: string) => {
          output = value;
        },
      },
    } as never);
    return { status, data: JSON.parse(output) };
  };
  const path = "/v1/connectors/mcp/:provider/token";
  assert.equal((await call(path, "U1", { accessToken: "token-1" })).status, 200);
  assert.equal((await call(path, "U2", { accessToken: "token-2" })).status, 200);
  const host = mcpOAuthCredentialHost(current);
  assert.equal(saved.get(`${host}:U1`), "token-1");
  assert.equal(saved.get(`${host}:U2`), "token-2");
  const status = await call("/v1/connectors/oauth/status", "U1");
  assert.equal(status.data.providers["mcp-example"].connectionMode, "token");
  assert.equal(status.data.providers["mcp-example"].connected, true);
  assert.equal((await call("/v1/connectors/oauth/revoke", "U1", { provider: "mcp-example" })).status, 200);
  assert.equal(saved.has(`${host}:U1`), false);
  assert.equal(saved.get(`${host}:U2`), "token-2");
  assert.equal((await call(path, "U1", { accessToken: "bad\r\ntoken" })).status, 400);
  current = { ...current, enabled: false };
  assert.equal((await call(path, "U1", { accessToken: "token" })).status, 404);
  current = { ...current, enabled: true, auth: "none" };
  assert.equal((await call(path, "U1", { accessToken: "token" })).status, 404);
});
