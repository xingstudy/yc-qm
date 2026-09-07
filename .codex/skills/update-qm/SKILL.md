---
name: update-qm
description: Merge upstream qm into this fork and open a sync PR when explicitly asked to sync upstream. Not a deployment update.
---

# Update QM

Follow [AGENTS.md](../../../AGENTS.md). This fork intentionally changes core;
merge conflicts are not grounds to discard downstream behavior or send it upstream.

1. Verify remotes and worktree state. Add `https://github.com/yc-software/qm.git`
   as `upstream` if missing, then fetch `origin` and `upstream`. Record both main
   SHAs. If upstream main is already an ancestor of origin main, no sync is needed.
2. Create `codex/sync-upstream-<date>` from `origin/main` in a clean worktree,
   preserving unrelated local work. Run `git merge upstream/main`; never rebase
   published downstream history.
3. Resolve using both histories and affected callers. Preserve fork-specific
   behavior and credential compatibility; record material conflict decisions.
4. Validate the final diff against the recorded origin main SHA under the root
   affected-test policy. A documentation-only sync does not require runtime suites.
5. Commit and push the sync branch to `origin`. Open the fork PR with explicit
   `--repo`, `--base main`, `--head`, and `--body-file`. Include the merged range,
   compatibility decisions, and verification results. Leave merging to review/CI.

When CLI validation, deployment contracts, or layers changed, check affected layers:

```bash
node cli/bin/qm.ts check --config deploy/layers/<org>/qm.config.jsonc
```

This may validate configured credentials with providers. Fix required contract
migrations without deploying or rotating existing credential roots as a side effect.
