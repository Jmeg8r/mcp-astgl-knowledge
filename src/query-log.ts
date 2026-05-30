/**
 * Query logging module for MCP analytics.
 *
 * WHAT: Logs every MCP tool invocation with timing, params, and cited content
 * WHY: Enables analytics on what users ask, which content gets cited, and response quality
 *
 * Durability:
 *   Each entry is written synchronously the moment it is logged. stdio MCP servers are
 *   client-spawned and torn down with SIGTERM/SIGKILL when a session ends — they never
 *   exit gracefully — so any in-memory buffer would be silently lost on every short
 *   session. We avoid that entirely by holding no buffer: the db runs in WAL mode, where
 *   a single durable INSERT (~0.014ms) is actually cheaper than the old amortized batch
 *   write, and survives SIGTERM, SIGKILL, and crashes alike.
 */

import { join, dirname } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";
import type { QueryLogEntry } from "./types.js";

// WHAT: Allow the log db path to be overridden via env
// WHY: Lets tests point at an isolated tmp db instead of the real data/ file
const LOG_DB_PATH =
  process.env.ASTGL_QUERY_LOG_PATH ??
  join(import.meta.dirname, "..", "data", "query-log.db");

let logDb: InstanceType<typeof Database> | null = null;
let insertStmt: Database.Statement<unknown[]> | null = null;
let handlersRegistered = false;

export function initQueryLog(): InstanceType<typeof Database> {
  const dataDir = dirname(LOG_DB_PATH);
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  logDb = new Database(LOG_DB_PATH);

  // WHAT: Run in WAL (write-ahead log) journal mode
  // WHY: Every INSERT is durably committed immediately — no buffer to lose on a
  //      signal-kill — while staying fast (~0.014ms/insert) and letting the cron
  //      readers (daily-report, dashboard, alerts) read concurrently with writes.
  logDb.pragma("journal_mode = WAL");

  logDb.exec(`
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
  `);

  // WHAT: Index on timestamp + tool_name for common analytics queries
  // WHY: Most reports filter by date range and/or tool
  logDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_query_log_ts ON query_log(timestamp)"
  );
  logDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_query_log_tool ON query_log(tool_name)"
  );

  // WHAT: Prepare the INSERT once and reuse it for every logQuery call
  // WHY: Avoids re-parsing the SQL on each invocation
  insertStmt = logDb.prepare<unknown[]>(
    `INSERT INTO query_log (timestamp, client_id, tool_name, query_params, content_cited, response_time_ms, confidence_score)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  registerShutdownHandlers();

  return logDb;
}

// WHAT: Persist a single log entry synchronously
// WHY: No buffering — the write is durable the instant it returns, so nothing is
//      lost when the client kills the server. The cost (~0.014ms in WAL) is
//      negligible against typical MCP tool latency.
export function logQuery(entry: QueryLogEntry): void {
  if (!logDb || !insertStmt) return;

  try {
    insertStmt.run(
      entry.timestamp,
      entry.clientId,
      entry.toolName,
      entry.queryParams,
      entry.contentCited,
      entry.responseTimeMs,
      entry.confidenceScore
    );
  } catch (err) {
    // WHAT: Log the error but never throw — analytics loss is acceptable
    // WHY: Query logging must never block or crash a tool response
    console.error(
      "Query log write failed (1 entry lost):",
      err instanceof Error ? err.message : err
    );
  }
}

export function closeQueryLog(): void {
  if (logDb) {
    // WHAT: close() checkpoints the WAL back into the main db on the last connection
    // WHY: Leaves the db clean; idempotent so signal + beforeExit + fatal paths can all call it
    logDb.close();
    logDb = null;
  }
  insertStmt = null;
}

// WHAT: Flush-and-close on every shutdown path, including signal-kill
// WHY: 'beforeExit' never fires when the process is terminated by a signal (the usual
//      stdio MCP teardown). Entries are already durable per-insert, so these handlers
//      exist to checkpoint the WAL and close cleanly — defense in depth, not a rescue.
function registerShutdownHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  // Natural exit (event loop drains): close cleanly.
  process.on("beforeExit", closeQueryLog);

  // Signal-kill (the real stdio teardown path): close, then re-raise so the process
  // terminates with the conventional 128+signal code. once() removes our listener
  // before the body runs, so re-raising falls through to Node's default disposition.
  const shutdown = (signal: NodeJS.Signals) => {
    closeQueryLog();
    process.kill(process.pid, signal);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
