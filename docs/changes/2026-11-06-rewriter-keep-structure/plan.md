---
change: 2026-11-06-rewriter-keep-structure
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: the rewriter never returns a page whose markdown structure changed

## Files that change

| File | Change |
|---|---|
| `src/rewriter.ts` | New `markdownStructure(body)`; `rewritePage` checks it after each pass; both prompts name tables, lists and code blocks |
| `test/rewriter.test.ts` | New tests, committed failing first |

## Order of work

1. Failing tests:
   - `markdownStructure` counts headings, table rows, list items and code fences,
     and ignores lines inside a fenced code block (a `# comment` in bash is not a
     heading);
   - a draft pass that turns a table into prose fails, naming the pass and the
     count, and never reaches the voice pass;
   - a voice pass that collapses a list fails the same way;
   - the voice prompt says tables stay, and the draft prompt names tables, lists
     and code blocks.
   → verify: all fail on `main`.
2. The change in `src/rewriter.ts`. → verify: `npm test`.
3. VERIFY and SHIP: `npx tsc --noEmit`, `npm run build`, a live probe against local
   Ollama on two pages that lost tables in the eval, `snyk test`, Codex review
   posted verbatim with my PASS/FAIL label outside it, the forge gate with
   `--base origin/main`, `forge-pr create`. Merge on James's OK. Then James re-runs
   `rewrite-eval`.

## Risks

- **Exact counts may refuse a harmless edit**, such as a model splitting one list
  item in two. Intended for now: a refused page stays as it was and the job records
  why. The eval re-run shows how often it happens; loosen it only from that data.
- **The prompt override may not be enough** for qwen3.6. Then the guard turns those
  pages into failures, and the eval shows the pair is not ready.

## Proof

`npm test` passes with the new tests, which fail on `main`. The live probe rewrites
two pages that lost tables on 2026-11-06 with their counts unchanged, or fails with
the named error.

## Options not taken

- **Edit the voice profile.** The Substack pipeline relies on the no-tables rule.
- **Score structure in `rewrite-eval` as well.** The eval calls `rewritePage`, so a
  structure change now arrives as an error naming the counts; a second scorer would
  never fire on a real run.
- **Allow a tolerance on the counts.** No data yet on what a harmless change looks
  like; exact counts fail closed.

## Deviations

- **More markdown forms are counted.** Codex review found three forms the first
  version missed, each one a way to lose structure without tripping the guard:
  tables without outer pipes, ordered lists numbered `1)`, and a closing code fence
  that does not match its opener. Each got a failing test first, then the fix.
  Setext headings were added with the `1)` lists, since they have the same gap.
- **Images and blockquote lines are counted too.** Ten answer pages carry diagrams
  and five carry blockquotes; a dropped diagram loses no claim token.
- The 2026-11-06 eval outputs still split the same way after every change: the 15
  pages that lost tables are refused and the 5 that kept them pass.
