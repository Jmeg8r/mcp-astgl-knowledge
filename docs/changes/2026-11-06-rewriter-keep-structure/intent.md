---
change: 2026-11-06-rewriter-keep-structure
status: accepted
track: T1
author: claude
accepted_by: james
linear: pending
source: conversation
---
# Intent: the rewriter never returns a page whose markdown structure changed

## Problem

On 2026-11-06, after the truncation fix (#77), James re-ran `rewrite-eval` for
`qwen3-coder:30b + qwen3.6:35b-a3b` on all 20 answer pages. The summary read clean:
100% of planted facts kept, length x1.00, 0 errors. The pages were not clean:

- 12 pages lost every markdown table and 3 lost some. The rows became sentences
  ("Without MCP, you copy-paste... With MCP, AI pulls...").
- Lists changed too: `how-mcp-registries-work` went from 55 list items to 8,
  `is-it-safe-to-run-ai-locally` from 45 to 12.
- Headings and code fences survived on every page.

The cause is the voice profile the voice pass sends, `humanizer-astgl.md`. It was
written for Substack and says never to emit a raw markdown table, because tables
render badly there. Answer pages publish on the astgl.ai site, where tables render
correctly. qwen3.6 follows the profile closely enough to apply that rule.

Nothing checks structure. The claim check catches tokens a model adds, and the eval
checks facts and length; a table rewritten as prose keeps the facts and roughly the
same length, so it passes everything and would reach a review branch.

## Outcome

- Both prompts tell the model to keep every table, list and code block, and the
  voice prompt says the profile's no-tables rule does not apply to site pages.
- A pass whose output changes the count of headings, table rows, list items or code
  fences fails with an error that names the pass and the counts that changed.
- The voice profile itself is unchanged: the Substack pipeline still uses it.

## Acceptance

James approved this fix in conversation on 2026-11-06 ("Yes, fix it here").
