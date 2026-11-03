#!/usr/bin/env tsx
/**
 * Weekly ASTGL answer-page rewrite queue (local models only).
 *
 * WHAT: Resolves open rewrites against astgl-site, picks the stalest astgl.ai answer
 *       page, claims it, rewrites its body on local Ollama models, runs the claim
 *       check, commits the page to a new LOCAL branch in the job's astgl-site
 *       worktree, and sends one review notice to Telegram and Slack.
 *
 * WHY:  Keeps the 20 answer pages fresh while James stays the only path to
 *       publication: he pushes the branch, opens the PR, and merging publishes
 *       (2026-11-03-astgl-local-rewrite). The job never pushes and makes no cloud
 *       model call.
 *
 * Usage:
 *   npm run rewrite-queue                          # one page, full pipeline
 *   npm run rewrite-queue:dev -- --dry-run         # list the pick; no claim, no model
 *   npm run rewrite-queue:dev -- --limit 2         # up to 2 pages
 *   npm run rewrite-queue:dev -- --article-url <url>  # a specific answer page
 *
 * Exit codes: 0 every item drafted (or nothing to do) and every notice sent;
 *             1 any item failed, any notice failed, or a forced URL was refused.
 *
 * Env:
 *   ASTGL_SITE_WORKTREE    the job's astgl-site worktree (default: <repo>/.rewrite-site)
 *   OLLAMA_BASE_URL        local Ollama host (default http://localhost:11434; must be local)
 *   OLLAMA_REWRITE_MODEL   draft pass model (default qwen3-coder:30b)
 *   OLLAMA_VOICE_MODEL     voice pass model (default astgl-voice:7b-v1.5)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_THREAD_ID (optional)
 *   SLACK_WEBHOOK_URL      Slack incoming webhook (a credential)
 */

import "dotenv/config";
import { existsSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import type Database from "better-sqlite3";

import { initKnowledgeDb } from "./knowledge-db.js";
import {
  claimJob,
  failAbandonedDrafts,
  getBlockedArticleUrls,
  getOpenSiteJobs,
  markFailed,
  markRejected,
  markSitePublished,
  recordSiteCommit,
} from "./db-rewrite-jobs.js";
import {
  DEFAULT_DRAFT_MODEL,
  DEFAULT_VOICE_MODEL,
  rewritePage,
  splitFrontmatter,
  type RewriteOptions,
  type RewriteResult,
} from "./rewriter.js";
import { checkClaims, datedFacts } from "./claim-check.js";
import {
  commitPage,
  fetchSite,
  listAnswerPages,
  readMainPage,
  resolveJob,
  staleCandidates,
  type AnswerPage,
} from "./site-worktree.js";
import { notifyAll, type ChannelResult } from "./notify.js";

const STALE_THRESHOLD_DAYS = 90;
// A real rewrite finishes within one run; a claim older than this was abandoned.
const ABANDONED_DRAFT_MS = 2 * 60 * 60 * 1000;
const ERROR_CHARS = 2000;
// Only external tool versions count as verified facts; the publish-gap check tracks
// this package's own version, which no answer page should cite.
const VERIFIED_FACT_CHECK_TYPES = ["npm_version_check", "github_release_check"];

export interface QueueDeps {
  db: InstanceType<typeof Database>;
  siteDir: string;
  now: Date;
  limit: number;
  articleUrl: string | null;
  dryRun: boolean;
  draftModel: string;
  voiceModel: string;
  rewrite: (page: string, opts: RewriteOptions) => Promise<RewriteResult>;
  notify: (text: string) => Promise<ChannelResult[]>;
}

export interface ItemResult {
  url: string;
  job_id: number | null;
  branch: string | null;
  status: "drafted" | "would_rewrite" | "refused" | "failed";
  error?: string;
  notices?: ChannelResult[];
}

export interface QueueSummary {
  resolved: { published: number; rejected: number; abandoned: number };
  processed: ItemResult[];
  drained: boolean;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, ERROR_CHARS);
}

