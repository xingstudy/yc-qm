# MCP connector credentials

Administrators register HTTP MCP servers through `PUT /v1/admin/mcp-servers/:id`.
Registration controls the outbound destination and the tools available to agents.

Choose the authentication mode in the MCP servers admin page:

| Mode                 | Administrator configures                   | Each user does                         |
| -------------------- | ------------------------------------------ | -------------------------------------- |
| `none`               | Server URL                                 | Uses the shared tools directly         |
| `bearer`             | Shared token, optional token header/prefix | Uses the organization's account        |
| `client-credentials` | Existing service client credentials        | Uses the organization's account        |
| `user-token`         | Optional token header/prefix               | Saves their own token in Keychain      |
| `user-oauth`         | Optional OAuth application settings        | Connects their own account in Keychain |

For example, Trello uses per-user OAuth:

```json
{
  "name": "Trello",
  "url": "https://mcp.trello.com/v1",
  "auth": "user-oauth",
  "readOnly": false,
  "enabled": true
}
```

Save this as `/v1/admin/mcp-servers/trello`, or use the MCP servers admin page.
Each person then opens Keychain and connects Trello using their own account.
QM discovers the authorization and token endpoints and supported scopes, and
stores and refreshes each user's encrypted tokens. Adding
another compatible server requires configuration only; no provider code is needed.
The server name appears automatically in Keychain. OAuth endpoints must use public
HTTPS addresses; redirects and private network destinations are rejected.

Tokens and OAuth client references are bound to the server ID and URL. Changing
the URL requires reconnecting, even when the new URL has the same hostname.
Existing Atlassian connections retain their previous token slot and client references.
Disabling or removing a configured server stops new connections and token refresh
for that server. Changing a generic server's OAuth application or settings also
requires reconnecting.
Per-user OAuth requires persistent keychain encryption (`CONNECTOR_SECRET_KEY`).

OAuth application selection uses the administrator's pre-registered `clientId`
first. Without one, QM uses a client metadata document when the authorization
server advertises support, then falls back to public dynamic registration (DCR).
Automatic client metadata requires a publicly reachable HTTPS `PUBLIC_WEB_URL`;
the document is served at `/v1/connectors/oauth/mcp-<server-id>/client-metadata`.
Local HTTP deployments can use DCR or a pre-registered application instead.
An administrator can also supply an externally hosted `oauth.clientMetadataUrl`.
The server name and client metadata are public; secrets and tokens are never
included in the metadata document.

For a pre-registered OAuth application, configure `clientId` and, if needed,
`clientSecret`. The secret is encrypted using the existing MCP secret store.
`oauth.tokenEndpointAuthMethod` supports `none`, `client_secret_basic`, and
`client_secret_post`; automatic selection uses a secret method when a secret is
present. Each user still receives their own access and refresh tokens.
Register the callback URL shown in the admin page with the service provider.

Discovery supports resource metadata advertised in a `WWW-Authenticate`
challenge, well-known resource URLs, OAuth authorization server metadata, and
OpenID Connect discovery. If discovery is unavailable, enter both
`oauth.authorizationUrl` and `oauth.tokenUrl` along with a pre-registered
`clientId`. `oauth.scopes` overrides discovered permissions. PKCE S256 and the MCP
resource parameter remain enabled. Provider-specific authentication outside these
flows still requires an adapter; this is not universal support for every protocol.

For token-based services, `tokenHeader` defaults to `Authorization` and
`tokenPrefix` defaults to `Bearer`. For an `X-API-Key` service, set
`tokenHeader: "X-API-Key"` and `tokenPrefix: ""`. These fields work with shared
`bearer` tokens and `user-token` tokens. Personal tokens are encrypted and scoped
to the server and user; the web server supplies the signed-in user's identity.
Replacing an expired personal token is manual.

Local `PORTAL_LOCAL_AUTH_BYPASS=1` uses a fixed development identity. Use actual
individual portal logins when validating multiple users.

`credentialScope` selects the identity used for `tools/call`:

- `shared` (the default for existing and new registrations): all callers use the
  configured `auth`, `bearerToken`, or `clientId` and `clientSecret`.
- `per-user`: each call uses the initiating actor's bearer token from the encrypted
  connector keychain, under `credentialHost` in the selected `credentialAccountType`
  slot (`default`, `personal`, or `company`; defaults to `default`). The
  runtime supplies the actor; tool arguments cannot select another user.

For example:

```json
{
  "name": "Customer tools",
  "url": "https://tools.example.com/mcp",
  "auth": "none",
  "credentialScope": "per-user",
  "credentialHost": "accounts.example.com",
  "readOnly": false,
  "enabled": true
}
```

Per-user mode requires persistent keychain encryption (`CONNECTOR_SECRET_KEY`).
Connect the user's account using an existing QM OAuth connector, or have a trusted
integration save its token through the source-authenticated
`POST /v1/connectors/token` endpoint with `host`, `principalId`, `accessToken`, and
optional `expiresAt` (Unix milliseconds). Supported OAuth providers can also store
and refresh a `refreshToken`. For `auth: "none"`, `"bearer"`, or
`"client-credentials"`, this mode does not perform OAuth discovery or interactive login. An unsupported provider must manage token renewal
in its integration; do not store a refresh token that QM cannot refresh.

Missing, expired, revoked, or unrefreshable user credentials fail the call with a
connection-required message. Per-user MCP calls do not use operator environment
tokens, organization credentials, another user's account, or the shared discovery
credential as fallback. Tokens are resolved again for every call rather than
cached across users. Triggered work uses its existing initiating actor identity.

Tool discovery (`tools/list`, including registration probes) remains connector-wide
and uses the configured `auth`. In per-user mode those credentials are only for
catalog discovery. The server must expose a common, non-sensitive catalog and
check each caller's permissions when executing a tool. A public catalog can use
`auth: "none"`; a private catalog can use a dedicated shared discovery credential.
Do not put user-specific data into names, descriptions, or schemas.

`credentialHost` explicitly authorizes sending that connector's user token to the
registered server. Only register a trusted service permitted to receive those
tokens. Per-user endpoints require HTTPS, except on loopback for local development.
HTTP redirects are rejected for every MCP authentication mode. Updating an endpoint
or credential host is an administrative trust decision. Tool call auditing records
the initiating actor as before; authentication does not expand the audience allowed
to receive the result.
