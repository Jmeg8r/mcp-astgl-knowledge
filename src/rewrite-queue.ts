#!/usr/bin/env tsx
/**
 * Daily ASTGL stale-article rewrite queue.
 *
 * WHAT: Picks the oldest stale article (subject to in-flight + cooldown filters),
 *       runs the two-pass rewriter, writes the draft to disk, inserts a row in
 *       rewrite_jobs, and posts a Telegram approval message with inline buttons.
 *
 * WHY:  Drains the 67-article freshness backlog automatically while keeping the
 *       human in the loop on publish.
 *
 * Usage:
 *   npm run rewrite-queue                        # picks 1 article, full pipeline
 *   npm run rewrite-queue:dev -- --dry-run       # picks but does not call models
 *   npm run rewrite-queue:dev -- --limit 3       # process up to 3 articles
 *   npm run rewrite-queue:dev -- --article-url <url>  # force a specific article
 *
 * Env:
 *   ANTHROPIC_API_KEY            (required for live runs)
 *   OLLAMA_BASE_URL              (default http://localhost:11434)
 *   OLLAMA_REWRITE_MODEL         (default qwen3:32b-fast)
 *   ASTGL_DRAFTS_DIR             (default /Volumes/Research/ASTGL Articles/Drafts)
 *   TELEGRAM_BOT_TOKEN           (required to send approval pings; skipped if absent)
 *   TELEGRAM_CHAT_ID             (single chat id for the approval ping)
 *   TELEGRAM_THREAD_ID           (optional forum-topic thread id)
 */

import "dotenv/config";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import {
  initKnowledgeDb,
  getStaleArticles,
  assembleArticleBody,
  type StaleArticleRow,
} from "./knowledge-db.js";
import {
  createRewriteJob,
  getBlockedArticleUrls,
  setTelegramRouting,
  markFailed,
} from "./db-rewrite-jobs.js";
import { rewriteArticle, type RewriteInput } from "./rewriter.js";

// WHAT: Rewrite drafts are written under the Research drive drafts archive.
// WHY:  The drafts archive was relocated off the repo (substack retired,
//       2026-07-13) to /Volumes/Research/ASTGL Articles/Drafts — canonical for
//       the whole draft pipeline (ingest + reconcile share this default).
//       Override with ASTGL_DRAFTS_DIR if the path differs.
const DEFAULT_DRAFTS_DIR = "/Volumes/Research/ASTGL Articles/Drafts";

interface CliFlags {
  dryRun: boolean;
  limit: number;
  articleUrl: string | null;
}

function parseArgs(): CliFlags {
  const args = process.argv.slice(2);
  let limit = 1;
  let articleUrl: string | null = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--limit") {
      limit = parseInt(args[++i] ?? "1", 10);
      if (Number.isNaN(limit) || limit < 1) limit = 1;
    } else if (arg === "--article-url") {
      articleUrl = args[++i] ?? null;
    }
  }
  return { dryRun, limit, articleUrl };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildFrontmatter(
  input: RewriteInput,
  jobId: number,
  rewrittenAt: string
): string {
  const yearMonth = rewrittenAt.slice(0, 7);
  const updatedTitle = input.title.includes("(Updated")
    ? input.title
    : `${input.title} (Updated ${yearMonth})`;
  const description = (input.description ?? "Rewritten for freshness.")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .trim()
    .slice(0, 240);

  return [
    "---",
    `title: "${updatedTitle.replace(/"/g, '\\"')}"`,
    `description: "${description}"`,
    `original_url: "${input.url}"`,
    `original_pub_date: "${input.pub_date ?? "unknown"}"`,
    `rewritten_at: "${rewrittenAt}"`,
    `rewrite_job_id: ${jobId}`,
    `voice: astgl`,
    "---",
    "",
  ].join("\n");
}

interface TelegramSendResult {
  message_id: number;
  chat_id: string;
  thread_id: number | null;
}

