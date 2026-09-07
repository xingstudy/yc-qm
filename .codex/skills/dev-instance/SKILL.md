---
name: dev-instance
description: Start, inspect, or stop this worktree's local QM stack for end-to-end QA. Use when requested or when cross-service behavior needs live validation.
---

# Dev instance

Run from the repository root. Check `status` and reuse a healthy instance serving
this worktree. Choose the surface being tested:

```bash
bash scripts/dev-instance.sh status
bash scripts/dev-instance.sh up --no-slack
bash scripts/dev-instance.sh up
```

`up --no-slack` serves Web/admin/portal without a Slack app. Plain `up` also connects
a bot from this machine's pool. Use the printed portal URL and Slack handle.
Slack QA uses Firefox in the configured workspace.

## Prerequisites

- Use local Docker for the sandbox and default dev Postgres. Build a missing or
  stale sandbox image with `npm run sandbox:local:build`. Cloud backends are for
  testing that provider's path, selected with `--sandbox <backend>`.
- The launcher reads exported env, `~/.config/qm/dev.env`, login-shell model
  credentials, and the worktree `.env`. `DEV_INSTANCE_ADMIN_PRINCIPAL` selects the
  local admin identity. Never use production data or a production `DATABASE_URL`.
- Agent behavior requires a model credential. For a deterministic UI/API wiring
  check without a model, use `DEV_INSTANCE_ALLOW_MOCK=1`; identify the mock in
  results. Missing prerequisites are a QA gap, not a reason for unrelated suites.

## Slack pool

Each running instance needs its own Slack app: shared Socket Mode connections can
split inbound events between instances. Pool files live at
`~/.config/qm/slack-pool/poolN.env` with `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and
`HANDLE`. Create apps from `src/slack/manifest.json`; the app token needs
`connections:write`. Do not borrow another machine's active app.

The launcher handles leases, startup probes, stale-slot recovery, and restarts.
A fresh supervisor heartbeat protects an active slot. For delivery verification,
use a dedicated `CANARY_CHANNEL` or the launcher's eligible test channel; no
eligible channel means delivery is unverified (`--strict` fails in that case).

## Diagnose and finish

```bash
bash scripts/dev-instance.sh doctor --json
bash scripts/dev-instance.sh logs [child] [-f]
bash scripts/dev-instance.sh canary
bash scripts/dev-instance.sh restart [child]
bash scripts/dev-instance.sh down
```

`up` re-reads env and reloads changed services; `--force` forces a restart and
`--rotate` claims another Slack app. Use `doctor` findings to choose a remedy;
`doctor --fix` can restart children. See `scripts/dev/cli.ts` for available options.

Exercise the affected flow and report its result, portal URL, and log directory.
Stop instances created only for this QA. Leave user-owned instances and instances
requested for manual testing running.
