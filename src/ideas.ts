/**
 * Idea Journal module.
 *
 * WHAT: Captures content ideas from query analytics and manual input
 * WHY: Surfaces content gaps and trending topics to drive article creation
 */

import { join } from "path";
import { existsSync } from "fs";
import { resolveKnowledgeDbPath, describeSearchedPaths } from "./db-path.js";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { insertIdea, getIdeas } from "./knowledge-db.js";
import type { Idea, IdeaFilters, IdeaSource, IdeaPriority } from "./types.js";

const QUERY_LOG_PATH = join(import.meta.dirname, "..", "data", "query-log.db");
// WHAT: Open a dedicated write connection to knowledge.db
// WHY: The MCP server's search.ts holds a read-only singleton — we need our own connection
function openKnowledgeDb(): InstanceType<typeof Database> {
  // WHY: Resolved via db-path.ts so an installed package (which ships only the
  //      pruned build/knowledge-public.db) finds a database instead of throwing.
  const KNOWLEDGE_PATH = resolveKnowledgeDbPath();
  if (!existsSync(KNOWLEDGE_PATH)) {
    throw new Error(
      `Knowledge database not found at ${describeSearchedPaths()}. Run 'npm run ingest' first.`
    );
  }
  const db = new Database(KNOWLEDGE_PATH);
  sqliteVec.load(db);

  // Ensure ideas table exists (idempotent)
  db.exec(`
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_ideas_source ON ideas(source)");

  return db;
}

interface IdeaSuggestion {
  title: string;
  description: string;
  source: IdeaSource;
  priority: IdeaPriority;
  related_queries: string[];
}

// WHAT: Auto-generate topic suggestions from query analytics
// WHY: Low-confidence and repeated queries reveal what users want but can't find
export function suggestIdeas(days: number, limit: number): IdeaSuggestion[] {
  const suggestions: IdeaSuggestion[] = [];

  if (!existsSync(QUERY_LOG_PATH)) return suggestions;

  let queryDb: InstanceType<typeof Database>;
  try {
    queryDb = new Database(QUERY_LOG_PATH, { readonly: true });
  } catch {
    return suggestions;
  }

  const tableCheck = queryDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'"
    )
    .get();
  if (!tableCheck) {
    queryDb.close();
    return suggestions;
  }

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - days);
  const fromStr = fromDate.toISOString();

  // Get existing idea titles for dedup
  const kdb = openKnowledgeDb();
  const existingTitles = new Set(
    getIdeas(kdb, { limit: 1000 }).map((i) => i.title.toLowerCase())
  );

  // WHAT: Find low-confidence queries (< 0.5)
  // WHY: These are questions the knowledge base can't answer well
  const lowConf = queryDb
    .prepare(
      `SELECT query_params, confidence_score, COUNT(*) as count
       FROM query_log
       WHERE timestamp >= ? AND confidence_score IS NOT NULL AND confidence_score < 0.5
       GROUP BY query_params
       ORDER BY count DESC, confidence_score ASC
       LIMIT ?`
    )
    .all(fromStr, limit * 2) as Array<{
    query_params: string;
    confidence_score: number;
    count: number;
  }>;

  for (const row of lowConf) {
    if (suggestions.length >= limit) break;
    const query = extractQueryText(row.query_params);
    if (!query || existingTitles.has(query.toLowerCase())) continue;

    suggestions.push({
      title: `Article: ${query}`,
      description: `Low confidence (${row.confidence_score}) across ${row.count} query(s). Users are asking about this but we lack good coverage.`,
      source: "low-confidence",
      priority: row.count >= 3 ? "high" : "medium",
      related_queries: [query],
    });
    existingTitles.add(`article: ${query}`.toLowerCase());
  }

  // WHAT: Find frequently repeated queries
  // WHY: High-volume queries indicate popular topics worth covering
  const trending = queryDb
    .prepare(
      `SELECT query_params, COUNT(*) as count
       FROM query_log
       WHERE timestamp >= ?
       GROUP BY query_params
       HAVING count >= 2
       ORDER BY count DESC
       LIMIT ?`
    )
    .all(fromStr, limit * 2) as Array<{
    query_params: string;
    count: number;
  }>;

  for (const row of trending) {
    if (suggestions.length >= limit) break;
    const query = extractQueryText(row.query_params);
    if (!query || existingTitles.has(`article: ${query}`.toLowerCase())) continue;

    suggestions.push({
      title: `Article: ${query}`,
      description: `Trending query with ${row.count} occurrence(s) in the last ${days} day(s).`,
      source: "trending",
      priority: row.count >= 5 ? "high" : "low",
      related_queries: [query],
    });
    existingTitles.add(`article: ${query}`.toLowerCase());
  }

  queryDb.close();
  kdb.close();

  return suggestions;
}

// WHAT: Add a content idea to the journal
// WHY: Centralizes idea capture from both auto-suggestions and manual input
export function addIdea(params: {
  title: string;
  description: string;
  source: IdeaSource;
  priority: IdeaPriority;
  tags: string[];
  related_queries: string[];
}): { id: number; message: string } {
  const kdb = openKnowledgeDb();
  const now = new Date().toISOString();

  try {
    const id = insertIdea(kdb, {
      title: params.title,
      description: params.description,
      source: params.source,
      priority: params.priority,
      status: "new",
      created_at: now,
      updated_at: now,
      related_queries: params.related_queries,
      tags: params.tags,
    });
    kdb.close();
    return { id, message: `Idea #${id} added: "${params.title}"` };
  } catch (err) {
    kdb.close();
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE constraint")) {
      throw new Error(`An idea with the title "${params.title}" already exists.`);
    }
    throw err;
  }
}

