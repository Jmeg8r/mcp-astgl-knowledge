/**
 * Tests for query-log durability (run with: npm test).
 *
 * The bug these guard against: a stdio MCP server is killed by signal when a session
 * ends, so a buffered entry would be silently lost. The fix removes the buffer and
 * writes each entry synchronously in WAL mode. These tests assert the real-world
 * invariant — a single short-session entry survives a non-graceful kill — across:
 *   - SIGTERM  (exercises the signal handler's clean close)
 *   - SIGKILL  (uncatchable; proves the durable per-insert write, not the handler)
 *   - in-process graceful close (sanity: row persists and WAL is active)
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";

const FIXTURE = join(import.meta.dirname, "query-log-child.ts");
const tmpPaths: string[] = [];

function uniqueDbPath(): string {
  const p = join(tmpdir(), `astgl-querylog-test-${randomUUID()}.db`);
  tmpPaths.push(p);
  return p;
}

function countRows(dbPath: string): number {
  // A fresh connection recovers any un-checkpointed -wal (the SIGKILL case).
  const db = new Database(dbPath, { readonly: false });
  try {
    return (
      db.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number }
    ).n;
  } finally {
    db.close();
  }
}

// Spawn the fixture, wait for it to write + announce READY, deliver `signal`,
// and resolve once the child has exited.
function logOneEntryThenSignal(
  dbPath: string,
  signal: NodeJS.Signals
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
      env: { ...process.env, ASTGL_QUERY_LOG_PATH: dbPath },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`child never reached READY (signal under test: ${signal})`));
    }, 15_000);

    let out = "";
    let signaled = false;
    child.stdout.on("data", (chunk) => {
      out += chunk.toString();
      if (!signaled && out.includes("READY")) {
        signaled = true;
        child.kill(signal);
      }
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[child stderr] ${chunk}`);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

after(() => {
  for (const p of tmpPaths) {
    for (const f of [p, `${p}-wal`, `${p}-shm`, `${p}-journal`]) {
      if (existsSync(f)) rmSync(f);
    }
  }
});

test("entry survives SIGTERM (signal handler closes cleanly)", async () => {
  const dbPath = uniqueDbPath();
  await logOneEntryThenSignal(dbPath, "SIGTERM");
  assert.equal(countRows(dbPath), 1);
});

test("entry survives SIGKILL (durable per-insert, handler can't run)", async () => {
  const dbPath = uniqueDbPath();
  await logOneEntryThenSignal(dbPath, "SIGKILL");
  assert.equal(countRows(dbPath), 1);
});

test("in-process: synchronous write persists and db is in WAL mode", async () => {
  const dbPath = uniqueDbPath();
  process.env.ASTGL_QUERY_LOG_PATH = dbPath;

  // Dynamic import so the module binds LOG_DB_PATH to our tmp path (set above)
  // rather than the real data/ file.
  const { initQueryLog, logQuery, closeQueryLog } = await import(
    "../query-log.js"
  );

  initQueryLog();
  logQuery({
    timestamp: new Date().toISOString(),
    clientId: "anon_test",
    toolName: "get_answer",
    queryParams: JSON.stringify({ question: "does it persist?" }),
    contentCited: JSON.stringify([]),
    responseTimeMs: 5,
    confidenceScore: null,
  });
  closeQueryLog();

  const db = new Database(dbPath);
  try {
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number })
        .n,
      1
    );
  } finally {
    db.close();
  }
});
