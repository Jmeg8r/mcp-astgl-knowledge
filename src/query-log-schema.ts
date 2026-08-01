/**
 * The query_log table's schema — defined once, for every module that opens it.
 *
 * WHAT: Creates the analytics/rate-limit table and migrates legacy copies of it
 *       so `content_cited` is enforced non-null with a JSON default.
 * WHY:  query-log.ts and rate-limit.ts deliberately share one database FILE, and
 *       each carried its own `CREATE TABLE IF NOT EXISTS` — either can be the one
 *       that creates it. Two copies of a DDL is two places to drift (Mistake #8),
 *       and they had already drifted in a way nothing could catch: `IF NOT EXISTS`
 *       never errors, so the second copy is silently ignored.
 *
 *       `content_cited` is contractually JSON — `'[]'` when nothing was cited,
 *       never NULL — because claudeclaw reads it and a NULL breaks its demand
 *       signal (see CLAUDE.md and the query_log.db contract note). Both copies
 *       nevertheless declared it plain `TEXT`, so the contract lived only in the
 *       17 call sites. Documented but unenforced is the same defect class as the
 *       journal mode this module shipped alongside: a property the code asserts
 *       nowhere holds only where someone remembered it.
 *
 *       Enforcement has to migrate, not just declare. `CREATE TABLE IF NOT EXISTS`
 *       is a no-op against an existing table, so tightening the DDL alone would
 *       fix new databases and leave every existing one nullable — exactly the
 *       fresh-vs-existing split being closed here.
 */

import type Database from "better-sqlite3";

type Db = InstanceType<typeof Database>;

// WHAT: The canonical shape of query_log.
// WHY:  One string, referenced by the create path and the rebuild path, so a
//       migrated database and a freshly created one cannot end up different.
const QUERY_LOG_COLUMNS = `
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      client_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      query_params TEXT NOT NULL,
      content_cited TEXT NOT NULL DEFAULT '[]',
      response_time_ms INTEGER NOT NULL,
      confidence_score REAL`;

// WHAT: Indexes serving the analytics readers and the rate-limit COUNT.
// WHY:  Listed once because a table rebuild drops them with the old table; the
//       migration recreates them from this same list rather than a second copy.
const QUERY_LOG_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_query_log_ts ON query_log(timestamp)",
  "CREATE INDEX IF NOT EXISTS idx_query_log_tool ON query_log(tool_name)",
  "CREATE INDEX IF NOT EXISTS idx_query_log_client ON query_log(client_id)",
];

const CONTENT_CITED_EMPTY = "'[]'";

// WHAT: Does this database's content_cited already refuse NULL?
// WHY:  Read from PRAGMA table_info rather than by matching the stored DDL text:
//       the constraint is what SQLite enforces, not how it was spelled. Returns
//       false for a table that has no such column at all, which is the safe
//       direction — it triggers the rebuild that adds it.
function contentCitedIsEnforced(db: Db): boolean {
  const columns = db.pragma("table_info(query_log)") as Array<{
    name: string;
    notnull: number;
  }>;

  const column = columns.find((c) => c.name === "content_cited");
  return column !== undefined && column.notnull === 1;
}

// WHAT: Rebuild query_log with the constraint, preserving every row.
// WHY:  SQLite cannot ALTER an existing column to NOT NULL, so the documented
//       path is create-copy-drop-rename. Wrapped in a transaction because a
//       failure between the DROP and the RENAME would lose the analytics history
//       outright — and this runs at server start, unattended.
function migrateLegacyTable(db: Db): void {
  db.transaction(() => {
    // Backfill first: rows written before the constraint may hold NULL, and the
    // copy below would otherwise fail against the new table's NOT NULL.
    db.exec(
      `UPDATE query_log SET content_cited = ${CONTENT_CITED_EMPTY} WHERE content_cited IS NULL`
    );

    db.exec(`CREATE TABLE query_log_migrated (${QUERY_LOG_COLUMNS})`);
    db.exec(`
      INSERT INTO query_log_migrated
        (id, timestamp, client_id, tool_name, query_params, content_cited, response_time_ms, confidence_score)
      SELECT
        id, timestamp, client_id, tool_name, query_params, content_cited, response_time_ms, confidence_score
      FROM query_log
    `);
    db.exec("DROP TABLE query_log");
    db.exec("ALTER TABLE query_log_migrated RENAME TO query_log");
    // The old table's indexes went with it; ensureQueryLogSchema recreates them
    // unconditionally after this returns, which is the only place they are made.
  })();
}

// WHAT: Bring any query-log database up to the current schema. Idempotent.
// WHY:  Called by both initQueryLog() and initRateLimitDb() — whichever opens the
//       file first establishes the schema, and the second call is a no-op. On an
//       already-migrated database the only work is the PRAGMA read.
export function ensureQueryLogSchema(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS query_log (${QUERY_LOG_COLUMNS})`);

  if (!contentCitedIsEnforced(db)) {
    migrateLegacyTable(db);
  }

  for (const statement of QUERY_LOG_INDEXES) db.exec(statement);
}
