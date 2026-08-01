/**
 * Database path resolution.
 *
 * WHAT: The single place that knows where knowledge.db and query-log.db live.
 * WHY:  There are two valid locations depending on how the code is running, and
 *       three modules on the MCP server's import graph need the same answer.
 *       Three copies of this rule is three places to drift (Mistake #8).
 *
 *       - `data/knowledge.db` — the full working database. NOT shipped.
 *       - `build/knowledge-public.db` — the pruned artifact that ships in the
 *         npm package (package.json `files`), produced by build-public-db.ts.
 *
 *       Locally the full database wins, which is what MAESTER and local tooling
 *       want. On an end user's install only the pruned artifact exists, so the
 *       server serves exactly what the publication gate allowed.
 *       See docs/adr/0001-knowledge-db-keeps-its-own-index.md.
 */

import { existsSync } from "fs";
import { join } from "path";

const FULL_DB_PATH = join(import.meta.dirname, "..", "data", "knowledge.db");
const PUBLIC_DB_PATH = join(
  import.meta.dirname,
  "..",
  "build",
  "knowledge-public.db"
);

// WHAT: Resolve which database file to read.
// WHY:  Evaluated per call rather than cached at module load so a build that
//       produces the artifact mid-process is picked up, and so tests can create
//       or remove either file without reloading the module.
export function resolveKnowledgeDbPath(): string {
  return existsSync(FULL_DB_PATH) ? FULL_DB_PATH : PUBLIC_DB_PATH;
}

// WHAT: Human-readable list of where we looked, for error messages.
// WHY:  "not found at <one path>" sends the reader to the wrong place when the
//       real problem is that the other location is the one that mattered.
export function describeSearchedPaths(): string {
  return `${FULL_DB_PATH} or ${PUBLIC_DB_PATH}`;
}

const QUERY_LOG_DB_PATH = join(
  import.meta.dirname,
  "..",
  "data",
  "query-log.db"
);

// WHAT: Resolve where the analytics/rate-limit database lives.
// WHY:  SIX modules used to hardcode this path independently — query-log.ts,
//       rate-limit.ts, ideas.ts, dashboard.ts, daily-report.ts and alerts.ts —
//       and rate-limit.ts deliberately shares the same FILE as the query log.
//       That made the override below actively dangerous to add anywhere else:
//       redirecting one writer would silently split it from five readers and from
//       rate limiting, which is Mistake #8 with a worse blast radius than usual.
//       One resolver, so a redirect moves all of them or none.
//
//       ASTGL_QUERY_LOG_DB exists so tests can point at a throwaway database.
//       Without it the only way to test durability is to write probe rows into the
//       real analytics database and delete them afterwards.
export function resolveQueryLogDbPath(): string {
  return process.env.ASTGL_QUERY_LOG_DB || QUERY_LOG_DB_PATH;
}
