---
change: 2026-11-07-rewriter-straight-quotes
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: the rewriter keeps the page's straight quotes

## Files that change

| File | Change |
|---|---|
| `src/rewriter.ts` | New `matchQuoteStyle(original, output)`; `rewritePage` applies it after each pass |
| `test/rewriter.test.ts` | New tests, committed failing first |

## Order of work

1. Failing tests:
   - `matchQuoteStyle` straightens all four curly quotes when the original has none;
   - it leaves the output alone when the original has a curly quote;
   - `rewritePage` returns straight quotes when the voice pass adds curly ones, and
     the voice prompt receives a straightened draft.
   → verify: they fail on `main`.
2. The change in `src/rewriter.ts`. → verify: `npm test`.
3. VERIFY and SHIP: `npx tsc --noEmit`, `npm run build`, replay `matchQuoteStyle`
   over the saved 2026-11-06c eval outputs (5 pages carry curly quotes; all should
   come out with none and no other change), `snyk test`, Codex review posted
   verbatim with my PASS/FAIL label outside it, the forge gate with
   `--base origin/main`, `forge-pr create`. Merge on James's OK.

## Risks

- **A curly quote inside a code block is straightened too.** Only when the original
  has no curly quotes anywhere, so any curly quote in the output came from the model.

## Proof

`npm test` passes with the new tests, which fail on `main`. The replay over the
2026-11-06c outputs leaves no curly quote on any page and changes nothing else.

## Options not taken

- **Tell the model not to use curly quotes.** A prompt rule is a request; the
  structure fix (#78) showed the model can ignore one. A replacement is certain.
- **Refuse the pass.** The text is otherwise good; the fix is mechanical.
- **Straighten on every page.** A page written with curly quotes would lose them.

## Deviations

None yet.
