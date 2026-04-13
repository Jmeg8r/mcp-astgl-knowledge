/**
 * Knowledge database module for incremental updates.
 * Provides UPSERT operations against knowledge.db without
 * destroying existing data (unlike ingest.ts's DROP/CREATE).
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Chunk, QaPair, StructuredArticle } from "./types.js";
import { EMBEDDING_DIM } from "./types.js";

const DB_PATH = join(import.meta.dirname, "..", "data", "knowledge.db");

let db: InstanceType<typeof Database> | null = null;

// WHAT: Open knowledge.db and run idempotent schema migrations
// WHY: Adds columns needed by the structuring pipeline without breaking existing data
export function initKnowledgeDb(): InstanceType<typeof Database> {
  const dataDir = join(import.meta.dirname, "..", "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  if (!existsSync(DB_PATH)) {
    throw new Error(
      `Knowledge database not found at ${DB_PATH}. Run 'npm run ingest' first to create the base schema.`
    );
  }

  db = new Database(DB_PATH);
  sqliteVec.load(db);

  runMigrations(db);
  return db;
}

// WHAT: Add new columns and tables needed by the structuring pipeline
// WHY: ALTER TABLE with try/catch is idempotent — safe to re-run after ingest.ts rebuilds
function runMigrations(database: InstanceType<typeof Database>): void {
  const alterColumns = [
    "ALTER TABLE articles ADD COLUMN source_url TEXT",
    "ALTER TABLE articles ADD COLUMN content_type TEXT DEFAULT 'article'",
    "ALTER TABLE articles ADD COLUMN json_ld TEXT",
    "ALTER TABLE articles ADD COLUMN processed_at TEXT",
    "ALTER TABLE articles ADD COLUMN pub_date TEXT",
    "ALTER TABLE articles ADD COLUMN last_reviewed_at TEXT",
    "ALTER TABLE articles ADD COLUMN freshness_status TEXT DEFAULT 'current'",
  ];

  for (const sql of alterColumns) {
    try {
      database.exec(sql);
    } catch {
      // Column already exists — expected after first run
    }
  }

  database.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_articles_url ON articles(url)"
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS article_qa (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_url TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      UNIQUE(article_url, question)
    )
  `);

  // WHAT: Track ecosystem versions for freshness detection
  // WHY: Comparing current vs previous version detects when articles may be outdated
  database.exec(`
    CREATE TABLE IF NOT EXISTS ecosystem_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      check_type TEXT NOT NULL,
      package_name TEXT NOT NULL,
      current_version TEXT NOT NULL,
      previous_version TEXT,
      checked_at TEXT NOT NULL,
      UNIQUE(check_type, package_name)
    )
  `);
}

// WHAT: Insert or replace an article in knowledge.db
// WHY: Keyed on url so discovered content can coexist with local articles
export function upsertArticle(
  database: InstanceType<typeof Database>,
  article: StructuredArticle
): void {
  const existing = database
    .prepare("SELECT id FROM articles WHERE url = ?")
    .get(article.url) as { id: number } | undefined;

  if (existing) {
    database
      .prepare(
        `UPDATE articles SET title = ?, description = ?, slug = ?,
         source_url = ?, content_type = ?, json_ld = ?, processed_at = ?,
         pub_date = COALESCE(?, pub_date)
         WHERE id = ?`
      )
      .run(
        article.title,
        article.description,
        article.slug,
        article.sourceUrl,
        article.contentType,
        article.jsonLd,
        article.processedAt,
        article.pubDate || null,
        existing.id
      );
  } else {
    database
      .prepare(
        `INSERT INTO articles (title, description, url, slug, source_url, content_type, json_ld, processed_at, pub_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        article.title,
        article.description,
        article.url,
        article.slug,
        article.sourceUrl,
        article.contentType,
        article.jsonLd,
        article.processedAt,
        article.pubDate || null
      );
  }
}

// WHAT: Update freshness status for an article
// WHY: Freshness checker sets status without re-processing the full article
export function updateFreshnessStatus(
  database: InstanceType<typeof Database>,
  articleUrl: string,
  status: string,
  reviewedAt?: string
): void {
  if (reviewedAt) {
    database
      .prepare(
        "UPDATE articles SET freshness_status = ?, last_reviewed_at = ? WHERE url = ?"
      )
      .run(status, reviewedAt, articleUrl);
  } else {
    database
      .prepare("UPDATE articles SET freshness_status = ? WHERE url = ?")
      .run(status, articleUrl);
  }
}

// WHAT: Delete existing chunks + vectors for an article, insert new ones
// WHY: sqlite-vec doesn't support INSERT OR REPLACE — delete-then-insert in a transaction
export function replaceChunksForArticle(
  database: InstanceType<typeof Database>,
  articleUrl: string,
  chunks: Chunk[],
  embeddings: number[][]
): void {
  const replaceAll = database.transaction(() => {
    // Find existing chunk IDs for this article
    const existingChunks = database
      .prepare("SELECT id FROM chunks WHERE article_url = ?")
      .all(articleUrl) as Array<{ id: number }>;

    // Delete vectors for those chunks
    const deleteVec = database.prepare(
      "DELETE FROM vec_chunks WHERE chunk_id = ?"
    );
    for (const chunk of existingChunks) {
      deleteVec.run(chunk.id);
    }

    // Delete the chunks themselves
    database
      .prepare("DELETE FROM chunks WHERE article_url = ?")
      .run(articleUrl);

    // Insert new chunks and vectors
    const insertChunk = database.prepare(
      `INSERT INTO chunks (article_title, article_url, article_order, section_heading, chunk_type, content)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertVec = database.prepare(
      "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)"
    );

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const result = insertChunk.run(
        chunk.articleTitle,
        chunk.articleUrl,
        chunk.articleOrder,
        chunk.sectionHeading,
        chunk.chunkType,
        chunk.content
      );
      const chunkId = result.lastInsertRowid;
      insertVec.run(
        BigInt(chunkId as number),
        new Float32Array(embeddings[i])
      );
    }
  });

  replaceAll();
}

// WHAT: Insert extracted Q&A pairs for an article
// WHY: Normalizes Q&A data for potential future querying
export function upsertQaPairs(
  database: InstanceType<typeof Database>,
  articleUrl: string,
  pairs: QaPair[]
): void {
  // Clear existing pairs for this article
  database
    .prepare("DELETE FROM article_qa WHERE article_url = ?")
    .run(articleUrl);

  const insert = database.prepare(
    "INSERT OR IGNORE INTO article_qa (article_url, question, answer) VALUES (?, ?, ?)"
  );

  const insertAll = database.transaction(() => {
    for (const pair of pairs) {
      insert.run(articleUrl, pair.question, pair.answer);
    }
  });

  insertAll();
}

export function closeKnowledgeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
