# Docker Compose

[`../docker-compose.yaml`](../docker-compose.yaml) runs a single-node local QM baseline: the private
core API and a PostgreSQL 18 database. It is intended for development and evaluation,
not as a complete production topology. The public portal, web UI, admin surface, auth
broker, TLS termination, backups, and monitoring are intentionally outside this file.

## Start it

Requirements: Docker Engine with the Compose plugin and enough disk space to build the
core image. Start with a private environment file:

```bash
cp .env.example .env
openssl rand -hex 32 # use one output for POSTGRES_PASSWORD
openssl rand -hex 32 # use a distinct output for CONNECTOR_SECRET_KEY
docker compose up --build --wait
curl -fsS http://127.0.0.1:8080/healthz
```

Set the two generated values in `.env`. `CONNECTOR_SECRET_KEY` is required whenever QM
uses durable storage. `.env` is ignored by Git; do not commit credentials or provider
keys. The core is bound to `127.0.0.1:8080` by default. Set `QM_BIND_ADDRESS` and
`QM_PORT` only when you intentionally need a different listener.

The Compose defaults are `HARNESS=mock` and `SANDBOX_BACKEND=local`, which allow the
core to start for wiring checks. The file deliberately does **not** provide the Docker
daemon socket or a local sandbox image to the core container. Consequently, command
execution from real agent turns is not available through this baseline. For real turns,
set a configured model harness and use a supported remote sandbox, such as Sprites;
provide its required credentials in `.env`. Do not add a raw `/var/run/docker.sock`
mount as a shortcut: it grants near-root host control to the container.

## Operate it

```bash
docker compose ps
docker compose logs --tail=200 core
docker compose down
```

The named `postgres-data` and `core-data` volumes survive `docker compose down`.
`docker compose down -v` deletes both volumes and the durable local data they contain.

For production, use the project-supported Fly or AWS deployment workflow, or provide
the missing production controls yourself: TLS, a private database with tested backups,
secret management, trusted identity configuration, monitoring, and an isolated sandbox.
