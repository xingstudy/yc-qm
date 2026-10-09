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

## Dependency and system version checks before commit/push

Before committing or pushing, finish the applicable checks above and inspect the
final diff against the CI/CD workflows: [CI](.github/workflows/cicd.yml),
[Postgres pooling](.github/workflows/pgbouncer.yml),
[production images](.github/workflows/release-production-images.yml), and
[package images](.github/workflows/release-package.yml). Keep those workflows as
the source of truth for commands, flags, platforms, and security thresholds.
Do not compile images locally by default; GitHub performs full builds and image
scans. Build locally only when explicitly requested.

For dependency, lockfile, Dockerfile, or release-workflow changes, complete these
version checks before commit/push:

- Verify the active Node/npm satisfy `.node-version` and the owning package's
  `engines`, including the runtime used by Git hooks. Use `npm ci` with each
  affected package's lockfile; do not silently regenerate unrelated lockfiles.
- Check the resolved production dependency tree, not just direct manifest
  versions. Include npm aliases, nested/overridden dependencies, global CLI
  dependencies, npm's bundled packages, Python environments, and pip's vendored
  packages/SBOM. Updating an application dependency does not patch a copy
  bundled inside npm, pip, or another tool.
- Run `npm audit --omit=dev --audit-level=moderate` for affected production npm
  packages, matching the production build gate. Check other affected ecosystems
  and system packages against current official security advisories or a fresh
  vulnerability database. Existing lockfiles, SBOMs, package inventories, and
  binaries may be scanned without rebuilding. Confirm the expected packages
  actually appear in the report; an empty report is not a successful scan.
- Verify pinned base-image tags and SHA256 digests resolve to the intended
  platform (`linux/amd64` for production). Check the base image's OS/package
  versions and known vulnerabilities, plus added apt/apk packages. Runtime
  package refreshes remain mandatory in CD; local version checks cannot predict
  repository updates or new advisories after push.
- Check the compiler used for copied Go binaries such as GitHub CLI and
  wireproxy. A new CLI version or `go get` does not patch its compiled standard
  library. Pin a patched Go builder and its matching digest; check toolchain
  auto-downloads cannot select a vulnerable compiler.
- Trace affected image consumers and synchronize canonical Dockerfiles and
  packaged CLI templates. Verify browser-use/browser-harness dependency pins,
  npm/pip replacement paths, and vendored inventories agree with patched code.
  Run the relevant image/workflow/template regression tests.
- Reject known HIGH/CRITICAL vulnerabilities, including unfixed findings, as
  production CD does. Never weaken audit levels, set `ignore-unfixed: true`,
  add vulnerability ignores, hide stale metadata, or bypass signature/release
  gates to obtain a passing result.

Record checked versions, advisory/database dates, commands, and results in the
PR. If a required version check fails or is unavailable, fix it or report the
specific blocker before commit/push; do not claim it passed. Repeat checks only
when an edit invalidates them. Version checks do not guarantee future GitHub
CI/CD success; full builds and scans remain GitHub's final gate.

## QA and merging

Verify visible changes in the affected page/preview. For non-trivial cross-service
behavior, use `dev-instance` before a PR: `--no-slack` for Web/admin/portal; Firefox
in the configured workspace for Slack. Real model behavior needs a real model;
label mocked wiring checks. Reuse a preview or screenshot for visible PR changes.

Before merging to `main`, get an independent review from an agent that did not
author the change, or `/code-review` when available. One focused reviewer suffices
for narrow changes; auth, migrations, concurrency, shared control flow, and public
contracts need deeper review. Resolve findings before merging; CI is not review.
