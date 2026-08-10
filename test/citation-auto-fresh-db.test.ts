/**
 * The automated citation runner's database bootstrap.
 *
 * WHAT: Asserts that citation-test-auto.ts can open a database that does not exist
 *       yet, without an unhandled "no such table: test_runs".
 * WHY:  openDb() probed `PRAGMA table_info(test_runs)` to decide whether to add the
 *       `method` column. On a MISSING table that PRAGMA returns [] rather than
 *       throwing, so the check read "no method column" and ran ALTER TABLE against
 *       a table that did not exist. Every fresh database — a clone, a worktree, a
 *       CI runner — failed there before a single engine query was sent. It survived
 *       unnoticed because the documented order is `citation-test -- init` first, so
 *       nobody reached it with an empty file.
 *
 *       Found in review of PR #61. An empty result meaning "nothing to inspect" is
 *       not the same as "nothing needs doing" — the same confusion as counting a
 *       scan that examined zero bytes as a pass.
 *
 * The probe runs the REAL script in a child process with ASTGL_CITATION_TEST_DB
 * pointed at a throwaway file, and passes NO subcommand. main() calls openDb()
 * before it reads the subcommand, so the bootstrap runs and then the script exits
 * on usage — no engine is queried, no API key is needed, and no paid request is
 * ever made. That ordering is what makes this testable at all.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";

const REPO_ROOT = join(import.meta.dirname, "..");
const MODULE = join(REPO_ROOT, "src", "citation-test-auto.ts");

// WHY: a hanging child would block the whole suite with no diagnostic.
const PROBE_TIMEOUT_MS = 60_000;

describe("citation-test-auto on a fresh database", () => {
  test("bootstraps the schema instead of failing on a missing table", () => {
    const workDir = mkdtempSync(join(tmpdir(), "astgl-citation-fresh-"));
    const dbPath = join(workDir, "citation-test.db");

    try {
      assert.equal(
        existsSync(dbPath),
        false,
        "the fixture database must not exist yet — that is the whole scenario"
      );

      const result = spawnSync(process.execPath, ["--import", "tsx", MODULE], {
        encoding: "utf8",
        cwd: REPO_ROOT,
        timeout: PROBE_TIMEOUT_MS,
        env: { ...process.env, ASTGL_CITATION_TEST_DB: dbPath },
      });
      const err = result.stderr ?? "";

      assert.equal(
        result.error,
        undefined,
        `probe child could not be run (${result.error?.message}) — this is a ` +
          "harness failure, not a bootstrap regression"
      );

      // WHAT: the load-bearing assertion.
      // WHY:  the exit code CANNOT discriminate here. With the bootstrap removed,
      //       openDb() throws, main()'s .catch() logs "Fatal:" and exits 1 — and
      //       the healthy path also exits 1, because no subcommand was given. Only
      //       the absence of the error, and the state of the file, tell them apart.
      assert.ok(
        !err.includes("no such table"),
        "openDb() ran ALTER TABLE against a table that does not exist. " +
          `The createSchema() call in src/citation-test-auto.ts is missing.\nstderr:\n${err}`
      );

      assert.ok(
        existsSync(dbPath),
        `openDb() did not create the database at ${dbPath}.\nstderr:\n${err}`
      );

      const db = new Database(dbPath, { readonly: true });
      try {
        const tables = (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .all() as Array<{ name: string }>
        ).map((t) => t.name);

        for (const expected of ["target_questions", "test_runs", "test_results"]) {
          assert.ok(
            tables.includes(expected),
            `fresh database is missing the ${expected} table — got ${tables.join(", ")}`
          );
        }

        // WHY: `method` is the column whose absent-vs-missing-table confusion
        //      caused this. Assert it landed, so a bootstrap that created the
        //      tables but skipped the migration still fails here.
        const columns = (
          db.prepare("PRAGMA table_info(test_runs)").all() as Array<{ name: string }>
        ).map((c) => c.name);
        assert.ok(
          columns.includes("method"),
          `test_runs has no method column — got ${columns.join(", ")}`
        );
      } finally {
        db.close();
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
