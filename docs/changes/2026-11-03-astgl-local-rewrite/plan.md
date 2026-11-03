---
change: 2026-11-03-astgl-local-rewrite
status: accepted
track: T2
intent: ./intent.md
spec: ./spec.md
linear: ASTGL-69
---
# Plan: Local-only rewrite of stale astgl.ai answer pages, published by PR

## Files that change

| File | Change | Requirements |
|---|---|---|
| `src/knowledge-db.ts` | Idempotent `rewrite_jobs` rebuild: new status set, `site_branch`, `site_commit`, partial unique index on open jobs | R3, R11, R13 (F3, F6) |
| `src/db-rewrite-jobs.ts` | `claimJob()` (transactional insert of `drafting`), `recordSiteCommit()`, `markSuperseded()`, `getOpenJobs()`; blocked list includes `drafting` | R3, R11, R12, R13 |
| `src/claim-check.ts` (new) | Pure: extract numbers, version strings, URLs, quoted spans; diff output against input plus verified facts; list dated facts to check | R7 (F1) |
| `src/site-worktree.ts` (new) | Fetch, list answer pages with frontmatter `date`, create branch from `origin/main`, atomic write, commit, resolve open jobs | R1, R2, R8, R11, R12 (F5) |
| `src/rewriter.ts` | Remove `claudePolish`; body-only two-pass local rewrite; frontmatter split and reassembly | R4, R5, R6 (F4) |
| `src/notify.ts` (new) | Telegram and Slack senders, one result shape, redacted errors | R9, R10 |
| `src/rewrite-queue.ts` | Rewire to the spec flow; exit codes; JSON summary | R1–R12 |
| `src/rewrite-backlog.ts` (new) | One-off: `--dry-run` lists; supersedes 132 rows; prints the 34 for review; `--keep <job-id>` sends a keeper down the R8 path | R13 |
| `src/rewrite-eval.ts` (new), `test/fixtures/rewrite-eval/` | Planted-facts set from the 20 public pages; per-model report; UNKNOWN on zero | R15 (F2) |
| `src/publish-rewrite.ts` | Deleted, with its `package.json` script | R14 |
| `test/*.test.ts` (new files per module) | Tests below, written first | all |
| `package.json` | Remove `publish-rewrite`; add `rewrite-backlog`, `rewrite-eval` (pass-cli wrapped where they need secrets) | R13–R15 |
| `CLAUDE.md`, `README.md` | External deps (no Anthropic for rewrite, Slack added, Substack publisher gone), Mistake #11 rewritten for the claim lock, the astgl-site worktree | — |

Not touched: `data/knowledge.db` (never committed), astgl-site, ClaudeClaw.

## Order of work

Each step lands as its own commit with its failing test committed first, so every
step is verifiable on its own.

1. **Schema and claim lock** (F3, F6). Tests on a temp DB: migration from the old
   schema keeps every row; running it twice is a no-op; two concurrent claims for one
   URL → one succeeds; `--article-url` on an open job is refused.
   → verify: `npm test`, plus the migration run on a *copy* of the live DB with
   integrity and row counts compared.
2. **Claim check** (F1). Table-driven tests: a new version string fails; one present
   in the input passes; one in the verified-facts table passes; a reworded sentence
   with no new tokens passes.
3. **Site worktree** (F5). Tests build throwaway git repos: lists only answers pages;
   picks the stalest by `date`; branch created from `origin/main`; merged commit →
   `published`; deleted branch → `rejected`; still open → unchanged; never pushes
   (assert no `push` invocation).
4. **Local rewriter** (F4). Tests with a stubbed Ollama: frontmatter byte-identical
   except `date`; body passes through both passes; `fetch` to any non-`localhost` host
   throws and the test proves none happens.
5. **Notify**. Tests: both channels called; one failing → other still sends, result
   records the failure; a webhook URL in an error is redacted.
6. **Queue runner** (R10). Tests: any failed item → exit nonzero; notification failure
   → exit nonzero with the branch kept; empty candidate list → exit 0 with
   `drained: true`. Then delete `publish-rewrite.ts` (R14).
7. **Backlog tool** (R13). Tests on a temp DB with representative rows: dry-run counts;
   supersede leaves answer-page rows untouched; `--keep` routes through the worktree.
8. **Evaluation harness** (F2). Fixture builder plants known stale facts into copies
   of the 20 pages; report includes article count; zero → UNKNOWN.
9. **Docs** (CLAUDE.md, README).
10. **VERIFY and SHIP**: `npx tsc --noEmit`, `npm test`, `npm run build`,
    `security-review` on the diff, `design:ux-copy` on the notification text,
    `snyk test`, Codex review posted verbatim with my PASS/FAIL label outside it,
    `forge-pr create`. Merge on James's OK.

## After merge: James's run sheet (each step is his, in this order)

1. Create the Slack incoming webhook for the chosen channel; store it in the `ASTGL`
   vault; add `SLACK_WEBHOOK_URL=pass://ASTGL/<item>/<field>` to `.env` and the
   placeholder line to `.env.example` (I do not read or edit either file).
2. Move the live checkout `~/Projects/mcp-astgl-knowledge` to `main` and build (F7).
   Its uncommitted `data/knowledge.db` stays uncommitted; the exact commands go in a
   separate run sheet once he decides how to handle `package-lock.json`.
3. Supervised migration on the live DB (backup, integrity before and after).
4. `rewrite-backlog --dry-run`, then the supersede run, then review of the 34 drafts.
5. `rewrite-eval`; James picks the model for each pass.
6. ClaudeClaw T3 change: ASTGL-scoped session wrapper (its own intent and PR).
7. Harness STATUS.md request: prompt change to the wrapper, cron to weekly, one
   supervised run, then resume. Nothing reactivates before that approval.

## Risks

- **Migration on production data.** Mitigated by idempotent DDL, a tested migration,
  the copy-first run and the db-surgeon backup contract.
- **The claim check is too strict** (fails rewrites that only reformat a number, such
  as `1,000` → `1000`). Mitigated by normalizing tokens before comparing; the eval
  measures the false-failure rate.
- **A 7B voice model drops content.** The eval reports length change and planted facts
  lost; James picks on those numbers.
- **Ollama contention** with other local jobs. Existing retry rules stay; the weekly
  cadence keeps load low.
- **Public repo leakage.** Fixtures use only the 20 public answer pages; tests and
  logs carry no withheld rows.

## Proof

The spec's Acceptance checks, run in this order: `npx tsc --noEmit` → `npm test` (all
new tests named above passing) → `rg -n "api.anthropic.com|ANTHROPIC_API_KEY|claudePolish|sync_to_substack" src/`
empty → `npm run build` and `rg -c claudePolish dist/rewrite-queue.js` empty →
migration on a DB copy (integrity `ok`, equal counts) → `rewrite-backlog --dry-run`
(132 / 34) → `rewrite-eval` (article count > 0) → supervised live run (one local
branch, astgl-site build passes, one Telegram and one Slack message, `git ls-remote`
shows nothing new, exit 0).

## Options not taken

- **Job pushes and opens the PR**: rejected in intent Q1 (credential, unattended push).
- **Model updates facts from memory**: rejected in F1 (unsupported claims).
- **Rewrite FAQ frontmatter now**: deferred in F4 (build risk).
- **Reuse `rejected` for the backlog**: rejected in intent Q2 (cooldown side effect).
- **Widen the daemon token to ASTGL**: rejected (all ASTGL secrets to every task).
