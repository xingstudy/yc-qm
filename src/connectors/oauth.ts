import type { OAuthToken, OAuthRefresh } from "../credentials/keychain.ts";
import { createEnvSecretSource, type SecretSource } from "../credentials/secret-source.ts";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { mintSignedPayload, verifySignedPayload } from "../auth/signed-token.ts";
import type { McpOAuthSettings, McpServer, McpServerStore } from "../mcp/mcp-server-store.ts";
import { fetchPublicMcpJson } from "../mcp/mcp-client.ts";
import { swallow } from "../util/errors.ts";

export type AccountType = "default" | "personal" | "company";

export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}
export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export type ConsentMode = "standard" | "admin" | "github_app";

interface OAuthSetupGuide {
  console: string;
  url: string;
  steps: string[];
  scopesRationale?: string;
}

interface OAuthAdapterArgs {
  provider: OAuthProviderConfig;
  client: ResolvedClient;
  redirectUri: string;
  fetchImpl: FetchLike;
  now: number;
  accountType?: AccountType;
  codeVerifier?: string;
}
type OAuthExchangeAdapter = (
  args: OAuthAdapterArgs & { code: string },
) => Promise<{ hosts: string[]; token: OAuthToken }>;
type OAuthRefreshAdapter = (args: OAuthAdapterArgs & { token: OAuthToken }) => Promise<OAuthToken>;

export interface OAuthProviderConfig {
  displayName?: string;
  mcp?: McpOAuthSettings & { clientId?: string; clientSecret?: string; autoClientMetadataUrl?: string };
  hosts: string[];
  authUrl: string;
  tokenUrl: string;
  resource?: string;
  scopes: string[];
  clientIdEnv: string;
  clientSecretEnv: string;
  redirectPath: string;
  consentMode: ConsentMode;
  egressRule: string[];
  setupGuide: OAuthSetupGuide;
  scopeParam?: string;
  authParams?: Record<string, string>;
  exchange?: OAuthExchangeAdapter;
  refresh?: OAuthRefreshAdapter | null;
  pkce?: boolean;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const realFetch: FetchLike = (url, { body, ...init }) => fetch(url, init.method === "GET" ? init : { ...init, body });

function parseScopes(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string" && raw.trim()) return raw.trim().split(/\s+/);
  return undefined;
}

function toToken(
  raw: Record<string, unknown>,
  fallbackRefresh: string | undefined,
  now: number,
  grantedScopes?: string[],
): OAuthToken {
  const access = String(raw.access_token ?? "");
  const refresh = raw.refresh_token ? String(raw.refresh_token) : fallbackRefresh;
  const expiresIn = typeof raw.expires_in === "number" ? raw.expires_in : undefined;
  const scopes = grantedScopes ?? parseScopes(raw.scope);
  return {
    accessToken: access,
    ...(refresh ? { refreshToken: refresh } : {}),
    ...(expiresIn ? { expiresAt: now + expiresIn * 1000 } : {}),
    ...(scopes ? { grantedScopes: scopes } : {}),
  };
}

function makeTokenAdapters(opts: {
  acceptJson?: boolean;
  rejectErrorBody?: boolean;
  label?: string;
  clientAuth?: "body" | "basic" | "none";
  encodeBasicCredentials?: boolean;
}): {
  exchange: (
    args: OAuthAdapterArgs & { code: string },
  ) => Promise<{ hosts: string[]; token: OAuthToken; raw: Record<string, unknown> }>;
  refresh: OAuthRefreshAdapter;
} {
  const prefix = opts.label ? `${opts.label} ` : "";
  const basic = opts.clientAuth === "basic";
  const none = opts.clientAuth === "none";
  const basicPart = (value: string) =>
    opts.encodeBasicCredentials ? new URLSearchParams([["", value]]).toString().slice(1) : value;
  const headers = (client: ResolvedClient) => ({
    "content-type": "application/x-www-form-urlencoded",
    ...(opts.acceptJson ? { accept: "application/json" } : {}),
    ...(basic
      ? {
          authorization: `Basic ${Buffer.from(`${basicPart(client.id)}:${basicPart(client.secret)}`).toString("base64")}`,
        }
      : {}),
  });
  const clientBody = (client: ResolvedClient): Record<string, string> =>
    basic || none ? { client_id: client.id } : { client_id: client.id, client_secret: client.secret };
  const checkErrorBody = (raw: Record<string, unknown>): void => {
    if (opts.rejectErrorBody && raw.error)
      throw new Error(`${prefix}oauth error: ${String(raw.error_description ?? raw.error)}`);
  };
  return {
    async exchange({ provider, client, code, redirectUri, fetchImpl, now, codeVerifier }) {
      const res = await fetchImpl(client.tokenUrl ?? provider.tokenUrl, {
        method: "POST",
        headers: headers(client),
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          ...clientBody(client),
          ...(provider.resource ? { resource: provider.resource } : {}),
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }).toString(),
      });
      if (!res.ok) throw new Error(`${prefix}token exchange failed (${res.status})`);
      const raw = (await res.json()) as Record<string, unknown>;
      checkErrorBody(raw);
      return { hosts: provider.hosts, token: toToken(raw, undefined, now), raw };
    },
    async refresh({ provider, client, token, fetchImpl, now }) {
      const res = await fetchImpl(client.tokenUrl ?? provider.tokenUrl, {
        method: "POST",
        headers: headers(client),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: token.refreshToken ?? "",
          ...clientBody(client),
          ...(provider.resource ? { resource: provider.resource } : {}),
        }).toString(),
      });
      if (!res.ok) throw new Error(`${prefix}token refresh failed (${res.status})`);
      const raw = (await res.json()) as Record<string, unknown>;
      checkErrorBody(raw);
      return toToken(raw, token.refreshToken, now, token.grantedScopes);
    },
  };
}

