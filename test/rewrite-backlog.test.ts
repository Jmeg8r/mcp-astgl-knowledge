/**
 * Tests for the one-off rewrite backlog tool.
 *
 * WHAT: Builds a temp DB with legacy pending_approval rows (answer pages and other
 *       sources) plus legacy draft files, and checks the plan, the supersede run,
 *       keeping one draft per page, and discarding a page's drafts.
 * WHY:  The backlog run changes 132 production rows at once (intent Q2), so the
 *       plan must count exactly what the run changes, the run must back up first,
 *       and nothing about an answer-page row may change until James decides it.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";

import { runMigrations } from "../src/knowledge-db.js";
import { discardPage, keepDraft, planBacklog, supersedeNonAnswerRows } from "../src/rewrite-backlog.js";
import type { ChannelResult } from "../src/notify.js";
import { git, withSite } from "./helpers/site-fixture.js";

const NOW = new Date("2026-11-03T12:00:00Z");
const OLD = "https://astgl.ai/answers/old-page";
const OLDER = "https://astgl.ai/answers/older-page";
const OK_NOTICE: ChannelResult[] = [
  { channel: "telegram", ok: true },
  { channel: "slack", ok: true },
];

interface Ctx {
  db: InstanceType<typeof Database>;
  dir: string;
  dbPath: string;
}

function withBacklog(fn: (c: Ctx) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rewrite-backlog-"));
  const dbPath = join(dir, "knowledge.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE articles (url TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, article_url TEXT NOT NULL, content TEXT NOT NULL);
  `);
  runMigrations(db);
  mkdirSync(join(dir, "drafts"));
  const insert = db.prepare(
    "INSERT INTO rewrite_jobs (article_url, status, draft_path) VALUES (?, ?, ?)"
  );
  const draft = (name: string, body: string) => {
    const path = join(dir, "drafts", name);
    writeFileSync(path, `---\ntitle: "Legacy"\nrewrite_job_id: 1\nvoice: astgl\n---\n\n${body}\n`);
    return path;
  };
  insert.run(OLD, "pending_approval", draft("old-1.md", "Body text."));
  insert.run(OLD, "pending_approval", draft("old-2.md", "Body text. Updated to 0.9.4."));
  insert.run(OLDER, "pending_approval", draft("older-1.md", "Body text."));
  insert.run("local://astgl-articles/draft/x", "pending_approval", "/missing/x.md");
  insert.run("wiki://secondbrain/entity/y", "pending_approval", "/missing/y.md");
  insert.run("https://astgl.ai/projects/z", "failed", null);
  return fn({ db, dir, dbPath }).finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function statuses(db: InstanceType<typeof Database>): string[] {
  return db.prepare("SELECT status FROM rewrite_jobs ORDER BY id").pluck().all() as string[];
}

describe("planBacklog", () => {
  test("counts non-answer rows to supersede and groups answer drafts by page", () =>
    withBacklog(async ({ db }) => {
      const plan = planBacklog(db);
      assert.deepEqual(plan.supersede.map((r) => r.id), [4, 5]);
      assert.deepEqual(
        plan.review.map((p) => [p.url, p.jobs.map((j) => j.id)]),
        [
          [OLD, [1, 2]],
          [OLDER, [3]],
        ]
      );
    }));
});

describe("supersedeNonAnswerRows", () => {
  test("backs up first, then supersedes only non-answer pending rows", () =>
    withBacklog(async ({ db, dir, dbPath }) => {
      const result = await supersedeNonAnswerRows(db, dbPath, NOW);
      assert.equal(result.changed, 2);
      assert.ok(existsSync(result.backupPath));
      assert.ok(readdirSync(dir).some((f) => f.startsWith("knowledge.db.bak.rewrite-backlog-")));
      assert.deepEqual(statuses(db), [
        "pending_approval",
        "pending_approval",
        "pending_approval",
        "superseded",
        "superseded",
        "failed",
      ]);
    }));
});

describe("keepDraft", () => {
  test("commits the kept draft to a local branch and supersedes the page's legacy rows", () =>
    withSite(({ wt, origin }) =>
      withBacklog(async ({ db }) => {
        const notices: string[] = [];
        const result = await keepDraft(db, {
          jobId: 1,
          siteDir: wt,
          now: NOW,
          acceptAdditions: false,
          notify: async (text) => {
            notices.push(text);
            return OK_NOTICE;
          },
        });
        assert.equal(result.exitCode, 0);
        assert.equal(result.branch, "rewrite/old-page-2026-11-03");
        assert.match(git(wt, "show", `${result.branch}:src/content/answers/old-page.md`), /date: '2026-11-03'/);
        assert.equal(git(origin, "branch", "--list", "rewrite/*"), "");
        assert.deepEqual(statuses(db).slice(0, 3), ["superseded", "superseded", "pending_approval"]);
        const newJob = db
          .prepare("SELECT article_url, status, site_branch FROM rewrite_jobs WHERE id = 7")
          .get();
        assert.deepEqual(newJob, { article_url: OLD, status: "pending_approval", site_branch: result.branch });
        assert.equal(notices.length, 1);
      })
    ));

  test("refuses a draft that adds facts unless additions are accepted", () =>
    withSite(({ wt }) =>
      withBacklog(async ({ db }) => {
        const notify = async () => OK_NOTICE;
        const refused = await keepDraft(db, { jobId: 2, siteDir: wt, now: NOW, acceptAdditions: false, notify });
        assert.equal(refused.exitCode, 1);
        assert.match(String(refused.error), /0\.9\.4/);
        assert.deepEqual(statuses(db).slice(0, 2), ["pending_approval", "pending_approval"]);
        assert.equal(git(wt, "branch", "--list", "rewrite/*"), "");

        const accepted = await keepDraft(db, { jobId: 2, siteDir: wt, now: NOW, acceptAdditions: true, notify });
        assert.equal(accepted.exitCode, 0);
      })
    ));

  test("refuses a job that is not a legacy answer-page draft", () =>
    withSite(({ wt }) =>
      withBacklog(async ({ db }) => {
        const notify = async () => OK_NOTICE;
        const result = await keepDraft(db, { jobId: 4, siteDir: wt, now: NOW, acceptAdditions: false, notify });
        assert.equal(result.exitCode, 1);
        assert.equal(statuses(db)[3], "pending_approval");
      })
    ));

  test("refuses when the draft file is missing (unmounted volume)", () =>
    withSite(({ wt }) =>
      withBacklog(async ({ db }) => {
        db.prepare("UPDATE rewrite_jobs SET draft_path = '/Volumes/NotMounted/x.md' WHERE id = 3").run();
        const notify = async () => OK_NOTICE;
        const result = await keepDraft(db, { jobId: 3, siteDir: wt, now: NOW, acceptAdditions: false, notify });
        assert.equal(result.exitCode, 1);
        assert.match(String(result.error), /not found/);
        assert.equal(statuses(db)[2], "pending_approval");
      })
    ));
});

describe("discardPage", () => {
  test("supersedes every legacy pending row for one answer page", () =>
    withBacklog(async ({ db }) => {
      assert.equal(discardPage(db, OLD), 2);
      assert.deepEqual(statuses(db).slice(0, 3), ["superseded", "superseded", "pending_approval"]);
    }));
});
