---
name: deploy-qm
description: Deploy this source fork to Fly.io or AWS using its in-tree CLI and organization layer when deployment is requested. Not for local feature validation; use dev-instance for local QA.
---

# Deploy QM

Read [`../../../deployment.md`](../../../deployment.md) for deployment acceptance
and only the selected provider reference. Its commands target a standalone package
consumer. In this source checkout, run from the repository root with these mappings:

| Operation              | Source-fork command                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| Initialize a new layer | `node cli/bin/qm.ts init deploy/layers/<org> --org <slug> --target <fly-or-aws> --model-provider <provider>` |
| Interactive setup      | `node cli/bin/qm.ts setup deploy/layers/<org>`                                                               |
| Validate config        | `node cli/bin/qm.ts check --config deploy/layers/<org>/qm.config.jsonc`                                      |
| Deploy this fork       | `node cli/bin/qm.ts up --build-from=. --config deploy/layers/<org>/qm.config.jsonc`                          |
| Live release gate      | `node cli/bin/qm.ts check --live --config deploy/layers/<org>/qm.config.jsonc`                               |

Keep `--build-from=.` on repeat deployments, including the idempotency check; plain
`up` can use package images that omit downstream code. `init` and `setup` take a
directory, not `--config`. Other config-based commands (plan, status, logs, secrets,
infra, rollback) use the layer's `--config`; inspect CLI help for other commands.
For the authorized non-interactive AWS `up` step, also pass `--yes` as its provider
reference requires.
Resolve runbook `.env`, manifests, and `infra/` paths inside `deploy/layers/<org>/`,
not the repository root. Never initialize over an existing layer.

Do not replace downstream code with the public npm package. Generated standalone
deployment directories outside this source checkout use their installed CLI and
generated skill. Read `references/slack.md` only when Slack is requested.

A deployment needs a base model key and a way for people to sign in. Collect
both in the same pass. The base model provider is a deployment choice recorded
as `modelProvider`, not a setting to leave for the Admin page. Sign-in is either
the built-in `auth` broker, which needs an email transport, or an external OIDC
provider such as Slack, which needs no email at all — read `references/email.md`
only once the operator has chosen the broker.

A documentation or configuration edit alone does not request a deployment. For an
authorized deployment, complete every acceptance check
and return the handoff required by `deployment.md`. Treat `qm check --live` and
its private live session canary as the automated release gate; still complete
the administrator's manual sign-in and web acceptance check.
