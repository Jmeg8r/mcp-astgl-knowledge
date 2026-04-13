#!/usr/bin/env tsx
/**
 * Daily AEO report generator.
 *
 * WHAT: Aggregates query logs, content stats, and health metrics into a daily report
 * WHY: Tracks AEO effectiveness — query volume, top topics, gaps, stale content
 *
 * Usage:
 *   npm run daily-report                  Print report to stdout (JSON)
 *   npm run daily-report -- --discord     Send report to Discord webhook
 *   npm run daily-report -- --days 7      Look back 7 days instead of 1
 *
 * Env: DISCORD_WEBHOOK_URL — Discord webhook for automated delivery
 */

import { join } from "path";
import { existsSync } from "fs";
import Database from "better-sqlite3";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const QUERY_LOG_PATH = join(DATA_DIR, "query-log.db");
const KNOWLEDGE_PATH = join(DATA_DIR, "knowledge.db");
const DISCOVERY_PATH = join(DATA_DIR, "discovery.db");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// WHAT: Parse CLI args for --discord flag and --days N
// WHY: Keeps the script flexible for both cron (Discord) and manual (stdout) use
function parseArgs(): { sendToDiscord: boolean; days: number } {
  const args = process.argv.slice(2);
  return {
    sendToDiscord: args.includes("--discord"),
    days: (() => {
      const idx = args.indexOf("--days");
      return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 1;
    })(),
  };
}

interface DailyReport {
  generated_at: string;
  period: { days: number; from: string; to: string };
  query_volume: {
    total: number;
    by_tool: Record<string, number>;
    unique_sessions: number;
    avg_response_ms: number;
    avg_confidence: number;
  };
  top_queries: Array<{ query: string; tool: string; count: number }>;
  top_cited: Array<{ url: string; times_cited: number }>;
  low_confidence: Array<{ query: string; confidence: number; tool: string }>;
  content_stats: {
    total_articles: number;
    total_chunks: number;
    by_type: Record<string, number>;
    recently_indexed: Array<{ title: string; url: string; indexed_at: string }>;
  };
  stale_content: Array<{ title: string; url: string; days_since_indexed: number }>;
  freshness_summary: Record<string, number>;
  discovery_stats: {
    pending: number;
    total_discovered: number;
  };
  health: {
    query_log_exists: boolean;
    knowledge_db_exists: boolean;
    discovery_db_exists: boolean;
    issues: string[];
  };
}

