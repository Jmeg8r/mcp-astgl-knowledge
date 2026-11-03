/**
 * Tests for the weekly rewrite-queue run.
 *
 * WHAT: Drives runQueue() against a throwaway astgl-site and a temp knowledge DB,
 *       with the rewriter and the notifier stubbed, and checks job state, the local
 *       branch, the notice and the exit code.
 * WHY:  The scheduler only sees the exit code, so every failure path must end
 *       nonzero (spec R10): a failed item, a claim-check violation, a refused forced
 *       URL, a notification that did not send. A failed notice must still leave the
 *       committed branch in place.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";

import { runMigrations, upsertSnapshot } from "../src/knowledge-db.js";
import { claimJob, recordSiteCommit } from "../src/db-rewrite-jobs.js";
import { commitPage } from "../src/site-worktree.js";
import type { RewriteResult } from "../src/rewriter.js";
import type { ChannelResult } from "../src/notify.js";
import { runQueue, type QueueDeps } from "../src/rewrite-queue.js";
import { git, page, withSite } from "./helpers/site-fixture.js";

const NOW = new Date("2026-11-03T12:00:00Z");
const OLDER = "https://astgl.ai/answers/older-page";
const OK_NOTICE: ChannelResult[] = [
  { channel: "telegram", ok: true },
  { channel: "slack", ok: true },
];

function withDb(fn: (db: InstanceType<typeof Database>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rewrite-queue-"));
  const db = new Database(join(dir, "knowledge.db"));
  db.exec(`
    CREATE TABLE articles (url TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT);
    CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, article_url TEXT NOT NULL, content TEXT NOT NULL);
  `);
  runMigrations(db);
  return fn(db).finally(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

interface Harness {
  deps: QueueDeps;
  rewrites: string[];
  notices: string[];
}

function harness(
  db: InstanceType<typeof Database>,
  siteDir: string,
  overrides: Partial<QueueDeps> = {},
  body = "Rewritten body."
): Harness {
  const rewrites: string[] = [];
  const notices: string[] = [];
  const deps: QueueDeps = {
    db,
    siteDir,
    now: NOW,
    limit: 1,
    articleUrl: null,
    dryRun: false,
    draftModel: "draft-model",
    voiceModel: "voice-model",
    rewrite: async (original: string): Promise<RewriteResult> => {
      rewrites.push(original);
      return {
        page: page("2026-11-03", body),
        originalBody: "\nBody text.\n",
        draftChars: 10,
        voiceChars: 10,
        draftMs: 1,
        voiceMs: 1,
      };
    },
    notify: async (text: string) => {
      notices.push(text);
      return OK_NOTICE;
    },
    ...overrides,
  };
  return { deps, rewrites, notices };
}

function jobs(db: InstanceType<typeof Database>): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT id, article_url, status, site_branch, error FROM rewrite_jobs ORDER BY id")
    .all() as Array<Record<string, unknown>>;
}

describe("runQueue", () => {
  test("rewrites the stalest page onto a local branch and sends one notice", () =>
    withSite(({ wt, origin }) =>
      withDb(async (db) => {
        const h = harness(db, wt);
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 0);
        assert.deepEqual(
          jobs(db).map((j) => [j.article_url, j.status, j.site_branch]),
          [[OLDER, "pending_approval", "rewrite/older-page-2026-11-03"]]
        );
        assert.equal(h.notices.length, 1);
        assert.match(h.notices[0], /rewrite\/older-page-2026-11-03/);
        assert.match(h.notices[0], /git -C .* push origin rewrite\/older-page-2026-11-03/);
        assert.equal(git(origin, "branch", "--list", "rewrite/*"), "");
      })
    ));

  test("a claim-check violation fails the item and the run, with no branch", () =>
    withSite(({ wt }) =>
      withDb(async (db) => {
        const h = harness(db, wt, {}, "Now 0.9.4 is out and 3x faster.");
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 1);
        const [job] = jobs(db);
        assert.equal(job.status, "failed");
        assert.match(String(job.error), /claim check/);
        assert.equal(git(wt, "branch", "--list", "rewrite/*"), "");
        assert.equal(h.notices.length, 0);
      })
    ));

  test("a version from the verified-facts table is allowed", () =>
    withSite(({ wt }) =>
      withDb(async (db) => {
        upsertSnapshot(db, "npm_version", "@modelcontextprotocol/sdk", "0.9.4");
        const h = harness(db, wt, {}, "Body text. Now on 0.9.4.");
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 0);
        assert.equal(jobs(db)[0].status, "pending_approval");
      })
    ));

  test("a failed notice keeps the branch and fails the run", () =>
    withSite(({ wt }) =>
      withDb(async (db) => {
        const h = harness(db, wt, {
          notify: async () => [
            { channel: "telegram", ok: true },
            { channel: "slack", ok: false, error: "HTTP 404" },
          ],
        });
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 1);
        assert.equal(jobs(db)[0].status, "pending_approval");
        assert.notEqual(git(wt, "branch", "--list", "rewrite/*"), "");
      })
    ));

  test("a rewriter error fails the job and the run", () =>
    withSite(({ wt }) =>
      withDb(async (db) => {
        const h = harness(db, wt, {
          rewrite: async () => {
            throw new Error("voice pass returned empty output");
          },
        });
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 1);
        assert.equal(jobs(db)[0].status, "failed");
      })
    ));

  test("a forced URL with an open job is refused without a rewrite", () =>
    withSite(({ wt }) =>
      withDb(async (db) => {
        claimJob(db, OLDER);
        const h = harness(db, wt, { articleUrl: OLDER });
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 1);
        assert.equal(h.rewrites.length, 0);
        assert.equal(jobs(db).length, 1);
      })
    ));

  test("nothing stale exits 0 and reports drained", () =>
    withSite(({ wt }) =>
      withDb(async (db) => {
        const h = harness(db, wt, { now: new Date("2024-01-01T00:00:00Z") });
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 0);
        assert.equal(run.summary.drained, true);
        assert.equal(h.rewrites.length, 0);
      })
    ));

  test("a dry run claims nothing and rewrites nothing", () =>
    withSite(({ wt }) =>
      withDb(async (db) => {
        const h = harness(db, wt, { dryRun: true });
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 0);
        assert.equal(jobs(db).length, 0);
        assert.equal(h.rewrites.length, 0);
      })
    ));

  test("a dry run reports resolutions without changing job state", () =>
    withSite(({ wt }) =>
      withDb(async (db) => {
        db.prepare(
          "INSERT INTO rewrite_jobs (article_url, status, created_at) VALUES (?, 'drafting', '2026-11-01 00:00:00')"
        ).run(OLDER);
        const h = harness(db, wt, { dryRun: true });
        const run = await runQueue(h.deps);
        assert.equal(run.summary.resolved.abandoned, 1);
        assert.deepEqual(jobs(db).map((j) => j.status), ["drafting"]);
      })
    ));

  test("a merged rewrite resolves to published before selection", () =>
    withSite(({ wt, seed }) =>
      withDb(async (db) => {
        const claim = claimJob(db, OLDER);
        assert.ok(claim.ok);
        const c = commitPage(wt, "older-page", page("2026-11-03", "Merged."), "2026-11-03", "msg");
        recordSiteCommit(db, claim.id, c.branch, c.commit, c.pagePath);
        git(wt, "push", "--quiet", "origin", c.branch);
        git(seed, "fetch", "--quiet", "origin");
        git(seed, "merge", "--quiet", "--no-ff", "-m", "merge", `origin/${c.branch}`);
        git(seed, "push", "--quiet", "origin", "main");
        git(wt, "switch", "--quiet", "--detach", "origin/main");

        const h = harness(db, wt);
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 0);
        assert.equal(jobs(db)[0].status, "published");
        // older-page is now dated 2026-11-03, so the next stalest page is chosen.
        assert.equal(jobs(db)[1].article_url, "https://astgl.ai/answers/old-page");
      })
    ));

  test("an abandoned drafting row is failed so it stops blocking", () =>
    withSite(({ wt }) =>
      withDb(async (db) => {
        db.prepare(
          "INSERT INTO rewrite_jobs (article_url, status, created_at) VALUES (?, 'drafting', '2026-11-01 00:00:00')"
        ).run(OLDER);
        const h = harness(db, wt);
        const run = await runQueue(h.deps);
        assert.equal(run.exitCode, 0);
        assert.equal(jobs(db)[0].status, "failed");
        assert.match(String(jobs(db)[0].error), /abandoned/);
        assert.equal(jobs(db)[1].article_url, OLDER);
      })
    ));
});
