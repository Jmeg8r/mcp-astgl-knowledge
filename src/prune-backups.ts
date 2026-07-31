#!/usr/bin/env tsx
/**
 * Backup retention pruner.
 *
 * WHAT: Takes a verified checkpoint of data/knowledge.db, then deletes the stale
 *       `data/knowledge.db.bak.*` files — keeping the new checkpoint plus any backup
 *       that is BOTH young enough AND schema-compatible with the live database.
 * WHY:  Every destructive script snapshots the database (~80 MB) and nothing has ever
 *       deleted one. `data/` reached 485 MB before anyone looked (PR #40).
 *
 * This replaces a hand-run bash recipe that took eleven review findings across four
 * rounds. Three of those findings are not fixed here — they are *unrepresentable*:
 *
 *   - **Writer exclusion.** The recipe used `lsof`, which only observes: a scheduled job
 *     could open the database a second after the check passed, and a commit landing in
 *     the WAL leaves the main file byte-identical, so a hash check would pass over a
 *     backup missing that commit. Here the copy happens inside `BEGIN EXCLUSIVE`, so
 *     SQLite itself blocks other writers (verified: a second process gets SQLITE_BUSY).
 *   - **Schema-signature collisions.** The recipe joined column metadata with a
 *     delimiter, so `("a:b" TEXT)` and `(a "b:TEXT")` produced identical signatures.
 *     Here schemas are compared as structured values; there is no delimiter to collide.
 *   - **Empty-equals-empty.** A failed shell query returned "", and "" = "" compares
 *     equal, so every backup read as compatible. Here a failed read throws or yields
 *     null, which is never equal to a schema.
 *
 * Usage:
 *   npm run prune-backups                     # DRY RUN (default) — reports, deletes nothing
 *   npm run prune-backups -- --apply          # actually delete
 *   npm run prune-backups -- --keep-days 60   # widen the age window
 *
 * Deleting backups is a stop-and-ask operation (CLAUDE.md). Dry-run is the default
 * precisely so that a mistyped invocation reports instead of destroying the only
 * restore points in the repo.
 */

import Database from "better-sqlite3";
import { createHash } from "crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

// --- Paths ---
const DATA_DIR = join(import.meta.dirname, "..", "data");
const LIVE_DB = join(DATA_DIR, "knowledge.db");
const BACKUP_PREFIX = "knowledge.db.bak.";
const CHECKPOINT_INFIX = "checkpoint-";

// --- Retention policy ---
// WHAT: A backup is an eligible restore point only if it is young enough AND its schema
//       still matches the live database.
// WHY:  Age alone is not enough — a backup taken 10 days ago but before a migration 5
//       days ago restores a schema the code no longer expects. The 8 files pruned in
//       July all predated the `public` column, so any restore would have silently
//       dropped the publication gate's fail-closed default (ADR-0001).
const DEFAULT_KEEP_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// WHAT: Refuse to run if the live database looks wrong.
// WHY:  A fully-failed run must record nothing and exit 1 rather than deleting restore
//       points on the strength of a bad reading (the PR #15 rule).
const MIN_LIVE_ARTICLES = 1;

// WHAT: Byte-to-MiB display conversion.
// WHY:  Named so the same divisor and precision are used everywhere a size is
//       printed; an inline 1024 in one place and 1000 in another is how two figures
//       in the same report come to disagree.
const BYTES_PER_MIB = 1024 * 1024;

// WHAT: Read size for content hashing.
// WHY:  Constant peak memory regardless of database size; 1 MiB is large enough that
//       syscall overhead is negligible on an 80 MB file.
const HASH_BLOCK_BYTES = 1024 * 1024;

// WHAT: SQLite sidecars that belong to a database file rather than standing alone.
// WHY:  A `-wal`/`-shm` beside a backup is part of THAT backup, not a backup of its
//       own. Listing them separately would classify a fragment as a restore point and
//       could delete a base file while leaving its WAL, or vice versa.
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;
const MIB_DECIMAL_PLACES = 1;

// --- Types ---

// WHAT: One row of sqlite_master — a table, index, trigger, view, or virtual table.
// WHY:  Schema compatibility used to be judged from `pragma_table_info('articles')`
//       alone, which cannot see a change to `chunks`, `vec_chunks`, `article_qa`,
//       `ecosystem_snapshots`, `ideas`, or `rewrite_jobs`. A backup missing the
//       `metrics` column added to ecosystem_snapshots this cycle would have classified
//       as compatible. The whole schema is compared, not one table of it.
export interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

