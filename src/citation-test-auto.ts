#!/usr/bin/env tsx
/**
 * Automated AI Citation Testing — Tier C (all 3 engines via API).
 *
 * WHAT: Programmatically asks the 20 target questions to Perplexity, Claude,
 *       and ChatGPT, parses the cited URLs from each response, and records
 *       whether astgl.ai was cited.
 * WHY: Replaces the ~45min manual workflow in citation-test.ts with a ~2min
 *      automated run. Manual flow remains available as a fallback.
 *
 * Usage:
 *   npm run citation-test-auto -- weekly                  Run all 3 engines
 *   npm run citation-test-auto -- record-perplexity       One engine only
 *   npm run citation-test-auto -- record-claude
 *   npm run citation-test-auto -- record-chatgpt
 *
 * Requires PERPLEXITY_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY in .env.
 */

import { join } from "path";
import { readFileSync, existsSync } from "fs";
import Database from "better-sqlite3";

// WHAT: Load .env from project root before reading process.env.
// WHY: Node's --env-file flag silently drops some values (observed with
//      Anthropic-style keys); a direct parse is more reliable.
function loadEnvFile(): void {
  const path = join(import.meta.dirname, "..", ".env");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    let value = rawValue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile();

const DB_PATH = join(import.meta.dirname, "..", "data", "citation-test.db");
const ASTGL_HOST = "astgl.ai";
const RATE_LIMIT_DELAY_MS = 1500;

type Engine = "perplexity" | "claude" | "chatgpt";

interface QueryResult {
  cited: boolean;
  citedUrl: string | null;
  position: number | null;
  snippet: string | null;
}

interface Question {
  id: number;
  question: string;
  expected_url: string;
}

function openDb(): InstanceType<typeof Database> {
  const db = new Database(DB_PATH);
  // WHAT: Add `method` column if missing.
  // WHY: Distinguishes API-recorded runs from the legacy interactive ones in
  //      reports. SQLite has no ALTER TABLE IF NOT EXISTS, so probe schema first.
  const cols = db.prepare("PRAGMA table_info(test_runs)").all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === "method")) {
    db.exec("ALTER TABLE test_runs ADD COLUMN method TEXT DEFAULT 'manual'");
  }
  return db;
}

function getQuestions(db: InstanceType<typeof Database>): Question[] {
  return db
    .prepare("SELECT id, question, expected_url FROM target_questions ORDER BY id")
    .all() as Question[];
}

function findAstglInUrls(urls: string[]): { citedUrl: string | null; position: number | null } {
  for (let i = 0; i < urls.length; i++) {
    if (urls[i].includes(ASTGL_HOST)) {
      return { citedUrl: urls[i], position: i + 1 };
    }
  }
  return { citedUrl: null, position: null };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// WHAT: Perplexity Sonar — chat completions with citations array.
// WHY: Sonar models always do web search and return `citations: string[]`.
async function queryPerplexity(question: string): Promise<QueryResult> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set");

  const model = process.env.PERPLEXITY_MODEL || "sonar";
  const res = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: question }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Perplexity ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    citations?: string[];
    choices?: Array<{ message?: { content?: string } }>;
  };

  const urls = data.citations || [];
  const { citedUrl, position } = findAstglInUrls(urls);
  const snippet = data.choices?.[0]?.message?.content?.slice(0, 500) || null;

  return { cited: citedUrl !== null, citedUrl, position, snippet };
}

// WHAT: Claude with web_search server tool. Citations appear in the response
//       content as web_search_tool_result blocks (search results) and as
//       citations attached to text blocks.
// WHY: Server-tool variant — Anthropic runs the search, we just parse URLs.
async function queryClaude(question: string): Promise<QueryResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const model = process.env.ANTHROPIC_MODEL || "claude-opus-4-7";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }],
      messages: [{ role: "user", content: question }],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    content?: Array<{
      type: string;
      text?: string;
      content?: Array<{ url?: string; title?: string }>;
      citations?: Array<{ url?: string }>;
    }>;
  };

  const urls: string[] = [];
  let textOut = "";
  for (const block of data.content || []) {
    if (block.type === "text" && block.text) {
      textOut += block.text;
      for (const c of block.citations || []) {
        if (c.url) urls.push(c.url);
      }
    } else if (block.type === "web_search_tool_result" && block.content) {
      for (const r of block.content) {
        if (r.url) urls.push(r.url);
      }
    }
  }

  const { citedUrl, position } = findAstglInUrls(urls);
  return { cited: citedUrl !== null, citedUrl, position, snippet: textOut.slice(0, 500) || null };
}

