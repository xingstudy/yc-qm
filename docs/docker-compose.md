# Docker Compose

## Pull-only production stack

[`../compose.production.yaml`](../compose.production.yaml) is the production-oriented,
single-host Compose entry point. Unlike this source-build reference stack, it contains no
`build:` entries or source mounts: a production host only downloads the release files and
the Docker Hub images. It does not need Node.js, npm, or this repository checkout.

Use `../.env.production.example` only as a complete, anonymous configuration reference.
Every key has an example value so operators can see expected formats, but examples are
intentionally unsafe for deployment. Run `../scripts/init-production-env.sh` once to
write `.env.production` with fresh replacement secrets, a private JWK, and the detected
`DOCKER_GID`; then replace the public URL, administrator, identity boundary, mail
transport, and model-provider values. Do not copy credentials between installations.

`../images.production.env` selects the release. Its `QM_CORE_IMAGE`,
`QM_WEB_UI_IMAGE`, `QM_ADMIN_IMAGE`, `QM_PORTAL_IMAGE`, `QM_AUTH_IMAGE`,
`QM_EDGE_IMAGE`, and `QM_SANDBOX_IMAGE` default to the `xingstudy` Docker Hub namespace
and must remain fixed at `@sha256:` digests. A tag, including `latest`, is not a release
identifier. `QM_SANDBOX_IMAGE` must reference the published local-sandbox runtime image,
not its base image.

```bash
docker login
docker compose --env-file .env.production -f compose.production.yaml --profile auth config --quiet
docker compose --env-file .env.production -f compose.production.yaml --profile auth pull
docker compose --env-file .env.production -f compose.production.yaml --profile auth up -d --wait --pull always
docker compose --env-file .env.production -f compose.production.yaml ps
curl -fsS https://your-qm.example/healthz
```

Production health is not complete until an allowed user signs in through the TLS edge,
runs a real Agent turn, and the core creates a local sandbox from the pinned image. Check
the configured model and each required connector as part of the same acceptance test.

Back up and restore-test Postgres, `core-data`, and each `qm-home-*` volume before any
upgrade. Keep the corresponding configuration and generated signing/encryption values in
the protected backup. Use a matched prior `images.production.env` and configuration for
rollback; restore durable data as well if the target release is not data-compatible.
Avoid `docker compose down -v`, which deletes Compose-managed durable volumes.

The pull-only stack is still single-host. Its edge must be behind TLS termination; direct
service ports and Postgres stay private. Firewall core's host-networked 8080 port,
configure `PORTAL_XFF_TRUSTED_HOPS` for the actual trusted proxy chain, and never run the
host Docker socket mount on a shared or untrusted host. The socket gives core near-root
host control. Add firewall policy, secret management, restore drills, monitoring,
alerting, log rotation, resource limits, and sandbox isolation before Internet exposure.
Any exposed credential must be rotated before launch, including database, mail,
OIDC/OAuth, private JWK, signing/session/token, and model-provider credentials. A
database-role change and a connector-encryption-key migration require explicit plans.

## Source-build development stack

[`../docker-compose.yaml`](../docker-compose.yaml) runs the local QM service stack:
PostgreSQL, core, Web UI, Admin, Portal, and Nginx. The built-in email authentication
broker is available through the optional `auth` profile.

## Topology

Nginx is the public edge and forwards every request to Portal. Portal owns browser
authentication, session validation, Admin authorization, request-header filtering, and
signed identity propagation. It routes `/` to Web UI and `/admin/` to Admin. Nginx must
not route browsers directly to Web UI, Admin, or core.

Each application listens on port 8080 inside the Compose network, except core, which
runs with `network_mode: host` so it can reach the per-scope sandbox containers on their
host-published loopback ports. The default host ports are:

| Service  | Host port | Purpose                                                 |
| -------- | --------: | ------------------------------------------------------- |
| Nginx    |      8088 | Browser entry point                                     |
| core     |      8080 | Private API diagnostics                                 |
| Admin    |      8090 | Direct diagnostics                                      |
| Web UI   |      8096 | Direct diagnostics                                      |
| Portal   |      8097 | Direct diagnostics                                      |
| auth     |      8099 | Optional broker diagnostics                             |
| Postgres |      5432 | Loopback only, for core's host-networked `DATABASE_URL` |

Set `QM_BIND_ADDRESS` for Nginx, `QM_INTERNAL_BIND_ADDRESS` for diagnostic ports, and
the corresponding `QM_*_PORT` variables to change these bindings. Keep
`QM_INTERNAL_BIND_ADDRESS=127.0.0.1` whenever localhost login bypass is enabled.
Production deployments should remove or firewall the direct service port bindings and
expose only Nginx. Direct Web UI and Admin ports are not browser login entry points
because those services require the signed identity produced by Portal.

