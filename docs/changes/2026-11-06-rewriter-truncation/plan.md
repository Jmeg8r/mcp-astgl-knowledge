---
change: 2026-11-06-rewriter-truncation
status: accepted
track: T1
intent: ./intent.md
linear: pending
---
# Plan: the rewriter never returns a truncated page as a finished one

## Files that change

| File | Change |
|---|---|
| `src/rewriter.ts` | `ollamaGenerate` sends `think: false` and throws when `done_reason` is `length` |
| `test/rewriter.test.ts` | The stub records `think` and can answer with a `done_reason`; new tests committed failing first |

## Order of work

1. Failing tests:
   - every request sends `think: false`;
   - a draft-pass response with `done_reason: "length"` fails, naming the model;
   - a voice-pass response with `done_reason: "length"` fails the same way.
   → verify: all fail on `main`.
2. The change in `ollamaGenerate`. → verify: `npm test`.
3. VERIFY and SHIP: `npx tsc --noEmit`, `npm run build`, a live probe against local
   Ollama (`qwen3.6:35b-a3b` with a tiny budget must now throw the named error),
   `snyk test`, Codex review posted verbatim with my PASS/FAIL label outside it, the
   forge gate with `--base origin/main`, `forge-pr create`. Merge on James's OK.
   Then James re-runs `rewrite-eval`.

## Risks

- **A model that does not support `think`.** Ollama ignores `think: false` for a
  non-thinking model; the probe below runs it against `qwen3-coder:30b` to confirm.
- **A legitimately long page now fails instead of shipping cut off.** Intended: the
  job records the failure and James sees it, rather than reviewing a half page.

## Proof

`npm test` passes with the new tests, which fail on `main`. The live probe shows the
named error for a budget-limited response and a normal result otherwise.

## Options not taken

- **Raise `num_predict` instead.** Thinking length is unbounded and varies per page,
  so a larger budget only moves the cut-off; truncation would still pass silently.
- **Keep thinking and strip it.** Ollama already separates `thinking` from
  `response`; the cost is the budget and the time, not the text.