async function sendTelegramApproval(
  jobId: number,
  input: RewriteInput,
  draftPath: string,
  output: { ollama_chars: number; claude_chars: number; ollama_ms: number; claude_ms: number }
): Promise<TelegramSendResult | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const threadId = process.env.TELEGRAM_THREAD_ID
    ? parseInt(process.env.TELEGRAM_THREAD_ID, 10)
    : null;

  if (!token || !chatId) {
    console.error(
      "  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping approval ping"
    );
    return null;
  }

  const ageDays = input.pub_date
    ? Math.floor(
        (Date.now() - new Date(input.pub_date).getTime()) / (1000 * 60 * 60 * 24)
      )
    : null;

  const body = [
    `📝 Rewrite ready for review (job #${jobId})`,
    ``,
    `Title: ${input.title}`,
    `Original URL: ${input.url}`,
    ageDays !== null ? `Original age: ${ageDays} days` : null,
    ``,
    `Draft: ${draftPath}`,
    `Sizes: ollama ${output.ollama_chars}c (${(output.ollama_ms / 1000).toFixed(1)}s)`,
    `       claude ${output.claude_chars}c (${(output.claude_ms / 1000).toFixed(1)}s)`,
    ``,
    `Tap Approve to publish to Substack as a draft.`,
  ]
    .filter((l) => l !== null)
    .join("\n");

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `astgl-rw:approve:${jobId}` },
        { text: "❌ Reject", callback_data: `astgl-rw:reject:${jobId}` },
      ],
      [{ text: "📄 View draft", callback_data: `astgl-rw:view:${jobId}` }],
    ],
  };

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: body,
    reply_markup,
  };
  if (threadId !== null) payload.message_thread_id = threadId;

  const resp = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(
      `telegram sendMessage failed: ${resp.status} ${errBody.slice(0, 300)}`
    );
  }

  const data = (await resp.json()) as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };
  if (!data.ok || !data.result) {
    throw new Error(`telegram sendMessage rejected: ${data.description ?? "unknown"}`);
  }
  return { message_id: data.result.message_id, chat_id: chatId, thread_id: threadId };
}

interface ProcessResult {
  url: string;
  title: string;
  job_id: number | null;
  draft_path: string | null;
  status: "drafted" | "skipped" | "failed";
  error?: string;
}

