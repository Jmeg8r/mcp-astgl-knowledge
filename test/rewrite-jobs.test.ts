/**
 * Tests for the rewrite_jobs schema migration and the claim lock.
 *
 * WHAT: Covers the one-time rebuild of rewrite_jobs (new statuses, site columns),
 *       its idempotence, and claimJob()'s refusal rules.
 * WHY:  The rebuild runs against the production knowledge.db, so losing or altering
 *       a row is the failure that matters most. The claim lock replaces the
 *       check-after-rewrite gap that queued the same article up to four times
 *       (Mistake #11, spec F6): a refused claim must come from the database, not
 *       from anything the caller remembers.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../src/knowledge-db.js";
import {
  claimJob,
  getBlockedArticleUrls,
  markRejected,
  markSuperseded,
  recordSiteCommit,
} from "../src/db-rewrite-jobs.js";

const URL_A = "https://astgl.ai/answers/what-is-an-mcp-server";
const URL_B = "https://astgl.ai/answers/build-your-first-mcp-server";

// The rewrite_jobs DDL as it stood before this change, verbatim. A legacy database
// is the input the migration must preserve exactly.
const LEGACY_REWRITE_JOBS_DDL = `
  CREATE TABLE rewrite_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    article_url TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL CHECK (status IN (
      'pending_approval','approved','published','rejected','failed'
    )),
    draft_path TEXT,
    telegram_chat_id TEXT,
    telegram_thread_id INTEGER,
    telegram_message_id INTEGER,
    approved_at TEXT,
    published_at TEXT,
    substack_url TEXT,
    cooldown_until TEXT,
    error TEXT
  )
`;

function baseTables(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE articles (url TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT);
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_url TEXT NOT NULL,
      content TEXT NOT NULL
    );
  `);
}

function withDb(
  fn: (db: InstanceType<typeof Database>, path: string) => void,
  legacy = false
): void {
  const dir = mkdtempSync(join(tmpdir(), "rewrite-jobs-"));
  const path = join(dir, "knowledge.db");
  const db = new Database(path);
  try {
    baseTables(db);
    if (legacy) db.exec(LEGACY_REWRITE_JOBS_DDL);
    fn(db, path);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function insertLegacy(
  db: InstanceType<typeof Database>,
  url: string,
  status: string,
  extra: Partial<Record<string, string | number>> = {}
): void {
  db.prepare(
    `INSERT INTO rewrite_jobs
       (article_url, created_at, status, draft_path, telegram_chat_id,
        telegram_thread_id, telegram_message_id, cooldown_until, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    url,
    extra.created_at ?? "2026-05-06 21:51:03",
    status,
    extra.draft_path ?? `/drafts/${status}.md`,
    extra.telegram_chat_id ?? "chat",
    extra.telegram_thread_id ?? 7,
    extra.telegram_message_id ?? 42,
    extra.cooldown_until ?? null,
    extra.error ?? null
  );
}

function allRows(db: InstanceType<typeof Database>): unknown[] {
  return db.prepare("SELECT * FROM rewrite_jobs ORDER BY id").all();
}

function legacyColumnsOnly(rows: unknown[]): unknown[] {
  return (rows as Array<Record<string, unknown>>).map((r) => {
    const { site_branch: _b, site_commit: _c, ...rest } = r;
    return rest;
  });
}

describe("rewrite_jobs migration", () => {
  test("a fresh database gets the new statuses and site columns", () => {
    withDb((db) => {
      runMigrations(db);
      const cols = (
        db.prepare("PRAGMA table_info(rewrite_jobs)").all() as Array<{ name: string }>
      ).map((c) => c.name);
      assert.ok(cols.includes("site_branch"));
      assert.ok(cols.includes("site_commit"));
      for (const status of ["drafting", "superseded"]) {
        assert.doesNotThrow(() =>
          db
            .prepare("INSERT INTO rewrite_jobs (article_url, status) VALUES (?, ?)")
            .run(URL_A, status)
        );
      }
    });
  });

  test("a legacy table keeps every row and value after the rebuild", () => {
    withDb((db) => {
      insertLegacy(db, URL_A, "pending_approval");
      insertLegacy(db, URL_A, "pending_approval", { created_at: "2026-06-01 10:00:00" });
      insertLegacy(db, URL_B, "failed", { error: "ollama draft failed" });
      insertLegacy(db, URL_B, "rejected", { cooldown_until: "2026-12-01T00:00:00Z" });
      const before = allRows(db);

      runMigrations(db);

      assert.deepEqual(legacyColumnsOnly(allRows(db)), before);
      const integrity = db.prepare("PRAGMA integrity_check").pluck().get();
      assert.equal(integrity, "ok");
    }, true);
  });

  test("the rebuilt table accepts the new statuses", () => {
    withDb((db) => {
      insertLegacy(db, URL_A, "pending_approval");
      runMigrations(db);
      assert.doesNotThrow(() =>
        db.prepare("UPDATE rewrite_jobs SET status = 'superseded'").run()
      );
    }, true);
  });

  test("running the migration twice changes nothing", () => {
    withDb((db) => {
      insertLegacy(db, URL_A, "pending_approval");
      runMigrations(db);
      const once = allRows(db);
      const schemaOnce = db
        .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'rewrite_jobs' ORDER BY name")
        .all();
      runMigrations(db);
      assert.deepEqual(allRows(db), once);
      assert.deepEqual(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE tbl_name = 'rewrite_jobs' ORDER BY name")
          .all(),
        schemaOnce
      );
    }, true);
  });
});

describe("claimJob", () => {
  test("claims an article with no history as drafting", () => {
    withDb((db) => {
      runMigrations(db);
      const result = claimJob(db, URL_A);
      assert.equal(result.ok, true);
      const row = db
        .prepare("SELECT status FROM rewrite_jobs WHERE id = ?")
        .get(result.ok ? result.id : -1) as { status: string };
      assert.equal(row.status, "drafting");
    });
  });

  test("refuses a second claim on the same article", () => {
    withDb((db) => {
      runMigrations(db);
      assert.equal(claimJob(db, URL_A).ok, true);
      const second = claimJob(db, URL_A);
      assert.equal(second.ok, false);
      assert.equal(
        db.prepare("SELECT count(*) FROM rewrite_jobs").pluck().get(),
        1
      );
    });
  });

  test("a refusal comes from the database, not the caller's handle", () => {
    withDb((db, path) => {
      runMigrations(db);
      const other = new Database(path);
      try {
        assert.equal(claimJob(db, URL_A).ok, true);
        assert.equal(claimJob(other, URL_A).ok, false);
      } finally {
        other.close();
      }
    });
  });

  test("refuses while a legacy pending_approval row is open", () => {
    withDb((db) => {
      insertLegacy(db, URL_A, "pending_approval");
      runMigrations(db);
      assert.equal(claimJob(db, URL_A).ok, false);
      assert.equal(claimJob(db, URL_B).ok, true);
    }, true);
  });

  test("refuses inside a rejection cooldown and allows after it", () => {
    withDb((db) => {
      runMigrations(db);
      const first = claimJob(db, URL_A);
      assert.ok(first.ok);
      markRejected(db, first.id, 14);
      assert.equal(claimJob(db, URL_A).ok, false);
      db.prepare("UPDATE rewrite_jobs SET cooldown_until = '2000-01-01T00:00:00Z'").run();
      assert.equal(claimJob(db, URL_A).ok, true);
    });
  });

  test("allows a claim when every earlier row is closed", () => {
    withDb((db) => {
      insertLegacy(db, URL_A, "failed");
      insertLegacy(db, URL_A, "published");
      runMigrations(db);
      db.prepare(
        "INSERT INTO rewrite_jobs (article_url, status) VALUES (?, 'superseded')"
      ).run(URL_A);
      assert.equal(claimJob(db, URL_A).ok, true);
    }, true);
  });
});

describe("job state helpers", () => {
  test("blocked URLs include drafting rows", () => {
    withDb((db) => {
      runMigrations(db);
      claimJob(db, URL_A);
      assert.deepEqual(getBlockedArticleUrls(db), [URL_A]);
    });
  });

  test("recordSiteCommit moves a drafting job to pending_approval", () => {
    withDb((db) => {
      runMigrations(db);
      const claim = claimJob(db, URL_A);
      assert.ok(claim.ok);
      recordSiteCommit(db, claim.id, "rewrite/what-is-an-mcp-server-2026-11-03", "abc123", "/wt/page.md");
      const row = db
        .prepare("SELECT status, site_branch, site_commit, draft_path FROM rewrite_jobs WHERE id = ?")
        .get(claim.id);
      assert.deepEqual(row, {
        status: "pending_approval",
        site_branch: "rewrite/what-is-an-mcp-server-2026-11-03",
        site_commit: "abc123",
        draft_path: "/wt/page.md",
      });
    });
  });

  test("markSuperseded changes only the named pending_approval rows", () => {
    withDb((db) => {
      insertLegacy(db, URL_A, "pending_approval");
      insertLegacy(db, URL_A, "pending_approval");
      insertLegacy(db, URL_B, "failed");
      runMigrations(db);
      const changed = markSuperseded(db, [1, 3]);
      assert.equal(changed, 1);
      const statuses = db
        .prepare("SELECT status FROM rewrite_jobs ORDER BY id")
        .pluck()
        .all();
      assert.deepEqual(statuses, ["superseded", "pending_approval", "failed"]);
    }, true);
  });
});
