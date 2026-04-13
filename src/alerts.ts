#!/usr/bin/env tsx
/**
 * Content gap alert engine.
 *
 * WHAT: Auto-detects AEO problems and sends Discord alerts when thresholds are crossed
 * WHY: Proactive alerting catches citation drops, content gaps, and competitor moves
 *       before they become invisible losses
 *
 * Alert types:
 *   1. Unknown topic spike — many queries with low confidence in a short window
 *   2. Zero-citation articles — high-value articles never appearing in cited content
 *   3. Repeated low-confidence — same query failing multiple times (content gap signal)
 *   4. Competitor MCP servers — new servers on registries covering similar topics
 *
 * Usage:
 *   npm run alerts                    Check all alerts, print to stdout (JSON)
 *   npm run alerts -- --discord       Also send triggered alerts to Discord
 *   npm run alerts -- --days 7        Look back 7 days (default: 1)
 *
 * Env: DISCORD_WEBHOOK_URL — Discord webhook for alert delivery
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const QUERY_LOG_PATH = join(DATA_DIR, "query-log.db");
const KNOWLEDGE_PATH = join(DATA_DIR, "knowledge.db");
const ALERT_DB_PATH = join(DATA_DIR, "alerts.db");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// --- Thresholds ---
const LOW_CONFIDENCE_THRESHOLD = 0.5;
const UNKNOWN_TOPIC_SPIKE_MIN = 5;
const REPEATED_QUERY_MIN = 3;
const ZERO_CITATION_LOOKBACK_DAYS = 14;
const ALERT_COOLDOWN_HOURS = 24;

// --- Types ---
interface Alert {
  type: "unknown_topic_spike" | "zero_citation" | "repeated_low_confidence" | "competitor_detected";
  severity: "info" | "warning" | "critical";
  title: string;
  details: string;
  data: Record<string, unknown>;
}

interface AlertReport {
  generated_at: string;
  period_days: number;
  alerts_fired: Alert[];
  alerts_suppressed: number;
  checks_run: string[];
}

// --- Alert History DB ---
// WHAT: Track which alerts have been sent to avoid spamming Discord
// WHY: Same alert condition can persist for days — only notify once per cooldown window
function initAlertDb(): InstanceType<typeof Database> {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  const db = new Database(ALERT_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_type TEXT NOT NULL,
      alert_key TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      details TEXT,
      UNIQUE(alert_type, alert_key, fired_at)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_alert_history_key ON alert_history(alert_type, alert_key)"
  );
  return db;
}

function wasRecentlyFired(
  alertDb: InstanceType<typeof Database>,
  type: string,
  key: string
): boolean {
  const cutoff = new Date();
  cutoff.setHours(cutoff.getHours() - ALERT_COOLDOWN_HOURS);

  const row = alertDb
    .prepare(
      `SELECT id FROM alert_history
       WHERE alert_type = ? AND alert_key = ? AND fired_at > ?
       LIMIT 1`
    )
    .get(type, key, cutoff.toISOString());

  return !!row;
}

function recordAlert(
  alertDb: InstanceType<typeof Database>,
  alert: Alert,
  key: string
): void {
  alertDb
    .prepare(
      "INSERT OR IGNORE INTO alert_history (alert_type, alert_key, fired_at, details) VALUES (?, ?, ?, ?)"
    )
    .run(alert.type, key, new Date().toISOString(), alert.title);
}

// --- Alert Check #1: Unknown Topic Spike ---
// WHAT: Detect when many queries have very low confidence scores
// WHY: Indicates users are asking about topics we don't cover — content gap opportunity
function checkUnknownTopicSpike(
  fromDate: string,
  alertDb: InstanceType<typeof Database>
): Alert[] {
  if (!existsSync(QUERY_LOG_PATH)) return [];

  const db = new Database(QUERY_LOG_PATH, { readonly: true });
  const tableCheck = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'")
    .get();
  if (!tableCheck) { db.close(); return []; }

  const lowConfQueries = db
    .prepare(
      `SELECT query_params, confidence_score, tool_name, COUNT(*) as occurrences
       FROM query_log
       WHERE timestamp >= ? AND confidence_score IS NOT NULL AND confidence_score < ?
       GROUP BY query_params
       ORDER BY occurrences DESC`
    )
    .all(fromDate, LOW_CONFIDENCE_THRESHOLD) as Array<{
    query_params: string;
    confidence_score: number;
    tool_name: string;
    occurrences: number;
  }>;

  db.close();

  if (lowConfQueries.length < UNKNOWN_TOPIC_SPIKE_MIN) return [];

  const key = `spike-${lowConfQueries.length}-${fromDate.split("T")[0]}`;
  if (wasRecentlyFired(alertDb, "unknown_topic_spike", key)) return [];

  const topQueries = lowConfQueries.slice(0, 5).map((q) => {
    try {
      const parsed = JSON.parse(q.query_params);
      return parsed.query || parsed.question || q.query_params;
    } catch {
      return q.query_params;
    }
  });

  const alert: Alert = {
    type: "unknown_topic_spike",
    severity: lowConfQueries.length >= 10 ? "critical" : "warning",
    title: `Unknown topic spike: ${lowConfQueries.length} low-confidence queries`,
    details: [
      `${lowConfQueries.length} unique queries scored below ${LOW_CONFIDENCE_THRESHOLD} confidence.`,
      "Top queries:",
      ...topQueries.map((q, i) => `  ${i + 1}. "${q}"`),
      "",
      "Action: Review these topics for new article opportunities.",
    ].join("\n"),
    data: {
      count: lowConfQueries.length,
      threshold: LOW_CONFIDENCE_THRESHOLD,
      top_queries: topQueries,
    },
  };

  recordAlert(alertDb, alert, key);
  return [alert];
}

// --- Alert Check #2: Zero-Citation Articles ---
// WHAT: Find articles that exist in the knowledge base but are never cited in query results
// WHY: Content that's never surfaced is invisible — may need better embeddings or rewriting
function checkZeroCitationArticles(
  fromDate: string,
  alertDb: InstanceType<typeof Database>
): Alert[] {
  if (!existsSync(QUERY_LOG_PATH) || !existsSync(KNOWLEDGE_PATH)) return [];

  const knowledgeDb = new Database(KNOWLEDGE_PATH, { readonly: true });
  const allArticles = knowledgeDb
    .prepare("SELECT title, url FROM articles")
    .all() as Array<{ title: string; url: string }>;
  knowledgeDb.close();

  const logDb = new Database(QUERY_LOG_PATH, { readonly: true });
  const tableCheck = logDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'")
    .get();

  if (!tableCheck) { logDb.close(); return []; }

  // WHAT: Collect all URLs that appeared in content_cited over the lookback window
  // WHY: If an article URL never shows up, it's either irrelevant or poorly embedded
  const lookback = new Date();
  lookback.setDate(lookback.getDate() - ZERO_CITATION_LOOKBACK_DAYS);

  const citedRows = logDb
    .prepare(
      `SELECT content_cited FROM query_log
       WHERE timestamp >= ? AND content_cited IS NOT NULL`
    )
    .all(lookback.toISOString()) as Array<{ content_cited: string }>;
  logDb.close();

  // Need at least some query activity to make this check meaningful
  if (citedRows.length < 10) return [];

  const citedUrls = new Set<string>();
  for (const row of citedRows) {
    try {
      const urls: string[] = JSON.parse(row.content_cited);
      for (const url of urls) citedUrls.add(url);
    } catch {
      // Skip malformed
    }
  }

  // WHAT: Filter to astgl.ai articles only (these are the "high-value" ones we control)
  // WHY: Substack mirror URLs being uncited is expected — the canonical ones matter
  const uncitedHighValue = allArticles.filter(
    (a) => a.url.startsWith("https://astgl.ai/") && !citedUrls.has(a.url)
  );

  if (uncitedHighValue.length === 0) return [];

  const key = `uncited-${uncitedHighValue.length}`;
  if (wasRecentlyFired(alertDb, "zero_citation", key)) return [];

  const alert: Alert = {
    type: "zero_citation",
    severity: uncitedHighValue.length >= 10 ? "warning" : "info",
    title: `${uncitedHighValue.length} high-value articles with zero citations (${ZERO_CITATION_LOOKBACK_DAYS}d)`,
    details: [
      `These astgl.ai articles were never cited in the last ${ZERO_CITATION_LOOKBACK_DAYS} days:`,
      ...uncitedHighValue.slice(0, 10).map((a) => `  - ${a.title}\n    ${a.url}`),
      uncitedHighValue.length > 10 ? `  ... and ${uncitedHighValue.length - 10} more` : "",
      "",
      "Action: Check embeddings quality, consider rewriting descriptions, or verify chunking.",
    ].join("\n"),
    data: {
      count: uncitedHighValue.length,
      lookback_days: ZERO_CITATION_LOOKBACK_DAYS,
      articles: uncitedHighValue.slice(0, 10).map((a) => ({ title: a.title, url: a.url })),
    },
  };

  recordAlert(alertDb, alert, key);
  return [alert];
}

// --- Alert Check #3: Repeated Low-Confidence Queries ---
// WHAT: Same query text appearing multiple times with consistently low confidence
// WHY: Repeated failures = a real user need we're not serving — highest-signal content gap
function checkRepeatedLowConfidence(
  fromDate: string,
  alertDb: InstanceType<typeof Database>
): Alert[] {
  if (!existsSync(QUERY_LOG_PATH)) return [];

  const db = new Database(QUERY_LOG_PATH, { readonly: true });
  const tableCheck = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='query_log'")
    .get();
  if (!tableCheck) { db.close(); return []; }

  const repeats = db
    .prepare(
      `SELECT query_params, tool_name,
              COUNT(*) as occurrences,
              ROUND(AVG(confidence_score), 3) as avg_confidence
       FROM query_log
       WHERE timestamp >= ?
         AND confidence_score IS NOT NULL
         AND confidence_score < ?
       GROUP BY query_params
       HAVING COUNT(*) >= ?
       ORDER BY occurrences DESC`
    )
    .all(fromDate, LOW_CONFIDENCE_THRESHOLD, REPEATED_QUERY_MIN) as Array<{
    query_params: string;
    tool_name: string;
    occurrences: number;
    avg_confidence: number;
  }>;

  db.close();

  if (repeats.length === 0) return [];

  const alerts: Alert[] = [];

  for (const r of repeats.slice(0, 5)) {
    let queryText = r.query_params;
    try {
      const parsed = JSON.parse(r.query_params);
      queryText = parsed.query || parsed.question || r.query_params;
    } catch {
      // Use raw
    }

    const key = `repeat-${queryText.slice(0, 50)}`;
    if (wasRecentlyFired(alertDb, "repeated_low_confidence", key)) continue;

    const alert: Alert = {
      type: "repeated_low_confidence",
      severity: r.occurrences >= 5 ? "critical" : "warning",
      title: `Repeated content gap: "${queryText}" (${r.occurrences}x, avg ${r.avg_confidence})`,
      details: [
        `Query "${queryText}" has been asked ${r.occurrences} times with avg confidence ${r.avg_confidence}.`,
        `Tool: ${r.tool_name}`,
        "",
        "Action: Write or improve content targeting this specific question.",
      ].join("\n"),
      data: {
        query: queryText,
        occurrences: r.occurrences,
        avg_confidence: r.avg_confidence,
        tool: r.tool_name,
      },
    };

    recordAlert(alertDb, alert, key);
    alerts.push(alert);
  }

  return alerts;
}

// --- Alert Check #4: Competitor MCP Servers ---
// WHAT: Scan Smithery registry for new MCP servers covering similar topics
// WHY: Competitors publishing knowledge MCP servers dilutes ASTGL's AEO position
async function checkCompetitorServers(
  alertDb: InstanceType<typeof Database>
): Promise<Alert[]> {
  const SEARCH_TERMS = ["knowledge base", "ai articles", "local ai", "mcp guide"];
  const OUR_SLUGS = ["astgl-knowledge", "mcp-astgl-knowledge"];

  const alerts: Alert[] = [];

  for (const term of SEARCH_TERMS) {
    try {
      // WHAT: Smithery registry search API
      // WHY: Public API, no auth needed, returns server metadata
      const resp = await fetch(
        `https://registry.smithery.ai/servers?q=${encodeURIComponent(term)}&pageSize=10`,
        {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        }
      );

      if (!resp.ok) continue;

      const data = (await resp.json()) as {
        servers?: Array<{
          qualifiedName: string;
          displayName: string;
          description: string;
          createdAt: string;
        }>;
      };

      if (!data.servers) continue;

      for (const server of data.servers) {
        // Skip our own server
        if (OUR_SLUGS.some((slug) => server.qualifiedName.includes(slug))) continue;

        // WHAT: Only alert on servers created in the last 30 days
        // WHY: Old servers aren't news — we want to catch new entrants
        const createdAt = new Date(server.createdAt);
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        if (createdAt < thirtyDaysAgo) continue;

        const key = `competitor-${server.qualifiedName}`;
        if (wasRecentlyFired(alertDb, "competitor_detected", key)) continue;

        const alert: Alert = {
          type: "competitor_detected",
          severity: "info",
          title: `New competitor MCP server: ${server.displayName}`,
          details: [
            `**Server:** ${server.qualifiedName}`,
            `**Name:** ${server.displayName}`,
            `**Description:** ${server.description?.slice(0, 200) || "N/A"}`,
            `**Created:** ${server.createdAt}`,
            `**Found via:** search for "${term}"`,
            "",
            "Action: Review server to assess overlap with ASTGL content coverage.",
          ].join("\n"),
          data: {
            qualified_name: server.qualifiedName,
            display_name: server.displayName,
            description: server.description,
            search_term: term,
          },
        };

        recordAlert(alertDb, alert, key);
        alerts.push(alert);
      }
    } catch {
      // Network error — skip this search term silently
    }
  }

  return alerts;
}

// --- Discord Delivery ---
function severityColor(severity: Alert["severity"]): number {
  switch (severity) {
    case "critical": return 0xff0000;
    case "warning": return 0xffa500;
    case "info": return 0x2196f3;
  }
}

function severityEmoji(severity: Alert["severity"]): string {
  switch (severity) {
    case "critical": return "🔴";
    case "warning": return "🟡";
    case "info": return "🔵";
  }
}

async function sendAlertsToDiscord(alerts: Alert[]): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) {
    console.error("DISCORD_WEBHOOK_URL not set.");
    return;
  }

  if (alerts.length === 0) return;

  // WHAT: Group alerts into a single Discord message with multiple embeds
  // WHY: One webhook call is better than N separate messages
  const embeds = alerts.slice(0, 10).map((alert) => ({
    title: `${severityEmoji(alert.severity)} ${alert.title}`,
    description: alert.details,
    color: severityColor(alert.severity),
    footer: { text: `Alert type: ${alert.type}` },
  }));

  const resp = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    console.error(`Discord webhook failed: ${resp.status} ${body}`);
  } else {
    console.error(`${alerts.length} alert(s) sent to Discord.`);
  }
}

// --- CLI ---
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

async function main() {
  const { sendToDiscord, days } = parseArgs();

  const from = new Date();
  from.setDate(from.getDate() - days);
  const fromDate = from.toISOString();

  const alertDb = initAlertDb();
  const checksRun: string[] = [];
  let suppressed = 0;
  const allAlerts: Alert[] = [];

  // Run all checks
  console.error("=== ASTGL Content Gap Alert Engine ===\n");

  console.error("Checking: unknown topic spike...");
  checksRun.push("unknown_topic_spike");
  const spikeAlerts = checkUnknownTopicSpike(fromDate, alertDb);
  allAlerts.push(...spikeAlerts);
  console.error(`  ${spikeAlerts.length} alert(s)\n`);

  console.error("Checking: zero-citation articles...");
  checksRun.push("zero_citation");
  const zeroCiteAlerts = checkZeroCitationArticles(fromDate, alertDb);
  allAlerts.push(...zeroCiteAlerts);
  console.error(`  ${zeroCiteAlerts.length} alert(s)\n`);

  console.error("Checking: repeated low-confidence queries...");
  checksRun.push("repeated_low_confidence");
  const repeatAlerts = checkRepeatedLowConfidence(fromDate, alertDb);
  allAlerts.push(...repeatAlerts);
  console.error(`  ${repeatAlerts.length} alert(s)\n`);

  console.error("Checking: competitor MCP servers...");
  checksRun.push("competitor_detected");
  const competitorAlerts = await checkCompetitorServers(alertDb);
  allAlerts.push(...competitorAlerts);
  console.error(`  ${competitorAlerts.length} alert(s)\n`);

  alertDb.close();

  const report: AlertReport = {
    generated_at: new Date().toISOString(),
    period_days: days,
    alerts_fired: allAlerts,
    alerts_suppressed: suppressed,
    checks_run: checksRun,
  };

  console.log(JSON.stringify(report, null, 2));

  if (sendToDiscord && allAlerts.length > 0) {
    await sendAlertsToDiscord(allAlerts);
  } else if (sendToDiscord && allAlerts.length === 0) {
    console.error("No alerts to send.");
  }

  console.error(
    `\n=== Done: ${allAlerts.length} alert(s) fired, ${suppressed} suppressed ===`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Alert engine failed:", err);
    process.exit(1);
  });
