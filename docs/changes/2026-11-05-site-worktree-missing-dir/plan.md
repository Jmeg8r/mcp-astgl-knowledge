---
change: 2026-11-05-site-worktree-missing-dir
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: a missing astgl-site worktree fails with an error that names it

## Files that change

| File | Change |
|---|---|
| `src/site-worktree.ts` | One `requireWorktree(dir)` check before every git spawn: in `git()`, before the `try` in `gitSucceeds()`, and in `readPageAt()`. The commit's own spawn always follows `git(dir, "add", …)`, so it is covered |
| `test/site-worktree.test.ts` | A `missing worktree` group; committed failing first |

## Order of work

1. Failing tests against a directory that does not exist:
   - `fetchSite` throws an error naming the directory and `ASTGL_SITE_WORKTREE`;
   - `listAnswerPages` and `readPageAt` throw the same;
   - `resolveJob` throws instead of returning `rejected`.
   → verify: all fail on `main` (ENOENT text, or `rejected` returned).
2. The `requireWorktree` check. → verify: `npm test`.
3. VERIFY and SHIP: `npx tsc --noEmit`, `npm run build`, a live probe of
   `rewrite-backlog --keep` with `ASTGL_SITE_WORKTREE` pointing at a missing directory,
   Codex review posted verbatim with my PASS/FAIL label outside it, the forge gate with
   `--base origin/main`, `forge-pr create`. Merge on James's OK.

## Risks

- **An extra `existsSync` per git call.** A stat is microseconds next to a process
  spawn. Accepted.
- **A directory that exists but is not a git repository.** Out of scope: git already
  says `not a git repository`, which names the problem.

## Proof

`npm test` passes with the new tests. On `main` they fail with the ENOENT error, and
`resolveJob` returns `rejected`.

## Options not taken

- **Catch `ENOENT` after the spawn and rewrite the message.** It needs the same handling
  at every call site, and `gitSucceeds` would still swallow it.
- **Check once in `rewrite-backlog` and `rewrite-queue` at startup.** That fixes today's
  callers but leaves `resolveJob`'s silent `rejected` for the next one.
