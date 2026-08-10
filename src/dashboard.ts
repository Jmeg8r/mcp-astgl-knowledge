#!/usr/bin/env tsx
/**
 * Dashboard data generator.
 *
 * WHAT: Generates a JSON snapshot of ASTGL analytics for the Astro site dashboard
 * WHY: Provides a single data file the Astro site can consume at build time
 *
 * Usage:
 *   npm run dashboard-data                  Print to stdout (JSON)
 *   npm run dashboard-data -- --output      Also write to data/dashboard.json
 *   npm run dashboard-data -- --days 30     Look back 30 days (default)
 */

import { join } from "path";
import { existsSync, writeFileSync } from "fs";
import Database from "better-sqlite3";
import type { DashboardData } from "./types.js";
import { resolveQueryLogDbPath } from "./db-path.js";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const QUERY_LOG_PATH = resolveQueryLogDbPath();
const KNOWLEDGE_PATH = join(DATA_DIR, "knowledge.db");

function parseArgs(): { days: number; outputFile: boolean } {
  const args = process.argv.slice(2);
  return {
    outputFile: args.includes("--output"),
    days: (() => {
      const idx = args.indexOf("--days");
      return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 30;
    })(),
  };
}

// WHAT: Generate comprehensive analytics snapshot
// WHY: Single function callable from both MCP tool and CLI
export function generateDashboardData(
  days: number,
  outputFile: boolean = false
): DashboardData {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  const fromStr = from.toISOString();

  const data: DashboardData = {
    generated_at: now.toISOString(),
    period_days: days,
    query_trends: getQueryTrends(fromStr),
    content_coverage: getContentCoverage(),
    citation_tracking: getCitationTracking(fromStr),
    content_gaps: getContentGaps(fromStr),
    ecosystem_status: getEcosystemStatus(),
  };

  if (outputFile) {
    const outPath = join(DATA_DIR, "dashboard.json");
    writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.error(`Dashboard data written to ${outPath}`);
  }

  return data;
}

function getQueryTrends(fromStr: string): DashboardData["query_trends"] {
  const defaults: DashboardData["query_trends"] = {
    total: 0,
    by_day: [],
    by_tool: {},
    top_queries: [],
    avg_confidence: 0,
  };

  if (!existsSync(QUERY_LOG_PATH)) return defaults;

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(QUERY_LOG_PATH, { readonly: true });
  } catch {
    return defaults;
  }

  const tableCheck = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'")
    .get();
  if (!tableCheck) {
    db.close();
    return defaults;
  }

  const summary = db
    .prepare(
      `SELECT COUNT(*) as total, ROUND(AVG(confidence_score), 3) as avg_confidence
       FROM query_log WHERE timestamp >= ?`
    )
    .get(fromStr) as { total: number; avg_confidence: number };

  const byDay = db
    .prepare(
      `SELECT DATE(timestamp) as date, COUNT(*) as count
       FROM query_log WHERE timestamp >= ?
       GROUP BY DATE(timestamp) ORDER BY date`
    )
    .all(fromStr) as Array<{ date: string; count: number }>;

  const byTool = db
    .prepare(
      `SELECT tool_name, COUNT(*) as count
       FROM query_log WHERE timestamp >= ?
       GROUP BY tool_name ORDER BY count DESC`
    )
    .all(fromStr) as Array<{ tool_name: string; count: number }>;

  const topQueries = db
    .prepare(
      `SELECT query_params, COUNT(*) as count
       FROM query_log WHERE timestamp >= ?
       GROUP BY query_params ORDER BY count DESC LIMIT 10`
    )
    .all(fromStr) as Array<{ query_params: string; count: number }>;

  db.close();

  return {
    total: summary.total,
    by_day: byDay,
    by_tool: Object.fromEntries(byTool.map((r) => [r.tool_name, r.count])),
    top_queries: topQueries.map((r) => ({
      query: extractQueryText(r.query_params),
      count: r.count,
    })),
    avg_confidence: summary.avg_confidence || 0,
  };
}

function getContentCoverage(): DashboardData["content_coverage"] {
  const defaults: DashboardData["content_coverage"] = {
    total_articles: 0,
    by_type: {},
    freshness_summary: {},
    recently_added: [],
  };

  if (!existsSync(KNOWLEDGE_PATH)) return defaults;

  const db = new Database(KNOWLEDGE_PATH, { readonly: true });

  const articleCount = db
    .prepare("SELECT COUNT(*) as count FROM articles")
    .get() as { count: number };

  const byType = db
    .prepare(
      `SELECT COALESCE(content_type, 'article') as content_type, COUNT(*) as count
       FROM articles GROUP BY content_type`
    )
    .all() as Array<{ content_type: string; count: number }>;

  let freshnessSummary: Record<string, number> = {};
  try {
    const byStatus = db
      .prepare(
        `SELECT COALESCE(freshness_status, 'current') as status, COUNT(*) as count
         FROM articles GROUP BY freshness_status`
      )
      .all() as Array<{ status: string; count: number }>;
    freshnessSummary = Object.fromEntries(byStatus.map((r) => [r.status, r.count]));
  } catch {
    // freshness_status column may not exist
  }

  const recentlyAdded = db
    .prepare(
      `SELECT title, url, COALESCE(processed_at, '') as date
       FROM articles
       ORDER BY COALESCE(processed_at, '') DESC, rowid DESC
       LIMIT 5`
    )
    .all() as Array<{ title: string; url: string; date: string }>;

  db.close();

  return {
    total_articles: articleCount.count,
    by_type: Object.fromEntries(byType.map((r) => [r.content_type, r.count])),
    freshness_summary: freshnessSummary,
    recently_added: recentlyAdded,
  };
}

