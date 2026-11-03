---
change: 2026-11-03-astgl-local-rewrite
status: draft
track: T2
intent: ./intent.md
accepted_by:
linear: ASTGL-69
skills_in_force: [astgl-db-surgeon, astgl-new-job]
claude_config_sha: 46f3fb5
---
# Spec: Local-only rewrite of stale astgl.ai answer pages, published by PR

## Flagged concerns

**F1. "Update stale facts" conflicts with "add no claims".** Source: intent
Constraints vs Proposed outcome; CLAUDE.md quality bar. The old prompt asked the
model to update tool versions "where you can do so confidently". A local model has no
source for current facts, so any version or date it changes comes from its training
memory, which is exactly an unsupported claim.
*Recommendation:* the rewriter never changes a fact from model memory. A
deterministic claim check compares the output with the input and fails the item on any
new number, version string, URL or quoted span that is not in the original or in a
verified-facts table built from the existing `freshness.ts` npm and GitHub release
checks. The job lists the original's dated facts (versions, model names, years) in the
notification and the commit message as "check these", for James to correct during
review.
*James:* accepted the recommendation (2026-11-03).

**F2. astgl-site's git history is too thin for the evaluation set (intent Q5).**
Source: measured 2026-11-03. 18 of the 20 pages have 3 commits and 2 have 4; the
later commits add graphics and related links, not prose revisions. There is no
"stale version, fresh version" pair to score against.
*Recommendation:* use the intent's stated fallback: the current 20 pages with planted
stale facts (each planted fact is known, so its handling is scored exactly), and say so
in the results. Add the 34 existing cloud-polished drafts of the same pages as a voice
reference only. They already exist, so this makes no new cloud call.
*James:* accepted the recommendation (2026-11-03).

**F3. Schema change on the live `knowledge.db`.** Source: CLAUDE.md Mistakes #8 and
#10, skill astgl-db-surgeon. `rewrite_jobs.status` has a `CHECK` constraint, so adding
`superseded` (and `drafting`, see F6) means rebuilding the table, which SQLite cannot
do in place. The spec also adds two columns.
*Recommendation:* one idempotent migration in `knowledge-db.ts` (the only DDL site for
this table; `grep` confirms no second definition), run once in a supervised step:
checkpoint and back up per the db-surgeon contract, `PRAGMA integrity_check` before and
after, row count before equals after. Never commit `data/knowledge.db`.
*James:* accepted the recommendation (2026-11-03).

**F4. FAQ and how-to blocks in the frontmatter.** Source: astgl-site
`src/content.config.ts`. FAQ answers carry facts and go stale too, but asking a model
(possibly a 7B one) to rewrite YAML risks a page that fails the build.
*Recommendation:* in this change the frontmatter is copied byte-for-byte except
`date`; only the markdown body is rewritten. FAQ refresh is a later change.
*James:* accepted the recommendation (2026-11-03).

**F5. How the job learns that a rewrite merged or was rejected.** Source: intent Q1
answer (the job never pushes, so no forge API is involved).
*Recommendation:* resolve from git. Each run fetches astgl-site and checks each open
job: if its recorded commit is reachable from `origin/main`, it is `published`; if its
local branch no longer exists and the commit is not on `main`, it is `rejected` (James
rejects by deleting the branch or closing the PR and deleting the branch). No other
state is kept outside git and `rewrite_jobs`.
*James:* accepted the recommendation (2026-11-03).

**F6. Why the same article was queued up to four times.** Source: CLAUDE.md Mistake
#11, `src/db-rewrite-jobs.ts:62`. The in-flight block only covers rows that already
exist, but the row is created after a rewrite that can take 15 minutes, and
`--article-url` skips the block entirely.
*Recommendation:* claim first. A `drafting` row is inserted inside a transaction
before any model call, guarded by a partial unique index on `article_url` for open
statuses, so a second run or a forced URL fails to claim instead of duplicating.

*James:* accepted the recommendation (2026-11-03).