// WHAT: List ideas with optional filters
// WHY: Provides browsable access to the idea journal
export function listIdeas(filters: IdeaFilters): Idea[] {
  const kdb = openKnowledgeDb();
  const ideas = getIdeas(kdb, filters);
  kdb.close();
  return ideas;
}

// WHAT: Export ideas as a formatted markdown document
// WHY: Human-readable export for review, sharing, or ASTGL blog planning
export function exportIdeasMarkdown(filters: IdeaFilters): string {
  const ideas = listIdeas({ ...filters, limit: filters.limit || 50 });

  if (ideas.length === 0) {
    return "# ASTGL Idea Journal\n\nNo ideas found matching the filters.";
  }

  let md = "# ASTGL Idea Journal\n\n";
  md += `_Exported ${new Date().toISOString()} | ${ideas.length} idea(s)_\n\n`;

  // Group by priority
  const byPriority: Record<string, Idea[]> = { high: [], medium: [], low: [] };
  for (const idea of ideas) {
    byPriority[idea.priority].push(idea);
  }

  for (const [priority, group] of Object.entries(byPriority)) {
    if (group.length === 0) continue;
    md += `## ${priority.charAt(0).toUpperCase() + priority.slice(1)} Priority\n\n`;

    for (const idea of group) {
      md += `### ${idea.title}\n`;
      md += `**Status:** ${idea.status} | **Source:** ${idea.source} | **Created:** ${idea.created_at.slice(0, 10)}\n\n`;
      if (idea.description) md += `${idea.description}\n\n`;
      if (idea.tags.length > 0) md += `**Tags:** ${idea.tags.join(", ")}\n`;
      if (idea.related_queries.length > 0) {
        md += `**Related queries:** ${idea.related_queries.join("; ")}\n`;
      }
      md += "\n";
    }
  }

  return md;
}

// WHAT: Extract the actual query text from JSON query_params
// WHY: Stored as JSON like {"query":"..."} or {"question":"..."}
function extractQueryText(queryParams: string): string | null {
  try {
    const parsed = JSON.parse(queryParams);
    return parsed.query || parsed.question || parsed.topic_a || null;
  } catch {
    return null;
  }
}