const { exchange: defaultExchange, refresh: defaultRefresh } = makeTokenAdapters({});

const googleExchange: OAuthExchangeAdapter = async (args) => {
  const { client, accountType } = args;
  const { hosts, token, raw } = await defaultExchange(args);
  if (accountType === "company" && client.hostedDomain) {
    const idToken = typeof raw?.id_token === "string" ? raw.id_token : "";
    let claims: Record<string, unknown> | undefined;
    try {
      if (idToken) claims = decodeJwt(idToken);
    } catch (e) {
      swallow("google id_token decode", e);
    }
    const hd = typeof claims?.hd === "string" ? claims.hd : "";
    if (hd.toLowerCase() !== client.hostedDomain.toLowerCase()) {
      throw new Error(
        `connected account is not in the ${client.hostedDomain} workspace — pick your company Google account`,
      );
    }
  }
  return { hosts, token };
};

const github = makeTokenAdapters({ acceptJson: true, rejectErrorBody: true, label: "github" });

const x = makeTokenAdapters({ acceptJson: true, rejectErrorBody: true, label: "x", clientAuth: "basic" });

function mcpTokenAdapters(client: ResolvedClient) {
  const method = client.tokenEndpointAuthMethod ?? "none";
  let clientAuth: "basic" | "body" | "none" = "none";
  if (method === "client_secret_basic") clientAuth = "basic";
  if (method === "client_secret_post") clientAuth = "body";
  return makeTokenAdapters({
    label: "MCP",
    acceptJson: true,
    rejectErrorBody: true,
    encodeBasicCredentials: true,
    clientAuth,
  });
}

const mcpOAuth: { exchange: OAuthExchangeAdapter; refresh: OAuthRefreshAdapter } = {
  exchange: (args) => mcpTokenAdapters(args.client).exchange(args),
  refresh: (args) => mcpTokenAdapters(args.client).refresh(args),
};

const slackExchange: OAuthExchangeAdapter = async ({ provider, client, code, redirectUri, fetchImpl }) => {
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      redirect_uri: redirectUri,
      client_id: client.id,
      client_secret: client.secret,
    }).toString(),
  });
  if (!res.ok) throw new Error(`slack token exchange failed (${res.status})`);
  const raw = (await res.json()) as Record<string, unknown>;
  if (raw.ok !== true) throw new Error(`slack oauth error: ${String(raw.error ?? "unknown")}`);
  const authedUser = (raw.authed_user ?? {}) as Record<string, unknown>;
  const access = String(authedUser.access_token ?? raw.access_token ?? "");
  if (!access) throw new Error("slack oauth returned no usable token (no user or bot token granted)");
  const grantedScopes = parseScopes(authedUser.scope) ?? parseScopes(raw.scope);
  return { hosts: provider.hosts, token: { accessToken: access, ...(grantedScopes ? { grantedScopes } : {}) } };
};

