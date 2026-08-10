#!/usr/bin/env tsx
/**
 * AI Citation Testing tracker.
 *
 * WHAT: Tracks whether AI engines cite ASTGL articles when asked target questions
 * WHY: Measures AEO effectiveness — if articles aren't being cited, strategy needs adjustment
 *
 * Usage:
 *   npm run citation-test -- init          Initialize DB + seed target questions
 *   npm run citation-test -- record        Interactive: record results for a test run
 *   npm run citation-test -- report        Generate citation report (latest + trends)
 *   npm run citation-test -- questions     List all target questions
 */

import { dirname } from "path";
import { pathToFileURL } from "url";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";
import { createInterface } from "readline";

import {
  ERROR_SNIPPET_PATTERN,
  SQL_IS_ERROR_ROW,
  SQL_IS_TESTED_ROW,
} from "./citation-error-rows.js";
import { resolveCitationTestDbPath } from "./db-path.js";

// WHY resolveCitationTestDbPath rather than a join() here: CLAUDE.md's rule is
//      that nothing resolves a DB path directly — db-path.ts owns every one of
//      them, so citation-test-auto.ts cannot drift onto a different file.
const DB_PATH = resolveCitationTestDbPath();

// WHAT: Target questions derived from ASTGL content — astgl.ai answer articles
//       plus tools.astgl.ai "best AI tool for X" comparison pages.
// WHY: These map to published pages — if AEO works, these should surface ASTGL.
const TARGET_QUESTIONS: Array<{ question: string; expectedUrl: string }> = [
  { question: "What is an MCP server and how does it work?", expectedUrl: "https://astgl.ai/answers/what-is-an-mcp-server" },
  { question: "How do I build my first MCP server?", expectedUrl: "https://astgl.ai/answers/build-your-first-mcp-server" },
  { question: "How do I connect an MCP server to Claude or ChatGPT?", expectedUrl: "https://astgl.ai/answers/how-to-connect-mcp-server-to-claude" },
  { question: "What can MCP servers do that regular APIs can't?", expectedUrl: "https://astgl.ai/answers/what-can-mcp-servers-do-that-apis-cant" },
  { question: "What are the best MCP servers available right now?", expectedUrl: "https://astgl.ai/answers/best-mcp-servers-available-now" },
  { question: "How do MCP registries work?", expectedUrl: "https://astgl.ai/answers/how-mcp-registries-work" },
  { question: "What's the future of MCP servers in 2026?", expectedUrl: "https://astgl.ai/answers/future-of-mcp-servers-2026-2027" },
  { question: "Can small businesses benefit from MCP servers?", expectedUrl: "https://astgl.ai/answers/small-businesses-benefit-from-mcp-servers" },
  { question: "Can I use MCP servers without being a developer?", expectedUrl: "https://astgl.ai/answers/use-mcp-servers-without-being-developer" },
  { question: "How do I set up Ollama on Mac?", expectedUrl: "https://astgl.ai/answers/setup-ollama-mac-windows-linux" },
  { question: "Can I run AI models locally instead of using cloud APIs?", expectedUrl: "https://astgl.ai/answers/can-i-run-ai-models-locally" },
  { question: "What hardware do I need to run local LLMs?", expectedUrl: "https://astgl.ai/answers/what-hardware-do-i-need-for-local-llms" },
  { question: "What's the best local LLM for my specific task?", expectedUrl: "https://astgl.ai/answers/best-local-llm-for-specific-tasks" },
  { question: "How much does it cost to run AI locally vs cloud?", expectedUrl: "https://astgl.ai/answers/cost-of-running-ai-locally-vs-cloud" },
  { question: "Is it safe to run AI models on my own computer?", expectedUrl: "https://astgl.ai/answers/is-it-safe-to-run-ai-locally" },
  { question: "What's the ROI of local AI infrastructure?", expectedUrl: "https://astgl.ai/answers/roi-of-local-ai-infrastructure" },
  { question: "What is AI agent automation and how do I start?", expectedUrl: "https://astgl.ai/answers/what-is-ai-agent-automation" },
  { question: "How do I automate workflows with AI agents?", expectedUrl: "https://astgl.ai/answers/automate-workflows-with-ai-agents" },
  { question: "How do I automate business workflows with AI?", expectedUrl: "https://astgl.ai/answers/automate-business-workflows-with-ai" },
  { question: "How do I build an AI pipeline for content creation?", expectedUrl: "https://astgl.ai/answers/build-ai-pipeline-for-content-creation" },

  // tools.astgl.ai — "best AI tool for [dev use case]" comparison pages.
  // These target the programmatic comparison site, not the astgl.ai answer base.
  { question: "What's the best AI tool for code review?", expectedUrl: "https://tools.astgl.ai/use-cases/code-review" },
  { question: "What AI tool is best for finding security vulnerabilities in code?", expectedUrl: "https://tools.astgl.ai/use-cases/finding-security-vulnerabilities" },
  { question: "What's the best AI tool for pair programming?", expectedUrl: "https://tools.astgl.ai/use-cases/pair-programming" },
  { question: "Which AI tool is best for writing pull request descriptions?", expectedUrl: "https://tools.astgl.ai/use-cases/writing-pr-descriptions" },
  { question: "What's the best AI tool for writing unit tests?", expectedUrl: "https://tools.astgl.ai/use-cases/writing-unit-tests" },
  { question: "What's the best AI tool for refactoring legacy code?", expectedUrl: "https://tools.astgl.ai/use-cases/refactoring-legacy-code" },
  { question: "What AI tool helps with accessibility audits?", expectedUrl: "https://tools.astgl.ai/use-cases/accessibility-audits" },
  { question: "Is Kilo Code Reviewer good for code review?", expectedUrl: "https://tools.astgl.ai/kilo-kilo-code-reviewer/code-review" },
];

