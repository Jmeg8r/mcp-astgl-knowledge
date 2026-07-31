/**
 * Tests for the backup retention pruner.
 *
 * WHAT: Covers the schema comparator, the retention classifier, and argument parsing.
 * WHY:  This code decides which 80 MB restore points get deleted. It replaces a bash
 *       recipe that took eleven review findings across four rounds precisely because a
 *       markdown procedure can only be reviewed by eye. The cases below are the ones
 *       that recipe got wrong — each one is now a test rather than a reviewer's catch.
 *
 * Run with: npm test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "fs";
import { join } from "path";

import {
  classifyBackups,
  parseArgs,
  schemasEqual,
} from "../src/prune-backups.js";
import type { BackupEntry, ColumnMeta } from "../src/prune-backups.js";

// WHAT: Snapshot data/ at import time, before any test body runs.
// WHY:  The first version of this module called main() at module scope. Importing it
//       ran the whole procedure, took a real 8 MB checkpoint, and called
//       process.exit(0) — so NOT ONE assertion below executed, and node:test happily
//       reported "tests 1, pass 1". A green suite that never ran is the worst possible
//       failure mode for a test file, so the absence of side effects is itself asserted.
const DATA_DIR = join(import.meta.dirname, "..", "data");
const BACKUPS_AT_IMPORT = (() => {
  try {
    return readdirSync(DATA_DIR).filter((n) => n.includes(".bak."));
  } catch {
    return [];
  }
})();

// --- Fixtures ---

const NOW = new Date("2026-07-31T00:00:00.000Z");

function col(over: Partial<ColumnMeta> & { cid: number; name: string }): ColumnMeta {
  return { type: "TEXT", notnull: 0, dflt_value: null, pk: 0, ...over };
}

// A trimmed stand-in for the real `articles` schema. `public` carries the publication
// gate's fail-closed property: INTEGER NOT NULL DEFAULT 0.
const LIVE_SCHEMA: ColumnMeta[] = [
  col({ cid: 0, name: "id", type: "INTEGER", pk: 1 }),
  col({ cid: 1, name: "title", notnull: 1 }),
  col({ cid: 2, name: "url", notnull: 1 }),
  col({ cid: 3, name: "source_origin", dflt_value: "'astgl-site'" }),
  col({ cid: 4, name: "public", type: "INTEGER", notnull: 1, dflt_value: "0" }),
];

function entry(over: Partial<BackupEntry> & { path: string }): BackupEntry {
  return {
    name: over.path.split("/").pop()!,
    bytes: 80 * 1024 * 1024,
    mtime: NOW,
    schema: LIVE_SCHEMA,
    ...over,
  };
}

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
}

const CHECKPOINT = "/data/knowledge.db.bak.checkpoint-2026-07-31T00-00-00Z";

function classify(entries: BackupEntry[], keepDays = 30) {
  return classifyBackups({
    entries,
    liveSchema: LIVE_SCHEMA,
    checkpointPath: CHECKPOINT,
    now: NOW,
    keepDays,
  });
}

// --- Import safety ---

describe("module import", () => {
  test("importing the script does not RUN the script", () => {
    // If main() executed on import it would have created a checkpoint here — and,
    // worse, called process.exit() before this assertion could ever be reached. The
    // fact that this test runs at all is half the signal; the file count is the rest.
    const now = (() => {
      try {
        return readdirSync(DATA_DIR).filter((n) => n.includes(".bak."));
      } catch {
        return [];
      }
    })();
    assert.deepEqual(
      now,
      BACKUPS_AT_IMPORT,
      "importing src/prune-backups.ts created or removed a backup — main() is not guarded by an entry-point check"
    );
  });
});

// --- schemasEqual ---

describe("schemasEqual", () => {
  test("matches an identical schema", () => {
    assert.equal(schemasEqual(LIVE_SCHEMA, [...LIVE_SCHEMA]), true);
  });

  test("catches a missing column", () => {
    assert.equal(schemasEqual(LIVE_SCHEMA.slice(0, 4), LIVE_SCHEMA), false);
  });

  test("catches a lost NOT NULL DEFAULT — invisible to a name comparison", () => {
    // WHY: this is the case the bash recipe shipped with. `public INTEGER` instead of
    //      `public INTEGER NOT NULL DEFAULT 0` has identical column NAMES, so a
    //      names-only check called it compatible. Restoring it would have silently
    //      removed the publication gate's fail-closed default (ADR-0001).
    const weakened = LIVE_SCHEMA.map((c) =>
      c.name === "public" ? { ...c, notnull: 0, dflt_value: null } : c
    );
    assert.deepEqual(
      weakened.map((c) => c.name),
      LIVE_SCHEMA.map((c) => c.name),
      "precondition: column names are identical"
    );
    assert.equal(schemasEqual(weakened, LIVE_SCHEMA), false);
  });

  test("cannot be fooled by a delimiter collision", () => {
    // WHY: the bash version joined metadata with ':' and '|', so `("a:b" TEXT)` and
    //      `(a "b:TEXT")` produced the same signature. Structured comparison has no
    //      delimiter, so the collision is not merely caught — it is unrepresentable.
    const a: ColumnMeta[] = [col({ cid: 0, name: "a:b", type: "TEXT" })];
    const b: ColumnMeta[] = [col({ cid: 0, name: "a", type: "b:TEXT" })];
    assert.equal(schemasEqual(a, b), false);
  });

  test("catches reordered columns with the same names", () => {
    const swapped = [
      { ...LIVE_SCHEMA[1], cid: 2 },
      { ...LIVE_SCHEMA[2], cid: 1 },
    ];
    assert.equal(schemasEqual(swapped, [LIVE_SCHEMA[1], LIVE_SCHEMA[2]]), false);
  });

  test("null is never equal to anything, including another null", () => {
    // WHY: null means "could not read". The bash version compared two empty strings and
    //      got `true`, so unreadable backups classified as compatible.
    assert.equal(schemasEqual(null, LIVE_SCHEMA), false);
    assert.equal(schemasEqual(LIVE_SCHEMA, null), false);
    assert.equal(schemasEqual(null, null), false, "two unknowns are not a match");
  });
});

// --- classifyBackups ---

describe("classifyBackups", () => {
  test("always keeps the fresh checkpoint", () => {
    const { keep, prune } = classify([entry({ path: CHECKPOINT })]);
    assert.equal(prune.length, 0);
    assert.equal(keep[0].reason, "fresh_checkpoint");
  });

  test("keeps a young, schema-compatible backup", () => {
    const { keep, prune } = classify([
      entry({ path: CHECKPOINT }),
      entry({ path: "/data/knowledge.db.bak.recent", mtime: daysAgo(5) }),
    ]);
    assert.equal(prune.length, 0);
    assert.equal(keep.length, 2);
    assert.ok(keep.some((k) => k.reason === "within_age_and_schema_ok"));
  });

  test("prunes a backup older than the window", () => {
    const { prune } = classify([
      entry({ path: CHECKPOINT }),
      entry({ path: "/data/knowledge.db.bak.old", mtime: daysAgo(45) }),
    ]);
    assert.equal(prune.length, 1);
    assert.equal(prune[0].reason, "older_than_keep_days");
  });

  test("prunes a YOUNG backup whose schema is stale", () => {
    // WHY: the exact contradiction the docs shipped with — a 10-day-old backup taken
    //      before a 5-day-old migration passes the age test and is still useless.
    const stale = LIVE_SCHEMA.slice(0, 4);
    const { prune } = classify([
      entry({ path: CHECKPOINT }),
      entry({ path: "/data/knowledge.db.bak.young-but-stale", mtime: daysAgo(10), schema: stale }),
    ]);
    assert.equal(prune.length, 1);
    assert.equal(prune[0].reason, "schema_mismatch");
  });

  test("reports schema_mismatch, not age, when a backup fails both", () => {
    // WHY: the summary names why something was deleted. "too old" for a file that was
    //      actually schema-incompatible sends the reader to the wrong conclusion.
    const { prune } = classify([
      entry({ path: CHECKPOINT }),
      entry({
        path: "/data/knowledge.db.bak.both",
        mtime: daysAgo(90),
        schema: LIVE_SCHEMA.slice(0, 3),
      }),
    ]);
    assert.equal(prune[0].reason, "schema_mismatch");
  });

  test("prunes an unreadable backup rather than keeping it", () => {
    const { prune } = classify([
      entry({ path: CHECKPOINT }),
      entry({ path: "/data/knowledge.db.bak.corrupt", mtime: daysAgo(1), schema: null }),
    ]);
    assert.equal(prune.length, 1);
    assert.equal(prune[0].reason, "unreadable");
  });

  test("keeps the checkpoint even if it would otherwise fail every rule", () => {
    // The checkpoint is what makes pruning the rest safe; it can never be a casualty.
    const { keep, prune } = classify([
      entry({ path: CHECKPOINT, mtime: daysAgo(999), schema: null }),
    ]);
    assert.equal(prune.length, 0);
    assert.equal(keep[0].reason, "fresh_checkpoint");
  });

  test("a boundary-age backup is kept, not pruned", () => {
    const { prune } = classify([
      entry({ path: CHECKPOINT }),
      entry({ path: "/data/knowledge.db.bak.exact", mtime: daysAgo(30) }),
    ]);
    assert.equal(prune.length, 0, "exactly keepDays old is still within the window");
  });

  test("keep-days 0 prunes everything except the checkpoint", () => {
    const { keep, prune } = classify(
      [
        entry({ path: CHECKPOINT }),
        entry({ path: "/data/knowledge.db.bak.a", mtime: daysAgo(1) }),
        entry({ path: "/data/knowledge.db.bak.b", mtime: daysAgo(2) }),
      ],
      0
    );
    assert.equal(keep.length, 1);
    assert.equal(prune.length, 2);
  });

  test("every input appears in exactly one bucket", () => {
    // WHY: a file silently dropped from both lists would be neither reported nor
    //      deleted — the summary would understate what happened.
    const entries = [
      entry({ path: CHECKPOINT }),
      entry({ path: "/data/knowledge.db.bak.keep", mtime: daysAgo(2) }),
      entry({ path: "/data/knowledge.db.bak.old", mtime: daysAgo(99) }),
      entry({ path: "/data/knowledge.db.bak.bad", schema: null }),
    ];
    const { keep, prune } = classify(entries);
    assert.equal(keep.length + prune.length, entries.length);
    const seen = [...keep.map((k) => k.path), ...prune.map((p) => p.path)];
    assert.equal(new Set(seen).size, entries.length);
  });

  test("an empty backup directory is not an error", () => {
    const { keep, prune } = classify([]);
    assert.equal(keep.length, 0);
    assert.equal(prune.length, 0);
  });
});

// --- parseArgs ---

describe("parseArgs", () => {
  test("dry run is the DEFAULT", () => {
    // WHY: this deletes the only full restore points in the repo. The safe mode has to
    //      be the one you get by omission, including from a mistyped invocation.
    assert.equal(parseArgs([]).apply, false);
    assert.equal(parseArgs(["--keep-days", "10"]).apply, false);
  });

  test("--apply opts into deletion", () => {
    assert.equal(parseArgs(["--apply"]).apply, true);
  });

  test("defaults to a 30-day window", () => {
    assert.equal(parseArgs([]).keepDays, 30);
  });

  test("accepts an explicit window, including zero", () => {
    assert.equal(parseArgs(["--keep-days", "60"]).keepDays, 60);
    assert.equal(parseArgs(["--keep-days", "0"]).keepDays, 0);
  });

  test("rejects a malformed window instead of falling back to the default", () => {
    // WHY: silently reverting to 30 days could delete backups the caller meant to keep.
    assert.throws(() => parseArgs(["--keep-days"]), /non-negative number/);
    assert.throws(() => parseArgs(["--keep-days", "abc"]), /non-negative number/);
    assert.throws(() => parseArgs(["--keep-days", "-5"]), /non-negative number/);
  });
});
