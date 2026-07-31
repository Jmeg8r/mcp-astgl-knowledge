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
import { join } from "path";

import {
  classifyBackups,
  parseArgs,
  schemasEqual,
} from "../src/prune-backups.js";
import type { BackupEntry, SchemaObject } from "../src/prune-backups.js";

// --- Fixtures ---

const NOW = new Date("2026-07-31T00:00:00.000Z");

function obj(over: Partial<SchemaObject> & { name: string }): SchemaObject {
  return { type: "table", tbl_name: over.name, sql: `CREATE TABLE ${over.name}(x)`, ...over };
}

// A trimmed stand-in for the real `articles` schema. `public` carries the publication
// gate's fail-closed property: INTEGER NOT NULL DEFAULT 0.
const LIVE_SCHEMA: SchemaObject[] = [
  obj({
    name: "articles",
    sql: "CREATE TABLE articles(id INTEGER PRIMARY KEY, title TEXT NOT NULL, public INTEGER NOT NULL DEFAULT 0)",
  }),
  obj({ name: "chunks", sql: "CREATE TABLE chunks(id INTEGER PRIMARY KEY, article_url TEXT)" }),
  obj({
    name: "ecosystem_snapshots",
    sql: "CREATE TABLE ecosystem_snapshots(id INTEGER PRIMARY KEY, check_type TEXT, metrics TEXT)",
  }),
  obj({ name: "vec_chunks", sql: "CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[768])" }),
  obj({ type: "index", name: "idx_articles_public", tbl_name: "articles", sql: "CREATE INDEX idx_articles_public ON articles(public)" }),
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

// --- schemasEqual ---

describe("schemasEqual", () => {
  test("matches an identical schema", () => {
    assert.equal(schemasEqual(LIVE_SCHEMA, [...LIVE_SCHEMA]), true);
  });

  test("catches a missing column", () => {
    assert.equal(schemasEqual(LIVE_SCHEMA.slice(0, 4), LIVE_SCHEMA), false);
  });

  test("catches a lost NOT NULL DEFAULT on articles.public", () => {
    // WHY: the case the bash recipe shipped with. Restoring a backup whose `public`
    //      column is merely INTEGER would silently remove the publication gate's
    //      fail-closed default (ADR-0001).
    const weakened = LIVE_SCHEMA.map((o) =>
      o.name === "articles"
        ? { ...o, sql: "CREATE TABLE articles(id INTEGER PRIMARY KEY, title TEXT NOT NULL, public INTEGER)" }
        : o
    );
    assert.deepEqual(
      weakened.map((o) => o.name),
      LIVE_SCHEMA.map((o) => o.name),
      "precondition: object names are identical"
    );
    assert.equal(schemasEqual(weakened, LIVE_SCHEMA), false);
  });

  test("catches a change OUTSIDE the articles table", () => {
    // WHY: the comparator used to read pragma_table_info('articles') only, so a backup
    //      missing the `metrics` column on ecosystem_snapshots — or an altered chunks,
    //      vec_chunks, ideas, or rewrite_jobs — classified as compatible.
    const stale = LIVE_SCHEMA.map((o) =>
      o.name === "ecosystem_snapshots"
        ? { ...o, sql: "CREATE TABLE ecosystem_snapshots(id INTEGER PRIMARY KEY, check_type TEXT)" }
        : o
    );
    assert.equal(schemasEqual(stale, LIVE_SCHEMA), false);
  });

  test("catches a dropped index and a changed virtual table", () => {
    assert.equal(
      schemasEqual(LIVE_SCHEMA.filter((o) => o.type !== "index"), LIVE_SCHEMA),
      false,
      "a missing index is a schema difference"
    );
    const vecChanged = LIVE_SCHEMA.map((o) =>
      o.name === "vec_chunks"
        ? { ...o, sql: "CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[384])" }
        : o
    );
    assert.equal(schemasEqual(vecChanged, LIVE_SCHEMA), false, "embedding dim change");
  });

  test("cannot be fooled by a delimiter collision", () => {
    // WHY: the bash version joined metadata with ':' and '|', so `("a:b" TEXT)` and
    //      `(a "b:TEXT")` produced the same signature. Structured comparison has no
    //      delimiter, so the collision is not merely caught — it is unrepresentable.
    const a: SchemaObject[] = [obj({ name: "a:b", sql: "CREATE TABLE \"a:b\"(x TEXT)" })];
    const b: SchemaObject[] = [obj({ name: "a", sql: "CREATE TABLE a(\"b:TEXT\" x)" })];
    assert.equal(schemasEqual(a, b), false);
  });

  test("catches reordered objects", () => {
    const swapped = [LIVE_SCHEMA[1], LIVE_SCHEMA[0]];
    assert.equal(schemasEqual(swapped, [LIVE_SCHEMA[0], LIVE_SCHEMA[1]]), false);
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

  test("propagates each entry's bytes onto the prune result", () => {
    // WHY: main() sums p.bytes into bytes_prunable and bytes_freed. Without this, a
    //      regression would report a wrong reclaimed size without failing any test.
    const { prune } = classify([
      entry({ path: CHECKPOINT }),
      entry({ path: "/data/knowledge.db.bak.sized", mtime: daysAgo(99), bytes: 12_345 }),
    ]);
    assert.equal(prune.length, 1);
    assert.equal(prune[0].bytes, 12_345);
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