function verifiedFacts(db: InstanceType<typeof Database>): string[] {
  const placeholders = VERIFIED_FACT_CHECK_TYPES.map(() => "?").join(",");
  return db
    .prepare(`SELECT current_version FROM ecosystem_snapshots WHERE check_type IN (${placeholders})`)
    .pluck()
    .all(...VERIFIED_FACT_CHECK_TYPES) as string[];
}

// WHAT: Close out open jobs from git and fail abandoned claims, before selecting.
function resolveOpenJobs(deps: QueueDeps): QueueSummary["resolved"] {
  const resolved = { published: 0, rejected: 0, abandoned: 0 };
  resolved.abandoned = failAbandonedDrafts(deps.db, new Date(deps.now.getTime() - ABANDONED_DRAFT_MS));
  for (const job of getOpenSiteJobs(deps.db)) {
    const slug = job.article_url.split("/").pop() ?? "";
    const outcome = resolveJob(deps.siteDir, job.site_branch, job.site_commit, `src/content/answers/${slug}.md`);
    if (outcome === "published") {
      markSitePublished(deps.db, job.id);
      resolved.published++;
    } else if (outcome === "rejected") {
      markRejected(deps.db, job.id);
      resolved.rejected++;
    }
  }
  return resolved;
}

function reviewNotice(page: AnswerPage, branch: string, siteDir: string, facts: string[]): string {
  return [
    `ASTGL rewrite ready for review: ${page.slug}`,
    `Page: ${page.url}`,
    `Branch: ${branch} (local only, not pushed)`,
    facts.length > 0
      ? `Check these dated facts before merging: ${facts.join(", ")}`
      : "No dated facts found to check.",
    "",
    "To publish, push the branch and open a PR:",
    `git -C ${siteDir} push origin ${branch}`,
    "To reject, delete the branch (and close the PR if you opened one).",
  ].join("\n");
}

async function processPage(deps: QueueDeps, page: AnswerPage, facts: string[]): Promise<ItemResult> {
  if (deps.dryRun) {
    console.error(`  [dry-run] would rewrite: ${page.url} (dated ${page.date})`);
    return { url: page.url, job_id: null, branch: null, status: "would_rewrite" };
  }

  const claim = claimJob(deps.db, page.url, deps.now);
  if (!claim.ok) {
    console.error(`  claim refused for ${page.url}: ${claim.reason}`);
    return { url: page.url, job_id: null, branch: null, status: "refused", error: claim.reason };
  }

  const date = deps.now.toISOString().slice(0, 10);
  try {
    const original = readMainPage(deps.siteDir, page.path);
    const result = await deps.rewrite(original, {
      draftModel: deps.draftModel,
      voiceModel: deps.voiceModel,
      date,
    });

    const added = checkClaims(splitFrontmatter(original).body, splitFrontmatter(result.page).body, facts).added;
    if (added.length > 0) {
      throw new Error(`claim check: rewrite added unsupported tokens: ${added.join(", ")}`);
    }

    const toCheck = datedFacts(splitFrontmatter(original).body);
    const message = [
      `content(answers): local rewrite of ${page.slug}`,
      "",
      `Rewritten by the weekly rewrite queue (job ${claim.id}) on local models`,
      `${deps.draftModel} and ${deps.voiceModel}. Facts are unchanged from the original.`,
      toCheck.length > 0 ? `Check these dated facts before merging: ${toCheck.join(", ")}` : "",
    ].join("\n");
    const site = commitPage(deps.siteDir, page.slug, result.page, date, message);
    recordSiteCommit(deps.db, claim.id, site.branch, site.commit, site.pagePath);
    console.error(`  committed ${site.branch} (${site.commit.slice(0, 8)})`);

    const notices = await deps.notify(reviewNotice(page, site.branch, deps.siteDir, toCheck));
    const failed = notices.filter((n) => !n.ok);
    for (const n of failed) console.error(`  ${n.channel} notice failed: ${n.ok ? "" : n.error}`);
    return {
      url: page.url,
      job_id: claim.id,
      branch: site.branch,
      status: "drafted",
      notices,
      ...(failed.length > 0 ? { error: "one or more notices failed" } : {}),
    };
  } catch (err) {
    const message = errorText(err);
    console.error(`  rewrite failed for ${page.url}: ${message}`);
    markFailed(deps.db, claim.id, message);
    return { url: page.url, job_id: claim.id, branch: null, status: "failed", error: message };
  }
}