export interface BackupEntry {
  path: string;
  name: string;
  bytes: number;
  mtime: Date;
  schema: SchemaObject[] | null; // null = unreadable
}

export type KeepReason = "fresh_checkpoint" | "within_age_and_schema_ok";
export type PruneReason = "schema_mismatch" | "older_than_keep_days" | "unreadable";

export interface Classification {
  keep: Array<{ path: string; reason: KeepReason }>;
  prune: Array<{ path: string; reason: PruneReason; bytes: number }>;
}

export interface Flags {
  apply: boolean;
  keepDays: number;
}

// --- Pure helpers (exported for tests) ---

// WHAT: Structural schema equality.
// WHY:  Compared field by field rather than as a joined string. The bash version used
//       `cid:name:type:...` joined by `|`, which collides whenever a column name or
//       type contains the delimiter. Here a collision cannot be expressed.
export function schemasEqual(
  a: SchemaObject[] | null,
  b: SchemaObject[] | null
): boolean {
  // WHY: null means "could not read". Unknown is never equal to anything, including
  //      another unknown — otherwise two unreadable files would compare as matching.
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((obj, i) => {
    const other = b[i];
    return (
      obj.type === other.type &&
      obj.name === other.name &&
      obj.tbl_name === other.tbl_name &&
      obj.sql === other.sql
    );
  });
}

// WHAT: Decide which backups survive.
// WHY:  Pure and side-effect free, so every branch is testable without a filesystem —
//       the deletion set is the one thing in this script that must never be wrong.
export function classifyBackups(input: {
  entries: BackupEntry[];
  liveSchema: SchemaObject[];
  checkpointPath: string;
  now: Date;
  keepDays: number;
}): Classification {
  const { entries, liveSchema, checkpointPath, now, keepDays } = input;
  const keep: Classification["keep"] = [];
  const prune: Classification["prune"] = [];

  for (const entry of entries) {
    // The checkpoint just taken is always kept — it is the restore point that makes
    // pruning the others safe in the first place.
    if (entry.path === checkpointPath) {
      keep.push({ path: entry.path, reason: "fresh_checkpoint" });
      continue;
    }

    if (entry.schema === null) {
      prune.push({ path: entry.path, reason: "unreadable", bytes: entry.bytes });
      continue;
    }

    const ageDays = (now.getTime() - entry.mtime.getTime()) / MS_PER_DAY;

    // WHY: schema is checked BEFORE age. A young but schema-stale backup is not a
    //      restore point, and reporting "older_than_keep_days" for it would name the
    //      wrong reason in the summary.
    if (!schemasEqual(entry.schema, liveSchema)) {
      prune.push({ path: entry.path, reason: "schema_mismatch", bytes: entry.bytes });
      continue;
    }

    if (ageDays > keepDays) {
      prune.push({
        path: entry.path,
        reason: "older_than_keep_days",
        bytes: entry.bytes,
      });
      continue;
    }

    keep.push({ path: entry.path, reason: "within_age_and_schema_ok" });
  }

  return { keep, prune };
}

// WHAT: Hand-rolled argv scan, matching every other script here.
// WHY:  --apply rather than --dry-run: dry run is the DEFAULT. This deletes the only
//       full restore points in the repo, so the safe mode is the one you get by
//       omission. A deliberate deviation from the repo's usual `--dry-run` opt-in.
export function parseArgs(argv: string[]): Flags {
  const keepIdx = argv.indexOf("--keep-days");
  let keepDays = DEFAULT_KEEP_DAYS;

  if (keepIdx >= 0) {
    const raw = argv[keepIdx + 1];
    const parsed = Number(raw);
    // WHY: reject rather than silently fall back to the default — a typo'd window that
    //      quietly reverts to 30 days could delete backups the caller meant to keep.
    if (!raw || !Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`--keep-days requires a non-negative number, got: ${raw ?? "(nothing)"}`);
    }
    keepDays = parsed;
  }

  return { apply: argv.includes("--apply"), keepDays };
}

// --- Database reads ---