const notionExchange: OAuthExchangeAdapter = async ({ provider, client, code, redirectUri, fetchImpl }) => {
  const basic = Buffer.from(`${client.id}:${client.secret}`).toString("base64");
  const res = await fetchImpl(provider.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${basic}` },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`notion token exchange failed (${res.status})`);
  const raw = (await res.json()) as Record<string, unknown>;
  const access = String(raw.access_token ?? "");
  if (!access) throw new Error("notion token exchange returned no access_token");
  return { hosts: provider.hosts, token: { accessToken: access } };
};

export const PROVIDERS: Record<string, OAuthProviderConfig> = {
  google: {
    hosts: [
      "gmail.googleapis.com",
      "www.googleapis.com",
      "sheets.googleapis.com",
      "docs.googleapis.com",
      "slides.googleapis.com",
    ],
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/tasks",
      "openid",
      "email",
    ],
    clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
    redirectPath: "google/callback",
    consentMode: "standard",
    egressRule: [
      "gmail.googleapis.com",
      "www.googleapis.com",
      "sheets.googleapis.com",
      "docs.googleapis.com",
      "slides.googleapis.com",
      "oauth2.googleapis.com",
      "accounts.google.com",
    ],
    authParams: { access_type: "offline", prompt: "consent" },
    exchange: googleExchange,
    setupGuide: {
      console: "Google Cloud Console → APIs & Services → Credentials",
      url: "https://console.cloud.google.com/auth/clients",
      steps: [
        "Create an OAuth 2.0 Client ID (type: Web application).",
        "Add the redirect URI shown below to 'Authorized redirect URIs' on YOUR client.",
        "Enable the Gmail, Calendar, Drive, Sheets, Docs, Slides, and Tasks APIs for the project.",
        "Choose admin-consent (domain-wide) vs per-user consent on the OAuth consent screen.",
        "Paste the Client ID + Client secret below; we validate by dry-running the consent URL.",
      ],
      scopesRationale:
        "gmail.modify/calendar/drive/spreadsheets/tasks back the Google Workspace skills; openid+email identify the account.",
    },
  },

  slack: {
    hosts: ["slack.com"],
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: [
      "users:read",
      "channels:read",
      "channels:history",
      "groups:read",
      "groups:history",
      "im:read",
      "im:write",
      "im:history",
      "mpim:read",
      "mpim:write",
      "mpim:history",
      "chat:write",
      "canvases:read",
      "canvases:write",
      "search:read",
      "search:read.im",
      "search:read.mpim",
    ],
    clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
    clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    redirectPath: "slack/callback",
    consentMode: "standard",
    egressRule: ["slack.com"],
    scopeParam: "user_scope",
    exchange: slackExchange,
    refresh: null,
    setupGuide: {
      console: "Slack API → Your Apps → OAuth & Permissions",
      url: "https://api.slack.com/apps",
      steps: [
        "Create a Slack app (from scratch) in your workspace.",
        "Under OAuth & Permissions, add the redirect URL shown below.",
        "Add the requested USER token scopes under 'User Token Scopes'.",
        "Install the app to the workspace.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale:
        "User-token scopes let the agent read/post, search, and edit canvases as the connecting user, not a bot.",
    },
  },

  notion: {
    hosts: ["api.notion.com"],
    authUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: [],
    clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
    clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
    redirectPath: "notion/callback",
    consentMode: "standard",
    egressRule: ["api.notion.com"],
    authParams: { owner: "user" },
    exchange: notionExchange,
    refresh: null,
    setupGuide: {
      console: "Notion → My integrations → New integration (Public)",
      url: "https://www.notion.so/profile/integrations",
      steps: [
        "Create a public OAuth integration.",
        "Add the redirect URI shown below to the integration's redirect URIs.",
        "Configure the capabilities the integration needs.",
        "Paste the Client ID (OAuth client ID) + the OAuth client secret below.",
      ],
      scopesRationale: "Notion grants access per selected pages at consent time (no OAuth scope list).",
    },
  },

  linear: {
    hosts: ["api.linear.app"],
    authUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    scopes: ["read", "write"],
    clientIdEnv: "LINEAR_OAUTH_CLIENT_ID",
    clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET",
    redirectPath: "linear/callback",
    consentMode: "standard",
    egressRule: ["api.linear.app"],
    refresh: null,
    setupGuide: {
      console: "Linear → Settings → API → OAuth applications",
      url: "https://linear.app/settings/api/applications",
      steps: [
        "Create an OAuth application.",
        "Add the redirect URI shown below as a callback URL.",
        "Select the read/write scopes.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale: "read/write let the agent query and update issues, projects, and comments.",
    },
  },

  dropbox: {
    hosts: ["api.dropboxapi.com", "content.dropboxapi.com"],
    authUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    scopes: [
      "account_info.read",
      "files.metadata.read",
      "files.content.read",
      "files.content.write",
      "sharing.read",
      "sharing.write",
    ],
    clientIdEnv: "DROPBOX_OAUTH_CLIENT_ID",
    clientSecretEnv: "DROPBOX_OAUTH_CLIENT_SECRET",
    redirectPath: "dropbox/callback",
    consentMode: "standard",
    egressRule: ["api.dropboxapi.com", "content.dropboxapi.com", "www.dropbox.com"],
    authParams: { token_access_type: "offline" },
    setupGuide: {
      console: "Dropbox App Console → Create app",
      url: "https://www.dropbox.com/developers/apps/create",
      steps: [
        "Create an app: Scoped access, Full Dropbox access.",
        "On the app's OAuth 2 section, add the redirect URI shown below.",
        "On the Permissions tab, enable account_info.read, files.metadata.read, files.content.read, files.content.write, sharing.read, sharing.write — then Submit.",
        "Paste the App key (Client ID) + App secret (Client secret) below.",
      ],
      scopesRationale:
        "files.content/metadata read+write back browse/download/upload; sharing.read/write let the agent manage shared links; account_info.read identifies the account.",
    },
  },

  github: {
    hosts: ["api.github.com"],
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo", "read:org"],
    clientIdEnv: "GITHUB_OAUTH_CLIENT_ID",
    clientSecretEnv: "GITHUB_OAUTH_CLIENT_SECRET",
    redirectPath: "github/callback",
    consentMode: "github_app",
    egressRule: ["api.github.com", "github.com"],
    exchange: github.exchange,
    refresh: github.refresh,
    setupGuide: {
      console: "GitHub → Settings → Developer settings → OAuth Apps (or GitHub App)",
      url: "https://github.com/settings/applications/new",
      steps: [
        "Register a new OAuth App (or a GitHub App for installation tokens).",
        "Set the Authorization callback URL to the redirect URI shown below.",
        "Select the repo/org scopes the agent needs.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale: "repo/read:org back the GitHub skills (PRs, issues, org-visible repos) as the connecting user.",
    },
  },

  x: {
    hosts: ["api.x.com"],
    authUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    clientIdEnv: "X_OAUTH_CLIENT_ID",
    clientSecretEnv: "X_OAUTH_CLIENT_SECRET",
    redirectPath: "x/callback",
    consentMode: "standard",
    egressRule: ["api.x.com"],
    pkce: true,
    exchange: x.exchange,
    refresh: x.refresh,
    setupGuide: {
      console: "X Developer Portal → Projects & Apps → your app → User authentication settings",
      url: "https://developer.x.com/en/portal/projects-and-apps",
      steps: [
        "Set up User authentication: OAuth 2.0, type Confidential client, App permissions Read and write.",
        "Add the Callback URI shown below to the app's Callback URLs.",
        "Under Keys and tokens, generate the OAuth 2.0 Client ID and Client Secret.",
        "Paste the Client ID + Client secret below.",
      ],
      scopesRationale:
        "tweet.read/users.read back reads; tweet.write lets the connecting user post as themselves; offline.access issues a refresh token so the 2-hour access token renews.",
    },
  },
  atlassian: {
    hosts: ["mcp.atlassian.com"],
    authUrl: "https://mcp.atlassian.com/v1/authorize",
    tokenUrl: "https://mcp.atlassian.com/v1/token",
    resource: "https://mcp.atlassian.com/v2/mcp",
    scopes: [
      "read:me",
      "offline_access",
      "read:jira:agent-interface",
      "write:jira:agent-interface",
      "search:jira:agent-interface",
    ],
    clientIdEnv: "",
    clientSecretEnv: "",
    redirectPath: "atlassian/callback",
    consentMode: "standard",
    egressRule: ["mcp.atlassian.com"],
    pkce: true,
    authParams: { prompt: "consent" },
    exchange: mcpOAuth.exchange,
    refresh: mcpOAuth.refresh,
    setupGuide: {
      console: "Atlassian Rovo MCP",
      url: "https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-oauth-2-1/",
      steps: [
        "An organization admin enables the Atlassian Rovo MCP server in QM.",
        "Each person opens Keychain and chooses Connect for Atlassian.",
        "Atlassian asks that person to grant the access their account is allowed to use.",
      ],
      scopesRationale:
        "Atlassian selects the permitted MCP tools from the connecting user's consent, app access, and existing permissions.",
    },
  },
};

export interface ResolvedClient {
  tokenEndpointAuthMethod?: McpOAuthSettings["tokenEndpointAuthMethod"];
  id: string;
  secret: string;
  scopes?: string[];
  redirectAllowlist?: string[];
  hostedDomain?: string;
  clientRef: string;
  authUrl?: string;
  tokenUrl?: string;
}

export function mcpOAuthCredentialHost(
  server: Pick<McpServer, "id" | "url"> & Partial<Pick<McpServer, "auth" | "oauth" | "clientId">>,
): string {
  if (server.auth !== "user-token" && server.url === PROVIDERS.atlassian!.resource) return "mcp.atlassian.com";
  const oauth = server.oauth;
  const settings =
    oauth || server.clientId
      ? JSON.stringify([
          server.clientId,
          oauth?.authorizationUrl,
          oauth?.tokenUrl,
          oauth?.clientMetadataUrl,
          oauth?.tokenEndpointAuthMethod,
          oauth?.scopes,
          ...(oauth?.registrationMode && oauth.registrationMode !== "auto" ? [oauth.registrationMode] : []),
        ])
      : "";
  const binding = `${server.id}\u0000${server.url}${settings ? `\u0000${settings}` : ""}`;
  const prefix = server.auth === "user-token" ? "mcp-token" : "mcp";
  return `${prefix}-${createHash("sha256").update(binding).digest("hex").slice(0, 40)}.oauth`;
}

export async function oauthProviders(
  servers?: Pick<McpServerStore, "list">,
  publicUrl?: string,
): Promise<Record<string, OAuthProviderConfig>> {
  const providers = { ...PROVIDERS };
  for (const server of (await servers?.list()) ?? []) {
    if (!server.enabled || server.auth !== "user-oauth") continue;
    const existing = server.url === PROVIDERS.atlassian!.resource;
    const name = existing ? "atlassian" : `mcp-${server.id}`;
    providers[name] = {
      ...(existing ? PROVIDERS.atlassian! : {}),
      displayName: server.name,
      hosts: [mcpOAuthCredentialHost(server)],
      authUrl: "",
      tokenUrl: "",
      resource: new URL(server.url).toString(),
      scopes: server.oauth?.scopes ?? [],
      clientIdEnv: "",
      clientSecretEnv: "",
      redirectPath: `${name}/callback`,
      consentMode: "standard",
      egressRule: [],
      pkce: true,
      exchange: mcpOAuth.exchange,
      refresh: mcpOAuth.refresh,
      mcp: {
        ...server.oauth,
        clientId: server.clientId,
        clientSecret: server.clientSecret,
        ...(publicUrl?.startsWith("https://")
          ? { autoClientMetadataUrl: `${publicUrl.replace(/\/$/, "")}/v1/connectors/oauth/${name}/client-metadata` }
          : {}),
      },
      setupGuide: { console: server.name, url: server.url, steps: ["Connect your own account in Keychain."] },
    };
  }
  return providers;
}

type McpOAuthMetadata = {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  clientMetadataSupported?: boolean;
  tokenEndpointAuthMethods?: string[];
  scopes: string[];
};

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} returned an invalid response`);
  return value as Record<string, unknown>;
}

function secureOAuthUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is missing`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} must be an HTTPS URL without credentials or fragment`);
  }
  return parsed.toString();
}

async function mcpOAuthMetadata(provider: OAuthProviderConfig, fetchImpl: FetchLike): Promise<McpOAuthMetadata> {
  const request = (url: string) => fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, body: "" });
  const settings = provider.mcp;
  if (settings?.authorizationUrl && settings.tokenUrl) {
    return {
      authorizationEndpoint: secureOAuthUrl(settings.authorizationUrl, "MCP authorization endpoint"),
      tokenEndpoint: secureOAuthUrl(settings.tokenUrl, "MCP token endpoint"),
      scopes: settings.scopes ?? [],
    };
  }
  const resourceUrl = new URL(secureOAuthUrl(provider.resource, "MCP resource"));
  const resourceUrls = [
    new URL(
      `/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`,
      resourceUrl,
    ).toString(),
    new URL("/.well-known/oauth-protected-resource", resourceUrl).toString(),
  ];
  const challenge = await request(resourceUrl.toString());
  const header = challenge.status === 401 ? (challenge.headers?.get("www-authenticate") ?? "") : "";
  const metadataUrl = /\bresource_metadata="([^"\r\n]+)"/i.exec(header)?.[1];
  const scope = /\bscope="([^"\r\n]*)"/i.exec(header)?.[1];
  const challengeScopes = scope === undefined ? undefined : scope.split(/\s+/).filter(Boolean);
  let resourceResponse = await request(
    metadataUrl ? secureOAuthUrl(metadataUrl, "MCP resource metadata URL") : resourceUrls[0]!,
  );
  if (!metadataUrl && resourceResponse.status === 404 && resourceUrls[0] !== resourceUrls[1])
    resourceResponse = await request(resourceUrls[1]!);
  if (!resourceResponse.ok)
    throw new Error(`MCP protected-resource metadata request failed (${resourceResponse.status})`);
  const resource = jsonRecord(await resourceResponse.json(), "MCP protected-resource metadata");
  if (secureOAuthUrl(resource.resource, "MCP protected resource") !== provider.resource)
    throw new Error("MCP protected-resource metadata is for a different MCP endpoint");
  const advertisedScopes = resource.scopes_supported;
  const scopes = Array.isArray(advertisedScopes)
    ? advertisedScopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0)
    : [];
  if (advertisedScopes !== undefined && (!Array.isArray(advertisedScopes) || scopes.length !== advertisedScopes.length))
    throw new Error("MCP protected-resource metadata returned invalid scopes");
  const authorizationServer = secureOAuthUrl(
    Array.isArray(resource.authorization_servers) ? resource.authorization_servers[0] : undefined,
    "MCP authorization server",
  );
  const issuer = new URL(authorizationServer);
  const path = issuer.pathname.replace(/\/$/, "");
  const metadataUrls = [
    ...new Set([
      new URL(`/.well-known/oauth-authorization-server${path}`, issuer).toString(),
      new URL(`/.well-known/openid-configuration${path}`, issuer).toString(),
      new URL(`${path}/.well-known/openid-configuration`, issuer).toString(),
      new URL(`${path}/.well-known/oauth-authorization-server`, issuer).toString(),
    ]),
  ];
  let response = await request(metadataUrls[0]!);
  for (const url of metadataUrls.slice(1)) {
    if (response.status !== 404) break;
    response = await request(url);
  }
  if (!response.ok) throw new Error(`MCP OAuth metadata request failed (${response.status})`);
  const metadata = jsonRecord(await response.json(), "MCP OAuth metadata");
  if (secureOAuthUrl(metadata.issuer, "MCP OAuth issuer") !== authorizationServer)
    throw new Error("MCP OAuth issuer does not match the MCP authorization server");
  if (
    !Array.isArray(metadata.code_challenge_methods_supported) ||
    !metadata.code_challenge_methods_supported.includes("S256")
  )
    throw new Error("MCP OAuth does not support PKCE S256");
  return {
    authorizationEndpoint: secureOAuthUrl(metadata.authorization_endpoint, "MCP authorization endpoint"),
    tokenEndpoint: secureOAuthUrl(metadata.token_endpoint, "MCP token endpoint"),
    ...(metadata.registration_endpoint
      ? { registrationEndpoint: secureOAuthUrl(metadata.registration_endpoint, "MCP registration endpoint") }
      : {}),
    clientMetadataSupported: metadata.client_id_metadata_document_supported === true,
    ...(Array.isArray(metadata.token_endpoint_auth_methods_supported)
      ? { tokenEndpointAuthMethods: metadata.token_endpoint_auth_methods_supported.map(String) }
      : {}),
    scopes: settings?.scopes ?? challengeScopes ?? scopes,
  };
}