export async function runQueue(deps: QueueDeps): Promise<{ summary: QueueSummary; exitCode: number }> {
  fetchSite(deps.siteDir);
  const resolved = resolveOpenJobs(deps);
  const pages = listAnswerPages(deps.siteDir);

  let picks: AnswerPage[];
  if (deps.articleUrl) {
    const forced = pages.find((p) => p.url === deps.articleUrl?.replace(/\/+$/, ""));
    if (!forced) {
      console.error(`  not an answer page on origin/main: ${deps.articleUrl}`);
      const item: ItemResult = { url: deps.articleUrl, job_id: null, branch: null, status: "refused", error: "not an answer page" };
      return { summary: { resolved, processed: [item], drained: false }, exitCode: 1 };
    }
    picks = [forced];
  } else {
    const blocked = new Set(getBlockedArticleUrls(deps.db));
    picks = staleCandidates(pages, deps.now, STALE_THRESHOLD_DAYS, blocked).slice(0, deps.limit);
  }

  if (picks.length === 0) {
    console.error("  nothing to rewrite: no stale, unblocked answer page");
    return { summary: { resolved, processed: [], drained: true }, exitCode: 0 };
  }

  const facts = verifiedFacts(deps.db);
  const processed: ItemResult[] = [];
  for (const page of picks) {
    console.error(`\nprocessing: ${page.url} (dated ${page.date})`);
    processed.push(await processPage(deps, page, facts));
  }

  // A refusal fails the run only for a forced URL: an unforced pick was unblocked a
  // moment ago, so its refusal means another run claimed it first.
  const failed = processed.some(
    (r) =>
      r.status === "failed" ||
      r.error === "one or more notices failed" ||
      (r.status === "refused" && deps.articleUrl !== null)
  );
  return { summary: { resolved, processed, drained: false }, exitCode: failed ? 1 : 0 };
}

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

async function main(): Promise<void> {
  const flags = parseArgs();
  const siteDir = process.env.ASTGL_SITE_WORKTREE || join(import.meta.dirname, "..", ".rewrite-site");
  console.error("=== ASTGL Answer-Page Rewrite Queue (local) ===");
  console.error(
    `mode: ${flags.dryRun ? "DRY-RUN" : "LIVE"}, limit: ${flags.limit}` +
      (flags.articleUrl ? `, article: ${flags.articleUrl}` : "")
  );
  if (!existsSync(join(siteDir, ".git"))) {
    console.error(`astgl-site worktree not found: ${siteDir}`);
    process.exitCode = 1;
    return;
  }

  const db = initKnowledgeDb();
  try {
    const { summary, exitCode } = await runQueue({
      db,
      siteDir,
      now: new Date(),
      limit: flags.limit,
      articleUrl: flags.articleUrl,
      dryRun: flags.dryRun,
      draftModel: process.env.OLLAMA_REWRITE_MODEL || DEFAULT_DRAFT_MODEL,
      voiceModel: process.env.OLLAMA_VOICE_MODEL || DEFAULT_VOICE_MODEL,
      rewrite: (page, opts) => rewritePage(page, opts),
      notify: (text) => notifyAll(text, process.env),
    });
    console.log(JSON.stringify(summary, null, 2));
    console.error(
      `\n=== Done: ${summary.processed.filter((r) => r.status === "drafted").length} drafted, ` +
        `${summary.processed.filter((r) => r.status === "failed").length} failed, ` +
        `${summary.resolved.published} published, ${summary.resolved.rejected} rejected ===`
    );
    process.exitCode = exitCode;
  } finally {
    db.close();
  }
}

// WHY no process.exit(): it can cut off an async stdout pipe before the JSON
//      summary drains; setting exitCode lets node exit once stdout is flushed.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => {
    console.error("rewrite-queue failed:", err);
    process.exitCode = 1;
  });
}
