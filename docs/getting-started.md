# Deploy QM for an organization

This source fork deploys its downstream changes using the in-tree CLI and an
organization layer under `deploy/layers/<org>/`: config, sandbox customizations,
provider coordinates, and generated Slack manifests. Core may intentionally differ
from upstream. See [organization layers](../deploy/layers/README.md) and the
[source deployment skill](../.codex/skills/deploy-qm/SKILL.md) for command mappings.
Standalone consumers of the published package use the generated deployment skill;
that package workflow does not include this fork's source changes.

For a new layer, the agent first asks the operator for Fly.io or AWS (the slug
is a local name derived from the organization, not globally unique), then runs:

```bash
node cli/bin/qm.ts init deploy/layers/<org> --org <slug> --target <fly-or-aws>
```

Provider choice is part of initialization because it determines the config,
secret rules, generated files, and teardown contract. Changing providers means
initializing a new empty directory. `qm init` materializes `deployment.md` and
`.codex/skills/deploy-qm/`. In this source fork, use the root source deployment skill
to adapt that generated runbook, including `up --build-from=.` on every deployment.
The workflow confirms the
operator-owned account and billing before mutation, configures email-gated web
onboarding first, optionally adds connectors and Slack, performs live checks,
and returns the operational URLs. Sign-in defaults to the built-in `auth`
broker, which emails a one-time link: supply the admin address, a verified
sender, and a Resend key or SMTP credentials, and the CLI generates and wires
everything else. Drop `"auth"` from `services` to use an external identity
provider instead; that provider must then register the exact
`<publicUrl>/auth/callback` redirect.

The installed package carries Fly and AWS provider templates and dispatches
their common lifecycle through the hosting-provider registry. Initialization
does not create deployment CI, and the QM source repository has no production
deployment workflow.
