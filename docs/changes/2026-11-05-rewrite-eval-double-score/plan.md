---
change: 2026-11-05-rewrite-eval-double-score
status: accepted
track: T1
intent: ./intent.md
linear: ASTGL-69
---
# Plan: rewrite-eval scores a page once, and a failed output write stops the run

## Files that change

| File | Change |
|---|---|
| `src/rewrite-eval.ts` | `try` covers only the rewrite and the scoring; the `--out` write moves after it, so a write error propagates; each pair's output directory is created before its first rewrite |
| `test/rewrite-eval.test.ts` | Tests below, committed failing first |

## Order of work

1. Failing tests:
   - an `--out` path that cannot be created rejects before any rewrite runs;
   - a write that fails for one page rejects the run, instead of a report with that
     page counted twice;
   - a successful `--out` run writes one file per page and counts each page once.
   → verify: `npm test` shows the first two failing on `main`'s code.
2. The fix in `runEval()`. → verify: `npx tsc --noEmit`, `npm test`.
3. VERIFY and SHIP: `npm run build`, Codex review posted verbatim with my PASS/FAIL
   label outside it, the forge gate, `forge-pr create`. Merge on James's OK.

## Risks

- **A disk error mid-run loses the scores gathered so far.** Accepted: the output
  directory is checked before any model time is spent, so this needs a fault that
  starts mid-run, and a partial report is what this change exists to prevent.

## Proof

`npm test` passes with the three new tests. Before the fix, the second test sees a
report instead of a rejection.

## Options not taken

- **Record the write failure on the page's score and keep going.** The report would
  still read `MEASURED` while drafts James asked for are missing; it needs a new
  verdict state for a case a pre-run check already makes rare.
