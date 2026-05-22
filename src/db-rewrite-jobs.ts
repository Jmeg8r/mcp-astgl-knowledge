/**
 * Rewrite jobs CRUD.
 *
 * WHAT: Tracks the lifecycle of an auto-rewrite from "pending_approval" through
 *       "published" or "rejected/failed". One row per attempt — re-queueing the
 *       same article creates a new row.
 * WHY:  Decouples the daily queue script (mcp-astgl-knowledge) from the Telegram
 *       approval handler (claudeclaw). Both processes read/write the same table.
 */

import type Database from "better-sqlite3";

export type RewriteStatus =
  | "pending_approval"
  | "approved"
  | "published"
  | "rejected"
  | "failed";

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
      `SELECT DISTINCT article_url FROM rewrite_jobs
       WHERE status IN ('pending_approval','approved')
          OR (status = 'rejected' AND cooldown_until IS NOT NULL AND cooldown_until > ?)`
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