// WHAT: OpenAI Responses API with web_search_preview tool. URL citations come
//       back as annotations with type "url_citation" on output_text items.
// WHY: gpt-4o supports web search natively; annotations expose cited URLs.
async function queryChatGPT(question: string): Promise<QueryResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const model = process.env.OPENAI_MODEL || "gpt-4o";

  // WHAT: Retry with exponential backoff on 5xx and 429.
  // WHY: web_search_preview occasionally 500s on the same prompt; one retry
  //      after a short wait usually succeeds.
  let res: Response | null = null;
  let lastBody = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(2000 * attempt);
    res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search_preview" }],
        input: question,
      }),
    });
    if (res.ok) break;
    lastBody = await res.text();
    if (res.status < 500 && res.status !== 429) break;
  }

  if (!res || !res.ok) {
    throw new Error(`OpenAI ${res?.status}: ${lastBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    output?: Array<{
      type: string;
      content?: Array<{
        type: string;
        text?: string;
        annotations?: Array<{ type: string; url?: string }>;
      }>;
    }>;
  };

  const urls: string[] = [];
  let textOut = "";
  for (const item of data.output || []) {
    if (item.type !== "message" || !item.content) continue;
    for (const c of item.content) {
      if (c.type === "output_text" && c.text) textOut += c.text;
      for (const a of c.annotations || []) {
        if (a.type === "url_citation" && a.url) urls.push(a.url);
      }
    }
  }

  const { citedUrl, position } = findAstglInUrls(urls);
  return { cited: citedUrl !== null, citedUrl, position, snippet: textOut.slice(0, 500) || null };
}

const ENGINE_FNS: Record<Engine, (q: string) => Promise<QueryResult>> = {
  perplexity: queryPerplexity,
  claude: queryClaude,
  chatgpt: queryChatGPT,
};

async function runEngine(engine: Engine, db: InstanceType<typeof Database>): Promise<void> {
  const today = new Date().toISOString().split("T")[0];
  const questions = getQuestions(db);

  const runStmt = db.prepare(
    "INSERT INTO test_runs (run_date, engine, notes, method) VALUES (?, ?, ?, 'api')"
  );
  const runId = runStmt.run(today, engine, `automated run via ${engine} API`).lastInsertRowid;

  const insertResult = db.prepare(
    `INSERT INTO test_results (run_id, question_id, cited, cited_url, position, snippet)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  console.error(`\n=== ${engine.toUpperCase()} (run #${runId}) ===`);
  let cited = 0;
  let errors = 0;

  for (const q of questions) {
    process.stderr.write(`Q${q.id}: ${q.question.slice(0, 60)}...  `);
    try {
      const result = await ENGINE_FNS[engine](q.question);
      insertResult.run(runId, q.id, result.cited ? 1 : 0, result.citedUrl, result.position, result.snippet);
      if (result.cited) {
        cited++;
        console.error(`✓ cited (pos ${result.position})`);
      } else {
        console.error("✗");
      }
    } catch (err) {
      errors++;
      console.error(`ERROR: ${(err as Error).message.slice(0, 100)}`);
      insertResult.run(runId, q.id, 0, null, null, `ERROR: ${(err as Error).message}`);
    }
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  const tested = questions.length - errors;
  const rate = tested > 0 ? Math.round((cited / tested) * 100) : 0;
  console.error(`\n${engine}: ${cited}/${tested} cited (${rate}%) — ${errors} errors`);

  // WHAT: If every question errored, the run is broken (e.g. a 401 auth failure),
  //       not a legitimate 0% citation result. Roll back the inserted rows and
  //       throw so the run fails loudly with a non-zero exit.
  // WHY: test_results rows with cited=0 are counted as "tested" by the report in
  //      citation-test.ts, so a fully-failed run otherwise masquerades as real
  //      "0% / tested 20" data and silently skews historical AEO reporting.
  if (questions.length > 0 && errors === questions.length) {
    db.prepare("DELETE FROM test_results WHERE run_id = ?").run(runId);
    db.prepare("DELETE FROM test_runs WHERE id = ?").run(runId);
    throw new Error(
      `${engine}: all ${errors} queries failed — run #${runId} discarded (check API keys / connectivity)`
    );
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const db = openDb();

  try {
    switch (cmd) {
      case "weekly":
        await runEngine("perplexity", db);
        await runEngine("claude", db);
        await runEngine("chatgpt", db);
        console.error("\n✓ Weekly run complete. View report: npm run citation-test -- report");
        break;
      case "record-perplexity":
        await runEngine("perplexity", db);
        break;
      case "record-claude":
        await runEngine("claude", db);
        break;
      case "record-chatgpt":
        await runEngine("chatgpt", db);
        break;
      default:
        console.error(
          "Usage: npm run citation-test-auto -- <weekly|record-perplexity|record-claude|record-chatgpt>"
        );
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