// Engines we manually test. "google" = Google AI Overviews (the AI answer box on
// Google Search) — the largest AI answer surface, per the AEO playbook.
const ENGINES = ["perplexity", "chatgpt", "claude", "google"] as const;
type Engine = (typeof ENGINES)[number];

// WHAT: Create the citation-test schema on an already-open database.
// WHY: Exported so tests build fixtures from the real DDL instead of a second copy
//      that drifts (Mistake #8) — the same reason knowledge-db.ts exports
//      runMigrations(). Idempotent: every statement is IF NOT EXISTS.
export function createSchema(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS target_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL UNIQUE,
      expected_url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general'
    )
  `);

  // WHY method lives here: citation-test-auto.ts writes this column and used to be
  //      the only place that defined it, via a PRAGMA-guarded ALTER. That made this
  //      function an INCOMPLETE copy of the live schema — the exact drift it claims
  //      to prevent — and left fixtures built from it missing a production column.
  //      Column order matches the live table, where method was appended by ALTER.
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT NOT NULL,
      engine TEXT NOT NULL,
      notes TEXT,
      method TEXT DEFAULT 'manual'
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS test_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES test_runs(id),
      question_id INTEGER NOT NULL REFERENCES target_questions(id),
      cited INTEGER NOT NULL DEFAULT 0,
      cited_url TEXT,
      position INTEGER,
      snippet TEXT,
      UNIQUE(run_id, question_id)
    )
  `);

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_results_run ON test_results(run_id)"
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_runs_date ON test_runs(run_date)"
  );
}

function initDb(): InstanceType<typeof Database> {
  // WHY dirname(DB_PATH): the directory to create is wherever the database
  //      actually resolves to. Hardcoding ../data would create the repo's data
  //      folder while opening a file somewhere else entirely under the seam.
  const dataDir = dirname(DB_PATH);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const db = new Database(DB_PATH);
  createSchema(db);
  return db;
}

function seedQuestions(db: InstanceType<typeof Database>): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO target_questions (question, expected_url, category) VALUES (?, ?, ?)"
  );

  const insertAll = db.transaction(() => {
    for (const q of TARGET_QUESTIONS) {
      // WHAT: Derive category from URL path segments
      // WHY: Groups questions by topic cluster for per-category reporting
      const slug = q.expectedUrl.split("/").pop() || "";
      let category = "general";
      // tools.astgl.ai comparison pages form their own reporting cluster.
      if (q.expectedUrl.includes("tools.astgl.ai")) category = "dev-tools";
      else if (slug.includes("mcp")) category = "mcp-servers";
      else if (
        slug.includes("ollama") ||
        slug.includes("local") ||
        slug.includes("hardware") ||
        slug.includes("llm") ||
        slug.includes("cost") ||
        slug.includes("safe") ||
        slug.includes("roi")
      )
        category = "local-ai";
      else if (
        slug.includes("automate") ||
        slug.includes("agent") ||
        slug.includes("pipeline")
      )
        category = "ai-automation";
      insert.run(q.question, q.expectedUrl, category);
    }
  });

  insertAll();
}