function getQueryStats(
  days: number,
  fromDate: string
): DailyReport["query_volume"] &
  Pick<DailyReport, "top_queries" | "top_cited" | "low_confidence"> {
  const defaults = {
    total: 0,
    by_tool: {} as Record<string, number>,
    unique_sessions: 0,
    avg_response_ms: 0,
    avg_confidence: 0,
    top_queries: [] as DailyReport["top_queries"],
    top_cited: [] as DailyReport["top_cited"],
    low_confidence: [] as DailyReport["low_confidence"],
  };

  if (!existsSync(QUERY_LOG_PATH)) return defaults;

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(QUERY_LOG_PATH, { readonly: true });
  } catch {
    return defaults;
  }

  // WHAT: Check if table exists (DB may be empty/corrupt)
  const tableCheck = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'"
    )
    .get();
  if (!tableCheck) {
    db.close();
    return defaults;
  }

  const summary = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        COUNT(DISTINCT client_id) as unique_sessions,
        ROUND(AVG(response_time_ms)) as avg_response_ms,
        ROUND(AVG(confidence_score), 3) as avg_confidence
       FROM query_log
       WHERE timestamp >= ?`
    )
    .get(fromDate) as {
    total: number;
    unique_sessions: number;
    avg_response_ms: number;
    avg_confidence: number;
  };

  const byTool = db
    .prepare(
      `SELECT tool_name, COUNT(*) as count
       FROM query_log WHERE timestamp >= ?
       GROUP BY tool_name ORDER BY count DESC`
    )
    .all(fromDate) as Array<{ tool_name: string; count: number }>;

  // WHAT: Extract the actual query text from JSON params
  // WHY: query_params is stored as JSON — need to parse for readability
  const topQueries = db
    .prepare(
      `SELECT query_params, tool_name, COUNT(*) as count
       FROM query_log WHERE timestamp >= ?
       GROUP BY query_params, tool_name
       ORDER BY count DESC LIMIT 10`
    )
    .all(fromDate) as Array<{
    query_params: string;
    tool_name: string;
    count: number;
  }>;

  // WHAT: Count how often each URL was cited across all queries
  // WHY: Shows which content is most valuable to AI consumers
  const allCited = db
    .prepare(
      `SELECT content_cited FROM query_log
       WHERE timestamp >= ? AND content_cited IS NOT NULL`
    )
    .all(fromDate) as Array<{ content_cited: string }>;

  const citedCounts = new Map<string, number>();
  for (const row of allCited) {
    try {
      const urls: string[] = JSON.parse(row.content_cited);
      for (const url of urls) {
        citedCounts.set(url, (citedCounts.get(url) || 0) + 1);
      }
    } catch {
      // Skip malformed JSON
    }
  }
  const topCited = [...citedCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([url, count]) => ({ url, times_cited: count }));

  // WHAT: Queries with low confidence scores (< 0.6)
  // WHY: These represent content gaps — users asking questions we can't answer well
  const lowConf = db
    .prepare(
      `SELECT query_params, confidence_score, tool_name
       FROM query_log
       WHERE timestamp >= ? AND confidence_score < 0.6 AND confidence_score IS NOT NULL
       ORDER BY confidence_score ASC LIMIT 10`
    )
    .all(fromDate) as Array<{
    query_params: string;
    confidence_score: number;
    tool_name: string;
  }>;

  db.close();

  return {
    total: summary.total,
    by_tool: Object.fromEntries(byTool.map((r) => [r.tool_name, r.count])),
    unique_sessions: summary.unique_sessions,
    avg_response_ms: summary.avg_response_ms || 0,
    avg_confidence: summary.avg_confidence || 0,
    top_queries: topQueries.map((r) => {
      let query = r.query_params;
      try {
        const parsed = JSON.parse(r.query_params);
        query = parsed.query || parsed.question || parsed.topic_a || r.query_params;
      } catch {
        // Use raw string
      }
      return { query, tool: r.tool_name, count: r.count };
    }),
    top_cited: topCited,
    low_confidence: lowConf.map((r) => {
      let query = r.query_params;
      try {
        const parsed = JSON.parse(r.query_params);
        query = parsed.query || parsed.question || r.query_params;
      } catch {
        // Use raw
      }
      return { query, confidence: r.confidence_score, tool: r.tool_name };
    }),
  };
}

function getContentStats(
  days: number,
  fromDate: string
): DailyReport["content_stats"] & { stale: DailyReport["stale_content"]; freshnessSummary: Record<string, number> } {
  const defaults = {
    total_articles: 0,
    total_chunks: 0,
    by_type: {} as Record<string, number>,
    recently_indexed: [] as DailyReport["content_stats"]["recently_indexed"],
    stale: [] as DailyReport["stale_content"],
    freshnessSummary: {} as Record<string, number>,
  };

  if (!existsSync(KNOWLEDGE_PATH)) return defaults;

  const db = new Database(KNOWLEDGE_PATH, { readonly: true });

  const articleCount = db
    .prepare("SELECT COUNT(*) as count FROM articles")
    .get() as { count: number };

  const chunkCount = db
    .prepare("SELECT COUNT(*) as count FROM chunks")
    .get() as { count: number };

  const byType = db
    .prepare(
      `SELECT COALESCE(content_type, 'article') as content_type, COUNT(*) as count
       FROM articles GROUP BY content_type`
    )
    .all() as Array<{ content_type: string; count: number }>;

  const recentlyIndexed = db
    .prepare(
      `SELECT title, url, processed_at
       FROM articles
       WHERE processed_at >= ?
       ORDER BY processed_at DESC LIMIT 10`
    )
    .all(fromDate) as Array<{
    title: string;
    url: string;
    processed_at: string;
  }>;

  // WHAT: Articles not updated in 90+ days
  // WHY: Stale content may have outdated info that hurts citation quality
  const STALE_DAYS = 90;
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - STALE_DAYS);

  const stale = db
    .prepare(
      `SELECT title, url, processed_at
       FROM articles
       WHERE processed_at IS NOT NULL AND processed_at < ?
       ORDER BY processed_at ASC LIMIT 10`
    )
    .all(staleDate.toISOString()) as Array<{
    title: string;
    url: string;
    processed_at: string;
  }>;

  // WHAT: Count articles by freshness_status
  // WHY: Shows at a glance how many articles need attention
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
    // freshness_status column may not exist yet
  }

  db.close();

  const now = Date.now();
  return {
    total_articles: articleCount.count,
    total_chunks: chunkCount.count,
    by_type: Object.fromEntries(byType.map((r) => [r.content_type, r.count])),
    recently_indexed: recentlyIndexed.map((r) => ({
      title: r.title,
      url: r.url,
      indexed_at: r.processed_at,
    })),
    stale: stale.map((r) => ({
      title: r.title,
      url: r.url,
      days_since_indexed: Math.floor(
        (now - new Date(r.processed_at).getTime()) / (1000 * 60 * 60 * 24)
      ),
    })),
    freshnessSummary,
  };
}

function getDiscoveryStats(): DailyReport["discovery_stats"] {
  if (!existsSync(DISCOVERY_PATH)) return { pending: 0, total_discovered: 0 };

  const db = new Database(DISCOVERY_PATH, { readonly: true });

  const tableCheck = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='discovered_content'"
    )
    .get();
  if (!tableCheck) {
    db.close();
    return { pending: 0, total_discovered: 0 };
  }

  const stats = db
    .prepare(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_new = 1 THEN 1 ELSE 0 END) as pending
       FROM discovered_content`
    )
    .get() as { total: number; pending: number };

  db.close();
  return { pending: stats.pending, total_discovered: stats.total };
}

