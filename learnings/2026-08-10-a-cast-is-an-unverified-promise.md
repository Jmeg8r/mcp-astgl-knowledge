# A cast is an unverified promise about someone else's JSON

**Date:** 2026-08-10
**Context:** PR #60 — `citation-test-auto.ts` intermittently wrote
`ERROR: block.content is not iterable` rows into `citation-test.db` on the `claude` engine
(1 error run #32 2026-07-27, 2 errors run #35 2026-08-03, 0 run #38 2026-08-10).

## The problem (one line)

A `for...of` over an Anthropic response field threw whenever the `web_search` tool errored, because
the field is an array on success and an **error object** on failure — and the code guarded it for
truthiness, not for being an array.

## The approach (plain steps)

1. **Reproduce from the data, not the description.** One `sqlite3 -readonly` query over
   `test_results` confirmed the error text verbatim, which engine, and which runs. The error string
   later became the test's reality anchor (step 6) — so read it exactly, don't paraphrase it.
2. **Get the API contract from the vendor, not from the code.** The code's own type declaration was
   the thing under suspicion, so it could not be the evidence. Loading the `claude-api` skill gave
   the actual rule: *a failed web search returns HTTP 200 with a `web_search_tool_result` whose
   `content` is a single `web_search_tool_result_error` object, not the result array.*
3. **Notice the type declaration is part of the defect.** `content?: Array<{url?: string}>` told the
   compiler this was always an array, so the crashing `for...of` typechecked cleanly. Widening it to
   a real union (`ClaudeSearchResult[] | ClaudeSearchError`) is what forces the branch; the
   `Array.isArray` guard alone fixes the symptom and leaves the next reader the same false comfort.
4. **Name the class before fixing the instance** (Mistake #13). The class is *iterating a field whose
   array-ness is an assumption*. Grepping `for (const … of` across `src/` found six more members —
   `item.content` in the ChatGPT parser (identical truthiness guard), four `|| []` fields
   (`||` guards `null`/`undefined` only), and `data.servers` in `alerts.ts`.
5. **Look for the silent members, not just the loud one.** Perplexity's `data.citations` had the same
   assumption but never threw: `findAstglInUrls` reads `.length`, which is `undefined` on an object,
   so the loop simply never ran and the question recorded a confident **wrong** "not cited". Symptom-
   hunting finds crashes; class-hunting finds the quiet ones. `alerts.ts` was the same — its throw
   landed in an enclosing `catch`, dropping a search term's results with no log line at all.
6. **Make the fix testable without paying for it.** The live test costs ~$1.50 per run (Mistake #12
   forbids re-running it to verify) and the module called `main()` at import. Extracting the parsers
   into a pure `citation-parse.ts` solved both — no network, no DB, no entry-point guard to get wrong.
7. **Anchor the fixture, then mutation-test the guard.** The error fixture was built from
   documentation, not a captured payload — the exact trap that let a stale CodeRabbit fixture pass
   for weeks. So one test asserts the fixture reproduces the *verbatim* `TypeError` from step 1 when
   replayed through the old guard. Then both guards were reverted: 7 of 13 tests failed, including
   all three modelling the crash. Restored, green.

## The judgment calls (what was NOT done, and why)

- **A search error no longer fails the question at all.** The task offered "ERROR row" or "skip"; the
  right answer was neither. An error block is one among several searches — the others still ground
  the answer, so "not cited" is a real measurement. Only when *every* search errored does it throw,
  because with no grounding `cited=0` is a fabricated data point (the per-question form of PR #15's
  all-errors rollback). When a question offers two options, check whether the real answer is a third.
- **Did not fix the report's denominator.** `citation-test.ts` counts ERROR rows in `tested` via
  `COUNT(tr.id)`. Real, but pre-existing, affects the 2026-05-25 401 rows equally, and touches four
  queries — flagged and spawned separately rather than smuggled into a bug fix.
- **Did not sweep `discover.ts`'s `feed.items` or `index.ts`'s `related_articles`.** `rss-parser`
  builds its own array and `related_articles` is internal. Neither is an external-JSON boundary;
  guarding them would be pattern-matching on syntax instead of on the class. Said so in the PR.
- **Did not upgrade `web_search_20250305` → `_20260209`.** Dynamic filtering changes which results
  come back, i.e. changes the measurement mid-series. Flagged for a deliberate decision.

## The reusable rule

**At any boundary where external JSON enters, the declared type is a promise *you* made on the
vendor's behalf — and the compiler will keep it, including when it is wrong.** A `x || []` or
`&& x` guard tests presence; it never tests shape, so a truthy non-array walks straight into
`for...of`. Write the union the vendor actually documents so the compiler forces the branch, then
sweep every sibling field — and expect the class to have two faces: one that throws where you can
see it, and one that returns a plausible empty result where you cannot.
