/**
 * Tests for ERROR-row accounting in the AEO citation report.
 *
 * WHAT: Covers the denominator the report divides by — which test_results rows count
 *       as tests, which count as errors, and what a rate over zero tests renders as.
 * WHY:  The report counted rows written by citation-test-auto's error path as
 *       legitimate tests, so an auth outage or a parse crash was indistinguishable
 *       from a measured non-citation and deflated every rate. Measured on the
 *       production DB 2026-08-10: 184 of 745 rows (25%) were error rows, including
 *       nine runs that were 100% errors and still reported "0% cited, tested 20".
 *
 *       The cases that matter most are the ones where a broken fix passes for a
 *       working one. Two in particular:
 *         - the manual `record` path inserts snippet = NULL, and a bare
 *           `NOT LIKE 'ERROR:%'` discards those rows too (NULL NOT LIKE x is NULL,
 *           not TRUE) — trading an over-count for an under-count;
 *         - excluding errors without reporting them leaves a fully-failed run at
 *           tested=0, and 0/0 rendered as "0%" is the original bug again.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { buildReport, createSchema } from "../src/citation-test.js";
import type { CitationReport } from "../src/citation-test.js";
import {
  ERROR_SNIPPET_PATTERN,
  ERROR_SNIPPET_PREFIX,
  formatErrorSnippet,
  isErrorSnippet,
} from "../src/citation-error-rows.js";

// --- Fixtures ---

interface ResultSpec {
  questionId: number;
  cited: 0 | 1;
  snippet: string | null;
}

function newDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  createSchema(db);
  const insertQuestion = db.prepare(
    "INSERT INTO target_questions (id, question, expected_url, category) VALUES (?, ?, ?, ?)"
  );
  insertQuestion.run(1, "Q one?", "https://astgl.ai/answers/one", "mcp-servers");
  insertQuestion.run(2, "Q two?", "https://astgl.ai/answers/two", "mcp-servers");
  insertQuestion.run(3, "Q three?", "https://astgl.ai/answers/three", "local-ai");
  return db;
}

function addRun(
  db: InstanceType<typeof Database>,
  runDate: string,
  engine: string,
  results: ResultSpec[]
): number {
  const runId = Number(
    db
      .prepare("INSERT INTO test_runs (run_date, engine, notes) VALUES (?, ?, NULL)")
      .run(runDate, engine).lastInsertRowid
  );
  const insert = db.prepare(
    `INSERT INTO test_results (run_id, question_id, cited, cited_url, position, snippet)
     VALUES (?, ?, ?, NULL, NULL, ?)`
  );
  for (const r of results) insert.run(runId, r.questionId, r.cited, r.snippet);
  return runId;
}

// WHY a real Error, not a literal string: this is the writer's own output crossing
//      into the reader. A hand-written 'ERROR: ...' fixture would test the test.
const errorSnippet = (message: string): string =>
  formatErrorSnippet(new Error(message));

function report(db: InstanceType<typeof Database>): CitationReport {
  const result = buildReport(db);
  assert.ok(!("message" in result), "expected a report, got the empty-DB message");
  return result;
}

// --- The marker itself ---

describe("ERROR snippet marker", () => {
  test("the writer's output is what the reader's pattern matches", () => {
    const snippet = errorSnippet("Anthropic 401: unauthorized");
    assert.ok(isErrorSnippet(snippet));
    assert.ok(snippet.startsWith(ERROR_SNIPPET_PREFIX));
    assert.equal(ERROR_SNIPPET_PATTERN, `${ERROR_SNIPPET_PREFIX}%`);
  });

  test("matches the shape historical rows were stamped with", () => {
    // WHY: 184 rows already in production were written by the pre-refactor literal
    //      `ERROR: ${message}`. If formatErrorSnippet emitted anything else, every
    //      one of them would go on counting as a legitimate test forever.
    const message = "block.content is not iterable";
    assert.equal(errorSnippet(message), `ERROR: ${message}`);
  });

  test("a non-Error throw still gets the marker", () => {
    assert.ok(isErrorSnippet(formatErrorSnippet("plain string throw")));
  });

  test("a real answer snippet is not an error row", () => {
    assert.equal(isErrorSnippet("An MCP server is a program that..."), false);
    assert.equal(isErrorSnippet(null), false);
  });
});

// --- The denominator ---

describe("citation report denominator", () => {
  test("error rows are excluded from tested and reported as errored", () => {
    const db = newDb();
    addRun(db, "2026-08-10", "claude", [
      { questionId: 1, cited: 1, snippet: "cited ASTGL" },
      { questionId: 2, cited: 0, snippet: "did not cite" },
      { questionId: 3, cited: 0, snippet: errorSnippet("block.content is not iterable") },
    ]);

    const r = report(db);
    const run = r.recent_runs[0];

    // 1 of 2 real answers, NOT 1 of 3 rows.
    assert.equal(run.tested, 2);
    assert.equal(run.cited, 1);
    assert.equal(run.errored, 1);
    assert.equal(run.citation_rate, "50%");
    db.close();
  });

  test("NULL snippets from the manual record path still count as tests", () => {
    // WHY: recordRun() inserts snippet = NULL. Under a bare `NOT LIKE 'ERROR:%'`
    //      these rows evaluate to NULL and vanish — measured on the production DB as
    //      496 surviving rows instead of 561. This asserts they survive.
    const db = newDb();
    addRun(db, "2026-05-05", "perplexity", [
      { questionId: 1, cited: 1, snippet: null },
      { questionId: 2, cited: 0, snippet: null },
      { questionId: 3, cited: 0, snippet: errorSnippet("Perplexity 401") },
    ]);

    const r = report(db);
    assert.equal(r.recent_runs[0].tested, 2);
    assert.equal(r.recent_runs[0].cited, 1);
    assert.equal(r.recent_runs[0].errored, 1);
    assert.equal(r.recent_runs[0].citation_rate, "50%");
    db.close();
  });

  test("a fully-errored run stays visible with a null rate, not 0%", () => {
    // WHY: this is the whole point. Dropping errors from the denominator without
    //      surfacing them would leave tested=0 rendering as "0%" — a broken run
    //      wearing the costume of a real result, which is the bug being fixed.
    const db = newDb();
    addRun(db, "2026-05-25", "chatgpt", [
      { questionId: 1, cited: 0, snippet: errorSnippet("OpenAI 401") },
      { questionId: 2, cited: 0, snippet: errorSnippet("OpenAI 401") },
      { questionId: 3, cited: 0, snippet: errorSnippet("OpenAI 401") },
    ]);

    const r = report(db);
    assert.equal(r.recent_runs.length, 1, "the run must not disappear from the report");
    const run = r.recent_runs[0];
    assert.equal(run.tested, 0);
    assert.equal(run.errored, 3);
    assert.equal(run.citation_rate, null);
    assert.notEqual(run.citation_rate, "0%");
    db.close();
  });

  test("a genuine zero is still reported as 0%, distinct from unmeasured", () => {
    const db = newDb();
    addRun(db, "2026-08-10", "perplexity", [
      { questionId: 1, cited: 0, snippet: "no ASTGL link" },
      { questionId: 2, cited: 0, snippet: "no ASTGL link" },
    ]);

    const r = report(db);
    assert.equal(r.recent_runs[0].citation_rate, "0%");
    assert.equal(r.recent_runs[0].tested, 2);
    assert.equal(r.recent_runs[0].errored, 0);
    db.close();
  });

  test("a run with no results at all counts no phantom test", () => {
    // WHY: these aggregates run over LEFT JOINs, where a resultless run yields one
    //      all-NULL row. Without the `tr.id IS NOT NULL` guard it counts as a test.
    const db = newDb();
    addRun(db, "2026-08-10", "claude", []);

    const r = report(db);
    assert.equal(r.recent_runs[0].tested, 0);
    assert.equal(r.recent_runs[0].errored, 0);
    assert.equal(r.recent_runs[0].citation_rate, null);
    db.close();
  });
});

// --- Aggregates ---

describe("citation report aggregates", () => {
  test("by_engine and by_category exclude errors consistently", () => {
    const db = newDb();
    addRun(db, "2026-08-03", "claude", [
      { questionId: 1, cited: 1, snippet: "cited" },
      { questionId: 2, cited: 0, snippet: errorSnippet("parse crash") },
      { questionId: 3, cited: 0, snippet: errorSnippet("parse crash") },
    ]);
    addRun(db, "2026-08-10", "claude", [
      { questionId: 1, cited: 0, snippet: "no cite" },
      { questionId: 3, cited: 0, snippet: null },
    ]);

    const r = report(db);

    const claude = r.by_engine.find((e) => e.engine === "claude");
    assert.ok(claude);
    assert.equal(claude.runs, 2);
    assert.equal(claude.tested, 3);
    assert.equal(claude.cited, 1);
    assert.equal(claude.errored, 2);
    assert.equal(claude.citation_rate, "33%");

    // q1+q2 are mcp-servers, q3 is local-ai.
    const mcp = r.by_category.find((c) => c.category === "mcp-servers");
    assert.ok(mcp);
    assert.equal(mcp.tested, 2); // q1 twice; q2's only row errored
    assert.equal(mcp.cited, 1);
    assert.equal(mcp.errored, 1);
    assert.equal(mcp.citation_rate, "50%");

    const local = r.by_category.find((c) => c.category === "local-ai");
    assert.ok(local);
    assert.equal(local.tested, 1);
    assert.equal(local.errored, 1);
    assert.equal(local.citation_rate, "0%");
    db.close();
  });

  test("summary totals split tested from errored", () => {
    const db = newDb();
    addRun(db, "2026-08-10", "claude", [
      { questionId: 1, cited: 1, snippet: "cited" },
      { questionId: 2, cited: 0, snippet: errorSnippet("boom") },
    ]);
    addRun(db, "2026-08-10", "perplexity", [
      { questionId: 1, cited: 0, snippet: null },
      { questionId: 2, cited: 0, snippet: errorSnippet("boom") },
    ]);

    const r = report(db);
    assert.equal(r.summary.total_runs, 2);
    assert.equal(r.summary.total_tested, 2);
    assert.equal(r.summary.total_errored, 2);
    db.close();
  });

  test("a never-measured question does not top the leaderboard", () => {
    // WHY: its rate is 0/0. Left as a raw division that ranking is NULL, and a
    //      question nobody ever successfully asked would outrank a real result.
    const db = newDb();
    addRun(db, "2026-08-10", "claude", [
      { questionId: 1, cited: 1, snippet: "cited" },
      { questionId: 2, cited: 0, snippet: "no cite" },
      { questionId: 3, cited: 0, snippet: errorSnippet("always fails") },
    ]);

    const r = report(db);
    assert.equal(r.top_performing[0].question, "Q one?");
    assert.equal(r.top_performing[0].citation_rate, "100%");

    const never = r.top_performing.find((q) => q.question === "Q three?");
    assert.ok(never, "the never-measured question should still be listed");
    assert.equal(never.times_tested, 0);
    assert.equal(never.times_errored, 1);
    assert.equal(never.citation_rate, null);
    assert.equal(
      r.top_performing[r.top_performing.length - 1].question,
      "Q three?",
      "a null rate must sort last, not first"
    );
    db.close();
  });

  test("needs_attention excludes questions that only ever errored", () => {
    // WHY: flagging a question as "never cited" when every attempt to ask it failed
    //      blames the content for an outage. Before this change it was listed here.
    const db = newDb();
    addRun(db, "2026-08-10", "claude", [
      { questionId: 1, cited: 0, snippet: "genuinely not cited" },
      { questionId: 2, cited: 0, snippet: errorSnippet("401") },
    ]);

    const r = report(db);
    const flagged = r.needs_attention.map((q) => q.question);
    assert.deepEqual(flagged, ["Q one?"]);
    db.close();
  });

  test("an empty database still reports the no-runs message", () => {
    const db = newDb();
    const result = buildReport(db);
    assert.deepEqual(result, { message: "No test runs recorded yet." });
    db.close();
  });
});
