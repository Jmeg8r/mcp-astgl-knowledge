---
change: 2026-11-07-rewriter-straight-quotes
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the rewriter keeps the page's straight quotes

## Problem

The 2026-11-06 re-run of `rewrite-eval` (`qwen3-coder:30b + qwen3.6:35b-a3b`, after
#78) passed every check, but 5 of the 20 pages came back with curly quotes the
original did not have (`’`, `“`, `”`). `cost-of-running-ai-locally-vs-cloud` has 10,
so its edited lines read `Let’s` while the lines the model left alone read `Let's`.
Earlier eval runs show the same thing on 5 pages.

None of the 20 answer pages on the site has a curly quote. The mix shows on the
published page, and no check catches it: the claim check looks for added tokens,
and a quote character is not one.

## Outcome

- When the original body has no curly quotes, each pass's output has its curly
  quotes replaced with straight ones (`’` and `‘` become `'`, `“` and `”` become `"`).
- A page that already uses curly quotes is left as the model returned it, since
  the rewriter cannot tell which style that page wants.

## Acceptance

James approved this fix in conversation on 2026-11-07 ("Yes, fix it here").