**F7. The live checkout the scheduled task runs is not on `main`.** Source: CLAUDE.md
Mistake #1; ClaudeClaw task prompt `cd ~/Projects/mcp-astgl-knowledge && ...
node dist/rewrite-queue.js`. That checkout is on
`cursor/dashboard-use-resolveknowledgedbpath-ac7c` with uncommitted
`data/knowledge.db` and `package-lock.json` changes, so its `dist/` is built from a
side branch.
*Recommendation:* reactivation is gated on the live checkout being on `main` with this
change merged and `npm run build` run, verified by `git rev-parse` and a `dist/`
grep. How to move that checkout (its uncommitted `knowledge.db` must stay uncommitted)
is James's step, written as a run sheet in plan.md.
*James:* accepted the recommendation (2026-11-03).

**F8. Policy skills not applied here.** Source: /spec step 2. `security-review` and
`gstack-cso` review a diff, and there is no diff yet; `design:ux-copy` was not loaded
this session.
*Recommendation:* run `security-review` on the PR diff before Codex review, and
review the notification copy (R9) with `design:ux-copy` at that point.
*James:* accepted the recommendation (2026-11-03).

## Requirements

Each traces to intent.md.

- **R1** Candidates are only `https://astgl.ai/answers/` pages, matched by the
  page files in an astgl-site worktree, never by other `knowledge.db` sources.
  (Outcome 1; Out of scope.)
- **R2** A page is stale when its frontmatter `date` is more than 90 days old;
  the stalest is chosen first; at most one page per run. (Outcome 1; Q3, Q4.)
- **R3** An article with an open job (`drafting` or `pending_approval`) or inside a
  rejection cooldown is never selected, including with `--article-url`. (Outcome 1;
  F6.)
- **R4** Both passes use only the local Ollama host. No code path reads
  `ANTHROPIC_API_KEY` or contacts a non-local host for generation. (Constraint 1.)
- **R5** The model for each pass is a configured value, set from the evaluation
  results James accepts, not hard-coded. (Outcome 2.)
- **R6** The output page keeps the original frontmatter byte-for-byte except
  `date` (set to the run date), and passes astgl-site `npm run build`. (Outcome 3;
  F4.)
- **R7** The output adds no number, version string, URL or quoted span absent from
  the original or the verified-facts table; a violation fails the item. (Constraint
  3; F1.)
- **R8** A successful item is one commit on a new local branch
  `rewrite/<slug>-<YYYY-MM-DD>` in a dedicated astgl-site worktree. The job never
  pushes and never touches `~/Projects/astgl-site`'s own checkout. (Outcome 4; Q1.)
- **R9** The job sends one plain message per branch to Telegram and to Slack: page,
  branch, the push and PR commands, and the facts-to-check list. No buttons.
  (Outcome 4; Q6.)
- **R10** The run exits nonzero if any item failed, any output was malformed, the
  commit failed, or any notification channel failed; a failed send leaves the
  committed branch in place and the other channel still sends. (Outcome 5;
  Constraint 4.)
- **R11** Job claiming is atomic and the page write is atomic (temp file, then
  rename). (Constraint 5; F6.)
- **R12** Open jobs resolve from git each run: commit on `origin/main` → `published`;
  branch gone and commit not on `main` → `rejected` with the normal cooldown. (F5.)
- **R13** The 132 non-answer `pending_approval` rows become `superseded`; the 34
  answer-page rows are presented to James for review (one keeper per page at most,
  sent down the R8 path), and the rest become `superseded`. (Outcome 6; Q2.)
- **R14** The Telegram approval handler path and `publish-rewrite.ts` (Substack) are
  removed, with their tests, docs and `package.json` scripts. (Outcome 4.)
- **R15** An evaluation harness scores each candidate model and reports, per model,
  over a stated article count greater than zero: claim-check violations, planted
  stale facts kept or flagged, build validity, length change, and time per page.
  Zero examined articles reports UNKNOWN. (Success signals; F2.)

## Design

**Flow of one weekly run** (`src/rewrite-queue.ts`):

1. Resolve open jobs (R12): `git fetch` in the astgl-site worktree, then check each
   `pending_approval` job's `site_commit` and `site_branch`.
2. List candidates (R1, R2): read `src/content/answers/*.md` frontmatter from the
   worktree's `origin/main`, drop blocked URLs (R3), sort by `date`.
3. Claim (R11): in one transaction, insert a `drafting` row for the chosen URL; the
   partial unique index rejects a second claim.