export function isDynamicOAuthProvider(provider: string, config = PROVIDERS[provider]): boolean {
  return !!config?.resource;
}

export async function resolveMcpOAuthClient(
  providerName: string,
  provider: OAuthProviderConfig,
  opts: {
    redirectUri: string;
    clientRef?: string;
    fetchImpl?: FetchLike;
  },
): Promise<ResolvedClient> {
  const fetchImpl = opts.fetchImpl ?? fetchPublicMcpJson;
  const configured = provider.mcp;
  const registrationMode = configured?.registrationMode ?? "auto";
  const boundRef = `mcp-config:${provider.hosts[0]}:${createHash("sha256")
    .update(
      JSON.stringify([
        configured?.clientId,
        configured?.clientMetadataUrl ?? configured?.autoClientMetadataUrl,
        configured?.authorizationUrl,
        configured?.tokenUrl,
        configured?.tokenEndpointAuthMethod,
        ...(registrationMode !== "auto" ? [registrationMode] : []),
      ]),
    )
    .digest("hex")}`;
  const staticClient = !!(configured?.clientId || configured?.clientMetadataUrl || registrationMode === "metadata");
  const prefix = providerName === "atlassian" ? "atlassian-dcr:" : `${providerName}-dcr:${provider.hosts[0]}:`;
  let clientId: string | null = opts.clientRef?.startsWith(prefix) ? opts.clientRef.slice(prefix.length) : null;
  if (
    opts.clientRef &&
    (staticClient || opts.clientRef === boundRef
      ? opts.clientRef !== boundRef
      : !clientId || clientId.length > 2048 || /[\s\x00-\x1f\x7f]/.test(clientId))
  )
    throw new Error("invalid MCP OAuth client reference");
  const metadata = await mcpOAuthMetadata(provider, fetchImpl);
  let clientRef = opts.clientRef;
  let method = configured?.tokenEndpointAuthMethod ?? "none";
  if (!configured?.tokenEndpointAuthMethod && configured?.clientSecret) {
    method =
      metadata.tokenEndpointAuthMethods?.includes("client_secret_post") &&
      !metadata.tokenEndpointAuthMethods.includes("client_secret_basic")
        ? "client_secret_post"
        : "client_secret_basic";
  }
  if (configured?.clientId) {
    clientId = configured.clientId;
    clientRef = boundRef;
  } else if (
    configured?.clientMetadataUrl ||
    registrationMode === "metadata" ||
    (registrationMode !== "dynamic" &&
      configured?.autoClientMetadataUrl &&
      !clientId &&
      (opts.clientRef === boundRef || (metadata.clientMetadataSupported && !metadata.registrationEndpoint)))
  ) {
    if (!metadata.clientMetadataSupported)
      throw new Error("MCP authorization server does not support client metadata documents");
    if (!configured?.clientMetadataUrl && !configured?.autoClientMetadataUrl)
      throw new Error("MCP client metadata requires a public HTTPS URL");
    clientId = secureOAuthUrl(
      configured.clientMetadataUrl ?? configured.autoClientMetadataUrl,
      "MCP client metadata URL",
    );
    if (
      !configured.clientMetadataUrl &&
      opts.redirectUri &&
      opts.redirectUri !== clientId.replace(/client-metadata$/, "callback")
    )
      throw new Error("MCP client metadata does not match the redirect URI");
    if (configured.clientMetadataUrl) {
      const response = await fetchImpl(clientId, { method: "GET", headers: { accept: "application/json" }, body: "" });
      if (!response.ok) throw new Error(`MCP client metadata request failed (${response.status})`);
      const document = jsonRecord(await response.json(), "MCP client metadata");
      if (
        document.client_id !== clientId ||
        typeof document.client_name !== "string" ||
        !document.client_name ||
        !Array.isArray(document.redirect_uris) ||
        (opts.redirectUri && !document.redirect_uris.includes(opts.redirectUri)) ||
        (document.token_endpoint_auth_method !== undefined && document.token_endpoint_auth_method !== "none")
      )
        throw new Error("MCP client metadata does not match the client or redirect URI");
    }
    method = "none";
    clientRef = boundRef;
  } else if (!clientId) {
    if (!opts.redirectUri) throw new Error("MCP OAuth redirect URI is required");
    if (!metadata.registrationEndpoint)
      throw new Error(
        "MCP OAuth requires a configured Client ID, client metadata URL, or dynamic registration endpoint",
      );
    const response = await fetchImpl(metadata.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "QM",
        redirect_uris: [opts.redirectUri],
        response_types: ["code"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        scope: metadata.scopes.join(" "),
      }),
    });
    if (!response.ok) throw new Error(`MCP OAuth client registration failed (${response.status})`);
    const registered = jsonRecord(await response.json(), "MCP OAuth client registration");
    if (registered.token_endpoint_auth_method !== undefined && registered.token_endpoint_auth_method !== "none")
      throw new Error("MCP OAuth registration requires an unsupported client authentication method");
    clientId = typeof registered.client_id === "string" ? registered.client_id : null;
  }
  if (!clientId || clientId.length > 2048 || /[\s\x00-\x1f\x7f]/.test(clientId))
    throw new Error("MCP OAuth returned an invalid client_id");
  if (method !== "none" && !configured?.clientSecret)
    throw new Error("MCP OAuth client authentication requires a client secret");
  if (metadata.tokenEndpointAuthMethods && !metadata.tokenEndpointAuthMethods.includes(method))
    throw new Error("MCP OAuth token endpoint does not support the configured client authentication method");
  return {
    id: clientId,
    secret: configured?.clientSecret ?? "",
    tokenEndpointAuthMethod: method,
    scopes: metadata.scopes,
    authUrl: metadata.authorizationEndpoint,
    tokenUrl: metadata.tokenEndpoint,
    clientRef: clientRef ?? `${prefix}${clientId}`,
  };
}

