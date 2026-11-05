#!/usr/bin/env tsx
/**
 * One-off cleanup of the legacy rewrite backlog.
 *
 * WHAT: Plans and applies the close-out of the pending_approval rows the old
 *       Telegram/Substack pipeline left behind: supersedes every non-answer-page row,
 *       lists the answer-page drafts for James's review, and per page either sends
 *       one kept draft down the local-branch path or discards the page's drafts.
 * WHY:  None of those rows could ever be approved, and an open row blocks its article
 *       from the new queue (intent Q2, spec R13). `superseded` closes them without
 *       the rejection cooldown. The answer-page drafts are James's call, page by page.
 *
 * Usage:
 *   npm run rewrite-backlog -- --dry-run            # the plan; changes nothing
 *   npm run rewrite-backlog -- --supersede          # back up, then supersede non-answer rows
 *   npm run rewrite-backlog -- --keep <job-id> [--accept-additions]
 *   npm run rewrite-backlog -- --discard <answer-page-url>
 *
 * Exit codes: 0 success; 1 refused or failed (nothing changed for that page).
 */

import "dotenv/config";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import type Database from "better-sqlite3";

import { initKnowledgeDb } from "./knowledge-db.js";
import { claimJob, markSuperseded, recordSiteCommit } from "./db-rewrite-jobs.js";
import { setFrontmatterDate, splitFrontmatter } from "./rewriter.js";
import { checkClaims, datedFacts } from "./claim-check.js";
import { commitPage, fetchSite, listAnswerPages, mainRevision, readPageAt } from "./site-worktree.js";
import { notifyAll, type ChannelResult } from "./notify.js";
import { reviewNotice } from "./rewrite-queue.js";

const ANSWERS_URL_PREFIX = "https://astgl.ai/answers/";

interface LegacyRow {
  id: number;
  article_url: string;
  draft_path: string | null;
  created_at: string;
}

export interface BacklogPlan {
  supersede: LegacyRow[];
  review: Array<{ url: string; jobs: LegacyRow[] }>;
}

function legacyPendingRows(db: InstanceType<typeof Database>): LegacyRow[] {
  return db
    .prepare(
      `SELECT id, article_url, draft_path, created_at FROM rewrite_jobs
       WHERE status = 'pending_approval' AND site_commit IS NULL ORDER BY id`
    )
    .all() as LegacyRow[];
}

const isAnswerPage = (url: string) => url.startsWith(ANSWERS_URL_PREFIX);

export function planBacklog(db: InstanceType<typeof Database>): BacklogPlan {
  const rows = legacyPendingRows(db);
  const byPage = new Map<string, LegacyRow[]>();
  for (const row of rows.filter((r) => isAnswerPage(r.article_url))) {
    byPage.set(row.article_url, [...(byPage.get(row.article_url) ?? []), row]);
  }
  return {
    supersede: rows.filter((r) => !isAnswerPage(r.article_url)),
    review: [...byPage.entries()].map(([url, jobs]) => ({ url, jobs })),
  };
}

