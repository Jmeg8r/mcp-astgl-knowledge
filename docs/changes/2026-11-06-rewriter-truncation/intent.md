---
change: 2026-11-06-rewriter-truncation
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the rewriter never returns a truncated page as a finished one

## Problem

On 2026-11-06 James ran `rewrite-eval` on all 20 answer pages. The
`qwen3-coder:30b + qwen3.6:35b-a3b` pair returned pages at a mean 0.48 of their
original length, and two pages came back empty. The ROI page came back as 550 of
2,098 words, ending mid-sentence in its first section.

`qwen3.6:35b-a3b` is a thinking model, and Ollama turns thinking on by default. Its
hidden reasoning counts against the rewriter's `num_predict` budget of 6000 tokens.
A direct probe confirmed it: with a 300-token budget the model spent all 300 tokens
thinking, returned an empty response, and Ollama reported `done_reason: "length"`.
With `"think": false` the same request stopped normally (`done_reason: "stop"`).

`ollamaGenerate` never reads `done_reason`, so a cut-off response is accepted as a
complete rewrite. The claim check catches tokens a model adds, not text it loses, so
in production a half-length page would pass every check and be committed to a review
branch. The evaluation numbers for any thinking model are also meaningless today.

## Outcome

- Both passes ask Ollama for no thinking, so the whole budget goes to the page.
- A response that stopped because it hit the output budget fails with an error that
  names the model and the pass, for every model, thinking or not.
- Behavior for a response that finishes normally is unchanged.

## Acceptance

James approved this fix in conversation on 2026-11-06 ("Yes, fix it here").