function buildReport(days: number): DailyReport {
  const now = new Date();
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  const fromDate = from.toISOString();

  const queryStats = getQueryStats(days, fromDate);
  const contentStats = getContentStats(days, fromDate);
  const discoveryStats = getDiscoveryStats();

  const issues: string[] = [];
  if (!existsSync(QUERY_LOG_PATH)) issues.push("query-log.db not found — MCP server may not have been used yet");
  if (!existsSync(KNOWLEDGE_PATH)) issues.push("knowledge.db not found — run 'npm run ingest'");
  if (!existsSync(DISCOVERY_PATH)) issues.push("discovery.db not found — run 'npm run discover'");
  if (discoveryStats.pending > 0) issues.push(`${discoveryStats.pending} discovered items pending structuring`);
  if (queryStats.avg_confidence > 0 && queryStats.avg_confidence < 0.6) issues.push("Average confidence below 0.6 — content may need expansion");

  return {
    generated_at: now.toISOString(),
    period: {
      days,
      from: fromDate,
      to: now.toISOString(),
    },
    query_volume: {
      total: queryStats.total,
      by_tool: queryStats.by_tool,
      unique_sessions: queryStats.unique_sessions,
      avg_response_ms: queryStats.avg_response_ms,
      avg_confidence: queryStats.avg_confidence,
    },
    top_queries: queryStats.top_queries,
    top_cited: queryStats.top_cited,
    low_confidence: queryStats.low_confidence,
    content_stats: {
      total_articles: contentStats.total_articles,
      total_chunks: contentStats.total_chunks,
      by_type: contentStats.by_type,
      recently_indexed: contentStats.recently_indexed,
    },
    stale_content: contentStats.stale,
    freshness_summary: contentStats.freshnessSummary,
    discovery_stats: discoveryStats,
    health: {
      query_log_exists: existsSync(QUERY_LOG_PATH),
      knowledge_db_exists: existsSync(KNOWLEDGE_PATH),
      discovery_db_exists: existsSync(DISCOVERY_PATH),
      issues,
    },
  };
}