export type OAuthClientResolver = (provider: string, ctx: { accountType?: AccountType }) => Promise<ResolvedClient>;

export function createSecretClientResolver(secrets: SecretSource = createEnvSecretSource()): OAuthClientResolver {
  return async (providerName) => {
    const p = PROVIDERS[providerName];
    if (!p) throw new Error(`unknown OAuth provider: ${providerName}`);
    const [id, secret, hostedDomain] = await Promise.all([
      secrets.get(p.clientIdEnv),
      secrets.get(p.clientSecretEnv),
      providerName === "google" ? secrets.get("GOOGLE_WORKSPACE_DOMAIN") : undefined,
    ]);
    if (!id || !secret) throw new Error(`provider not configured — set ${p.clientIdEnv} and ${p.clientSecretEnv}`);
    return { id, secret, clientRef: `env:${providerName}`, ...(hostedDomain ? { hostedDomain } : {}) };
  };
}

export interface OAuthState {
  provider: string;
  principalId: string;
  redirectUri: string;
  issuedAt: number;
  nonce: string;
  returnTo?: string;
  orgId?: string;
  accountType?: AccountType;
  clientRef?: string;
  codeVerifier?: string;
  consentLinkId?: string;
  sessionVersion?: number;
}

const ACCOUNT_TYPES: readonly AccountType[] = ["default", "personal", "company"];