// WHAT: Read a database's complete authored schema — every table, index, trigger,
//       view and virtual table it declares — or null if the file cannot be opened or
//       carries no schema at all.
// WHY:  This is the value schema-compatibility is judged on, so it must describe the
//       WHOLE database rather than one table of it.
function readSchema(dbPath: string): SchemaObject[] | null {
  let db: InstanceType<typeof Database> | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    // WHY: `sqlite_`-prefixed names are SQLite's own auto-created objects (autoindexes,
    //      the sequence table). They are derived, not authored, so including them would
    //      report spurious mismatches. Everything the migrations create is compared.
    // WHY ESCAPE: `_` is a LIKE wildcard, so an unescaped 'sqlite_%' also matches
    //      user-defined names such as `sqliteBackup` — silently excluding a real table
    //      from the comparison. Verified: 'sqliteBackup' LIKE 'sqlite_%' is TRUE,
    //      and FALSE once the underscore is escaped.
    const rows = db
      .prepare(
        String.raw`SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite\_%' ESCAPE '\'
         ORDER BY type, name`
      )
      .all() as SchemaObject[];
    // WHY: an empty result means no schema at all — not a knowledge database.
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

// WHAT: Content hash, read in fixed-size blocks.
// WHY:  readFileSync allocated the ENTIRE file — ~80 MB here — and sha256 is called
//       three times per apply run, so peak memory tracked database size. Block reads
//       keep it constant. Kept synchronous so takeVerifiedCheckpoint can stay sync and
//       hold BEGIN EXCLUSIVE across the copy without an await in the critical section.
function sha256(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(HASH_BLOCK_BYTES);
  try {
    let bytesRead: number;
    while ((bytesRead = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

function listBackups(): BackupEntry[] {
  const names = readdirSync(DATA_DIR).filter((n) => n.startsWith(BACKUP_PREFIX));

  return names
    // WHY: a `-wal`/`-shm` belongs to the backup it sits beside. Treating one as a
    //      standalone backup would classify a fragment as a restore point, and could
    //      delete a base file while orphaning its WAL.
    .filter((n) => !SQLITE_SIDECAR_SUFFIXES.some((suffix) => n.endsWith(suffix)))
    .map((name) => {
      const path = join(DATA_DIR, name);
      const stat = statSync(path);
      // WHAT: size includes any sidecars, since they are removed with the base file.
      // WHY:  bytes_freed would otherwise understate what a prune actually reclaimed.
      const sidecarBytes = SQLITE_SIDECAR_SUFFIXES.reduce((sum, suffix) => {
        const sidecar = `${path}${suffix}`;
        return existsSync(sidecar) ? sum + statSync(sidecar).size : sum;
      }, 0);
      return {
        path,
        name,
        bytes: stat.size + sidecarBytes,
        mtime: stat.mtime,
        schema: readSchema(path),
      };
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
}

// --- Checkpoint ---

interface CheckpointResult {
  path: string;
  articles: number;
  bytes: number;
}

// WHAT: Copy the live database while holding SQLite's own exclusive write lock.
// WHY:  This is the whole reason the procedure is a script. `BEGIN EXCLUSIVE` makes
//       concurrent writers fail with SQLITE_BUSY for the duration, so no commit can
//       land between the checkpoint and the copy. The bash recipe could only observe
//       with `lsof` and hope. Verified: a second process attempting a write during the
//       lock receives SQLITE_BUSY.
function takeVerifiedCheckpoint(stamp: string): CheckpointResult {
  const path = join(DATA_DIR, `${BACKUP_PREFIX}${CHECKPOINT_INFIX}${stamp}`);
  if (existsSync(path)) {
    throw new Error(`checkpoint already exists: ${path}`);
  }

  const db = new Database(LIVE_DB);
  let liveArticles = 0;
  let liveHash = "";

  try {
    // Fold any WAL content into the main file BEFORE locking, so the copy is complete.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.exec("BEGIN EXCLUSIVE");

    liveArticles = (
      db.prepare("SELECT COUNT(*) AS n FROM articles").get() as { n: number }
    ).n;
    if (liveArticles < MIN_LIVE_ARTICLES) {
      throw new Error(
        `live database has ${liveArticles} articles (minimum ${MIN_LIVE_ARTICLES}) — refusing to prune on a suspect reading`
      );
    }

    copyFileSync(LIVE_DB, path);
    liveHash = sha256(LIVE_DB);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Not in a transaction — nothing to roll back.
    }
    if (existsSync(path)) rmSync(path);
    db.close();
    throw err;
  }
  db.close();

  // --- Verify the artifact itself, not our belief about it ---
  // WHY: every check below removes the copy and throws. A verification that merely
  //      reports leaves a bad checkpoint on disk looking like a good one.
  const failVerification = (reason: string): never => {
    rmSync(path, { force: true });
    throw new Error(`checkpoint verification failed: ${reason}`);
  };

  const verify = new Database(path, { readonly: true });
  let integrity: string;
  let articles: number;
  try {
    integrity = (
      verify.pragma("integrity_check") as Array<{ integrity_check: string }>
    )[0].integrity_check;
    articles = (
      verify.prepare("SELECT COUNT(*) AS n FROM articles").get() as { n: number }
    ).n;
  } finally {
    verify.close();
  }

  if (integrity !== "ok") failVerification(`integrity_check returned "${integrity}"`);
  if (articles !== liveArticles) {
    failVerification(`article count ${articles} != live ${liveArticles}`);
  }
  if (sha256(path) !== liveHash) {
    failVerification("checkpoint is not byte-identical to the live database");
  }
  // WHY: a WAL appearing after the copy means a writer committed despite the lock.
  //      Content-checked rather than existence-checked: wal_checkpoint(TRUNCATE) can
  //      leave a legitimate zero-length sidecar behind.
  const wal = `${LIVE_DB}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) {
    failVerification("a non-empty WAL exists after the copy — a writer was active");
  }

  return { path, articles, bytes: statSync(path).size };
}

// WHAT: Dry-run counterpart to takeVerifiedCheckpoint — proves the run COULD proceed.
// WHY:  A dry run that skipped the database entirely would report a plan it has no
//       evidence it can carry out. This takes and releases the same exclusive lock, so
//       "another writer holds the database" fails in dry run rather than surfacing for
//       the first time during the destructive run.
function probeExclusiveAccess(): { articles: number } {
  const db = new Database(LIVE_DB);
  try {
    db.exec("BEGIN EXCLUSIVE");
    const articles = (
      db.prepare("SELECT COUNT(*) AS n FROM articles").get() as { n: number }
    ).n;
    if (articles < MIN_LIVE_ARTICLES) {
      throw new Error(
        `live database has ${articles} articles (minimum ${MIN_LIVE_ARTICLES}) — refusing to prune on a suspect reading`
      );
    }
    db.exec("COMMIT");
    return { articles };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Not in a transaction.
    }
    throw err;
  } finally {
    db.close();
  }
}

// WHAT: Counters every summary carries, whatever the outcome.
// WHY:  A scheduler parsing stdout must find the same fields whether the run
//       succeeded, refused, or partly failed. Emitting one shape on success and a
//       different one on a fatal path means the consumer has to branch on shape
//       before it can read a count — so the counters are part of the type.
interface SummaryCounters {
  processed: number;
  skipped: number;
  failed: number;
}

const ZERO_COUNTERS: SummaryCounters = { processed: 0, skipped: 0, failed: 0 };

// WHAT: The one and only stdout write.
// WHY:  The pipeline contract is exactly ONE final JSON line on stdout. Routing every
//       exit path — success, refusal, partial failure — through a single function is
//       what makes that checkable rather than aspirational. The signature requires the
//       counters, so a new exit path cannot omit them by forgetting.
let summaryEmitted = false;

function emitSummary(
  summary: SummaryCounters & Record<string, unknown>
): void {
  // WHY: exactly one line, so a late failure after a successful summary cannot
  //      append a second and break every consumer that reads one JSON document.
  if (summaryEmitted) return;
  summaryEmitted = true;
  console.log(JSON.stringify(summary));
}

// --- Main ---

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  console.error("=== Backup retention pruner ===\n");
  if (!flags.apply) console.error("  [DRY RUN — nothing will be deleted]\n");

  if (!existsSync(LIVE_DB)) {
    console.error(`Live database not found at ${LIVE_DB}`);
    // WHY: emit before failing. A fatal path that exits without the summary leaves
    //      MAESTER and any scheduler parsing stdout with nothing at all — the same
    //      defect as the deletion loop's escaping throw, on a different branch.
    emitSummary({
      ok: false,
      error: "live_db_missing",
      dry_run: !flags.apply,
      ...ZERO_COUNTERS,
    });
    process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d{3}Z$/, "Z");

  // WHAT: Only a real run writes the checkpoint.
  // WHY:  The checkpoint is an ~80 MB copy. Writing one on every dry run means merely
  //       *looking* at what would be pruned costs 80 MB of disk each time — surprising
  //       for a read-only-sounding mode, and it accumulates. A dry run still proves the
  //       lock can be taken and the database read, which is the part that could fail.
  let checkpoint: CheckpointResult | null = null;

  if (flags.apply) {
    console.error("Taking verified checkpoint...");
    checkpoint = takeVerifiedCheckpoint(stamp);
    console.error(
      `  ${checkpoint.path} — ${checkpoint.articles} articles, ${(checkpoint.bytes / BYTES_PER_MIB).toFixed(MIB_DECIMAL_PLACES)} MB, verified\n`
    );
  } else {
    const probe = probeExclusiveAccess();
    console.error(
      `  would checkpoint ${probe.articles} articles (exclusive lock available, database readable)\n`
    );
  }

  const liveSchema = readSchema(LIVE_DB);
  if (!liveSchema) {
    // WHY: `force: true` only suppresses ENOENT — EACCES or EROFS still throw, and a
    //      throw here would skip the summary below. The checkpoint path is reported
    //      when cleanup fails, because claiming `checkpoint: null` while an 80 MB file
    //      is still on disk tells the reader the opposite of what happened.
    let orphanedCheckpoint: string | null = null;
    if (checkpoint) {
      try {
        rmSync(checkpoint.path, { force: true });
      } catch (err) {
        orphanedCheckpoint = checkpoint.path;
        console.error(
          `  WARNING: could not remove checkpoint ${checkpoint.path}: ${err instanceof Error ? err.message : err}`
        );
      }
    }
    console.error("Could not read the live schema — refusing to classify backups.");
    emitSummary({
      ok: false,
      error: "live_schema_unreadable",
      dry_run: !flags.apply,
      checkpoint: orphanedCheckpoint,
      checkpoint_cleanup_failed: orphanedCheckpoint !== null,
      ...ZERO_COUNTERS,
    });
    process.exitCode = 1;
    return;
  }

  const entries = listBackups();
  const { keep, prune } = classifyBackups({
    entries,
    liveSchema,
    // WHY: on a dry run no checkpoint exists yet, so nothing is exempt. The preview is
    //      still honest — a real run creates and keeps its checkpoint first, so the
    //      prune set below is what would be deleted with a fresh restore point in hand.
    checkpointPath: checkpoint?.path ?? "",
    now: new Date(),
    keepDays: flags.keepDays,
  });

  console.error(`Classification (keep-days: ${flags.keepDays}):`);
  for (const k of keep) console.error(`  KEEP   ${k.reason.padEnd(26)} ${k.path}`);
  for (const p of prune) console.error(`  PRUNE  ${p.reason.padEnd(26)} ${p.path}`);

  const bytesToFree = prune.reduce((sum, p) => sum + p.bytes, 0);
  console.error(
    `\n  ${keep.length} kept, ${prune.length} to prune (${(bytesToFree / BYTES_PER_MIB).toFixed(MIB_DECIMAL_PLACES)} MB)\n`
  );

  let deleted = 0;
  let failed = 0;
  let skipped = 0;
  let sidecarFailures = 0;
  let bytesFreed = 0;

  if (flags.apply) {
    // WHY: each deletion is isolated. rmSync can throw (EACCES, EBUSY, a file removed
    //      by someone else mid-run), and an escaping throw would skip the JSON summary
    //      below entirely — so a run that deleted four of seven files would report
    //      NOTHING while having destroyed four restore points. A partially-completed
    //      destructive run is exactly when the summary matters most.
    // WHY: delete by explicit path from the classified list, never by glob. `rm
    //      data/*.bak.*` would take the checkpoint just created along with the rest.
    for (const p of prune) {
      try {
        // WHY no `force: true`: it swallows ENOENT, so a file another process already
        //      removed would count as deleted and its bytes added to bytes_freed —
        //      overstating what this run actually reclaimed. ENOENT is a distinct,
        //      benign outcome and is reported as such.
        rmSync(p.path);
        // WHY: recorded IMMEDIATELY, before touching sidecars. The base file is gone
        //      the instant that call returns, so a later throw must not be able to
        //      unwind the record of it — this block previously incremented after the
        //      sidecar loop, so a sidecar failure reported the entry as failed/skipped
        //      and left pruned and bytes_freed UNDERSTATING what the run destroyed.
        deleted++;
        bytesFreed += p.bytes;
        console.error(`  deleted ${p.path}`);

        // WHY: sidecars are part of this backup; leaving them orphans WAL fragments in
        //      data/ that no later run would recognise as belonging to anything. Their
        //      failures are counted separately — the backup IS pruned either way, so
        //      folding them into `failed` would misreport the outcome in the other
        //      direction. Only attempted once the base is confirmed gone, so a failed
        //      base deletion never strands its own sidecars.
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
          const sidecar = `${p.path}${suffix}`;
          if (!existsSync(sidecar)) continue;
          try {
            rmSync(sidecar);
          } catch (sidecarErr) {
            sidecarFailures++;
            console.error(
              `  WARNING: orphaned sidecar ${sidecar}: ${sidecarErr instanceof Error ? sidecarErr.message : sidecarErr}`
            );
          }
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT") {
          skipped++;
          console.error(`  already gone ${p.path}`);
        } else {
          failed++;
          console.error(
            `  FAILED to delete ${p.path}: ${err instanceof Error ? err.message : err}`
          );
        }
      }
    }
  }

  emitSummary({
      // WHY: a run that failed to delete something is not ok, however many others
      //      succeeded. Reporting ok:true alongside failed:2 asks the consumer to
      //      ignore the field that exists to be trusted.
      ok: failed === 0,
      dry_run: !flags.apply,
      keep_days: flags.keepDays,
      checkpoint: checkpoint?.path ?? null,
      checkpoint_articles: checkpoint?.articles ?? null,
      backups_total: entries.length,
      kept: keep.length,
      // WHAT: the three contract counters, present on every summary shape.
      processed: entries.length,
      skipped,
      failed,
      pruned: deleted,
      // WHAT: sidecars that could not be removed after their base backup was pruned.
      // WHY:  informational, deliberately NOT folded into `failed` — the backup was
      //       pruned; only a fragment remains.
      sidecar_failures: sidecarFailures,
      prunable: prune.length,
      // WHY: only bytes actually reclaimed. Reporting the full planned total would
      //      overstate the result whenever a deletion failed.
      bytes_freed: bytesFreed,
      bytes_prunable: bytesToFree,
      prune_reasons: prune.reduce<Record<string, number>>((acc, p) => {
        acc[p.reason] = (acc[p.reason] ?? 0) + 1;
        return acc;
      }, {}),
  });

  console.error(
    flags.apply
      ? `\n=== Done: ${deleted} deleted${skipped > 0 ? `, ${skipped} already gone` : ""}${failed > 0 ? `, ${failed} FAILED` : ""}, ${(bytesFreed / BYTES_PER_MIB).toFixed(MIB_DECIMAL_PLACES)} MB freed ===`
      : `\n=== Dry run: ${prune.length} would be deleted. Re-run with --apply ===`
  );

  // WHY: a run with failures exits 1 so a caller notices — but only AFTER the summary
  //      has been written, so what did happen is still on the record.
  if (failed > 0) process.exitCode = 1;
}

// WHAT: Run main() only when this file is the process entry point.
// WHY:  Every other script here self-executes at module scope, but this one is imported
//       by its own test suite — and an unguarded main() runs the whole procedure on
//       import, takes a real checkpoint, and calls process.exit(0) BEFORE any test
//       executes. That is not hypothetical: it happened, and node:test reported
//       "tests 1, pass 1" — a green suite in which not one assertion had run.
//       A deliberate deviation from the repo's self-executing convention; the
//       convention assumes nothing imports these modules, which is no longer true.
const isEntryPoint =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  // WHY no process.exit(): it terminates before an async stdout pipe has drained, so
  //      the JSON summary can be TRUNCATED for exactly the consumer that parses it —
  //      MAESTER reads this over a pipe. Setting exitCode lets node exit naturally
  //      once stdout is flushed. main() also sets exitCode on its own fatal paths.
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error("prune-backups failed:", message);
    // WHY: found by sweeping the class rather than patching the reported instance.
    //      Anything main() throws — a busy exclusive lock, a checkpoint that failed
    //      verification — reached here and exited with NO json at all.
    emitSummary({
      ok: false,
      error: "unexpected_error",
      message,
      // WHY: every other summary carries dry_run; a consumer must be able to tell a
      //      failed dry run from a failed apply run. Read from argv because flags may
      //      not have been parsed when the throw happened.
      dry_run: !process.argv.includes("--apply"),
      ...ZERO_COUNTERS,
    });
    process.exitCode = 1;
  });
}
