/**
 * Journal-mode tests for the shared analytics database.
 *
 * WHAT: Proves a fresh query-log database comes up in WAL mode from either module
 *       that can create it, and that the probe could actually report otherwise.
 * WHY:  The production file has been WAL since before it was documented, but no
 *       code ever established the mode (git log -S "journal_mode" -- src/ is
 *       empty before this change) — so every fresh database silently came up in
 *       rollback mode and diverged from the contract CLAUDE.md documents. WAL is
 *       what lets the analytics readers overlap the MCP server's buffered
 *       flushes without SQLITE_BUSY.
 *
 *       Assertions cross the boundary they police: the mode is read back through
 *       a separate readonly connection after the module under test has closed
 *       its own, never through the connection that set it.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

// WHAT: Point both modules at a throwaway database BEFORE they load.
// WHY:  query-log.ts and rate-limit.ts cache resolveQueryLogDbPath() at module
//       load, so the override must exist before the dynamic imports below — a
//       static import would hoist above this assignment and hit the real path.
const DIR = mkdtempSync(join(tmpdir(), "astgl-qlog-wal-"));
const DB_PATH = join(DIR, "query-log.db");
process.env.ASTGL_QUERY_LOG_DB = DB_PATH;

const { initQueryLog, closeQueryLog } = await import("../src/query-log.js");
const { initRateLimitDb, closeRateLimitDb } = await import(
  "../src/rate-limit.js"
);

after(() => rmSync(DIR, { recursive: true, force: true }));

// WHAT: Read the persisted journal mode through a fresh readonly connection.
// WHY:  Asking the connection that set the mode what the mode is would be the
//       check verifying itself. The file header is the ground truth.
function persistedJournalMode(path: string): string {
  const probe = new Database(path, { readonly: true });
  try {
    return probe.pragma("journal_mode", { simple: true }) as string;
  } finally {
    probe.close();
  }
}

// WHAT: Remove the database and its WAL sidecars between module probes.
// WHY:  journal_mode persists inside the file. Without this, the second module
//       would open a file the FIRST module already switched to WAL, and its
//       assertion would pass without proving that module sets anything.
function removeDb(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(DB_PATH + suffix, { force: true });
  }
}

test("a fresh database created by initQueryLog comes up in WAL mode", () => {
  removeDb();
  initQueryLog();
  closeQueryLog();

  assert.equal(
    persistedJournalMode(DB_PATH),
    "wal",
    "initQueryLog left a fresh database in rollback mode — a new clone would diverge from the documented WAL contract"
  );
});

test("a fresh database created by initRateLimitDb comes up in WAL mode", () => {
  removeDb();
  initRateLimitDb();
  closeRateLimitDb();

  assert.equal(
    persistedJournalMode(DB_PATH),
    "wal",
    "initRateLimitDb left a fresh database in rollback mode — whichever module opens the file first must establish the mode"
  );
});

// WHAT: The negative control for this file.
// WHY:  If the probe reported "wal" for any SQLite file, both tests above would
//       pass while proving nothing. A database created WITHOUT the pragma must
//       read back in SQLite's default rollback mode, pinning that the probe can
//       tell the two states apart.
test("the probe distinguishes WAL from rollback mode (assertion target is real)", () => {
  const rawPath = join(DIR, "no-pragma.db");
  const raw = new Database(rawPath);
  raw.exec("CREATE TABLE t (x INTEGER)");
  raw.close();

  assert.equal(persistedJournalMode(rawPath), "delete");
});
