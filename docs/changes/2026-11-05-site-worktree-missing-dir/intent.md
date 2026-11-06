---
change: 2026-11-05-site-worktree-missing-dir
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: a missing astgl-site worktree fails with an error that names it

## Problem

Every git call in `src/site-worktree.ts` runs with `cwd` set to the astgl-site worktree.
When that directory does not exist, Node reports the failed spawn as
`spawnSync git ENOENT` with `path: 'git'`, which reads as "git is not installed".

On 2026-11-05 James ran 18 `rewrite-backlog --keep` commands. Each one failed this way
because `.env` does not set `ASTGL_SITE_WORKTREE` and the default `.rewrite-site/` had
never been created. Git was on the PATH the whole time. Finding the cause took a
database check, the code, and `which git`.

There is a second, quieter form of the same fault. `gitSucceeds` turns any failure into
`false`, so `resolveJob` against a missing directory finds no branch and no page and
returns `rejected`. That would close an open review with the rejection cooldown. Today
the queue fetches first, which throws, so this is latent rather than live.

## Outcome

- Any site-worktree operation against a missing directory throws an error that names
  the directory and says how to fix it (`ASTGL_SITE_WORKTREE`, or create the worktree).
- `resolveJob` never reports `rejected`, `open` or anything else for a missing
  directory; it throws.
- Behavior against an existing worktree is unchanged.

## Acceptance

James approved this fix in conversation on 2026-11-05 ("Yes, fix it here").
