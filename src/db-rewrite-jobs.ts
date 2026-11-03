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

export interface OpenSiteJob {
  id: number;
  article_url: string;
  site_branch: string;
  site_commit: string;
}

// WHAT: Jobs awaiting James's review that carry a local astgl-site commit.
// WHY:  Legacy rows (no site commit) cannot be resolved from git; the backlog tool
//       closes those instead.
export function getOpenSiteJobs(db: InstanceType<typeof Database>): OpenSiteJob[] {
  return db
    .prepare(
      `SELECT id, article_url, site_branch, site_commit FROM rewrite_jobs
       WHERE status = 'pending_approval' AND site_commit IS NOT NULL AND site_branch IS NOT NULL
       ORDER BY id`
    )
    .all() as OpenSiteJob[];
}

export function markSitePublished(db: InstanceType<typeof Database>, jobId: number): void {
  db.prepare(
    `UPDATE rewrite_jobs SET status = 'published', published_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), jobId);
}

// WHAT: Fail 'drafting' rows older than the cutoff; returns how many changed.
// WHY:  A run that dies mid-rewrite leaves its claim behind, and an open claim blocks
//       the article forever. A real rewrite finishes within one run, so a claim
//       older than the cutoff is abandoned. created_at is SQLite's UTC
//       "YYYY-MM-DD HH:MM:SS", compared in that same form.
export function failAbandonedDrafts(
  db: InstanceType<typeof Database>,
  cutoff: Date
): number {
  const cutoffSql = cutoff.toISOString().replace("T", " ").slice(0, 19);
  return db
    .prepare(
      `UPDATE rewrite_jobs SET status = 'failed', error = 'abandoned draft (run did not finish)'
       WHERE status = 'drafting' AND created_at < ?`
    )
    .run(cutoffSql).changes;
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