async function processArticle(
  db: ReturnType<typeof initKnowledgeDb>,
  staleRow: StaleArticleRow,
  flags: CliFlags
): Promise<ProcessResult> {
  const assembled = assembleArticleBody(db, staleRow.url);
  if (!assembled || !assembled.body) {
    return {
      url: staleRow.url,
      title: staleRow.title,
      job_id: null,
      draft_path: null,
      status: "skipped",
      error: "no body chunks",
    };
  }

  const input: RewriteInput = {
    title: assembled.title,
    url: assembled.url,
    description: assembled.description,
    pub_date: assembled.pub_date,
    body: assembled.body,
  };

  if (flags.dryRun) {
    console.error(`  [dry-run] would rewrite: ${input.title}`);
    console.error(`  [dry-run] body chars: ${input.body.length}`);
    return {
      url: input.url,
      title: input.title,
      job_id: null,
      draft_path: null,
      status: "drafted",
    };
  }

  // Two-pass rewrite
  let output;
  try {
    output = await rewriteArticle(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  rewriter error: ${message}`);
    return {
      url: input.url,
      title: input.title,
      job_id: null,
      draft_path: null,
      status: "failed",
      error: message,
    };
  }

  // Write draft to disk
  const draftsDir = process.env.ASTGL_DRAFTS_DIR || DEFAULT_DRAFTS_DIR;
  // WHAT: Refuse to write if the drafts root is missing.
  // WHY:  The archive lives on the external Research drive. If it's unmounted,
  //       mkdirSync(recursive) below would create a PHANTOM local dir shadowing
  //       the mount point, and the draft would vanish on remount. Fail loudly.
  if (!existsSync(draftsDir)) {
    const message = `Drafts root not found: ${draftsDir} — external volume may be unmounted; refusing to write draft.`;
    console.error(`  ${message}`);
    return {
      url: input.url,
      title: input.title,
      job_id: null,
      draft_path: null,
      status: "failed",
      error: message,
    };
  }
  const today = new Date().toISOString().slice(0, 10);
  const slug = slugify(input.title) || `rewrite-${Date.now()}`;
  const dirName = `${today}-rewrite-${slug}`;
  const dirPath = join(draftsDir, dirName);
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  const draftPath = join(dirPath, "article.md");

  // Insert job row first so we have an ID for the frontmatter
  const jobId = createRewriteJob(db, input.url, draftPath);

  const rewrittenAt = new Date().toISOString();
  const frontmatter = buildFrontmatter(input, jobId, rewrittenAt);
  writeFileSync(draftPath, frontmatter + output.markdown + "\n");
  console.error(`  draft written: ${draftPath}`);

  // Telegram approval ping
  try {
    const sent = await sendTelegramApproval(jobId, input, draftPath, output);
    if (sent) {
      setTelegramRouting(db, jobId, sent.chat_id, sent.thread_id, sent.message_id);
      console.error(`  telegram message ${sent.message_id} sent to ${sent.chat_id}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  telegram ping failed (job stays pending): ${message}`);
    markFailed(db, jobId, `telegram ping failed: ${message}`);
    return {
      url: input.url,
      title: input.title,
      job_id: jobId,
      draft_path: draftPath,
      status: "failed",
      error: message,
    };
  }

  return {
    url: input.url,
    title: input.title,
    job_id: jobId,
    draft_path: draftPath,
    status: "drafted",
  };
}

async function main(): Promise<void> {
  const flags = parseArgs();
  console.error("=== ASTGL Stale-Article Rewrite Queue ===");
  console.error(
    `mode: ${flags.dryRun ? "DRY-RUN" : "LIVE"}, limit: ${flags.limit}` +
      (flags.articleUrl ? `, article: ${flags.articleUrl}` : "")
  );

  const db = initKnowledgeDb();

  const blocked = getBlockedArticleUrls(db);
  console.error(`  blocked URLs (in-flight or in-cooldown): ${blocked.length}`);

  let candidates: StaleArticleRow[];
  if (flags.articleUrl) {
    const row = db
      .prepare(
        `SELECT title, url,
                COALESCE(last_reviewed_at, pub_date, processed_at) as effective_date
         FROM articles WHERE url = ?`
      )
      .get(flags.articleUrl) as StaleArticleRow | undefined;
    if (!row) {
      console.error(`  article not found: ${flags.articleUrl}`);
      db.close();
      process.exit(1);
    }
    candidates = [row];
  } else {
    candidates = getStaleArticles(db, 90, blocked).slice(0, flags.limit);
  }

  console.error(`  candidates: ${candidates.length}`);
  if (candidates.length === 0) {
    console.error("  nothing to rewrite — backlog drained or all blocked");
    db.close();
    console.log(JSON.stringify({ processed: [], drained: true }, null, 2));
    return;
  }

  const results: ProcessResult[] = [];
  for (const row of candidates) {
    console.error(`\nprocessing: ${row.title}`);
    console.error(`  url: ${row.url}`);
    console.error(`  effective_date: ${row.effective_date}`);
    const result = await processArticle(db, row, flags);
    results.push(result);
  }

  db.close();
  console.log(JSON.stringify({ processed: results, drained: false }, null, 2));
  console.error(
    `\n=== Done: ${results.filter((r) => r.status === "drafted").length} drafted, ` +
      `${results.filter((r) => r.status === "failed").length} failed, ` +
      `${results.filter((r) => r.status === "skipped").length} skipped ===`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("rewrite-queue failed:", err);
    process.exit(1);
  });
