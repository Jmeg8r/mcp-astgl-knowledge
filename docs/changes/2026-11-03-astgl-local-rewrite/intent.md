---
change: 2026-11-03-astgl-local-rewrite
status: draft
track: T2
author: james
accepted_by:
linear: ASTGL-69
source: conversation
---
# Intent: Local-only rewrite of stale astgl.ai answer pages, published by PR

## Problem

The daily `astgl-rewrite-queue` task has been paused since 2026-09-24. James chose
then to replace it with a local-only version rather than restore the cloud pipeline
(ClaudeClaw `tasks/local-gateway-health-plan-2026-09-24.md`: "No cloud restoration
authorized"; "Do not restore the old Anthropic-key wrapper").

A read-only inventory on 2026-11-03 found that the pipeline was broken past the
cloud key:

- **No draft was ever approved or published.** `rewrite_jobs` holds 166
  `pending_approval` rows for 116 articles (2026-05-06 to 2026-08-26), 11 `failed`,
  and no `approved` or `published` rows. 165 of the pending rows sent a Telegram
  approval message.
- **Nothing handles the approval buttons.** `src/publish-rewrite.ts` says it is
  called by ClaudeClaw's `astgl-rw:approve` handler. No `astgl-rw` or
  `publish-rewrite` reference exists in ClaudeClaw's `src/`, `dist/` or git history.
- **The publish target is retired.** Approval would run `sync_to_substack.py`;
  Substack was retired on 2026-07-13 (comment in `src/rewrite-queue.ts`).
- **Most candidates have nowhere to go.** The candidate query reads every stale
  article in `knowledge.db`. Of the 166 pending drafts, only 34 (20 articles) are
  `astgl.ai/answers/` pages; 104 are `local://astgl-articles/draft/...` and 28 are
  other sources, none with an astgl.ai page.
- **The same article is queued repeatedly** (up to 4 pending rows per URL), so the
  in-flight block does not hold.
- **Failures exit 0.** `main()` exits 0 even when every item failed, so the
  scheduler records a failed run as a success.
- **The polish pass is a cloud call** (`claude-sonnet-4-6` via the Anthropic API).

The cost: the 20 answer pages, which are the site's answer-engine surface, go stale
with no working way to refresh them, while the queue produced drafts nobody could
act on.

## Proposed outcome

- The queue selects only the 20 `astgl.ai/answers/` pages, the stalest one first,
  each at most once until its rewrite is merged or rejected.
- Both rewrite passes run on local models only. The model for each pass is chosen
  by measured quality on archived answer pages, not by assumption. Candidates
  include the existing `astgl-voice:7b-v1.5` fine-tune and the larger local
  general models.
- The rewrite edits the page's file in astgl-site (`src/content/answers/<slug>.md`),
  keeping its frontmatter valid against `src/content.config.ts` (title, description,
  date, order, faq, howto, related links), its source attribution and its factual
  claims.
- Each rewrite is proposed as a pull request on astgl-site. James reviews the diff;
  **merging is the approval and the publish** (Cloudflare Pages deploys `main`).
  Rejecting is closing the PR. The Telegram button flow and the Substack publish
  path are removed.
- A run that fails any item, produces malformed output or cannot open its change
  exits nonzero, so the scheduler records the failure and its existing failure
  audit fires.
- The 166 stale `pending_approval` rows are closed out so they no longer block or
  clutter the queue.

## Affected users and systems

- **James**: reviews and merges astgl-site PRs instead of pressing Telegram buttons.
- **mcp-astgl-knowledge** (most of the work): `src/rewriter.ts`,
  `src/rewrite-queue.ts`, `src/db-rewrite-jobs.ts`, `src/knowledge-db.ts` candidate
  query, `src/publish-rewrite.ts` (removed or replaced), tests, a new evaluation
  harness.
- **astgl-site**: receives the PRs; its build validates the frontmatter. No code
  change expected there.
- **ClaudeClaw**: the `astgl-rewrite-queue` scheduled task's prompt and its access
  to the `ASTGL` vault. That access is a separate T3 change in the ClaudeClaw repo
  (a session and token scoped to `ASTGL` only, token `astgl-pass-cli-token` already
  in the Keychain), reviewed on its own.
- **Ollama** on the Mac Studio: model load contention with other local jobs.

## Constraints

- **Local inference only.** No cloud model call in the rewrite path; no
  `ANTHROPIC_API_KEY` read. (2026-09-24 decision.)
- **Explicit human approval before publication.** Nothing reaches astgl.ai without
  James merging.
- **Preserve source attribution and protected factual claims.** The rewrite must not
  add benchmarks, statistics, quotes or claims that are not in the original.
- **Fail closed.** Nonzero exit on any failed item, malformed output or failed
  change creation; an evaluation that examined zero articles reports UNKNOWN, not
  pass.
- **Idempotent job claiming and atomic draft writes**, so a crash or a concurrent
  run cannot leave a half-written page or a duplicate job.
- **No secret scope widening.** The `claudeclaw-daemon` token stays `claudeclaw`-only;
  ASTGL access goes through the separate ASTGL-scoped session.
- **Reactivation needs its own approval** recorded in the harness STATUS.md: the
  scheduled task stays paused until James approves the quality results and the
  resume.
- Repos are forge-only for pushes; the `github` remote on mcp-astgl-knowledge is
  never pushed to.

## Out of scope

- Rewriting anything other than the 20 `astgl.ai/answers/` pages (local drafts,
  wiki pages, projects pages, old `astgl.com/p/` posts).
- pSEO pages on tools.astgl.ai (their own pipeline in pseo-astgl).
- Retraining or changing the `astgl-voice` model.
- New answer pages; this only refreshes existing ones.
- Changes to astgl-site's layout, build or deploy.

## Success signals

- `npm test` passes, including new tests that:
  - the candidate query returns only `https://astgl.ai/answers/` URLs;
  - an article with an open job is never selected again;
  - a run with any failed item exits nonzero;
  - the rewriter module makes no request to a non-local host (a test with the
    network stubbed to fail on any non-`localhost` URL).
- `rg -n "api.anthropic.com|ANTHROPIC_API_KEY" src/` returns nothing.
- The evaluation harness, run on the archived answer pages, reports for each
  candidate model: unsupported-claim count, frontmatter validity, length change and
  a repair-burden score, over a stated article count greater than zero. James
  accepts a model on those numbers.
- One supervised live run opens exactly one astgl-site PR whose page passes
  `npm run build` in astgl-site, and records the job against that PR.
- `select status, count(*) from rewrite_jobs group by status;` shows no stale
  `pending_approval` rows from before this change.

## Open questions

1. **Who opens the PR?** (a) The scheduled job pushes a branch and opens the PR
   itself, which needs a forge token, likely kept in the `ASTGL` vault; or (b) the
   job commits to a local astgl-site worktree branch and notifies James, who pushes.
   (a) is fully automatic but adds a credential and an unattended outward action;
   (b) keeps every push in James's hands.
2. **How should the 166 old rows close out?** The status enum has no `superseded`;
   options are a new `superseded` status (a schema change) or `rejected` with an
   error note. And should any of the 34 existing answer-page drafts be reviewed
   instead of discarded, given they include a cloud polish?
3. **Cadence.** With 20 pages and a 90-day staleness bar, is daily still right, or
   weekly?
4. **What counts as "stale" for an answer page** now that `last_reviewed_at` is set
   by a merge rather than a Telegram approval: the page's `date` frontmatter, the
   merge date, or both?
5. **Where the archived evaluation set comes from**: the current 20 pages as they
   are (the rewrite target and the reference at once), or earlier git versions of
   them in astgl-site.
6. **Notification.** With Telegram approval gone, does James still want a message
   when a PR opens, or is the forge's own PR notification enough?