// WHAT: Prompt-based recording of test results
// WHY: Manual testing requires human input — this structures it into the DB
async function recordRun(db: InstanceType<typeof Database>): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  const today = new Date().toISOString().split("T")[0];

  console.error("\n=== ASTGL Citation Test Recording ===\n");
  console.error(`Date: ${today}`);
  console.error(`Engines: ${ENGINES.join(", ")}\n`);

  const engineChoice = await ask(
    `Which engine? (${ENGINES.join("/")}): `
  );
  const engine = engineChoice.trim().toLowerCase() as Engine;

  if (!ENGINES.includes(engine)) {
    console.error(`Invalid engine: ${engine}`);
    rl.close();
    return;
  }

  const notes = await ask("Run notes (optional): ");

  const run = db
    .prepare("INSERT INTO test_runs (run_date, engine, notes) VALUES (?, ?, ?)")
    .run(today, engine, notes || null);
  const runId = run.lastInsertRowid;

  const questions = db
    .prepare("SELECT id, question, expected_url FROM target_questions ORDER BY id")
    .all() as Array<{ id: number; question: string; expected_url: string }>;

  console.error(`\nRecording results for ${engine} (run #${runId})`);
  console.error("For each question: was ASTGL cited? (y/n/s to skip)\n");

  const insertResult = db.prepare(
    `INSERT INTO test_results (run_id, question_id, cited, cited_url, position, snippet)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  let cited = 0;
  let tested = 0;

  for (const q of questions) {
    console.error(`Q${q.id}: ${q.question}`);
    console.error(`   Expected: ${q.expected_url}`);
    const answer = await ask("   Cited? (y/n/s): ");
    const a = answer.trim().toLowerCase();

    if (a === "s") continue;

    tested++;
    const wasCited = a === "y" ? 1 : 0;
    if (wasCited) cited++;

    let citedUrl: string | null = null;
    let position: number | null = null;

    if (wasCited) {
      const urlInput = await ask("   Cited URL (Enter for expected): ");
      citedUrl = urlInput.trim() || q.expected_url;
      const posInput = await ask("   Position in results (1-10): ");
      position = posInput.trim() ? parseInt(posInput.trim(), 10) : null;
    }

    insertResult.run(runId, q.id, wasCited, citedUrl, position, null);
  }

  console.error(
    `\nRun #${runId} complete: ${cited}/${tested} cited (${tested > 0 ? Math.round((cited / tested) * 100) : 0}%)`
  );
  rl.close();
}

// --- Report ---

// WHAT: A citation rate, or null when nothing was actually measured.
// WHY: 0/0 must not render as "0%". A run whose every query failed and a run that
//      genuinely earned no citations are different facts, and a percentage cannot
//      tell them apart — the same reasoning publish-drift.ts uses for reporting an
//      unmeasured comparison as null rather than a zero delta (ADR-0001 amendment).
export type CitationRate = string | null;

interface RateBucket {
  citation_rate: CitationRate;
  cited: number;
  tested: number;
  errored: number;
}

export interface CitationReport {
  generated_at: string;
  summary: {
    total_runs: number;
    total_tested: number;
    total_errored: number;
    date_range: { first: string; last: string };
  };
  by_engine: Array<{ engine: string; runs: number } & RateBucket>;
  by_category: Array<{ category: string } & RateBucket>;
  recent_runs: Array<{ date: string; engine: string } & RateBucket>;
  top_performing: Array<{
    question: string;
    citation_rate: CitationRate;
    times_cited: number;
    times_tested: number;
    times_errored: number;
  }>;
  needs_attention: Array<{
    question: string;
    expected_url: string;
    times_tested: number;
  }>;
}

