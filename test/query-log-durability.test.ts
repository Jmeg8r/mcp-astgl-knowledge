/**
 * Durability tests for the buffered query log.
 *
 * WHAT: Proves that a buffered entry survives every way the process can end.
 * WHY:  query-log.ts trades durability for latency — entries sit in memory for up
 *       to FLUSH_INTERVAL_MS. That is a fine trade only if every exit path flushes.
 *       Before this suite it did not: 'beforeExit' fires when the event loop drains
 *       naturally, and never when the process is killed by a signal. An MCP stdio
 *       server is client-spawned and torn down with SIGTERM at session end, so the
 *       trailing window was lost on every normal shutdown.
 *
 *       Each test spawns a real child and kills it for real. An in-process test
 *       cannot express this defect: the assertion would have to run after the
 *       teardown it is testing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";

const CHILD = join(import.meta.dirname, "fixtures", "query-log-sigterm-child.ts");

// WHAT: Run the fixture under node itself, with tsx loaded as an import hook.
// WHY:  node_modules/.bin/tsx is a WRAPPER that spawns a second node process. Killing
//       the wrapper makes it observe its child's signal death and exit with 128+15 of
//       its own, so the parent sees `code=143, signal=null` and cannot distinguish
//       "died of SIGTERM" from "chose to exit 143". Spawning node directly makes the
//       process under test the process we signal, so `signal` means what it says.
const CHILD_ARGV = ["--import", "tsx", CHILD];

// WHY: comfortably inside query-log.ts's 5s FLUSH_INTERVAL_MS, so a passing test
//      can only mean a shutdown hook ran — never that the periodic timer beat us.
const KILL_AFTER_MS = 400;
const READY_TIMEOUT_MS = 20_000;

// WHAT: How long a signalled child gets to die before we SIGKILL it.
// WHY:  A handler that flushes but forgets to re-raise leaves the process running
//       forever. Without this bound the suite HANGS rather than fails — verified by
//       mutation: deleting the re-raise ran the test runner out to an 8-minute
//       timeout with no output. A hung job is strictly worse than a red one, because
//       it burns the whole CI budget and reports nothing about which test stuck.
const EXIT_TIMEOUT_MS = 5_000;

interface ChildResult {
  ready: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the child had to be SIGKILLed because it ignored the signal. */
  hung: boolean;
  stderr: string;
}

// WHAT: Run the fixture, wait for it to buffer an entry, then end it the given way.
// WHY:  Returns `ready` so every assertion can first confirm the child actually got
//       far enough to log something. "The probe found nothing" and "the probe never
//       ran" are otherwise the same observation, and the second one passes silently.
function runChild(
  dbPath: string,
  end: (pid: number) => void,
  mode: "idle" | "exit" = "idle"
): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, CHILD_ARGV, {
      env: { ...process.env, ASTGL_QUERY_LOG_DB: dbPath, CHILD_MODE: mode },
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    let ready = false;
    let hung = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let hangTimer: ReturnType<typeof setTimeout> | null = null;

    const readyTimer = setTimeout(() => {
      if (!ready) child.kill("SIGKILL");
    }, READY_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (!ready && stderr.includes("CHILD_READY")) {
        ready = true;
        killTimer = setTimeout(() => {
          end(child.pid!);
          // Bound the wait: a child that ignores the signal gets killed outright
          // and reported as hung, so the assertion fails instead of the suite
          // stalling.
          hangTimer = setTimeout(() => {
            hung = true;
            child.kill("SIGKILL");
          }, EXIT_TIMEOUT_MS);
        }, KILL_AFTER_MS);
      }
    });

    child.on("exit", (code, signal) => {
      clearTimeout(readyTimer);
      if (killTimer) clearTimeout(killTimer);
      if (hangTimer) clearTimeout(hangTimer);
      resolve({ ready, code, signal, hung, stderr });
    });
  });
}

function countProbeRows(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM query_log WHERE client_id = ?")
      .get("durability-probe") as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function withTempDb(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "astgl-qlog-"));
  return {
    path: join(dir, "query-log.db"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a buffered entry survives SIGTERM teardown", async () => {
  const db = withTempDb();
  try {
    const r = await runChild(db.path, (pid) => process.kill(pid, "SIGTERM"));

    assert.equal(r.ready, true, `child never buffered an entry; stderr: ${r.stderr}`);
    assert.equal(
      countProbeRows(db.path),
      1,
      "entry was lost on SIGTERM — the shutdown hook did not flush"
    );
  } finally {
    db.cleanup();
  }
});

test("a buffered entry survives SIGINT teardown", async () => {
  const db = withTempDb();
  try {
    const r = await runChild(db.path, (pid) => process.kill(pid, "SIGINT"));

    assert.equal(r.ready, true, `child never buffered an entry; stderr: ${r.stderr}`);
    assert.equal(countProbeRows(db.path), 1, "entry was lost on SIGINT");
  } finally {
    db.cleanup();
  }
});

test("a buffered entry survives an explicit process.exit()", async () => {
  const db = withTempDb();
  try {
    // The fixture exits itself; nothing for the parent to do.
    const r = await runChild(db.path, () => {}, "exit");

    assert.equal(r.ready, true, `child never buffered an entry; stderr: ${r.stderr}`);
    assert.equal(r.code, 0, "fixture should have exited cleanly");
    assert.equal(
      countProbeRows(db.path),
      1,
      "entry was lost on process.exit() — 'beforeExit' does not fire on that path"
    );
  } finally {
    db.cleanup();
  }
});

// WHAT: Guards the hazard the fix itself introduces.
// WHY:  Installing ANY SIGTERM listener suppresses Node's default terminate. A
//       handler that flushed but forgot to re-raise would turn a data-loss bug into
//       a server that never shuts down — strictly worse, and invisible to the tests
//       above, which would still see their row written.
test("SIGTERM still terminates the process, by the signal", async () => {
  const db = withTempDb();
  try {
    const r = await runChild(db.path, (pid) => process.kill(pid, "SIGTERM"));

    assert.equal(r.ready, true, `child never buffered an entry; stderr: ${r.stderr}`);
    assert.equal(
      r.hung,
      false,
      `process ignored SIGTERM and had to be SIGKILLed after ${EXIT_TIMEOUT_MS}ms — ` +
        "the handler flushed but never re-raised, so the server would never shut down"
    );
    assert.equal(
      r.signal,
      "SIGTERM",
      `process should die OF SIGTERM so a supervisor sees the real cause; got signal=${r.signal} code=${r.code}`
    );
  } finally {
    db.cleanup();
  }
});

// WHAT: The negative control for this whole file.
// WHY:  Every test above asserts a row EXISTS. If the fixture silently wrote to some
//       other database, they would all pass while proving nothing about the temp one.
//       This pins the assertion target: an untouched temp path has no rows, so a
//       count of 1 elsewhere is genuinely the child's write and not ambient state.
test("the temp database starts empty (assertion target is real)", () => {
  const db = withTempDb();
  try {
    assert.equal(countProbeRows(db.path), 0);
  } finally {
    db.cleanup();
  }
});
