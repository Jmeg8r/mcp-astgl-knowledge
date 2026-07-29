#!/usr/bin/env tsx
/**
 * Public database build.
 *
 * WHAT: Emits build/knowledge-public.db — a copy of data/knowledge.db with every
 *       `public = 0` row and its chunks/embeddings physically removed.
 * WHY:  data/knowledge.db holds unpublished drafts and private-project wiki
 *       pages. Filtering inside the MCP tool handlers would not help: the rows
 *       would still ship inside the npm tarball, one `better-sqlite3` open away
 *       from anyone who downloaded it. A gate is only real if the excluded rows
 *       are ABSENT from the shipped file.
 *       See docs/adr/0001-knowledge-db-keeps-its-own-index.md.
 *
 * Usage:
 *   npm run build-public-db              # write build/knowledge-public.db
 *   npm run build-public-db -- --dry-run # report what would be pruned, write nothing
 *
 * Never mutates data/knowledge.db — it operates on a copy, always.
 */

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { copyFileSync, existsSync, mkdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { deleteArticle } from "./knowledge-db.js";

const SOURCE_DB = join(import.meta.dirname, "..", "data", "knowledge.db");
const BUILD_DIR = join(import.meta.dirname, "..", "build");
const PUBLIC_DB = join(BUILD_DIR, "knowledge-public.db");

// WHAT: Refuse to ship a database with no rows in it.
// WHY:  A misclassification or an empty gate would otherwise publish a hollow
//       package that looks successful — the fully-failed-run rule (PR #15).
const MIN_PUBLIC_ARTICLES = 1;

const FLAGS = {
  dryRun: process.argv.includes("--dry-run"),
};

interface PruneRow {
  url: string;
  title: string;
  content_type: string;
  source_origin: string;
}

function main(): void {
  console.error("=== Build public database ===\n");
  if (FLAGS.dryRun) console.error("  [DRY RUN — nothing will be written]\n");

  if (!existsSync(SOURCE_DB)) {
    console.error(`Source database not found at ${SOURCE_DB}`);
    process.exit(1);
  }

  // --- Survey the source read-only, before touching anything ---
  const source = new Database(SOURCE_DB, { readonly: true });
  const hasPublicColumn = (
    source.prepare("PRAGMA table_info(articles)").all() as Array<{ name: string }>
  ).some((c) => c.name === "public");

  if (!hasPublicColumn) {
    // WHY: Without the column every row would look withheld and the build would
    //      emit an empty database. Fail loudly rather than ship nothing.
    console.error(
      "articles.public column missing — run a writer pipeline once to apply migrations first."
    );
    source.close();
    process.exit(1);
  }

  const totals = source
    .prepare(
      `SELECT
         SUM(CASE WHEN public = 1 THEN 1 ELSE 0 END) AS keep,
         SUM(CASE WHEN public = 0 THEN 1 ELSE 0 END) AS prune,
         COUNT(*) AS total
       FROM articles`
    )
    .get() as { keep: number; prune: number; total: number };

  const breakdown = source
    .prepare(
      `SELECT source_origin, content_type, public, COUNT(*) AS n
       FROM articles GROUP BY 1, 2, 3 ORDER BY public DESC, n DESC`
    )
    .all() as Array<{
    source_origin: string;
    content_type: string;
    public: number;
    n: number;
  }>;

  console.error("  Classification of the source database:");
  for (const r of breakdown) {
    console.error(
      `    ${r.public === 1 ? "SHIP    " : "WITHHOLD"} ${r.source_origin.padEnd(12)} ${r.content_type.padEnd(11)} ${r.n}`
    );
  }
  console.error(
    `\n  → ${totals.keep} of ${totals.total} articles ship; ${totals.prune} withheld\n`
  );

  const pruneRows = source
    .prepare(
      "SELECT url, title, content_type, source_origin FROM articles WHERE public = 0"
    )
    .all() as PruneRow[];
  source.close();

  if (totals.keep < MIN_PUBLIC_ARTICLES) {
    console.error(
      `Refusing to build: only ${totals.keep} public article(s), minimum is ${MIN_PUBLIC_ARTICLES}.`
    );
    console.log(
      JSON.stringify({
        built: false,
        error: "no_public_articles",
        articles_public: totals.keep,
        dry_run: FLAGS.dryRun,
      })
    );
    process.exit(1);
  }

  if (FLAGS.dryRun) {
    console.error(`  Would prune ${pruneRows.length} article(s), e.g.:`);
    for (const r of pruneRows.slice(0, 10)) {
      console.error(`    - [${r.content_type}] ${r.title.slice(0, 60)}`);
    }
    if (pruneRows.length > 10) {
      console.error(`    … and ${pruneRows.length - 10} more`);
    }
    console.log(
      JSON.stringify({
        built: false,
        dry_run: true,
        articles_total: totals.total,
        articles_public: totals.keep,
        articles_pruned: pruneRows.length,
      })
    );
    return;
  }

  // --- Copy, then prune the copy ---
  mkdirSync(BUILD_DIR, { recursive: true });
  // WHY: Remove a previous artifact rather than pruning it again — a stale
  //      artifact that merely gets re-pruned would silently retain rows that
  //      have since been withheld.
  if (existsSync(PUBLIC_DB)) rmSync(PUBLIC_DB);
  copyFileSync(SOURCE_DB, PUBLIC_DB);

  const publicDb = new Database(PUBLIC_DB);
  sqliteVec.load(publicDb);

  // WHY: deleteArticle() removes chunks AND their vec_chunks rows inside a
  //      transaction. sqlite-vec has no cascading delete, so raw SQL against
  //      chunks would leave orphaned embeddings that still match searches —
  //      i.e. withheld content remaining findable (Mistake #4).
  let chunksRemoved = 0;
  for (const row of pruneRows) {
    const result = deleteArticle(publicDb, row.url);
    chunksRemoved += result.chunksDeleted;
  }

  const remaining = publicDb
    .prepare("SELECT COUNT(*) AS n FROM articles")
    .get() as { n: number };
  const leaked = publicDb
    .prepare("SELECT COUNT(*) AS n FROM articles WHERE public = 0")
    .get() as { n: number };
  const orphanChunks = publicDb
    .prepare(
      "SELECT COUNT(*) AS n FROM chunks WHERE article_url NOT IN (SELECT url FROM articles)"
    )
    .get() as { n: number };
  // WHAT: Embeddings whose chunk is gone.
  // WHY:  This is the leak that actually matters. sqlite-vec has no cascading
  //       delete, so a withheld page's vectors can survive its rows and keep
  //       matching KNN searches — withheld content still findable, which is
  //       exactly what the gate exists to prevent (Mistake #4). Checking
  //       chunks-without-articles alone would not catch it.
  const orphanEmbeddings = publicDb
    .prepare(
      "SELECT COUNT(*) AS n FROM vec_chunks WHERE chunk_id NOT IN (SELECT id FROM chunks)"
    )
    .get() as { n: number };

  publicDb.prepare("VACUUM").run();
  publicDb.close();

  // WHY: Assert on the artifact itself, not on what we believe we did. A gate
  //      that is not verified against the shipped file is an intention.
  if (
    leaked.n > 0 ||
    orphanChunks.n > 0 ||
    orphanEmbeddings.n > 0 ||
    remaining.n !== totals.keep
  ) {
    console.error(
      `Verification FAILED — withheld rows: ${leaked.n}, orphan chunks: ${orphanChunks.n}, orphan embeddings: ${orphanEmbeddings.n}, articles: ${remaining.n} (expected ${totals.keep})`
    );
    rmSync(PUBLIC_DB);
    console.log(JSON.stringify({ built: false, error: "verification_failed" }));
    process.exit(1);
  }

  const size = statSync(PUBLIC_DB).size;
  console.error(
    `\n=== Built ${PUBLIC_DB} — ${remaining.n} articles, ${chunksRemoved} chunks removed, ${(size / 1024 / 1024).toFixed(1)} MB ===`
  );

  console.log(
    JSON.stringify({
      built: true,
      path: PUBLIC_DB,
      articles_total: totals.total,
      articles_public: remaining.n,
      articles_pruned: pruneRows.length,
      chunks_removed: chunksRemoved,
      bytes: size,
      dry_run: false,
    })
  );
}

try {
  main();
  process.exit(0);
} catch (err) {
  console.error("build-public-db failed:", err);
  process.exit(1);
}
