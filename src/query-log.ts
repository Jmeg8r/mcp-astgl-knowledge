/**
 * Query logging module for MCP analytics.
 *
 * WHAT: Logs every MCP tool invocation with timing, params, and cited content
 * WHY: Enables analytics on what users ask, which content gets cited, and response quality
 *
 * Performance:
 *   Entries are buffered in memory and flushed to SQLite in batches
 *   (every 5 seconds or when buffer hits 20 entries) to avoid blocking responses.
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";
import type { QueryLogEntry } from "./types.js";

const LOG_DB_PATH = join(import.meta.dirname, "..", "data", "query-log.db");

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 20;

let logDb: InstanceType<typeof Database> | null = null;
let buffer: QueryLogEntry[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;

export function initQueryLog(): InstanceType<typeof Database> {
  const dataDir = join(import.meta.dirname, "..", "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  logDb = new Database(LOG_DB_PATH);

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

  // WHAT: Flush on process exit
  // WHY: Don't lose buffered entries when the MCP server shuts down
  process.on("beforeExit", flushBuffer);

  return logDb;
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