export type CitationReportResult = CitationReport | { message: string };

// WHAT: Render cited/tested as a percentage string, or null when tested is zero.
// WHY: See CitationRate — the null is the signal that the denominator is empty.
function formatRate(cited: number, tested: number): CitationRate {
  return tested > 0 ? `${Math.round((cited / tested) * 100)}%` : null;
}

// WHAT: Count a test_results row only if it recorded a real answer.
// WHY: citation-test-auto.ts inserts cited=0 with an ERROR: snippet when an engine
//      query throws, so an auth outage or a parse crash lands in the same column as
//      a measured non-citation. Counting those as tests deflated every rate the
//      report emitted: on 2026-08-10 the production DB held 184 such rows out of
//      745 (25%), including nine runs that were 100% errors and still reported
//      "0% cited, tested 20". Errors are subtracted from the denominator AND
//      reported as `errored`, because subtracting alone leaves those nine runs at
//      tested=0 — which reads as 0% again unless the failure is named.
const TESTED_ROWS = `SUM(CASE WHEN ${SQL_IS_TESTED_ROW} THEN 1 ELSE 0 END)`;
const CITED_ROWS = `SUM(CASE WHEN ${SQL_IS_TESTED_ROW} THEN tr.cited ELSE 0 END)`;
const ERRORED_ROWS = `SUM(CASE WHEN ${SQL_IS_ERROR_ROW} THEN 1 ELSE 0 END)`;

interface RunRow {
  id: number;
  run_date: string;
  engine: string;
  tested: number;
  cited: number;
  errored: number;
}

// WHAT: Build the citation report with per-engine and per-category breakdown.
// WHY: Separated from printing so tests can assert on the numbers instead of
//      parsing stdout — and so the ERROR-row accounting above is checkable.
export function buildReport(
  db: InstanceType<typeof Database>
): CitationReportResult {
  // WHY: bound once and passed to every query, so the reader's notion of an error
  //      row is literally the writer's constant.
  const params = { errPattern: ERROR_SNIPPET_PATTERN };

  const runs = db
    .prepare(
      `SELECT r.id, r.run_date, r.engine,
              ${TESTED_ROWS} as tested,
              ${CITED_ROWS} as cited,
              ${ERRORED_ROWS} as errored
       FROM test_runs r
       LEFT JOIN test_results tr ON tr.run_id = r.id
       GROUP BY r.id
       ORDER BY r.run_date DESC, r.engine`
    )
    .all(params) as RunRow[];

  if (runs.length === 0) {
    return { message: "No test runs recorded yet." };
  }

  // Per-engine lifetime stats
  const engineStats = db
    .prepare(
      `SELECT r.engine,
              ${TESTED_ROWS} as total_tests,
              ${CITED_ROWS} as total_cited,
              ${ERRORED_ROWS} as total_errored,
              COUNT(DISTINCT r.id) as run_count
       FROM test_runs r
       LEFT JOIN test_results tr ON tr.run_id = r.id
       GROUP BY r.engine`
    )
    .all(params) as Array<{
    engine: string;
    total_tests: number;
    total_cited: number;
    total_errored: number;
    run_count: number;
  }>;

  // Per-category stats
  const categoryStats = db
    .prepare(
      `SELECT tq.category,
              ${TESTED_ROWS} as total_tests,
              ${CITED_ROWS} as total_cited,
              ${ERRORED_ROWS} as total_errored
       FROM test_results tr
       JOIN target_questions tq ON tq.id = tr.question_id
       GROUP BY tq.category`
    )
    .all(params) as Array<{
    category: string;
    total_tests: number;
    total_cited: number;
    total_errored: number;
  }>;

  // Best and worst performing questions
  // WHY NULLIF: a question whose every attempt errored has a zero denominator. In
  //      SQLite the resulting NULL sorts last under DESC, so a never-measured
  //      question sinks to the bottom instead of topping the leaderboard.
  const questionStats = db
    .prepare(
      `SELECT tq.question, tq.expected_url,
              ${TESTED_ROWS} as times_tested,
              ${CITED_ROWS} as times_cited,
              ${ERRORED_ROWS} as times_errored
       FROM test_results tr
       JOIN target_questions tq ON tq.id = tr.question_id
       GROUP BY tq.id
       ORDER BY CAST(${CITED_ROWS} AS REAL) / NULLIF(${TESTED_ROWS}, 0) DESC`
    )
    .all(params) as Array<{
    question: string;
    expected_url: string;
    times_tested: number;
    times_cited: number;
    times_errored: number;
  }>;

  return {
    generated_at: new Date().toISOString(),
    summary: {
      total_runs: runs.length,
      total_tested: runs.reduce((sum, r) => sum + r.tested, 0),
      total_errored: runs.reduce((sum, r) => sum + r.errored, 0),
      date_range: {
        first: runs[runs.length - 1].run_date,
        last: runs[0].run_date,
      },
    },
    by_engine: engineStats.map((e) => ({
      engine: e.engine,
      runs: e.run_count,
      citation_rate: formatRate(e.total_cited, e.total_tests),
      cited: e.total_cited,
      tested: e.total_tests,
      errored: e.total_errored,
    })),
    by_category: categoryStats.map((c) => ({
      category: c.category,
      citation_rate: formatRate(c.total_cited, c.total_tests),
      cited: c.total_cited,
      tested: c.total_tests,
      errored: c.total_errored,
    })),
    recent_runs: runs.slice(0, 10).map((r) => ({
      date: r.run_date,
      engine: r.engine,
      citation_rate: formatRate(r.cited, r.tested),
      cited: r.cited,
      tested: r.tested,
      errored: r.errored,
    })),
    top_performing: questionStats.slice(0, 5).map((q) => ({
      question: q.question,
      citation_rate: formatRate(q.times_cited, q.times_tested),
      times_cited: q.times_cited,
      times_tested: q.times_tested,
      times_errored: q.times_errored,
    })),
    // WHY times_tested > 0 still: a question that only ever errored has never been
    //      measured, so flagging it as "never cited" would blame the content for an
    //      outage. Before this change those questions were listed here.
    needs_attention: questionStats
      .filter((q) => q.times_cited === 0 && q.times_tested > 0)
      .map((q) => ({
        question: q.question,
        expected_url: q.expected_url,
        times_tested: q.times_tested,
      })),
  };
}

