/**
 * The ERROR-row marker shared by the citation-test writer and reader.
 *
 * WHAT: One definition of "this test_results row records a failed query, not a
 *       measured non-citation", plus the SQL fragments that classify rows by it.
 * WHY:  citation-test-auto.ts WRITES the marker and citation-test.ts READS it. When
 *       each carried its own copy of the string, the reader had no copy at all — it
 *       counted error rows as legitimate tests and deflated every citation rate it
 *       reported. A marker owned by neither side and imported by both cannot drift
 *       (the Mistake #8 discipline, applied to a magic string rather than a table).
 */

// WHAT: Prefix stamped on the snippet of a row whose engine query threw.
// WHY: test_results has no `error` column, and adding one would need a backfill
//      whose only possible evidence is this same prefix — so the prefix IS the
//      schema. Kept as a constant so the writer's template and the reader's LIKE
//      pattern are derived from one literal.
export const ERROR_SNIPPET_PREFIX = "ERROR:";

// WHAT: LIKE pattern matching any error row.
// WHY: Derived, never re-typed — a hand-written 'ERROR:%' in a fourth place is
//      exactly how the reader and writer diverged in the first place.
export const ERROR_SNIPPET_PATTERN = `${ERROR_SNIPPET_PREFIX}%`;

// WHAT: Format a caught error into the snippet column's marker form.
// WHY: The writer's single entry point, so the stamped shape can never disagree
//      with what ERROR_SNIPPET_PATTERN matches.
export function formatErrorSnippet(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${ERROR_SNIPPET_PREFIX} ${message}`;
}

// WHAT: In-process counterpart to the SQL fragments below.
// WHY: Lets tests and callers classify a row without a round trip, using the same
//      literal the queries use.
export function isErrorSnippet(snippet: string | null | undefined): boolean {
  return snippet != null && snippet.startsWith(ERROR_SNIPPET_PREFIX);
}

// WHAT: SQL predicates classifying a test_results row aliased as `tr`.
// WHY (COALESCE): the manual `record` path inserts snippet = NULL, and in SQL
//      `NULL NOT LIKE 'ERROR:%'` is NULL — not TRUE — so a bare NOT LIKE silently
//      discards every manually-recorded row along with the error rows. Measured on
//      the production DB: bare NOT LIKE keeps 496 rows, COALESCE keeps 561. Both
//      "fixes" undercount; only one undercounts nothing.
// WHY (tr.id IS NOT NULL): these run over LEFT JOINs, where a run with no results
//      yields one all-NULL row. Without the id check that phantom row counts as a
//      test. It must never move to a WHERE clause either — that collapses the LEFT
//      JOIN to an INNER JOIN and drops fully-errored runs from the report entirely,
//      which is the opposite of making a degraded run visible.
// Both fragments bind the named parameter $errPattern (= ERROR_SNIPPET_PATTERN).
export const SQL_IS_ERROR_ROW = "COALESCE(tr.snippet, '') LIKE $errPattern";
export const SQL_IS_TESTED_ROW =
  "tr.id IS NOT NULL AND COALESCE(tr.snippet, '') NOT LIKE $errPattern";