function isOAuthState(v: unknown): v is OAuthState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as OAuthState;
  return (
    typeof s.provider === "string" &&
    typeof s.principalId === "string" &&
    typeof s.redirectUri === "string" &&
    typeof s.issuedAt === "number" &&
    typeof s.nonce === "string" &&
    (s.returnTo === undefined || typeof s.returnTo === "string") &&
    (s.orgId === undefined || typeof s.orgId === "string") &&
    (s.accountType === undefined || (typeof s.accountType === "string" && ACCOUNT_TYPES.includes(s.accountType))) &&
    (s.clientRef === undefined || typeof s.clientRef === "string") &&
    (s.codeVerifier === undefined || typeof s.codeVerifier === "string") &&
    (s.consentLinkId === undefined || typeof s.consentLinkId === "string") &&
    (s.sessionVersion === undefined || (Number.isInteger(s.sessionVersion) && s.sessionVersion >= 0))
  );
}

export function sealOAuthState(
  state: Omit<OAuthState, "issuedAt" | "nonce"> & { issuedAt?: number; nonce?: string },
  opts: { secret: string; now?: () => number } = { secret: "" },
): Promise<string> {
  if (!opts.secret) throw new Error("OAuth state secret required");
  return mintSignedPayload(
    {
      ...state,
      issuedAt: state.issuedAt ?? (opts.now ?? Date.now)(),
      nonce: state.nonce ?? randomUUID(),
    },
    opts.secret,
  );
}