// WHAT: Format report as a Discord embed message
// WHY: Embeds are structured, scannable, and look professional in Discord channels
function formatDiscordEmbed(report: DailyReport): object {
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

  // Query volume
  const toolBreakdown = Object.entries(report.query_volume.by_tool)
    .map(([tool, count]) => `${tool}: ${count}`)
    .join("\n") || "No queries";

  fields.push({
    name: "Query Volume",
    value: [
      `**Total:** ${report.query_volume.total}`,
      `**Sessions:** ${report.query_volume.unique_sessions}`,
      `**Avg Response:** ${report.query_volume.avg_response_ms}ms`,
      `**Avg Confidence:** ${report.query_volume.avg_confidence}`,
    ].join("\n"),
    inline: true,
  });

  fields.push({
    name: "By Tool",
    value: toolBreakdown,
    inline: true,
  });

  // Content stats
  const typeBreakdown = Object.entries(report.content_stats.by_type)
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");

  fields.push({
    name: "Knowledge Base",
    value: [
      `**Articles:** ${report.content_stats.total_articles}`,
      `**Chunks:** ${report.content_stats.total_chunks}`,
      `**Types:** ${typeBreakdown}`,
    ].join("\n"),
    inline: true,
  });

  // Top queries
  if (report.top_queries.length > 0) {
    fields.push({
      name: "Top Queries",
      value: report.top_queries
        .slice(0, 5)
        .map((q, i) => `${i + 1}. "${q.query}" (${q.count}x)`)
        .join("\n"),
    });
  }

  // Top cited
  if (report.top_cited.length > 0) {
    fields.push({
      name: "Most Cited",
      value: report.top_cited
        .slice(0, 5)
        .map((c, i) => `${i + 1}. ${c.url} (${c.times_cited}x)`)
        .join("\n"),
    });
  }

  // Low confidence (content gaps)
  if (report.low_confidence.length > 0) {
    fields.push({
      name: "Content Gaps (Low Confidence)",
      value: report.low_confidence
        .slice(0, 5)
        .map((q) => `"${q.query}" → ${q.confidence}`)
        .join("\n"),
    });
  }

  // New content
  if (report.content_stats.recently_indexed.length > 0) {
    fields.push({
      name: "Recently Indexed",
      value: report.content_stats.recently_indexed
        .slice(0, 5)
        .map((a) => `[${a.title}](${a.url})`)
        .join("\n"),
    });
  }

  // Freshness summary
  if (Object.keys(report.freshness_summary).length > 0) {
    const statusLine = Object.entries(report.freshness_summary)
      .map(([status, count]) => `**${status}:** ${count}`)
      .join(" | ");
    fields.push({ name: "Content Freshness", value: statusLine });
  }

  // Stale content
  if (report.stale_content.length > 0) {
    fields.push({
      name: "Stale Content (90+ days)",
      value: report.stale_content
        .slice(0, 5)
        .map((a) => `${a.title} (${a.days_since_indexed}d)`)
        .join("\n"),
    });
  }

  // Health issues
  if (report.health.issues.length > 0) {
    fields.push({
      name: "Issues",
      value: report.health.issues.map((i) => `⚠ ${i}`).join("\n"),
    });
  }

  // Discovery
  fields.push({
    name: "Discovery Pipeline",
    value: `**Total discovered:** ${report.discovery_stats.total_discovered} | **Pending:** ${report.discovery_stats.pending}`,
  });

  const color = report.health.issues.length > 0 ? 0xffa500 : 0x00c853;

  return {
    embeds: [
      {
        title: `ASTGL AEO Daily Report — ${report.period.days}d`,
        color,
        fields,
        footer: { text: `Generated ${report.generated_at}` },
      },
    ],
  };
}

async function sendToDiscord(report: DailyReport): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    console.error(
      "DISCORD_WEBHOOK_URL not set. Set it in your environment to enable Discord delivery."
    );
    console.error("Example: export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...");
    process.exit(1);
  }

  const payload = formatDiscordEmbed(report);

  const resp = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Discord webhook failed: ${resp.status} ${body}`);
  }

  console.error("Report sent to Discord successfully.");
}

async function main() {
  const { sendToDiscord: shouldSend, days } = parseArgs();

  const report = buildReport(days);

  // Always output JSON to stdout (for OpenClaw logging)
  console.log(JSON.stringify(report, null, 2));

  if (shouldSend) {
    await sendToDiscord(report);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Daily report failed:", err);
    process.exit(1);
  });