function getCitationTracking(fromStr: string): DashboardData["citation_tracking"] {
  const defaults: DashboardData["citation_tracking"] = {
    top_cited: [],
    uncited_count: 0,
  };

  if (!existsSync(QUERY_LOG_PATH) || !existsSync(KNOWLEDGE_PATH)) return defaults;

  let queryDb: InstanceType<typeof Database>;
  try {
    queryDb = new Database(QUERY_LOG_PATH, { readonly: true });
  } catch {
    return defaults;
  }

  const tableCheck = queryDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'")
    .get();
  if (!tableCheck) {
    queryDb.close();
    return defaults;
  }

  // Count citations per URL
  const allCited = queryDb
    .prepare(
      `SELECT content_cited FROM query_log
       WHERE timestamp >= ? AND content_cited IS NOT NULL`
    )
    .all(fromStr) as Array<{ content_cited: string }>;

  queryDb.close();

  const citedCounts = new Map<string, number>();
  for (const row of allCited) {
    try {
      // WHAT: Check the parse result is an array before iterating it.
      // WHY: JSON.parse returns `any`, so annotating `string[]` asserted a shape
      //      nothing had checked. Matches search.ts listTags().
      const urls = JSON.parse(row.content_cited);
      if (Array.isArray(urls)) {
        for (const url of urls) {
          citedCounts.set(url, (citedCounts.get(url) || 0) + 1);
        }
      }
    } catch {
      // Skip malformed JSON
    }
  }

  const topCited = [...citedCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([url, count]) => ({ url, times_cited: count }));

  // Count uncited articles
  const knowledgeDb = new Database(KNOWLEDGE_PATH, { readonly: true });
  const totalArticles = (
    knowledgeDb.prepare("SELECT COUNT(*) as count FROM articles").get() as {
      count: number;
    }
  ).count;
  knowledgeDb.close();

  const citedUrls = new Set(citedCounts.keys());
  const uncitedCount = totalArticles - citedUrls.size;

  return {
    top_cited: topCited,
    uncited_count: Math.max(0, uncitedCount),
  };
}

function getContentGaps(fromStr: string): DashboardData["content_gaps"] {
  const defaults: DashboardData["content_gaps"] = {
    low_confidence_queries: [],
    idea_count_by_status: {},
  };

  // Low confidence queries
  if (existsSync(QUERY_LOG_PATH)) {
    try {
      const db = new Database(QUERY_LOG_PATH, { readonly: true });
      const tableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'")
        .get();

      if (tableCheck) {
        const lowConf = db
          .prepare(
            `SELECT query_params, ROUND(confidence_score, 3) as confidence
             FROM query_log
             WHERE timestamp >= ? AND confidence_score IS NOT NULL AND confidence_score < 0.5
             ORDER BY confidence_score ASC LIMIT 10`
          )
          .all(fromStr) as Array<{ query_params: string; confidence: number }>;

        defaults.low_confidence_queries = lowConf.map((r) => ({
          query: extractQueryText(r.query_params),
          confidence: r.confidence,
        }));
      }
      db.close();
    } catch {
      // Skip on error
    }
  }

  // Idea counts by status
  if (existsSync(KNOWLEDGE_PATH)) {
    try {
      const db = new Database(KNOWLEDGE_PATH, { readonly: true });
      const tableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ideas'")
        .get();

      if (tableCheck) {
        const counts = db
          .prepare("SELECT status, COUNT(*) as count FROM ideas GROUP BY status")
          .all() as Array<{ status: string; count: number }>;
        defaults.idea_count_by_status = Object.fromEntries(
          counts.map((r) => [r.status, r.count])
        );
      }
      db.close();
    } catch {
      // Skip on error
    }
  }

  return defaults;
}

function getEcosystemStatus(): DashboardData["ecosystem_status"] {
  if (!existsSync(KNOWLEDGE_PATH)) return [];

  try {
    const db = new Database(KNOWLEDGE_PATH, { readonly: true });

    const tableCheck = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ecosystem_snapshots'"
      )
      .get();

    if (!tableCheck) {
      db.close();
      return [];
    }

    const rows = db
      .prepare(
        `SELECT package_name, current_version, check_type
         FROM ecosystem_snapshots ORDER BY package_name`
      )
      .all() as Array<{
      package_name: string;
      current_version: string;
      check_type: string;
    }>;

    db.close();
    return rows;
  } catch {
    return [];
  }
}

function extractQueryText(queryParams: string): string {
  try {
    const parsed = JSON.parse(queryParams);
    return parsed.query || parsed.question || parsed.topic_a || queryParams;
  } catch {
    return queryParams;
  }
}

// WHAT: Only run CLI when executed directly, not when imported
// WHY: index.ts imports generateDashboardData — must not trigger CLI side effects
const isDirectRun =
  process.argv[1]?.endsWith("dashboard.ts") ||
  process.argv[1]?.endsWith("dashboard.js");

if (isDirectRun) {
  const { days, outputFile } = parseArgs();
  const data = generateDashboardData(days, outputFile);
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}