// WHAT: Back up the database, then supersede every legacy non-answer pending row.
// WHY:  A bulk change to production rows gets a restore point first (astgl-db-surgeon
//       rule 1). The backup name matches the repo's ignored `data/*.bak*` pattern.
export async function supersedeNonAnswerRows(
  db: InstanceType<typeof Database>,
  dbPath: string,
  now: Date
): Promise<{ changed: number; backupPath: string }> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${dbPath}.bak.rewrite-backlog-${stamp}`;
  await db.backup(backupPath);
  const ids = planBacklog(db).supersede.map((r) => r.id);
  return { changed: markSuperseded(db, ids), backupPath };
}

export function discardPage(db: InstanceType<typeof Database>, url: string): number {
  const ids = legacyPendingRows(db)
    .filter((r) => r.article_url === url)
    .map((r) => r.id);
  return markSuperseded(db, ids);
}

export interface KeepOptions {
  jobId: number;
  siteDir: string;
  now: Date;
  acceptAdditions: boolean;
  notify: (text: string) => Promise<ChannelResult[]>;
}

export interface KeepResult {
  exitCode: number;
  branch?: string;
  error?: string;
}

// WHAT: Turn one legacy draft into a local astgl-site branch for James to push.
// WHY:  Legacy drafts were cloud-polished and allowed fact updates, so the claim
//       check still runs; added tokens refuse the keep unless James passes
//       --accept-additions after reading them. The page's legacy rows are
//       superseded only after the commit, so a refusal changes nothing.
export async function keepDraft(db: InstanceType<typeof Database>, opts: KeepOptions): Promise<KeepResult> {
  const row = legacyPendingRows(db).find((r) => r.id === opts.jobId);
  if (!row || !isAnswerPage(row.article_url)) {
    return { exitCode: 1, error: `job ${opts.jobId} is not a legacy answer-page draft` };
  }
  if (!row.draft_path || !existsSync(row.draft_path)) {
    return { exitCode: 1, error: `draft file not found: ${row.draft_path} (is /Volumes/Research mounted?)` };
  }

  fetchSite(opts.siteDir);
  const page = listAnswerPages(opts.siteDir).find((p) => p.url === row.article_url.replace(/\/+$/, ""));
  if (!page) return { exitCode: 1, error: `no answer page on origin/main for ${row.article_url}` };

  const base = mainRevision(opts.siteDir);
  const original = readPageAt(opts.siteDir, base, page.path);
  const { frontmatter, body: originalBody } = splitFrontmatter(original);
  const draftBody = splitFrontmatter(readFileSync(row.draft_path, "utf-8")).body.trim();
  const added = checkClaims(originalBody, draftBody).added;
  if (added.length > 0 && !opts.acceptAdditions) {
    return {
      exitCode: 1,
      error: `draft adds unsupported tokens: ${added.join(", ")} (rerun with --accept-additions after checking them)`,
    };
  }

  const date = opts.now.toISOString().slice(0, 10);
  const newPage = `${setFrontmatterDate(frontmatter, date)}\n${draftBody}\n`;
  const toCheck = datedFacts(originalBody);
  const message = [
    `content(answers): kept legacy rewrite of ${page.slug}`,
    "",
    `Legacy rewrite job ${row.id}, kept by James from the pre-2026-11-03 backlog.`,
    added.length > 0 ? `Additions James accepted: ${added.join(", ")}` : "",
    toCheck.length > 0 ? `Check these dated facts before merging: ${toCheck.join(", ")}` : "",
  ].join("\n");

  const supersededIds = legacyPendingRows(db)
    .filter((r) => r.article_url === row.article_url)
    .map((r) => r.id);
  const site = commitPage(opts.siteDir, page.slug, newPage, date, message, base);
  markSuperseded(db, supersededIds);
  const claim = claimJob(db, page.url, opts.now);
  if (!claim.ok) return { exitCode: 1, branch: site.branch, error: `claim refused after commit: ${claim.reason}` };
  recordSiteCommit(db, claim.id, site.branch, site.commit, site.pagePath);

  const notices = await opts.notify(reviewNotice(page, site.branch, opts.siteDir, toCheck));
  const failed = notices.filter((n) => !n.ok);
  return failed.length > 0
    ? { exitCode: 1, branch: site.branch, error: `notice failed: ${failed.map((n) => n.channel).join(", ")}` }
    : { exitCode: 0, branch: site.branch };
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const siteDir = process.env.ASTGL_SITE_WORKTREE || join(import.meta.dirname, "..", ".rewrite-site");
  const dbPath = join(import.meta.dirname, "..", "data", "knowledge.db");
  const db = initKnowledgeDb();
  try {
    if (args.includes("--dry-run")) {
      const plan = planBacklog(db);
      console.error(`supersede: ${plan.supersede.length} non-answer rows`);
      console.error(`review: ${plan.review.reduce((n, p) => n + p.jobs.length, 0)} drafts across ${plan.review.length} answer pages`);
      console.log(JSON.stringify(plan, null, 2));
    } else if (args.includes("--supersede")) {
      const result = await supersedeNonAnswerRows(db, dbPath, new Date());
      console.error(`backup: ${result.backupPath}`);
      console.log(JSON.stringify(result));
    } else if (argValue(args, "--keep")) {
      const result = await keepDraft(db, {
        jobId: parseInt(argValue(args, "--keep") ?? "", 10),
        siteDir,
        now: new Date(),
        acceptAdditions: args.includes("--accept-additions"),
        notify: (text) => notifyAll(text, process.env),
      });
      if (result.error) console.error(result.error);
      console.log(JSON.stringify(result));
      process.exitCode = result.exitCode;
    } else if (argValue(args, "--discard")) {
      const changed = discardPage(db, argValue(args, "--discard") as string);
      console.log(JSON.stringify({ changed }));
    } else {
      console.error("usage: rewrite-backlog --dry-run | --supersede | --keep <job-id> [--accept-additions] | --discard <url>");
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => {
    console.error("rewrite-backlog failed:", err);
    process.exitCode = 1;
  });
}
