/**
 * Rewrite jobs CRUD.
 *
 * WHAT: Tracks the lifecycle of an auto-rewrite from "drafting" (claimed) through
 *       "pending_approval" (committed to a local astgl-site branch) to "published"
 *       or "rejected/failed/superseded". One row per attempt — re-queueing the same
 *       article creates a new row.
 * WHY:  The row is the claim lock and the record of which local commit James is
 *       reviewing (2026-11-03-astgl-local-rewrite).
 */

import type Database from "better-sqlite3";

export type RewriteStatus =
  | "drafting"
  | "pending_approval"
  | "approved"
  | "published"
  | "rejected"
  | "failed"
  | "superseded";

export interface RewriteJob {
  id: number;
  article_url: string;
  created_at: string;
  status: RewriteStatus;
  draft_path: string | null;
  telegram_chat_id: string | null;
  telegram_thread_id: number | null;
  telegram_message_id: number | null;
  approved_at: string | null;
  published_at: string | null;
  substack_url: string | null;
  cooldown_until: string | null;
  error: string | null;
  site_branch: string | null;
  site_commit: string | null;
}

// An article is blocked while it has an open job or sits inside a rejection
// cooldown. One definition, shared by the candidate filter and the claim lock, so
// the two can never disagree about what "open" means.
const BLOCKING_JOB_SQL = `(status IN ('drafting','pending_approval','approved')
   OR (status = 'rejected' AND cooldown_until IS NOT NULL AND cooldown_until > ?))`;

export type ClaimResult = { ok: true; id: number } | { ok: false; reason: string };

// WHAT: Atomically claim an article for a rewrite by inserting a 'drafting' row.
// WHY:  The old flow created the row only after a rewrite that could take 15
//       minutes, so overlapping runs and --article-url queued the same article up
//       to four times (Mistake #11, spec F6). BEGIN IMMEDIATE takes the write lock
//       before the check, so no other connection can insert between check and claim.
export function claimJob(
  db: InstanceType<typeof Database>,
  articleUrl: string,
  now: Date = new Date()
): ClaimResult {
  const claim = db.transaction((): ClaimResult => {
    const blocking = db
      .prepare(
        `SELECT status, cooldown_until FROM rewrite_jobs
         WHERE article_url = ? AND ${BLOCKING_JOB_SQL} LIMIT 1`
      )
      .get(articleUrl, now.toISOString()) as
      | { status: string; cooldown_until: string | null }
      | undefined;
    if (blocking) {
      return {
        ok: false,
        reason:
          blocking.status === "rejected"
            ? `in rejection cooldown until ${blocking.cooldown_until}`
            : `open job (${blocking.status})`,
      };
    }
    const result = db
      .prepare("INSERT INTO rewrite_jobs (article_url, status) VALUES (?, 'drafting')")
      .run(articleUrl);
    return { ok: true, id: Number(result.lastInsertRowid) };
  });
  return claim.immediate();
}

// WHAT: Record the local astgl-site commit for a claimed job and open it for review.
// WHY:  Fails loudly unless exactly one 'drafting' row changes: recording a commit
//       against a job that is not mid-draft means the caller's state is wrong.
export function recordSiteCommit(
  db: InstanceType<typeof Database>,
  jobId: number,
  siteBranch: string,
  siteCommit: string,
  pagePath: string
): void {
  const result = db
    .prepare(
      `UPDATE rewrite_jobs
       SET status = 'pending_approval', site_branch = ?, site_commit = ?, draft_path = ?
       WHERE id = ? AND status = 'drafting'`
    )
    .run(siteBranch, siteCommit, pagePath, jobId);
  if (result.changes !== 1) {
    throw new Error(`recordSiteCommit: job ${jobId} is not a drafting job`);
  }
}

// WHAT: Close named pending_approval jobs as superseded; returns how many changed.
// WHY:  Clears the never-reviewable backlog without the rejection cooldown that
//       'rejected' would start (intent Q2). Other statuses are left untouched.
export function markSuperseded(
  db: InstanceType<typeof Database>,
  jobIds: number[]
): number {
  if (jobIds.length === 0) return 0;
  const placeholders = jobIds.map(() => "?").join(",");
  return db
    .prepare(
      `UPDATE rewrite_jobs SET status = 'superseded'
       WHERE status = 'pending_approval' AND id IN (${placeholders})`
    )
    .run(...jobIds).changes;
}

export function createRewriteJob(
  db: InstanceType<typeof Database>,
  articleUrl: string,
  draftPath: string
): number {
  const result = db
    .prepare(
      `INSERT INTO rewrite_jobs (article_url, status, draft_path)
       VALUES (?, 'pending_approval', ?)`
    )
    .run(articleUrl, draftPath);
  return result.lastInsertRowid as number;
}

export function getJob(
  db: InstanceType<typeof Database>,
  jobId: number
): RewriteJob | null {
  const row = db
    .prepare("SELECT * FROM rewrite_jobs WHERE id = ?")
    .get(jobId) as RewriteJob | undefined;
  return row ?? null;
}

// WHAT: Return URLs that have an open rewrite job or are inside their reject cooldown.
// WHY:  rewrite-queue.ts uses this to skip articles that shouldn't be re-queued.
export function getBlockedArticleUrls(
  db: InstanceType<typeof Database>
): string[] {
  const nowIso = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT DISTINCT article_url FROM rewrite_jobs WHERE ${BLOCKING_JOB_SQL}`
    )
    .all(nowIso) as Array<{ article_url: string }>;
  return rows.map((r) => r.article_url);
}

export function setTelegramRouting(
  db: InstanceType<typeof Database>,
  jobId: number,
  chatId: string,
  threadId: number | null,
  messageId: number
): void {
  db.prepare(
    `UPDATE rewrite_jobs
     SET telegram_chat_id = ?, telegram_thread_id = ?, telegram_message_id = ?
     WHERE id = ?`
  ).run(chatId, threadId, messageId, jobId);
}

export function markApproved(
  db: InstanceType<typeof Database>,
  jobId: number
): void {
  db.prepare(
    `UPDATE rewrite_jobs SET status = 'approved', approved_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), jobId);
}

export function markPublished(
  db: InstanceType<typeof Database>,
  jobId: number,
  substackUrl: string
): void {
  db.prepare(
    `UPDATE rewrite_jobs
     SET status = 'published', published_at = ?, substack_url = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), substackUrl, jobId);
}

// WHAT: Mark a job rejected and set a cooldown so the article doesn't get re-queued
//       for `cooldownDays` days. Default 14 days matches the plan.
export function markRejected(
  db: InstanceType<typeof Database>,
  jobId: number,
  cooldownDays = 14
): void {
  const cooldownUntil = new Date();
  cooldownUntil.setDate(cooldownUntil.getDate() + cooldownDays);
  db.prepare(
    `UPDATE rewrite_jobs SET status = 'rejected', cooldown_until = ? WHERE id = ?`
  ).run(cooldownUntil.toISOString(), jobId);
}

export function markFailed(
  db: InstanceType<typeof Database>,
  jobId: number,
  error: string
): void {
  db.prepare(
    `UPDATE rewrite_jobs SET status = 'failed', error = ? WHERE id = ?`
  ).run(error.slice(0, 2000), jobId);
}
