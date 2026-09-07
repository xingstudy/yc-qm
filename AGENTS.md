# qm

## Repository boundaries

This is the `xingstudy/yc-qm` downstream fork. Check `git remote -v` before remote
operations; changes, commits, and PRs belong to its `origin`, never upstream qm.
Core may diverge from upstream. Keep organization deployment data in
`deploy/layers/<org>/`. Sync upstream only when requested, using a merge, not rebase.
Use `--repo` for repository-scoped `gh` commands: this clone's upstream remote can
otherwise select the wrong repository. Do not mention upstream issue/PR numbers in
GitHub content; those mentions expose fork activity through public backlinks.

`CLAUDE.md` and `.claude/skills/` link to their canonical files. Edit the targets.
`skills-seed/`, onboarding skills, and deployment templates are product assets,
not developer instructions. Historical plans are not current task checklists.

## Code constraints

- Fix all instances of the same root cause, preferably at the shared layer.
  Search callers across core and plugins; leave unrelated cleanup out of the diff.
- Do not add code comments, docblocks, suppression directives, or commented-out
  code. Shebangs are allowed. Do not strip unrelated existing comments.
- Plugins are separate packages and must not import core. Shared plugin/core
  plumbing belongs in `plugins/chassis`, imported by relative path; chassis must
  not import core. Existing core helpers live in `src/util/{errors,async,sweeper}.ts`,
  `src/sandbox/process-poll.ts`, and `src/memory/notebook.ts`.
- Core runs blue-green and multi-instance. Logs, audit, queues, and resolved config
  must persist in Postgres. RAM is only a cache or disposable, re-derivable state.
- Preserve existing encrypted IM/Bot credentials when changing secret handling;
  do not rotate root keys or bypass audit/release gates to make validation pass.

## Validation

Run checks covering the changed behavior and its callers. Small changes do not
require full suites. Prose-only edits need format/link/frontmatter checks and any
existing tests that consume those assets, not application builds or typechecks.
For code changes, run affected tests, lint changed code, and typecheck the owning
TS project. Add regression coverage for bugs. Shared/auth/migration changes need
consumer and failure-path coverage even when the diff is one line.

Full local suites are for an explicit request or cross-cutting impact that remains
unbounded after tracing consumers; explain that reason first. Otherwise CI is the
full gate. Once relevant checks pass, repeat only checks invalidated by edits or
new failures. Report skipped checks and environment failures accurately.

Use the package's required Node/npm versions. In WSL, `type -a node npm` detects
Windows npm accidentally running CMD. Plugins have separate lockfiles; install
only needed dependencies. Preserve the owning test script's flags, environment,
and working directory when selecting files. Do not append a file to `npm test`:
its existing wildcard can still run the whole package. Examples from the root:

```bash
node --experimental-test-module-mocks --test test/skill-conformance.test.ts
node --test --test-name-pattern='<affected case regex>' cli/test/aws.test.ts
node node_modules/prettier/bin/prettier.cjs --check <changed-files>
node node_modules/eslint/bin/eslint.js <changed-code-files>
npm --prefix plugins/web-ui run typecheck
```

Use project typechecks, not `tsc <individual-files>`, which bypasses tsconfig.
Confirm filtered tests actually ran. Postgres tests require a dedicated test DB.

## QA and merging

Verify visible changes in the affected page/preview. For non-trivial cross-service
behavior, use `dev-instance` before a PR: `--no-slack` for Web/admin/portal; Firefox
in the configured workspace for Slack. Real model behavior needs a real model;
label mocked wiring checks. Reuse a preview or screenshot for visible PR changes.

Before merging to `main`, get an independent review from an agent that did not
author the change, or `/code-review` when available. One focused reviewer suffices
for narrow changes; auth, migrations, concurrency, shared control flow, and public
contracts need deeper review. Resolve findings before merging; CI is not review.
