/**
 * Test fixture (not part of the build — see tsconfig "exclude").
 *
 * WHAT: A minimal stand-in for the MCP server: open the query log, write exactly
 *       one entry (a typical short session), announce readiness, then idle.
 * WHY:  The parent test signals this process (SIGTERM / SIGKILL) to prove a logged
 *       entry survives a non-graceful kill. Requires ASTGL_QUERY_LOG_PATH to point
 *       at an isolated tmp db.
 */

import { initQueryLog, logQuery } from "../query-log.js";

if (!process.env.ASTGL_QUERY_LOG_PATH) {
  console.error("fixture requires ASTGL_QUERY_LOG_PATH");
  process.exit(2);
}

initQueryLog();

logQuery({
  timestamp: new Date().toISOString(),
  clientId: "anon_test",
  toolName: "search_articles",
  queryParams: JSON.stringify({ query: "short session single entry" }),
  contentCited: JSON.stringify(["https://astgl.ai/answers/example"]),
  responseTimeMs: 12,
  confidenceScore: 0.9,
});

// The write above is synchronous and durable (WAL fsync) before this line runs.
console.log("READY");

// WHAT: Keep the process alive (not unref'd) so the parent can deliver a signal.
// WHY: Mirrors the real server, whose stdio transport holds the event loop open.
setInterval(() => {}, 1 << 30);
