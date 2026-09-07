---
name: github-gitlab
description: Work with GitHub and GitLab repositories through resident gh/glab/git auth on the agent computer.
requiredCapabilities:
  - egress:github.com
  - egress:api.github.com
  - egress:gitlab.com
---

# GitHub / GitLab

Use this skill when the user asks to inspect repos, issues, pull requests, merge
requests, code history, branches, or to make a small code change in a hosted repo.

This is a resident-machine-auth connector. Prefer the native CLIs (`gh`, `glab`) and
`git`, using the agent computer's logged-in state. Do not ask the user to paste tokens,
and do not rely on proxy bearer-token injection.

One exception: if the system prompt lists a shared org credential for a Git remote, the
token is broker-only and never appears on the computer. For clone/fetch/push, use the
core-hosted smart HTTP remote documented in `skills/use-shared-credential/SKILL.md`.
That keeps normal `git` workflows working while core injects the upstream credential
server-side.

## Logging in

If `gh auth status` (or `glab auth status`) fails, log in with the native command:

```bash
gh auth login
```

The platform recognizes this device-flow login and runs it as a **durable process
session** (ADR 0002): it prints the one-time code + verification URL immediately and keeps
polling on the agent computer across turns — it does not block your turn or die at
teardown. Give the user the code and URL, ask them to approve in the browser, then say
"done". On the next turn, run `gh auth status` (or `gh auth login` again): the platform
reports you're authenticated once approval completes, and the login self-expires if the
user takes too long (just run `gh auth login` again to restart). GitLab is the same with
`glab auth login`.

## Read-only work

Check auth and inspect repo state:

```bash
gh auth status
gh repo view OWNER/REPO --json name,description,url,defaultBranchRef
gh issue list --repo OWNER/REPO --state open --limit 20
gh pr list --repo OWNER/REPO --state open --limit 20
```

For GitLab:

```bash
glab auth status
glab repo view GROUP/PROJECT
glab issue list --repo GROUP/PROJECT
glab mr list --repo GROUP/PROJECT
```

Use `git log`, `git show`, and `git diff` for codebase-change summaries. Cite commit
hashes, PR/MR numbers, and links.

## Checkout and edits

Clone or fetch only the repo the user asked for:

```bash
gh repo clone OWNER/REPO repo
cd repo
git checkout -b codex/small-change
```

Keep changes scoped and read the checkout's applicable instructions. Select tests
covering the changed behavior and its callers, preserving the package runner's
flags and environment. Prose-only changes need document checks; a small code fix
does not automatically need every suite. Run full local suites only when requested
or justified by unbounded cross-cutting impact. If a push or PR/MR is requested,
prepare the branch and summary first.

## Writes require approval

Pushing branches, creating PRs/MRs, merging, closing issues, editing labels, changing
repo settings, releases, or workflows are writes. Ask for approval before running the
write command when that action and target are not already authorized in the
conversation. Do not ask again for an explicitly requested push or PR; approval
for a PR does not authorize a merge or a change to another repository.

After approval:

```bash
git push -u origin codex/small-change
gh pr create --repo OWNER/REPO --title "..." --body-file pr.md
```

For GitLab:

```bash
git push -u origin codex/small-change
glab mr create --repo GROUP/PROJECT --title "..." --description-file mr.md
```

Report the final URL and leave enough context for review.
