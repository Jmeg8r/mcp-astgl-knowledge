/**
 * Schema tests for the shared query_log table.
 *
 * WHAT: Proves content_cited is enforced NOT NULL on fresh databases, that an
 *       existing nullable database is migrated with every row preserved, and
 *       that NULLs already on disk are backfilled to '[]' rather than dropped.
 * WHY:  CLAUDE.md documents content_cited as JSON — '[]' when nothing was cited,
 *       never NULL — because claudeclaw reads it. Both DDL copies nevertheless
 *       declared plain TEXT, so the contract was enforced only by the 17 call
 *       sites remembering it (CodeRabbit, PR #48). Declaring NOT NULL alone would
 *       not have been enough: CREATE TABLE IF NOT EXISTS is a no-op against an
 *       existing table, so the constraint would reach new databases only and
 *       leave every existing one nullable.
 *
 *       The legacy fixture below is the VERBATIM pre-migration DDL, copied from
 *       git history rather than retyped, so it encodes the real old shape instead
 *       of my belief about it.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ensureQueryLogSchema } from "../src/query-log-schema.js";

const DIR = mkdtempSync(join(tmpdir(), "astgl-qlog-schema-"));
after(() => rmSync(DIR, { recursive: true, force: true }));

// WHAT: The table exactly as query-log.ts created it before this change.
// WHY:  Taken from `git show 9063d73:src/query-log.ts`. A hand-written fixture
//       would test the migration against a shape that never shipped — the trap
//       that let a stale CodeRabbit regression fixture pass for weeks.
const LEGACY_DDL = `
    CREATE TABLE IF NOT EXISTS query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      client_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      query_params TEXT NOT NULL,
      content_cited TEXT,
      response_time_ms INTEGER NOT NULL,
      confidence_score REAL
    )
  `;

let dbCounter = 0;
function freshDb(): InstanceType<typeof Database> {
  return new Database(join(DIR, `db-${dbCounter++}.db`));
}

function contentCitedNotNull(db: InstanceType<typeof Database>): boolean {
  const columns = db.pragma("table_info(query_log)") as Array<{
    name: string;
    notnull: number;
  }>;
  return columns.find((c) => c.name === "content_cited")?.notnull === 1;
}

function insertLegacyRow(
  db: InstanceType<typeof Database>,
  clientId: string,
  contentCited: string | null
): void {
  db.prepare(
    `INSERT INTO query_log (timestamp, client_id, tool_name, query_params, content_cited, response_time_ms, confidence_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run("2026-08-01T00:00:00.000Z", clientId, "probe", "{}", contentCited, 1, null);
}

test("a fresh database enforces content_cited NOT NULL", () => {
  const db = freshDb();
  try {
    ensureQueryLogSchema(db);
    assert.equal(contentCitedNotNull(db), true);

    assert.throws(
      () => insertLegacyRow(db, "probe", null),
      /NOT NULL/,
      "an explicit NULL should be rejected, not silently stored"
    );
  } finally {
    db.close();
  }
});

test("an omitted content_cited defaults to '[]' rather than NULL", () => {
  const db = freshDb();
  try {
    ensureQueryLogSchema(db);
    db.prepare(
      `INSERT INTO query_log (timestamp, client_id, tool_name, query_params, response_time_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).run("2026-08-01T00:00:00.000Z", "probe", "probe", "{}", 1);

    const row = db
      .prepare("SELECT content_cited FROM query_log WHERE client_id = ?")
      .get("probe") as { content_cited: string };

    assert.equal(row.content_cited, "[]");
  } finally {
    db.close();
  }
});

test("a legacy nullable database is migrated, backfilled, and keeps every row", () => {
  const db = freshDb();
  try {
    db.exec(LEGACY_DDL);
    insertLegacyRow(db, "has-citation", '["https://astgl.ai/a"]');
    insertLegacyRow(db, "null-citation", null);
    insertLegacyRow(db, "empty-citation", "[]");

    // Precondition: the fixture really is the un-enforced shape, so a pass below
    // cannot come from the fixture having been correct all along.
    assert.equal(contentCitedNotNull(db), false, "fixture should start nullable");
    const before = db
      .prepare("SELECT COUNT(*) AS n FROM query_log")
      .get() as { n: number };

    ensureQueryLogSchema(db);

    assert.equal(contentCitedNotNull(db), true, "migration did not enforce the constraint");

    const after = db.prepare("SELECT COUNT(*) AS n FROM query_log").get() as {
      n: number;
    };
    assert.equal(after.n, before.n, "migration lost rows");

    const rows = db
      .prepare("SELECT client_id, content_cited FROM query_log ORDER BY id")
      .all() as Array<{ client_id: string; content_cited: string }>;

    assert.deepEqual(
      rows.map((r) => [r.client_id, r.content_cited]),
      [
        ["has-citation", '["https://astgl.ai/a"]'],
        ["null-citation", "[]"],
        ["empty-citation", "[]"],
      ],
      "existing citations must survive verbatim and NULL must become '[]'"
    );
  } finally {
    db.close();
  }
});

test("the migration preserves id values, so analytics history stays stable", () => {
  const db = freshDb();
  try {
    db.exec(LEGACY_DDL);
    insertLegacyRow(db, "first", "[]");
    insertLegacyRow(db, "second", "[]");
    db.exec("DELETE FROM query_log WHERE client_id = 'first'");

    const idBefore = (
      db.prepare("SELECT id FROM query_log").get() as { id: number }
    ).id;
    assert.equal(idBefore, 2, "fixture should leave a gap at id 1");

    ensureQueryLogSchema(db);

    const idAfter = (
      db.prepare("SELECT id FROM query_log").get() as { id: number }
    ).id;
    assert.equal(idAfter, 2, "rebuild renumbered rows instead of copying ids");

    // WHAT: The AUTOINCREMENT high-water mark must survive the rebuild too.
    // WHY:  Preserving existing ids is only half of it. sqlite_sequence is what
    //       stops a new row from reusing the id of a deleted one — and these ids
    //       are the analytics table's append-only ordering. Verified against the
    //       bundled SQLite rather than assumed: RENAME carries the sequence, so
    //       the next insert must be 3, never 1.
    insertLegacyRow(db, "after-migration", "[]");
    const newId = (
      db
        .prepare("SELECT id FROM query_log WHERE client_id = ?")
        .get("after-migration") as { id: number }
    ).id;
    assert.equal(
      newId,
      3,
      "the rebuild reset sqlite_sequence — a new row reused a retired id"
    );
  } finally {
    db.close();
  }
});

// WHAT: The one shape this module refuses instead of migrating.
// WHY:  Both the backfill and the copy name content_cited, so a table without it
//       would fail mid-rebuild with a bare "no such column". Every version of
//       this table has had the column, so its absence means the database was not
//       written by this system — rebuilding would fabricate citation history
//       claudeclaw reads. Asserted here so the refusal cannot quietly become a
//       rebuild later (CodeRabbit, PR #48).
test("a query_log with no content_cited column is refused, not rebuilt", () => {
  const db = freshDb();
  try {
    db.exec(`
      CREATE TABLE query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        client_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        query_params TEXT NOT NULL,
        response_time_ms INTEGER NOT NULL,
        confidence_score REAL
      )
    `);
    db.prepare(
      `INSERT INTO query_log (timestamp, client_id, tool_name, query_params, response_time_ms)
       VALUES (?, ?, ?, ?, ?)`
    ).run("2026-08-01T00:00:00.000Z", "foreign", "probe", "{}", 1);

    assert.throws(
      () => ensureQueryLogSchema(db),
      /content_cited column/,
      "should refuse by name, not throw a bare SQLite 'no such column'"
    );

    // WHY: This throws at server start, unattended. An operator reading the log
    //      needs to know WHICH database — the path is resolved through db-path.ts
    //      and an override, so "the query log" is not enough to act on.
    assert.throws(
      () => ensureQueryLogSchema(db),
      new RegExp(db.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "the error should name the database file it refused"
    );

    // The refusal must leave the database exactly as it found it.
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number }).n,
      1,
      "the refused database was modified anyway"
    );
    assert.equal(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?")
          .get("query_log_migrated") as { n: number }
      ).n,
      0,
      "a half-built rebuild table was left behind"
    );
  } finally {
    db.close();
  }
});

test("the migration restores the indexes it drops with the old table", () => {
  const db = freshDb();
  try {
    db.exec(LEGACY_DDL);
    insertLegacyRow(db, "probe", "[]");
    ensureQueryLogSchema(db);

    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'query_log'"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    for (const expected of [
      "idx_query_log_ts",
      "idx_query_log_tool",
      "idx_query_log_client",
    ]) {
      assert.ok(
        indexes.includes(expected),
        `${expected} was dropped with the old table and never recreated; got ${indexes.join(", ")}`
      );
    }
  } finally {
    db.close();
  }
});

test("running the migration twice is a no-op", () => {
  const db = freshDb();
  try {
    db.exec(LEGACY_DDL);
    insertLegacyRow(db, "probe", '["https://astgl.ai/a"]');

    ensureQueryLogSchema(db);
    const first = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'query_log'")
      .get() as { sql: string };

    ensureQueryLogSchema(db);
    const second = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'query_log'")
      .get() as { sql: string };

    assert.equal(second.sql, first.sql, "second run altered the schema");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number }).n,
      1,
      "second run touched the data"
    );
    // No leftover scaffolding from the rebuild.
    const scaffolding = db
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'query_log_migrated'"
      )
      .get() as { n: number };
    assert.equal(scaffolding.n, 0, "the rebuild's temporary table was left behind");
  } finally {
    db.close();
  }
});
