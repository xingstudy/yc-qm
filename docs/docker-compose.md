# Docker Compose

[`../docker-compose.yaml`](../docker-compose.yaml) runs the local QM service stack:
PostgreSQL, core, Web UI, Admin, Portal, and Nginx. The built-in email authentication
broker is available through the optional `auth` profile.

## Topology

Nginx is the public edge and forwards every request to Portal. Portal owns browser
authentication, session validation, Admin authorization, request-header filtering, and
signed identity propagation. It routes `/` to Web UI and `/admin/` to Admin. Nginx must
not route browsers directly to Web UI, Admin, or core.

Each application listens on port 8080 inside the Compose network. The default host
ports are:

| Service | Host port | Purpose                     |
| ------- | --------: | --------------------------- |
| Nginx   |      8088 | Browser entry point         |
| core    |      8080 | Private API diagnostics     |
| Admin   |      8090 | Direct diagnostics          |
| Web UI  |      8096 | Direct diagnostics          |
| Portal  |      8097 | Direct diagnostics          |
| auth    |      8099 | Optional broker diagnostics |

Set `QM_BIND_ADDRESS` for Nginx, `QM_INTERNAL_BIND_ADDRESS` for diagnostic ports, and
the corresponding `QM_*_PORT` variables to change these bindings. Keep
`QM_INTERNAL_BIND_ADDRESS=127.0.0.1` whenever localhost login bypass is enabled.
Production deployments should remove or firewall the direct service port bindings and
expose only Nginx. Direct Web UI and Admin ports are not browser login entry points
because those services require the signed identity produced by Portal.

Portal and Nginx refuse to start if localhost login bypass is enabled while the relevant
bind address is non-loopback. In that mode Nginx selects its loopback-only development
configuration. Disable the bypass and configure OIDC before publishing the edge on a
non-loopback address; Nginx then selects the production configuration, which never
derives identity from the request Host header.

## Start the stack

Copy the environment template and generate a distinct value for every required secret:

```bash
cp .env.example .env
openssl rand -hex 32
```

Set `POSTGRES_PASSWORD`, `CONNECTOR_SECRET_KEY`, `CORE_SIGNING_SECRET`,
`CAPABILITY_SECRET`, `PORTAL_IDENTITY_SECRET`, and `PORTAL_SESSION_SECRET` in `.env`.
The four authentication secrets must be distinct.

```bash
docker compose up --build --wait
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8088/healthz
```

Open `http://localhost:8088/`. Local development defaults to Portal's localhost-only
login bypass as `dev-admin`. Set `ADMIN_GRANTS=dev-admin:org_admin` before the first
boot of a new database if that principal should administer the instance.

The named `postgres-data` and `core-data` volumes survive `docker compose down`.
`docker compose down -v` deletes both volumes and the durable local data they contain.

## Production authentication

Set `NODE_ENV=production`, `PORTAL_LOCAL_AUTH_BYPASS=0`, an HTTPS
`PORTAL_PUBLIC_URL`, and the Portal OIDC variables. Portal refuses to start in production
with missing or placeholder secrets, insecure endpoints, or no configured identity
boundary.

The optional built-in email broker requires its full `AUTH_*` configuration and either
Resend or SMTP credentials. Enable it with:

```bash
docker compose --profile auth up --build --wait
```

Give `auth` the issuer `${PORTAL_PUBLIC_URL}/idp`, configure Portal's broker upstream as
`http://qm-auth.internal:8080`, and use the broker's private token, userinfo, and JWKS
URLs. The browser-facing authorize endpoint remains under Portal's `/idp` path.

## Nginx and TLS

[`../deploy/nginx/nginx.conf`](../deploy/nginx/nginx.conf) preserves the request path,
supports streaming and WebSocket upgrades, and forwards trusted proxy headers to
Portal. It listens on port 8080 inside its container. The Compose mapping publishes it
on host port 8088 by default.

The checked-in configuration is the HTTP application edge. For Internet production,
terminate TLS in a load balancer before Nginx or provide an organization-managed TLS
server block and certificate lifecycle. Keep `PORTAL_XFF_TRUSTED_HOPS` aligned with the
actual number of trusted proxies.

## Sandbox and operations

The Compose stack does not mount the Docker daemon socket into core. Do not add a raw
`/var/run/docker.sock` mount: it grants near-root control of the host. Configure a
supported isolated sandbox before enabling real agent command execution.

Operate the stack with:

```bash
docker compose ps
docker compose logs --tail=200 core portal nginx
docker compose down
```

A production installation additionally needs tested database backups, external secret
management, monitoring, resource limits, and a supported isolated sandbox. Fly and AWS
deployments already provide their own managed edge and do not need this Nginx service.
