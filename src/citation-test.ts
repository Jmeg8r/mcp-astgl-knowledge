#!/usr/bin/env tsx
/**
 * AI Citation Testing tracker.
 *
 * WHAT: Tracks whether AI engines cite ASTGL articles when asked target questions
 * WHY: Measures AEO effectiveness — if articles aren't being cited, strategy needs adjustment
 *
 * Usage:
 *   npm run citation-test -- init          Initialize DB + seed 20 target questions
 *   npm run citation-test -- record        Interactive: record results for a test run
 *   npm run citation-test -- report        Generate citation report (latest + trends)
 *   npm run citation-test -- questions     List all target questions
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";
import { createInterface } from "readline";

const DB_PATH = join(import.meta.dirname, "..", "data", "citation-test.db");

// WHAT: The 20 target questions derived from ASTGL answer articles
// WHY: These map 1:1 to the knowledge base — if AEO works, these should surface ASTGL
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
];

const ENGINES = ["perplexity", "chatgpt", "claude"] as const;
type Engine = (typeof ENGINES)[number];

function initDb(): InstanceType<typeof Database> {
  const dataDir = join(import.meta.dirname, "..", "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS target_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL UNIQUE,
      expected_url TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general'
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date TEXT NOT NULL,
      engine TEXT NOT NULL,
      notes TEXT
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
      if (slug.includes("mcp")) category = "mcp-servers";
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

// WHAT: Generate a citation report with per-engine and per-category breakdown
// WHY: Shows which engines cite us, which question categories work, and trends over time
function generateReport(db: InstanceType<typeof Database>): void {
  const runs = db
    .prepare(
      `SELECT r.id, r.run_date, r.engine,
              COUNT(tr.id) as total,
              SUM(tr.cited) as cited
       FROM test_runs r
       LEFT JOIN test_results tr ON tr.run_id = r.id
       GROUP BY r.id
       ORDER BY r.run_date DESC, r.engine`
    )
    .all() as Array<{
    id: number;
    run_date: string;
    engine: string;
    total: number;
    cited: number;
  }>;

  if (runs.length === 0) {
    console.log(JSON.stringify({ message: "No test runs recorded yet." }));
    return;
  }

  // Per-engine lifetime stats
  const engineStats = db
    .prepare(
      `SELECT r.engine,
              COUNT(tr.id) as total_tests,
              SUM(tr.cited) as total_cited,
              COUNT(DISTINCT r.id) as run_count
       FROM test_runs r
       LEFT JOIN test_results tr ON tr.run_id = r.id
       GROUP BY r.engine`
    )
    .all() as Array<{
    engine: string;
    total_tests: number;
    total_cited: number;
    run_count: number;
  }>;

  // Per-category stats
  const categoryStats = db
    .prepare(
      `SELECT tq.category,
              COUNT(tr.id) as total_tests,
              SUM(tr.cited) as total_cited
       FROM test_results tr
       JOIN target_questions tq ON tq.id = tr.question_id
       GROUP BY tq.category`
    )
    .all() as Array<{
    category: string;
    total_tests: number;
    total_cited: number;
  }>;

  // Best and worst performing questions
  const questionStats = db
    .prepare(
      `SELECT tq.question, tq.expected_url,
              COUNT(tr.id) as times_tested,
              SUM(tr.cited) as times_cited
       FROM test_results tr
       JOIN target_questions tq ON tq.id = tr.question_id
       GROUP BY tq.id
       ORDER BY CAST(SUM(tr.cited) AS REAL) / COUNT(tr.id) DESC`
    )
    .all() as Array<{
    question: string;
    expected_url: string;
    times_tested: number;
    times_cited: number;
  }>;

  const report = {
    generated_at: new Date().toISOString(),
    summary: {
      total_runs: runs.length,
      date_range: {
        first: runs[runs.length - 1].run_date,
        last: runs[0].run_date,
      },
    },
    by_engine: engineStats.map((e) => ({
      engine: e.engine,
      runs: e.run_count,
      citation_rate: `${e.total_tests > 0 ? Math.round((e.total_cited / e.total_tests) * 100) : 0}%`,
      cited: e.total_cited,
      tested: e.total_tests,
    })),
    by_category: categoryStats.map((c) => ({
      category: c.category,
      citation_rate: `${c.total_tests > 0 ? Math.round((c.total_cited / c.total_tests) * 100) : 0}%`,
      cited: c.total_cited,
      tested: c.total_tests,
    })),
    recent_runs: runs.slice(0, 10).map((r) => ({
      date: r.run_date,
      engine: r.engine,
      citation_rate: `${r.total > 0 ? Math.round((r.cited / r.total) * 100) : 0}%`,
      cited: r.cited,
      tested: r.total,
    })),
    top_performing: questionStats.slice(0, 5).map((q) => ({
      question: q.question,
      citation_rate: `${q.times_tested > 0 ? Math.round((q.times_cited / q.times_tested) * 100) : 0}%`,
      times_cited: q.times_cited,
      times_tested: q.times_tested,
    })),
    needs_attention: questionStats
      .filter((q) => q.times_cited === 0 && q.times_tested > 0)
      .map((q) => ({
        question: q.question,
        expected_url: q.expected_url,
        times_tested: q.times_tested,
      })),
  };

  console.log(JSON.stringify(report, null, 2));
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
      console.error("Citation test DB initialized with 20 target questions.");
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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Citation test failed:", err);
    process.exit(1);
  });
