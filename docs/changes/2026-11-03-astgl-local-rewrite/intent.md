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

- The queue runs weekly and selects only the 20 `astgl.ai/answers/` pages, the
  stalest one first by the page's `date` frontmatter, each at most once until its
  rewrite is merged or rejected.
- Both rewrite passes run on local models only. The model for each pass is chosen
  by measured quality on archived answer pages, not by assumption. Candidates
  include the existing `astgl-voice:7b-v1.5` fine-tune and the larger local
  general models.
- The rewrite edits the page's file in astgl-site (`src/content/answers/<slug>.md`),
  keeping its frontmatter valid against `src/content.config.ts` (title, description,
  date, order, faq, howto, related links), its source attribution and its factual
  claims.
- Each rewrite is committed to a local branch in an astgl-site worktree, and the job
  notifies James. James pushes the branch and opens the pull request; the job never
  pushes. James reviews the diff; **merging is the approval and the publish**
  (Cloudflare Pages deploys `main`). Rejecting is closing the PR or deleting the
  branch. The Telegram button flow and the Substack publish path are removed.
- A run that fails any item, produces malformed output or cannot open its change
  exits nonzero, so the scheduler records the failure and its existing failure
  audit fires.
- The 166 stale `pending_approval` rows are closed out so they no longer block or
  clutter the queue, under a new `superseded` status (not `rejected`, whose cooldown
  would hold the pages back):
  - the 132 rows for non-answer sources are marked `superseded`;
  - the 34 rows for the 20 answer pages are reviewed by James first (all 34 draft
    files are present on disk as of 2026-11-03). For each page he keeps at most one
    draft, which goes through the same local-branch path as a new rewrite; the rest
    are marked `superseded`. Publishing an existing draft makes no new cloud call.

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
- One supervised live run commits exactly one local astgl-site branch whose page
  passes `npm run build` in astgl-site, records the job against that branch, sends
  one notification, and pushes nothing (`git -C <astgl-site> ls-remote` shows no new
  branch until James pushes).
- `select status, count(*) from rewrite_jobs group by status;` shows no stale
  `pending_approval` rows from before this change.

## Open questions

1. ~~Who opens the PR?~~ **Answered 2026-11-03 (James): the job commits to a local
   astgl-site worktree branch and notifies; James pushes and opens the PR.** No forge
   token is added and the job makes no outward push. Revisit only if the manual step
   becomes a burden.
2. ~~How should the 166 old rows close out?~~ **Answered 2026-11-03 (James): review
   the 34 answer-page drafts first; supersede the other 132.** A new `superseded`
   status, because `rejected` starts a cooldown.
3. ~~Cadence.~~ **Answered 2026-11-03 (James): weekly, one page per run.**
4. ~~What counts as "stale".~~ **Answered 2026-11-03 (James): the page's `date`
   frontmatter in astgl-site**, set to the merge date when a rewrite merges. The
   candidate query reads staleness from the page files, not from `knowledge.db`.
5. ~~Evaluation set.~~ **Answered 2026-11-03 (James): earlier versions of the 20
   pages from astgl-site's git history**, each scored against a later version. If
   the history is too thin, fall back to current pages with planted stale facts, and
   say so in the results.
6. ~~Notification.~~ **Answered 2026-11-03 (James): notify on Telegram and Slack**
   when a branch is ready, as plain messages with no approval buttons. The forge
   cannot notify because nothing is pushed. Telegram reuses the existing sender;
   neither repo has a Slack sender today. The spec must cover the Slack credential
   (created by James, kept in the `ASTGL` vault), its workspace and channel, and what
   a failed send on one channel does to the run.
