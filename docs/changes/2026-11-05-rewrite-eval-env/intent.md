---
change: 2026-11-05-rewrite-eval-env
status: accepted
track: T1
author: claude
accepted_by: james
linear: ASTGL-69
source: conversation
---
# Intent: `npm run rewrite-eval` reads the settings in `.env`

## Problem

The `rewrite-eval` script runs `node dist/rewrite-eval.js` with nothing that loads
`.env`. The eval reads two settings from the environment: `ASTGL_SITE_WORKTREE` (which
astgl-site worktree to read pages from) and `OLLAMA_BASE_URL` (which Ollama to call).
When they are set only in `.env`, as for `rewrite-queue` and `rewrite-backlog`, the eval
silently uses the defaults: `.rewrite-site/` and `http://localhost:11434`. It may then
measure the wrong pages or the wrong Ollama, with nothing in the report to show it.

Every other script that needs `.env` runs through `pass-cli run --env-file .env`. The
eval was left unwrapped on purpose because it needs no secrets (2026-11-03 plan,
Deviations). That reasoning still holds, but it also dropped the plain settings.

Found by a Codex review of PR #72 (2026-11-04), not posted with that round.

## Why now

Step 5 of the 2026-11-03 run sheet is James picking the production models from this
report. The report must measure the same site checkout and Ollama that the queue uses.

## Outcome

- `npm run rewrite-eval` loads `.env` before the eval starts.
- A value already set in the shell still wins over `.env`, so a one-off override works.
- A missing `.env` stops the script, as it does for the other `.env` scripts, instead of
  silently using the defaults.
- No secret is resolved: the eval still does not run through `pass-cli`.

## Acceptance

James approved this fix in conversation on 2026-11-05 ("Yes, fix it").
