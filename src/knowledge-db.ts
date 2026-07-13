/**
 * Knowledge database module for incremental updates.
 * Provides UPSERT operations against knowledge.db without
 * destroying existing data (unlike ingest.ts's DROP/CREATE).
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { Chunk, QaPair, StructuredArticle, Idea, IdeaFilters } from "./types.js";
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
    // WHAT: Curated tags as a JSON array string (e.g. '["Python","MCP"]').
    // WHY: Lets find_articles filter by tag without re-deriving from chunk text.
    "ALTER TABLE articles ADD COLUMN tags TEXT DEFAULT '[]'",
    "ALTER TABLE articles ADD COLUMN source_origin TEXT DEFAULT 'astgl-site'",
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
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_articles_content_type ON articles(content_type)"
  );
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_articles_source_origin ON articles(source_origin)"
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

  // WHAT: Idea journal for capturing content opportunities
  // WHY: Surfaces content gaps from query analytics and manual brainstorming
  database.exec(`
    CREATE TABLE IF NOT EXISTS ideas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'manual'
        CHECK(source IN ('manual','query-gap','low-confidence','trending','alert')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('high','medium','low')),
      status TEXT NOT NULL DEFAULT 'new'
        CHECK(status IN ('new','in-progress','published','rejected')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      related_queries TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      UNIQUE(title)
    )
  `);
  database.exec("CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status)");
  database.exec("CREATE INDEX IF NOT EXISTS idx_ideas_source ON ideas(source)");

  // WHAT: Track auto-rewrite jobs for stale articles (one row per attempt)
  // WHY: Drives the daily rewrite-queue cron + the Telegram approval gate.
  //      cooldown_until lets a rejected article sit for N days before re-queue.
  database.exec(`
    CREATE TABLE IF NOT EXISTS rewrite_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status TEXT NOT NULL CHECK (status IN (
        'pending_approval','approved','published','rejected','failed'
      )),
      draft_path TEXT,
      telegram_chat_id TEXT,
      telegram_thread_id INTEGER,
      telegram_message_id INTEGER,
      approved_at TEXT,
      published_at TEXT,
      substack_url TEXT,
      cooldown_until TEXT,
      error TEXT
    )
  `);
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_rewrite_jobs_status ON rewrite_jobs(status)"
  );
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_rewrite_jobs_article ON rewrite_jobs(article_url)"
  );
}

// WHAT: Shared "which articles are stale?" query.
// WHY: Both freshness.ts (for alerting) and rewrite-queue.ts (for picking
//      the next article to rewrite) need the exact same filter — keep it
//      in one place so the two stay in lockstep when STALE_THRESHOLD_DAYS
//      changes or the COALESCE priority is tweaked.
export interface StaleArticleRow {
  title: string;
  url: string;
  effective_date: string;
}

export function getStaleArticles(
  database: InstanceType<typeof Database>,
  thresholdDays = 90,
  excludeUrls: string[] = []
): StaleArticleRow[] {
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - thresholdDays);
  const staleDateStr = staleDate.toISOString();

  const exclusion =
    excludeUrls.length > 0
      ? `AND url NOT IN (${excludeUrls.map(() => "?").join(",")})`
      : "";

  const sql = `SELECT title, url,
                      COALESCE(last_reviewed_at, pub_date, processed_at) as effective_date
               FROM articles
               WHERE COALESCE(last_reviewed_at, pub_date, processed_at) IS NOT NULL
                 AND COALESCE(last_reviewed_at, pub_date, processed_at) < ?
                 ${exclusion}
               ORDER BY COALESCE(last_reviewed_at, pub_date, processed_at) ASC`;

  return database.prepare(sql).all(staleDateStr, ...excludeUrls) as StaleArticleRow[];
}

// WHAT: Return the assembled markdown body for an article by reading its chunks.
// WHY: Articles table holds metadata only; the actual prose lives in `chunks`.
//      The rewriter needs the original text as input.
export interface AssembledArticle {
  title: string;
  url: string;
  description: string | null;
  pub_date: string | null;
  body: string;
}

export function assembleArticleBody(
  database: InstanceType<typeof Database>,
  articleUrl: string
): AssembledArticle | null {
  const article = database
    .prepare(
      "SELECT title, url, description, pub_date FROM articles WHERE url = ?"
    )
    .get(articleUrl) as
    | { title: string; url: string; description: string | null; pub_date: string | null }
    | undefined;

  if (!article) return null;

  const chunks = database
    .prepare(
      `SELECT section_heading, chunk_type, content
       FROM chunks
       WHERE article_url = ?
       ORDER BY article_order ASC`
    )
    .all(articleUrl) as Array<{
    section_heading: string | null;
    chunk_type: string | null;
    content: string;
  }>;

  const parts: string[] = [];
  let currentHeading: string | null = null;
  for (const chunk of chunks) {
    if (chunk.section_heading && chunk.section_heading !== currentHeading) {
      currentHeading = chunk.section_heading;
      parts.push(`## ${chunk.section_heading}`);
    }
    parts.push(chunk.content);
  }

  return {
    title: article.title,
    url: article.url,
    description: article.description,
    pub_date: article.pub_date,
    body: parts.join("\n\n").trim(),
  };
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

  // WHAT: Only overwrite tags when the caller provides them (COALESCE keeps
  //       existing tags if this upsert doesn't carry any), so re-ingesting a
  //       source that lacks tags never wipes previously-stored tags.
  const tagsJson =
    article.tags && article.tags.length > 0
      ? JSON.stringify(article.tags)
      : null;

  if (existing) {
    database
      .prepare(
        `UPDATE articles SET title = ?, description = ?, slug = ?,
         source_url = ?, content_type = ?, json_ld = ?, processed_at = ?,
         pub_date = COALESCE(?, pub_date), tags = COALESCE(?, tags),
         source_origin = COALESCE(?, source_origin)
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
        tagsJson,
        article.sourceOrigin || null,
        existing.id
      );
  } else {
    database
      .prepare(
        `INSERT INTO articles (title, description, url, slug, source_url, content_type, json_ld, processed_at, pub_date, tags, source_origin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        article.pubDate || null,
        tagsJson ?? "[]",
        article.sourceOrigin || "astgl-site"
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

// WHAT: Hard-delete an article and every dependent row (chunks, vectors, Q&A)
// WHY: Used by the draft reconciler to retire orphaned drafts whose source folder
//      has been removed or renamed Published_*. Wrapped in a transaction so a
//      partial failure can't leave dangling vec_chunks rows.
export function deleteArticle(
  database: InstanceType<typeof Database>,
  articleUrl: string
): { chunksDeleted: number; qaDeleted: number; articleDeleted: boolean } {
  let chunksDeleted = 0;
  let qaDeleted = 0;
  let articleDeleted = false;

  const tx = database.transaction(() => {
    const existingChunks = database
      .prepare("SELECT id FROM chunks WHERE article_url = ?")
      .all(articleUrl) as Array<{ id: number }>;

    const deleteVec = database.prepare(
      "DELETE FROM vec_chunks WHERE chunk_id = ?"
    );
    for (const chunk of existingChunks) {
      deleteVec.run(chunk.id);
    }

    const chunkResult = database
      .prepare("DELETE FROM chunks WHERE article_url = ?")
      .run(articleUrl);
    chunksDeleted = chunkResult.changes;

    const qaResult = database
      .prepare("DELETE FROM article_qa WHERE article_url = ?")
      .run(articleUrl);
    qaDeleted = qaResult.changes;

    const articleResult = database
      .prepare("DELETE FROM articles WHERE url = ?")
      .run(articleUrl);
    articleDeleted = articleResult.changes > 0;
  });

  tx();
  return { chunksDeleted, qaDeleted, articleDeleted };
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

// --- Idea Journal CRUD ---

export function insertIdea(
  database: InstanceType<typeof Database>,
  idea: Omit<Idea, "id">
): number {
  const result = database
    .prepare(
      `INSERT INTO ideas (title, description, source, priority, status, created_at, updated_at, related_queries, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      idea.title,
      idea.description,
      idea.source,
      idea.priority,
      idea.status,
      idea.created_at,
      idea.updated_at,
      JSON.stringify(idea.related_queries),
      JSON.stringify(idea.tags)
    );
  return result.lastInsertRowid as number;
}

export function getIdeas(
  database: InstanceType<typeof Database>,
  filters: IdeaFilters
): Idea[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.status) {
    conditions.push("status = ?");
    params.push(filters.status);
  }
  if (filters.priority) {
    conditions.push("priority = ?");
    params.push(filters.priority);
  }
  if (filters.source) {
    conditions.push("source = ?");
    params.push(filters.source);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit || 10;
  params.push(limit);

  const rows = database
    .prepare(
      `SELECT * FROM ideas ${where} ORDER BY
         CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 END,
         created_at DESC
       LIMIT ?`
    )
    .all(...params) as Array<{
    id: number;
    title: string;
    description: string;
    source: string;
    priority: string;
    status: string;
    created_at: string;
    updated_at: string;
    related_queries: string;
    tags: string;
  }>;

  return rows.map((r) => ({
    ...r,
    source: r.source as Idea["source"],
    priority: r.priority as Idea["priority"],
    status: r.status as Idea["status"],
    related_queries: JSON.parse(r.related_queries) as string[],
    tags: JSON.parse(r.tags) as string[],
  }));
}

export function getIdeaCountByStatus(
  database: InstanceType<typeof Database>
): Record<string, number> {
  const rows = database
    .prepare("SELECT status, COUNT(*) as count FROM ideas GROUP BY status")
    .all() as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

export function closeKnowledgeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
