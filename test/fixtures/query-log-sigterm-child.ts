/**
 * Child process fixture for the query-log durability tests.
 *
 * WHAT: Initialises the query log against a throwaway database, writes one entry,
 *       announces readiness, then stays alive so the parent can decide how it dies.
 * WHY:  The defect under test only exists across a process boundary — it is about
 *       what survives when the process is killed. It cannot be observed in-process,
 *       because the assertion would run before the teardown it is meant to test.
 *
 * Contract with the parent:
 *   env ASTGL_QUERY_LOG_DB  — database path (query-log.ts reads it at module load)
 *   env CHILD_MODE          — "idle" (default) or "exit" (call process.exit(0))
 *   stderr "CHILD_READY"    — the entry is buffered; signal me now
 */

import { initQueryLog, logQuery } from "../../src/query-log.js";

const PROBE_CLIENT_ID = "durability-probe";

initQueryLog();

logQuery({
  timestamp: new Date().toISOString(),
  clientId: PROBE_CLIENT_ID,
  toolName: "probe_tool",
  queryParams: "{}",
  contentCited: "[]",
  responseTimeMs: 1,
  confidenceScore: null,
});

// WHY: stderr, never stdout — matches the repo-wide contract that stdout is
//      protocol or a single JSON summary, and keeps this fixture honest about it.
console.error("CHILD_READY");

if (process.env.CHILD_MODE === "exit") {
  // WHAT: Leave via an explicit exit rather than a signal.
  // WHY:  'beforeExit' does not fire on process.exit(); this exercises the 'exit'
  //       hook specifically, which is the path src/index.ts takes on a fatal error.
  process.exit(0);
} else {
  // WHAT: Hold the event loop open.
  // WHY:  If the loop drained, 'beforeExit' would flush and the test would pass for
  //       the wrong reason — it would never exercise signal teardown at all.
  setInterval(() => {}, 1_000);
}