export async function openOAuthState(
  sealed: string,
  opts: { secret: string; now?: () => number; maxAgeMs?: number },
): Promise<OAuthState> {
  if (!opts.secret) throw new Error("OAuth state secret required");
  const parsed = await verifySignedPayload(sealed, opts.secret);
  if (!isOAuthState(parsed)) throw new Error("invalid OAuth state");
  const now = (opts.now ?? Date.now)();
  const maxAgeMs = opts.maxAgeMs ?? 10 * 60_000;
  if (parsed.issuedAt > now + 60_000 || now - parsed.issuedAt > maxAgeMs) {
    throw new Error("expired OAuth state");
  }
  return parsed;
}

export function scopesFor(p: OAuthProviderConfig, client: ResolvedClient): string[] {
  return client.scopes ?? p.scopes;
}

export function authorizeUrl(
  provider: string,
  opts: {
    redirectUri: string;
    state: string;
    client: ResolvedClient;
    accountType?: AccountType;
    codeChallenge?: string;
    providerConfig?: OAuthProviderConfig;
  },
): string {
  const p = opts.providerConfig ?? PROVIDERS[provider];
  if (!p) throw new Error(`unknown OAuth provider: ${provider}`);
  const accountType = opts.accountType ?? "default";
  const scopes = scopesFor(p, opts.client);
  const q = new URLSearchParams({
    client_id: opts.client.id,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    state: opts.state,
  });
  if (opts.codeChallenge) {
    q.set("code_challenge", opts.codeChallenge);
    q.set("code_challenge_method", "S256");
  }
  if (p.resource) q.set("resource", p.resource);
  if (scopes.length) q.set(p.scopeParam ?? "scope", scopes.join(" "));
  for (const [k, v] of Object.entries(p.authParams ?? {})) q.set(k, v);
  if (accountType === "company" && opts.client.hostedDomain) q.set("hd", opts.client.hostedDomain);
  const url = new URL(opts.client.authUrl ?? p.authUrl);
  for (const [key, value] of q) url.searchParams.set(key, value);
  return url.toString();
}

export async function exchangeCode(
  provider: string,
  code: string,
  redirectUri: string,
  opts: {
    client: ResolvedClient;
    fetchImpl?: FetchLike;
    now?: number;
    accountType?: AccountType;
    codeVerifier?: string;
    providerConfig?: OAuthProviderConfig;
  },
): Promise<{ hosts: string[]; token: OAuthToken }> {
  const p = opts.providerConfig ?? PROVIDERS[provider];
  if (!p) throw new Error(`unknown OAuth provider: ${provider}`);
  const adapter = p.exchange ?? defaultExchange;
  return adapter({
    provider: p,
    client: opts.client,
    code,
    redirectUri,
    fetchImpl: opts.fetchImpl ?? (isDynamicOAuthProvider(provider, p) ? fetchPublicMcpJson : realFetch),
    now: opts.now ?? Date.now(),
    ...(opts.accountType ? { accountType: opts.accountType } : {}),
    ...(opts.codeVerifier ? { codeVerifier: opts.codeVerifier } : {}),
  });
}

function providerForHost(
  host: string,
  providers: Record<string, OAuthProviderConfig>,
): { name: string; config: OAuthProviderConfig } | null {
  for (const [name, config] of Object.entries(providers)) {
    if (config.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return { name, config };
  }
  return null;
}

export function makeRefresh(opts: {
  resolveClient: OAuthClientResolver;
  mcpServers?: Pick<McpServerStore, "list">;
  publicUrl?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}): OAuthRefresh {
  return async (host, token, ctx) => {
    const match = providerForHost(host, await oauthProviders(opts.mcpServers, opts.publicUrl));
    if (!match) throw new Error(`cannot refresh ${host} (unknown provider)`);
    if (match.config.refresh === null) throw new Error(`${match.name} tokens do not refresh — reconnect`);
    if (!token.refreshToken) throw new Error(`cannot refresh ${host} (no refresh token)`);
    const accountType = (ctx?.accountType ?? token.accountType) as AccountType | undefined;
    const client = isDynamicOAuthProvider(match.name, match.config)
      ? await resolveMcpOAuthClient(match.name, match.config, {
          redirectUri: "",
          clientRef: ctx?.clientRef ?? token.clientRef,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        })
      : await opts.resolveClient(match.name, accountType ? { accountType } : {});
    const adapter = match.config.refresh ?? defaultRefresh;
    const fresh = await adapter({
      provider: match.config,
      client,
      token,
      redirectUri: "",
      fetchImpl: opts.fetchImpl ?? (isDynamicOAuthProvider(match.name, match.config) ? fetchPublicMcpJson : realFetch),
      now: (opts.now ?? Date.now)(),
      ...(accountType ? { accountType } : {}),
    });
    if (!fresh.accessToken) throw new Error(`${match.name} token refresh returned an empty access token`);
    return fresh;
  };
}