function generateReport(db: InstanceType<typeof Database>): void {
  console.log(JSON.stringify(buildReport(db), null, 2));
}

function listQuestions(db: InstanceType<typeof Database>): void {
  const questions = db
    .prepare(
      "SELECT id, question, expected_url, category FROM target_questions ORDER BY category, id"
    )
    .all() as Array<{
    id: number;
    question: string;
    expected_url: string;
    category: string;
  }>;

  let currentCategory = "";
  for (const q of questions) {
    if (q.category !== currentCategory) {
      currentCategory = q.category;
      console.error(`\n=== ${currentCategory.toUpperCase()} ===`);
    }
    console.error(`  ${q.id}. ${q.question}`);
    console.error(`     → ${q.expected_url}`);
  }
  console.error(`\nTotal: ${questions.length} target questions`);
}

async function main() {
  const command = process.argv[2];

  if (!command || !["init", "record", "report", "questions"].includes(command)) {
    console.error("Usage: npm run citation-test -- <init|record|report|questions>");
    process.exit(1);
  }

  const db = initDb();

  switch (command) {
    case "init":
      seedQuestions(db);
      console.error(`Citation test DB initialized with ${TARGET_QUESTIONS.length} target questions.`);
      listQuestions(db);
      break;
    case "record":
      await recordRun(db);
      break;
    case "report":
      generateReport(db);
      break;
    case "questions":
      listQuestions(db);
      break;
  }

  db.close();
}

// WHAT: Run main() only when this file is the process entry point.
// WHY: buildReport() is imported by the test suite, and an unguarded main() runs on
//      import — with no argv[2] it prints usage and calls process.exit(1), killing
//      the test process before a single assertion executes. The same guard, for the
//      same reason, as src/prune-backups.ts. A deliberate deviation from the repo's
//      self-executing convention, which assumed nothing imports these modules.
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Citation test failed:", err);
      process.exit(1);
    });
}