Core is the exception to that loopback posture: host networking binds its API to port
8080 on every host interface — sandbox containers reach it through the bridge gateway,
so it cannot be loopback-only. Firewall 8080 (and keep 5432 on loopback) on any machine
with untrusted LAN peers. This reference stack is supported only on Linux or WSL2,
regardless of host-network feature availability on other platforms.

Portal and Nginx refuse to start if localhost login bypass is enabled while the relevant
bind address is non-loopback. In that mode Nginx selects its loopback-only development
configuration. Disable the bypass and configure OIDC before publishing the edge on a
non-loopback address; Nginx then selects the production configuration, which never
derives identity from the request Host header.

## Start the stack

Copy the environment template and generate a distinct value for every required secret:

```bash
cp .env.example .env

qm_socket_gid="$(stat -c %g /var/run/docker.sock)"
sed -i "s/^DOCKER_GID=.*/DOCKER_GID=${qm_socket_gid}/" .env

for qm_secret_name in \
  POSTGRES_PASSWORD \
  CONNECTOR_SECRET_KEY \
  CORE_SIGNING_SECRET \
  CAPABILITY_SECRET \
  PORTAL_IDENTITY_SECRET \
  PORTAL_SESSION_SECRET \
  SKILL_SIGNING_SECRET
do
  qm_secret_value="$(openssl rand -hex 32)"
  sed -i "s/^${qm_secret_name}=.*/${qm_secret_name}=${qm_secret_value}/" .env
done
```

Set `POSTGRES_PASSWORD`, `CONNECTOR_SECRET_KEY`, `CORE_SIGNING_SECRET`,
`CAPABILITY_SECRET`, `PORTAL_IDENTITY_SECRET`, `PORTAL_SESSION_SECRET`, and
`SKILL_SIGNING_SECRET` in `.env`. The generated signing and encryption secrets must be
distinct. Compose requires `DOCKER_GID` while resolving its configuration, so set it
before the first `docker compose` command.

```bash
npm ci
npm run sandbox:local:build
docker compose config --quiet
docker compose up -d --build --wait
curl -fsS http://127.0.0.1:8080/healthz
curl -fsS http://127.0.0.1:8088/healthz
```

Open `http://localhost:8088/`. Local development defaults to Portal's localhost-only
login bypass as `dev-admin`. Set `ADMIN_GRANTS=dev-admin:org_admin` before the first
boot of a new database if that principal should administer the instance.

The named `postgres-data` and `core-data` volumes survive `docker compose down`.
`docker compose down -v` deletes both of those volumes, but it does not delete the
per-scope `qm-home-*` volumes created by the local sandbox backend.

## Production authentication

Set `NODE_ENV=production`, `PORTAL_LOCAL_AUTH_BYPASS=0`, an HTTPS
`PORTAL_PUBLIC_URL`, and the Portal OIDC variables. Portal refuses to start in production
with missing or placeholder secrets, insecure endpoints, or no configured identity
boundary. Set `OIDC_ALLOWED_EMAIL_DOMAIN`, `OIDC_ALLOWED_EMAILS`, or
`PORTAL_EXPECTED_TEAM_ID` to constrain that boundary to an email domain, explicit email
list, or Slack workspace.

The optional built-in email broker requires its full `AUTH_*` configuration and either
Resend or SMTP credentials. Enable it with:

```bash
docker compose --profile auth up -d --build --wait
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

The Compose stack runs the local sandbox backend: core mounts the host Docker daemon
socket and spawns one `qm-sandbox-local` container per scope, reaching each on the host's
loopback (core uses `network_mode: host`; sandbox agent URLs inside those containers
resolve `host.docker.internal`). The socket mount grants core near-root control of the
host — appropriate for a single-tenant machine, not a shared one. Build the sandbox image
before the first agent turn and after updating sandbox sources:

```bash
npm run sandbox:local:build
```

The script runs the two Docker builds defined in `scripts/local-sandbox-build.sh`.

`DOCKER_GID` in `.env` must match the socket's group id (`stat -c %g
/var/run/docker.sock`) so the unprivileged core process can open it. The start procedure
above sets it before Compose validates the file.

Operate the stack with:

```bash
docker compose ps
docker compose logs --tail=200 core portal nginx
docker compose down
```

`--wait` and `/healthz` are liveness checks, not end-to-end readiness checks. Verify a
real browser sign-in, agent turn, sandbox creation, model call, and any required connector
before relying on the deployment.

After checking out an approved source revision, take a tested backup and rebuild both the
sandbox and application images:

```bash
npm ci
npm run sandbox:local:build
docker compose up -d --build --wait
```

Durable state spans the `postgres-data` and `core-data` Compose volumes plus per-scope
`qm-home-*` Docker volumes created by the local sandbox backend. A recovery plan must
cover all three stores and the encryption/signing secrets required to use them. Compose
does not provide database rollback, high availability, or zero-downtime rollout.

A production installation additionally needs tested database backups, external secret
management, monitoring, resource limits, and a supported isolated sandbox. Fly and AWS
deployments already provide their own managed edge and do not need this Nginx service.
