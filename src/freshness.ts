#!/usr/bin/env tsx
/**
 * Content freshness automation.
 *
 * WHAT: Detects stale content and ecosystem version changes, sends Discord alerts
 * WHY: Proactive freshness tracking prevents serving outdated info that hurts
 *       citation quality and reader trust
 *
 * Checks:
 *   1. Stale content — articles older than 90 days (pub_date or processed_at)
 *   2. MCP SDK version — polls npm registry for @modelcontextprotocol/sdk updates
 *   3. Key tool releases — polls GitHub releases for Ollama, MCP servers, Open WebUI
 *
 * Usage:
 *   npm run freshness                    Check all, print to stdout (JSON)
 *   npm run freshness -- --discord       Also send triggered alerts to Discord
 *
 * Env: DISCORD_WEBHOOK_URL — Discord webhook for alert delivery
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";
import { initKnowledgeDb } from "./knowledge-db.js";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const KNOWLEDGE_PATH = join(DATA_DIR, "knowledge.db");
const DISCOVERY_PATH = join(DATA_DIR, "discovery.db");
const ALERT_DB_PATH = join(DATA_DIR, "alerts.db");

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// --- Thresholds ---
const STALE_THRESHOLD_DAYS = 90;
const ALERT_COOLDOWN_HOURS = 168; // 7 days — stale content doesn't change daily

// --- Tracked Ecosystem Packages ---
const TRACKED_NPM_PACKAGES = ["@modelcontextprotocol/sdk"];

const TRACKED_GITHUB_REPOS = [
  { owner: "ollama", repo: "ollama", label: "Ollama" },
  { owner: "modelcontextprotocol", repo: "servers", label: "MCP Reference Servers" },
  { owner: "open-webui", repo: "open-webui", label: "Open WebUI" },
];

// --- Types ---
interface Alert {
  type: "stale_content" | "npm_version_change" | "github_release_change";
  severity: "info" | "warning" | "critical";
  title: string;
  details: string;
  data: Record<string, unknown>;
}

interface FreshnessReport {
  generated_at: string;
  alerts_fired: Alert[];
  alerts_suppressed: number;
  checks_run: string[];
  ecosystem_versions: Array<{ package: string; version: string; type: string }>;
  stale_articles: number;
  total_articles: number;
}

// --- Alert History DB ---
// WHAT: Reuse the same alerts.db as alerts.ts for cooldown tracking
// WHY: Single source of truth for alert suppression across all alert types
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

// --- Ecosystem Snapshots ---
// WHAT: Store last-known version for each tracked package/repo
// WHY: Comparing against previous version detects ecosystem changes
function initEcosystemTable(knowledgeDb: InstanceType<typeof Database>): void {
  knowledgeDb.exec(`
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

function getSnapshot(
  knowledgeDb: InstanceType<typeof Database>,
  checkType: string,
  packageName: string
): { current_version: string; previous_version: string | null } | undefined {
  return knowledgeDb
    .prepare(
      "SELECT current_version, previous_version FROM ecosystem_snapshots WHERE check_type = ? AND package_name = ?"
    )
    .get(checkType, packageName) as
    | { current_version: string; previous_version: string | null }
    | undefined;
}

function upsertSnapshot(
  knowledgeDb: InstanceType<typeof Database>,
  checkType: string,
  packageName: string,
  version: string
): void {
  const existing = getSnapshot(knowledgeDb, checkType, packageName);

  if (existing) {
    if (existing.current_version !== version) {
      knowledgeDb
        .prepare(
          `UPDATE ecosystem_snapshots
           SET previous_version = current_version, current_version = ?, checked_at = ?
           WHERE check_type = ? AND package_name = ?`
        )
        .run(version, new Date().toISOString(), checkType, packageName);
    } else {
      knowledgeDb
        .prepare(
          "UPDATE ecosystem_snapshots SET checked_at = ? WHERE check_type = ? AND package_name = ?"
        )
        .run(new Date().toISOString(), checkType, packageName);
    }
  } else {
    knowledgeDb
      .prepare(
        `INSERT INTO ecosystem_snapshots (check_type, package_name, current_version, checked_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(checkType, packageName, version, new Date().toISOString());
  }
}

// --- Backfill pub_date from discovery.db ---
// WHAT: Copy pub_date from discovered_content into articles table
// WHY: pub_date wasn't carried through the pipeline until now — backfill existing articles
function backfillPubDates(knowledgeDb: InstanceType<typeof Database>): number {
  if (!existsSync(DISCOVERY_PATH)) return 0;

  const discoveryDb = new Database(DISCOVERY_PATH, { readonly: true });

  const tableCheck = discoveryDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovered_content'")
    .get();
  if (!tableCheck) { discoveryDb.close(); return 0; }

  const rows = discoveryDb
    .prepare(
      `SELECT url, pub_date FROM discovered_content
       WHERE pub_date IS NOT NULL AND pub_date != ''`
    )
    .all() as Array<{ url: string; pub_date: string }>;

  discoveryDb.close();

  if (rows.length === 0) return 0;

  const update = knowledgeDb.prepare(
    "UPDATE articles SET pub_date = ? WHERE (url = ? OR source_url = ?) AND pub_date IS NULL"
  );

  let updated = 0;
  const runAll = knowledgeDb.transaction(() => {
    for (const row of rows) {
      const result = update.run(row.pub_date, row.url, row.url);
      updated += result.changes;
    }
  });
  runAll();

  return updated;
}

// --- Check #1: Stale Content by Age ---
// WHAT: Flag articles where effective age exceeds 90 days
// WHY: Old content may have outdated info that hurts citation quality
function checkStaleContent(
  knowledgeDb: InstanceType<typeof Database>,
  alertDb: InstanceType<typeof Database>
): { alerts: Alert[]; staleCount: number; totalCount: number } {
  const totalRow = knowledgeDb
    .prepare("SELECT COUNT(*) as count FROM articles")
    .get() as { count: number };

  // WHAT: Use COALESCE priority: last_reviewed_at > pub_date > processed_at
  // WHY: If reviewed recently, that resets the clock. Otherwise use real pub date.
  const staleDate = new Date();
  staleDate.setDate(staleDate.getDate() - STALE_THRESHOLD_DAYS);
  const staleDateStr = staleDate.toISOString();

  const staleArticles = knowledgeDb
    .prepare(
      `SELECT title, url,
              COALESCE(last_reviewed_at, pub_date, processed_at) as effective_date
       FROM articles
       WHERE COALESCE(last_reviewed_at, pub_date, processed_at) IS NOT NULL
         AND COALESCE(last_reviewed_at, pub_date, processed_at) < ?
       ORDER BY COALESCE(last_reviewed_at, pub_date, processed_at) ASC`
    )
    .all(staleDateStr) as Array<{
    title: string;
    url: string;
    effective_date: string;
  }>;

  if (staleArticles.length === 0) {
    return { alerts: [], staleCount: 0, totalCount: totalRow.count };
  }

  // Update freshness_status for stale articles
  const markStale = knowledgeDb.prepare(
    "UPDATE articles SET freshness_status = 'review_needed' WHERE url = ? AND freshness_status = 'current'"
  );
  for (const article of staleArticles) {
    markStale.run(article.url);
  }

  const key = `stale-${staleArticles.length}`;
  if (wasRecentlyFired(alertDb, "stale_content", key)) {
    return { alerts: [], staleCount: staleArticles.length, totalCount: totalRow.count };
  }

  const now = Date.now();
  const articleList = staleArticles.slice(0, 10).map((a) => {
    const days = Math.floor(
      (now - new Date(a.effective_date).getTime()) / (1000 * 60 * 60 * 24)
    );
    return `  - ${a.title} (${days}d old)\n    ${a.url}`;
  });

  const alert: Alert = {
    type: "stale_content",
    severity: staleArticles.length >= 6 ? "critical" : "warning",
    title: `${staleArticles.length} articles need freshness review (${STALE_THRESHOLD_DAYS}d+ old)`,
    details: [
      `${staleArticles.length} of ${totalRow.count} articles are older than ${STALE_THRESHOLD_DAYS} days:`,
      ...articleList,
      staleArticles.length > 10 ? `  ... and ${staleArticles.length - 10} more` : "",
      "",
      "Action: Review and update stale articles, or mark as reviewed if still current.",
    ]
      .filter(Boolean)
      .join("\n"),
    data: {
      stale_count: staleArticles.length,
      total_count: totalRow.count,
      threshold_days: STALE_THRESHOLD_DAYS,
      articles: staleArticles.slice(0, 10).map((a) => ({
        title: a.title,
        url: a.url,
        effective_date: a.effective_date,
      })),
    },
  };

  recordAlert(alertDb, alert, key);
  return { alerts: [alert], staleCount: staleArticles.length, totalCount: totalRow.count };
}

// --- Check #2: npm Package Version Changes ---
// WHAT: Poll npm registry for version changes in tracked packages
// WHY: New MCP SDK versions may invalidate articles about MCP development
async function checkNpmVersions(
  knowledgeDb: InstanceType<typeof Database>,
  alertDb: InstanceType<typeof Database>
): Promise<Alert[]> {
  const alerts: Alert[] = [];

  for (const pkg of TRACKED_NPM_PACKAGES) {
    try {
      // WHAT: Use the dist-tags endpoint for minimal response size
      // WHY: Full package metadata can be megabytes — we only need the latest version
      const encodedPkg = pkg.replace("/", "%2f");
      const resp = await fetch(
        `https://registry.npmjs.org/-/package/${encodedPkg}/dist-tags`,
        { signal: AbortSignal.timeout(10_000) }
      );

      if (!resp.ok) {
        console.error(`  npm registry returned ${resp.status} for ${pkg}`);
        continue;
      }

      const tags = (await resp.json()) as Record<string, string>;
      const latestVersion = tags.latest;

      if (!latestVersion) continue;

      const existing = getSnapshot(knowledgeDb, "npm_version", pkg);
      upsertSnapshot(knowledgeDb, "npm_version", pkg, latestVersion);

      // WHAT: Don't alert on first detection (bootstrap)
      // WHY: Every package would trigger an alert on the first run
      if (!existing) {
        console.error(`  Bootstrapped ${pkg} at v${latestVersion}`);
        continue;
      }

      if (existing.current_version === latestVersion) continue;

      const key = `npm-${pkg}-${latestVersion}`;
      if (wasRecentlyFired(alertDb, "npm_version_change", key)) continue;

      // WHAT: Find articles that cover this package
      // WHY: Alert should list which content may need updating
      const affectedArticles = findArticlesByTopic(knowledgeDb, ["mcp", "model context protocol", "mcp server"]);

      const alert: Alert = {
        type: "npm_version_change",
        severity: "warning",
        title: `${pkg} updated: ${existing.current_version} → ${latestVersion}`,
        details: [
          `**Package:** ${pkg}`,
          `**Previous:** ${existing.current_version}`,
          `**Current:** ${latestVersion}`,
          `**npm:** https://www.npmjs.com/package/${pkg}`,
          "",
          affectedArticles.length > 0
            ? `**${affectedArticles.length} article(s) may need review:**`
            : "No directly related articles found.",
          ...affectedArticles.slice(0, 5).map((a) => `  - ${a.title}\n    ${a.url}`),
          "",
          "Action: Check changelog for breaking changes and update affected articles.",
        ].join("\n"),
        data: {
          package: pkg,
          previous_version: existing.current_version,
          current_version: latestVersion,
          affected_articles: affectedArticles.slice(0, 5),
        },
      };

      recordAlert(alertDb, alert, key);
      alerts.push(alert);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  npm check failed for ${pkg}: ${message}`);
    }
  }

  return alerts;
}

// --- Check #3: GitHub Release Version Changes ---
// WHAT: Poll GitHub releases API for version changes in tracked repos
// WHY: New Ollama/Open WebUI versions may require article updates
async function checkGitHubReleases(
  knowledgeDb: InstanceType<typeof Database>,
  alertDb: InstanceType<typeof Database>
): Promise<Alert[]> {
  const alerts: Alert[] = [];

  for (const { owner, repo, label } of TRACKED_GITHUB_REPOS) {
    try {
      const resp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
        {
          headers: { Accept: "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(10_000),
        }
      );

      if (!resp.ok) {
        // 404 = no releases, rate limit = 403
        if (resp.status === 403) {
          console.error(`  GitHub rate limit hit for ${owner}/${repo}`);
        } else {
          console.error(`  GitHub returned ${resp.status} for ${owner}/${repo}`);
        }
        continue;
      }

      const release = (await resp.json()) as {
        tag_name: string;
        html_url: string;
        published_at: string;
        name: string;
      };

      const version = release.tag_name;
      const packageKey = `${owner}/${repo}`;

      const existing = getSnapshot(knowledgeDb, "github_release", packageKey);
      upsertSnapshot(knowledgeDb, "github_release", packageKey, version);

      // Bootstrap: don't alert on first detection
      if (!existing) {
        console.error(`  Bootstrapped ${label} at ${version}`);
        continue;
      }

      if (existing.current_version === version) continue;

      const key = `github-${packageKey}-${version}`;
      if (wasRecentlyFired(alertDb, "github_release_change", key)) continue;

      // Find related articles by searching topics for the tool name
      const searchTerms = label.toLowerCase().split(/\s+/);
      const affectedArticles = findArticlesByTopic(knowledgeDb, searchTerms);

      const alert: Alert = {
        type: "github_release_change",
        severity: "info",
        title: `${label} released: ${existing.current_version} → ${version}`,
        details: [
          `**Repository:** ${owner}/${repo}`,
          `**Release:** ${release.name || version}`,
          `**Previous:** ${existing.current_version}`,
          `**Current:** ${version}`,
          `**URL:** ${release.html_url}`,
          `**Published:** ${release.published_at}`,
          "",
          affectedArticles.length > 0
            ? `**${affectedArticles.length} article(s) may need review:**`
            : "No directly related articles found.",
          ...affectedArticles.slice(0, 5).map((a) => `  - ${a.title}\n    ${a.url}`),
          "",
          "Action: Review release notes for changes that affect existing article content.",
        ].join("\n"),
        data: {
          repo: packageKey,
          label,
          previous_version: existing.current_version,
          current_version: version,
          release_url: release.html_url,
          affected_articles: affectedArticles.slice(0, 5),
        },
      };

      recordAlert(alertDb, alert, key);
      alerts.push(alert);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  GitHub check failed for ${owner}/${repo}: ${message}`);
    }
  }

  return alerts;
}

// --- Helper: Find articles by topic keywords ---
// WHAT: Search articles table for any whose title or content_type matches search terms
// WHY: Links ecosystem version changes to specific articles that may need updating
function findArticlesByTopic(
  knowledgeDb: InstanceType<typeof Database>,
  searchTerms: string[]
): Array<{ title: string; url: string }> {
  // Build a WHERE clause matching any search term in title (case-insensitive)
  const conditions = searchTerms.map(() => "LOWER(title) LIKE ?").join(" OR ");
  const params = searchTerms.map((t) => `%${t.toLowerCase()}%`);

  return knowledgeDb
    .prepare(
      `SELECT DISTINCT title, url FROM articles WHERE ${conditions} LIMIT 10`
    )
    .all(...params) as Array<{ title: string; url: string }>;
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

  const embeds = alerts.slice(0, 10).map((alert) => ({
    title: `${severityEmoji(alert.severity)} ${alert.title}`,
    description: alert.details,
    color: severityColor(alert.severity),
    footer: { text: `Freshness check: ${alert.type}` },
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
    console.error(`${alerts.length} freshness alert(s) sent to Discord.`);
  }
}

// --- CLI ---
function parseArgs(): { sendToDiscord: boolean } {
  const args = process.argv.slice(2);
  return { sendToDiscord: args.includes("--discord") };
}

async function main() {
  const { sendToDiscord } = parseArgs();

  console.error("=== ASTGL Content Freshness Checker ===\n");

  if (!existsSync(KNOWLEDGE_PATH)) {
    console.error("knowledge.db not found. Run 'npm run ingest' first.");
    process.exit(1);
  }

  // WHAT: Use initKnowledgeDb to run schema migrations (adds pub_date, freshness_status, etc.)
  // WHY: The new columns won't exist until migrations run
  const knowledgeDb = initKnowledgeDb();
  const alertDb = initAlertDb();

  // Ensure ecosystem_snapshots table exists (also created by migration, but safe to re-run)
  initEcosystemTable(knowledgeDb);

  // Backfill pub_date from discovery.db (idempotent)
  console.error("Backfilling pub_date from discovery.db...");
  const backfilled = backfillPubDates(knowledgeDb);
  if (backfilled > 0) {
    console.error(`  Updated ${backfilled} article(s) with pub_date\n`);
  } else {
    console.error("  No articles needed backfill\n");
  }

  const checksRun: string[] = [];
  const allAlerts: Alert[] = [];
  const ecosystemVersions: FreshnessReport["ecosystem_versions"] = [];

  // Check #1: Stale content
  console.error("Checking: stale content (90+ days)...");
  checksRun.push("stale_content");
  const { alerts: staleAlerts, staleCount, totalCount } = checkStaleContent(
    knowledgeDb,
    alertDb
  );
  allAlerts.push(...staleAlerts);
  console.error(`  ${staleCount} of ${totalCount} articles are stale\n`);

  // Check #2: npm version changes
  console.error("Checking: npm package versions...");
  checksRun.push("npm_version_check");
  const npmAlerts = await checkNpmVersions(knowledgeDb, alertDb);
  allAlerts.push(...npmAlerts);
  console.error(`  ${npmAlerts.length} version change(s) detected\n`);

  // Collect ecosystem versions for report
  for (const pkg of TRACKED_NPM_PACKAGES) {
    const snap = getSnapshot(knowledgeDb, "npm_version", pkg);
    if (snap) {
      ecosystemVersions.push({
        package: pkg,
        version: snap.current_version,
        type: "npm",
      });
    }
  }

  // Check #3: GitHub release changes
  console.error("Checking: GitHub releases...");
  checksRun.push("github_release_check");
  const ghAlerts = await checkGitHubReleases(knowledgeDb, alertDb);
  allAlerts.push(...ghAlerts);
  console.error(`  ${ghAlerts.length} release change(s) detected\n`);

  // Collect GitHub versions for report
  for (const { owner, repo, label } of TRACKED_GITHUB_REPOS) {
    const snap = getSnapshot(knowledgeDb, "github_release", `${owner}/${repo}`);
    if (snap) {
      ecosystemVersions.push({
        package: label,
        version: snap.current_version,
        type: "github",
      });
    }
  }

  knowledgeDb.close();
  alertDb.close();

  const report: FreshnessReport = {
    generated_at: new Date().toISOString(),
    alerts_fired: allAlerts,
    alerts_suppressed: 0,
    checks_run: checksRun,
    ecosystem_versions: ecosystemVersions,
    stale_articles: staleCount,
    total_articles: totalCount,
  };

  console.log(JSON.stringify(report, null, 2));

  if (sendToDiscord && allAlerts.length > 0) {
    await sendAlertsToDiscord(allAlerts);
  } else if (sendToDiscord && allAlerts.length === 0) {
    console.error("No freshness alerts to send.");
  }

  console.error(
    `\n=== Done: ${allAlerts.length} alert(s) fired ===`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Freshness checker failed:", err);
    process.exit(1);
  });