4. Rewrite (R4, R5): split the page into frontmatter and body; send only the body
   through pass 1 (draft) and pass 2 (voice), both via the existing Ollama
   `/api/generate` client with its retry rules.
5. Check (R6, R7): reassemble with the original frontmatter and new `date`; run the
   claim check; extract the facts-to-check list from the original.
6. Commit (R8): create the branch from `origin/main`, write the page atomically,
   commit with the facts list in the message, record `site_branch`,
   `site_commit`; status `pending_approval`.
7. Notify (R9, R10): Telegram, then Slack, each recorded on its own; any failure
   sets the exit code but changes nothing already committed.
8. Print the single JSON summary on stdout; everything else on stderr (Mistake #6).

**Data** (`rewrite_jobs`, one migration in `knowledge-db.ts`, F3): status set becomes
`drafting, pending_approval, approved, published, rejected, failed, superseded`; add
`site_branch TEXT`, `site_commit TEXT`; partial unique index on `article_url` where
status in (`drafting`, `pending_approval`). The Telegram routing columns stay
(historical rows use them); `substack_url` stays, unused.

**Modules:** `rewriter.ts` loses `claudePolish`, gains a second local pass; new
`claim-check.ts` (pure, R7); new `site-worktree.ts` (fetch, list pages, branch,
commit, resolve; R1, R8, R12); new `notify.ts` (Telegram and Slack senders sharing one
result shape); new `rewrite-eval.ts` plus a planted-facts fixture set (R15); new
one-off `rewrite-backlog.ts` for R13 with `--dry-run`.

**Configuration:** `OLLAMA_REWRITE_MODEL`, `OLLAMA_VOICE_MODEL`,
`ASTGL_SITE_WORKTREE` (default under the repo's own ignored path, not
`~/Projects/astgl-site`), `SLACK_WEBHOOK_URL` (secret), Telegram vars unchanged.

**Schedule:** stays a ClaudeClaw scheduled task (not launchd, so the astgl-new-job
plist steps do not apply). The cron change `0 11 * * *` → weekly is part of the
reactivation request, not this code change.

## Security and data

- **Secrets:** `SLACK_WEBHOOK_URL` is new. James creates the webhook and stores it in
  the `ASTGL` vault; `.env.example` gets a placeholder; the `.env` reference is a name
  form `pass://ASTGL/...`. Error text from a failed send is redacted before logging
  (a webhook URL is itself the credential). No secret is printed (Mistake #9).
- **Vault access:** ASTGL secrets resolve through the separate ASTGL-scoped session
  (ClaudeClaw change, T3), never by widening `claudeclaw-daemon`.
- **Public repo:** this repo is public. No spec, fixture, test or log names a withheld
  article or describes one (`docs/publication-gate.md`). Fixtures use the 20 public
  answer pages only.
- **Model input:** page bodies are public text; generation stays local; output reaches
  the internet only after James pushes and merges.
- **Git safety:** the job commits only in its own worktree, never pushes, and never
  skips hooks.

## Acceptance checks

- `npm test` passes with new tests for R1, R3 (including `--article-url`), R6, R7,
  R10 (one channel failing), R11 (two concurrent claims), R12 (merged, deleted,
  still open).
- `rg -n "api.anthropic.com|ANTHROPIC_API_KEY|claudePolish|sync_to_substack" src/`
  returns nothing.
- A test stubs `fetch` to throw on any non-`localhost` URL and runs the rewriter end to
  end.
- Migration on a copy of `knowledge.db`: `PRAGMA integrity_check` is `ok` before and
  after; `select count(*) from rewrite_jobs` equal before and after.
- `rewrite-backlog --dry-run` lists 132 rows to supersede and 34 to review.
- `npm run rewrite-eval` prints a per-model table with an article count > 0.
- Supervised run: one local branch, page passes astgl-site `npm run build`, one
  Telegram and one Slack message, `git ls-remote` shows no new branch, exit 0.
- `npm run build` run and `dist/rewrite-queue.js` contains no `claudePolish`
  (Mistake #1).

## Open questions

- F1–F8: resolved 2026-11-03 (James accepted all eight recommendations).
- Slack workspace and channel for the webhook (James, when creating it).
