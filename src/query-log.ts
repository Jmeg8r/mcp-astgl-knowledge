/**
 * Query logging module for MCP analytics.
 *
 * WHAT: Logs every MCP tool invocation with timing, params, and cited content
 * WHY: Enables analytics on what users ask, which content gets cited, and response quality
 *
 * Performance:
 *   Entries are buffered in memory and flushed to SQLite in batches
 *   (every 5 seconds or when buffer hits 20 entries) to avoid blocking responses.
 *   Buffering means the process can die holding unwritten entries, so every path
 *   out of the process flushes — see registerShutdownHooks().
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";
import { resolveQueryLogDbPath } from "./db-path.js";
import type { QueryLogEntry } from "./types.js";

// WHY: Resolved via db-path.ts, which is also what rate-limit.ts and the four
//      analytics readers use — this file is shared, so the path rule cannot live
//      in six places (Mistake #8).
const LOG_DB_PATH = resolveQueryLogDbPath();

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 20;

// WHAT: Signals that mean "this process is going away".
// WHY:  An MCP stdio server is spawned by its client and torn down with SIGTERM
//       when the session ends; SIGINT is the interactive equivalent.
const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT"];

let logDb: InstanceType<typeof Database> | null = null;
let buffer: QueryLogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

// WHAT: Whether process-level shutdown hooks have been installed.
// WHY:  initQueryLog() is called once per process in production but repeatedly
//       across tests. Without this guard each call stacks another listener set and
//       Node warns about a leak at 11.
let shutdownHooksRegistered = false;

export function initQueryLog(): InstanceType<typeof Database> {
  const dataDir = join(import.meta.dirname, "..", "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  logDb = new Database(LOG_DB_PATH);

  // WHAT: Pin WAL journal mode on every open.
  // WHY:  Maester's morning analytics jobs read this file while the server's
  //       buffered flushes write it; WAL lets readers overlap the writer instead
  //       of surfacing SQLITE_BUSY. The mode persists inside the database file —
  //       the production file has been WAL since long before this line — but no
  //       code ever established it, so a fresh database (new clone, or a test
  //       pointed at ASTGL_QUERY_LOG_DB) came up in rollback mode and diverged
  //       from the contract CLAUDE.md documents (-wal/-shm sidecars are normal).
  //       Decided 2026-08-01. Idempotent on an already-WAL file.
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

  // WHAT: Start periodic flush timer
  // WHY: Ensures buffered entries are written even during low-traffic periods
  flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);
  flushTimer.unref(); // Don't keep process alive just for logging

  registerShutdownHooks();

  return logDb;
}

// WHAT: Flush the buffer on every path this process can leave by.
// WHY:  'beforeExit' alone loses data. It fires only when the event loop drains
//       naturally — NOT when the process is killed by a signal, and NOT on an
//       explicit process.exit(). An MCP stdio server is client-spawned and torn
//       down with SIGTERM at session end, so before this every entry logged inside
//       the trailing FLUSH_INTERVAL_MS window was silently lost. Measured against
//       the previous code: a child SIGTERM'd 0.5s after logQuery() persisted 0
//       rows, while the same child left alive past the 5s timer persisted 1.
function registerShutdownHooks(): void {
  if (shutdownHooksRegistered) return;
  shutdownHooksRegistered = true;

  // Event loop drained on its own.
  process.on("beforeExit", flushBuffer);

  // WHAT: Last-resort synchronous flush.
  // WHY:  'exit' is the only hook that still runs after process.exit(), which
  //       src/index.ts calls on a fatal error. Only synchronous work is permitted
  //       here, which flushBuffer already is — better-sqlite3 is synchronous.
  process.on("exit", flushBuffer);

  for (const signal of TERMINATION_SIGNALS) {
    process.once(signal, () => handleTerminationSignal(signal));
  }
}

// WHAT: Flush, release the database, then let the signal do what it would have done.
// WHY:  Installing ANY listener for SIGTERM/SIGINT suppresses Node's default
//       terminate-the-process behavior, so a handler that merely flushes would hang
//       the server forever on shutdown — turning a data-loss bug into a worse one.
//       Re-raising after `once` has removed this listener restores the default:
//       the process dies of the signal, and its parent sees "killed by SIGTERM"
//       rather than a synthetic exit code, which is what a supervisor expects.
function handleTerminationSignal(signal: NodeJS.Signals): void {
  closeQueryLog();
  process.kill(process.pid, signal);
}

// WHAT: Buffer log entries and flush when threshold is reached
// WHY: Removes ~1-5ms synchronous INSERT from every tool response
export function logQuery(entry: QueryLogEntry): void {
  if (!logDb) return;

  buffer.push(entry);

  if (buffer.length >= FLUSH_BATCH_SIZE) {
    flushBuffer();
  }
}

// WHAT: Write all buffered entries to SQLite in a single transaction
// WHY: Batch INSERT in a transaction is ~10x faster than individual INSERTs
function flushBuffer(): void {
  if (!logDb || buffer.length === 0) return;

  const entries = buffer.splice(0);

  try {
    const insert = logDb.prepare(
      `INSERT INTO query_log (timestamp, client_id, tool_name, query_params, content_cited, response_time_ms, confidence_score)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );

    const insertAll = logDb.transaction(() => {
      for (const entry of entries) {
        insert.run(
          entry.timestamp,
          entry.clientId,
          entry.toolName,
          entry.queryParams,
          entry.contentCited,
          entry.responseTimeMs,
          entry.confidenceScore
        );
      }
    });

    insertAll();
  } catch (err) {
    // WHAT: Log error but don't crash — analytics loss is acceptable
    // WHY: Query logging should never block or crash the MCP server
    console.error(
      `Query log flush failed (${entries.length} entries lost):`,
      err instanceof Error ? err.message : err
    );
  }
}

export function closeQueryLog(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }

  flushBuffer(); // Final flush

  if (logDb) {
    logDb.close();
    logDb = null;
  }
}
