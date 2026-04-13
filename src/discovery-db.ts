/**
 * Discovery database module.
 * Manages SQLite storage for discovered content metadata.
 * Separate from knowledge.db — discovery.db accumulates over time.
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";

const DB_PATH = join(import.meta.dirname, "..", "data", "discovery.db");

export interface DiscoveredItem {
  url: string;
  title: string | null;
  description: string | null;
  pubDate: string | null;
  source: "astgl-rss" | "substack-rss" | "astgl-sitemap";
  contentHash: string;
}

export type UpsertResult = "new" | "updated" | "skipped";

let db: InstanceType<typeof Database> | null = null;

// WHAT: Initialize discovery database with schema
// WHY: CREATE IF NOT EXISTS preserves accumulated history across runs
export function initDb(): InstanceType<typeof Database> {
  const dataDir = join(import.meta.dirname, "..", "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  db = new Database(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS discovered_content (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL UNIQUE,
      title TEXT,
      description TEXT,
      pub_date TEXT,
      source TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      is_new INTEGER DEFAULT 1
    )
  `);

  return db;
}

// WHAT: Insert or update a discovered item based on URL + content hash
// WHY: Dedup via URL, detect content changes via hash difference
export function upsertItem(
  database: InstanceType<typeof Database>,
  item: DiscoveredItem
): UpsertResult {
  const now = new Date().toISOString();

  const existing = database
    .prepare("SELECT id, content_hash FROM discovered_content WHERE url = ?")
    .get(item.url) as { id: number; content_hash: string } | undefined;

  if (!existing) {
    database
      .prepare(
        `INSERT INTO discovered_content (url, title, description, pub_date, source, content_hash, first_seen, last_seen, is_new)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
      .run(
        item.url,
        item.title,
        item.description,
        item.pubDate,
        item.source,
        item.contentHash,
        now,
        now
      );
    return "new";
  }

  if (existing.content_hash !== item.contentHash) {
    database
      .prepare(
        `UPDATE discovered_content
         SET title = ?, description = ?, content_hash = ?, last_seen = ?, is_new = 1
         WHERE id = ?`
      )
      .run(item.title, item.description, item.contentHash, now, existing.id);
    return "updated";
  }

  database
    .prepare("UPDATE discovered_content SET last_seen = ? WHERE id = ?")
    .run(now, existing.id);
  return "skipped";
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
