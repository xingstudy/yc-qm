# Docker Compose

## Pull-only production stack

[`../compose.production.yaml`](../compose.production.yaml) is the production-oriented,
single-host Compose entry point. Unlike this source-build reference stack, it contains no
`build:` entries or source mounts: a production host only downloads the release files and
the Docker Hub images. The built-in `auth` service is required, not a Compose profile. It
does not need Node.js, npm, or this repository checkout. Production images are Linux
`amd64`/`x86_64` only.

Use `../.env.production.example` only as a complete, anonymous configuration reference.
Every key has an example value so operators can see expected formats, but examples are
intentionally unsafe for deployment. From a source checkout, run
`./scripts/init-production-env.sh .env.production prod-vMAJOR.MINOR.PATCH` once to
write `.env.production` with fresh replacement secrets, a private JWK, and the detected
`DOCKER_GID`; then replace the public URL, administrator, identity boundary, mail
transport, and model-provider values. Never rerun the initializer for an existing
deployment.

`QM_RELEASE_TAG=prod-vMAJOR.MINOR.PATCH` selects a GitHub Release. The versioned deployer
verifies that release and its seven image signatures, stores the exact `@sha256` lock
under `.releases/<tag>/`, and makes Compose run those digests rather than mutable tags.
`QM_POSTGRES_VOLUME` and `QM_CORE_VOLUME` are literal Docker volume names; they preserve
data routing even when the working directory or Compose project changes.

Download the Compose file, initializer, deployer, configuration template, image manifests,
`SHA256SUMS`, and its Sigstore bundle from the same GitHub Release. Verify the bundle and
checksums before executing the downloaded initializer or deployer. The verified deployer
then validates every image signature before it invokes Compose with production secrets.
The release configuration asset is named
`default.env.production.example`; the initializer accepts that release name and the
checked-in `.env.production.example` name. Do not combine files from different releases.

`release-production-images.yml` is separate from the existing Release and CLI workflows.
It publishes only from `main` when the input matches `prod-vMAJOR.MINOR.PATCH`. Protect
matching Git tags from updates and deletion, enable
matching immutable-tag rules in every Docker Hub repository, and give an exclusive
`DOCKERHUB_TOKEN` only the required push access. Store it only as a secret in the
`production-images` GitHub Environment, require reviewer approval, restrict deployments
to `main`, and limit allowed reviewers. Create
`lijixing/qm-production-staging` as a private candidate repository, remove expired build
tags after the 30-day recovery window, and never deploy from it. If a run fails after
partial promotion, dispatch with that failed run's `resume_run_id` while its
30-day artifacts remain available. Preserve each generated digest manifest as the
immutable release and rollback record.

```bash
cosign verify-blob \
  --bundle SHA256SUMS.bundle \
  --certificate-identity='https://github.com/xingstudy/yc-qm/.github/workflows/release-production-images.yml@refs/heads/main' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  SHA256SUMS
sha256sum -c SHA256SUMS
./scripts/deploy-production-release.sh
curl -fsS http://127.0.0.1:8088/healthz
```

Public release images do not require `docker login`. Use a deployment-only, read-only
pull token only when a repository is private, registry policy requires identity, or the
host reaches Docker Hub's anonymous limit. The `sandbox-image` one-shot service ensures
that Compose pulls the selected `sandbox-local` image before core starts.

Production health is not complete until an allowed user signs in through the TLS edge,
runs a real Agent turn, and the core creates a local sandbox from the pinned image. Check
the configured model and each required connector as part of the same acceptance test.

Back up and restore-test Postgres, `core-data`, and each `qm-home-*` volume before any
upgrade. Keep the corresponding configuration and generated signing/encryption values in
the protected backup. For a release whose notes do not change the Compose or configuration
contract, update only `QM_RELEASE_TAG` in the existing `.env.production`, rerun the
versioned deployer, and repeat the acceptance checks. Do not regenerate the file or
replace durable secrets, project identity, or volume names. The deployer obtains the
release-specific Compose file and digest lock and removes same-project services absent
from the selected release. Compare the new template and add only
required keys when release notes change the configuration contract. Restore the previous
tag for a data-compatible rollback; restore durable data as well when the target release
is not data-compatible. Avoid
`docker compose down -v`, which deletes Compose-managed durable volumes.

The published `prod-v0.7.1` bundle predates the versioned deployer and has an inconsistent
hidden-template asset name. Do not use it for this first-install procedure; publish a
later production release with the updated workflow.

## Migrating the source-build stack

At this revision both stacks use PostgreSQL 18 with
`postgres-data:/var/lib/postgresql` and mount `core-data:/data`. The logical names alone
do not prove reuse: Compose normally creates
`<project>_postgres-data` and `<project>_core-data`. Resolve the old project and actual
mount names from the running containers before stopping them. Set the target release as
`QM_RELEASE_TAG`, the project as `QM_COMPOSE_PROJECT`, the Postgres mount name as `QM_POSTGRES_VOLUME`, and the core mount
name as `QM_CORE_VOLUME`. These explicit names are not redirected by
`COMPOSE_PROJECT_NAME`, `-p`, or a different working directory. Keep the production
environment file at mode `0600`.

Preserve the old `POSTGRES_USER`, `POSTGRES_DB`, database role password, `ORG_ID`,
`CONNECTOR_SECRET_KEY`, `CORE_SIGNING_SECRET`, `CAPABILITY_SECRET`,
`PORTAL_IDENTITY_SECRET`, `PORTAL_SESSION_SECRET`, `SKILL_SIGNING_SECRET`, and active auth
token, client, and JWK values. PostgreSQL initialization variables do not rotate the role
password in an existing volume, and new encryption keys cannot read existing connector
credentials. Add the production-only HTTPS, auth, SMTP, administrator, and model settings
without replacing these durable values. If the existing database role password is not
hexadecimal, rotate the actual role in a controlled maintenance window and update both
environments; changing the file alone is not a password rotation.

Create and restore-test a PostgreSQL logical backup plus backups of `core-data` and every
global `qm-home-*` sandbox volume. An older PostgreSQL major version or a different data
mount requires a database migration rather than direct volume reuse. Run the deployer
`prepare` action while source is still serving; it verifies and pulls without changing
containers. Only after success, remove the old stack with
`docker compose ... down --remove-orphans` without `-v`, then run the offline `apply`
action. Accept the cutover only after database, browser sign-in, administrator, real
Agent, sandbox, model, and connector checks pass. For a data-compatible source-build
rollback, prebuild the original source revision, run the deployer's offline `down`
action, then start source with the same project, environment, and profiles using
`up -d --wait --no-build --remove-orphans`. Restore the coordinated data backup before
the source start when the production version wrote an incompatible schema or file format.

The pull-only stack is still single-host. Its HTTP edge defaults to
`QM_BIND_ADDRESS=127.0.0.1` and is only for a same-host TLS reverse proxy, never direct
Internet exposure; direct service ports and Postgres stay private.
`PORTAL_XFF_TRUSTED_HOPS=2` represents the external TLS proxy plus the built-in edge.
Firewall core's host-networked 8080 port, and never run the host Docker socket mount on a
shared or untrusted host. The socket gives core near-root
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
