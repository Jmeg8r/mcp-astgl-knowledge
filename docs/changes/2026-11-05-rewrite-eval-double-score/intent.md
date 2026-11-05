---
change: 2026-11-05-rewrite-eval-double-score
status: accepted
track: T1
author: claude
accepted_by: james
linear: ASTGL-69
source: conversation
---
# Intent: rewrite-eval scores a page once, and a failed output write stops the run

## Problem

`runEval()` in `src/rewrite-eval.ts` wraps the rewrite, the scoring and the `--out`
file write in one `try`. When the write fails after the page was scored, the `catch`
pushes a second, error entry for the same page. The report then counts that page
twice: `pagesExamined` and `errors` are inflated, the means are taken over a mixed
set, and the verdict still reads `MEASURED`. The draft James asked to review is
missing and nothing says so plainly.

Found by a Codex review of PR #72 (2026-11-04), not posted with that round.

## Why now

Step 5 of the 2026-11-03 run sheet is James choosing the production models from this
report. A report that can miscount pages must not be the basis for that choice.

## Outcome

- Each page appears exactly once per model pair in the report.
- An `--out` directory that cannot be created fails the run before any model time is
  spent.
- A write that fails mid-run stops the run with a nonzero exit, instead of a report
  that reads `MEASURED` with drafts silently missing.

## Out of scope

- The other unposted P2: `rewrite-eval` does not load `.env`
  (`src/rewrite-eval.ts`, `main()`). It stays a separate follow-up.

## Acceptance

James approved this fix in conversation on 2026-11-05 ("Yes, fix it").
