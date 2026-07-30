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
 *   4. Publish gap — compares local publishable content against what this package
 *      actually serves on npm (see publish-drift.ts, ADR-0001)
 *
 * Checks 1–3 watch the ECOSYSTEM for staleness; check 4 watches THIS package. They
 * share a script because they share the cooldown table and the Discord delivery
 * path, and because "what we serve is out of date" is one question whether the
 * staleness is in the articles or in the tarball.
 *
 * Usage:
 *   npm run freshness                       Check all, print to stdout (JSON)
 *   npm run freshness -- --discord          Also send triggered alerts to Discord
 *   npm run freshness -- --only publish_gap Run a subset of checks
 *   npm run publish-drift                   Shorthand for --only publish_gap
 *   npm run freshness -- --skip-tarball     Skip the 4.7 MB registry tarball download
 *
 * Env: DISCORD_WEBHOOK_URL — Discord webhook for alert delivery
 */

import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import Database from "better-sqlite3";
import {
  initKnowledgeDb,
  getStaleArticles,
  getSnapshot,
  upsertSnapshot,
} from "./knowledge-db.js";
import { runPublishGapCheck, publishGapAlertKey } from "./publish-drift.js";
import type { PublishDrift } from "./publish-drift.js";

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

// WHAT: Every check this script knows how to run, in execution order.
// WHY:  Named so `--only` can select a subset and the summary can report which
//       checks actually ran. A check that was skipped must never look like a check
//       that ran and found nothing.
const ALL_CHECKS = [
  "stale_content",
  "npm_version_check",
  "github_release_check",
  "publish_gap",
] as const;

type CheckName = (typeof ALL_CHECKS)[number];

// --- Types ---
interface Alert {
  type:
    | "stale_content"
    | "npm_version_change"
    | "github_release_change"
    | "publish_gap";
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
  checks_skipped: string[];
  ecosystem_versions: Array<{ package: string; version: string; type: string }>;
  stale_articles: number | null;
  total_articles: number | null;
  publish_drift: PublishDrift | null;
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
// WHAT: getSnapshot/upsertSnapshot now live in knowledge-db.ts.
// WHY:  This module used to carry its own CREATE TABLE for ecosystem_snapshots
//       alongside the one in runMigrations(), plus private copies of both helpers.
//       `CREATE TABLE IF NOT EXISTS` never errors, so the two definitions could
//       drift silently (Mistake #8) — and publish-drift.ts needs the same helpers,
//       which would have made three copies. The table is declared once in
//       runMigrations(); the accessors are imported above.

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
  // Shared helper — also used by rewrite-queue.ts so both stay in lockstep.
  const staleArticles = getStaleArticles(knowledgeDb, STALE_THRESHOLD_DAYS);

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
interface Flags {
  sendToDiscord: boolean;
  checks: Set<CheckName>;
  skipTarball: boolean;
}

// WHAT: Hand-rolled argv scan, matching the convention in every other script here.
// WHY:  `--only` takes a comma-separated list of check names. An unrecognised name
//       is a hard error rather than a silent no-op: a typo'd filter that quietly
//       runs zero checks and reports "0 alerts" is the false all-clear this repo
//       has been bitten by before.
function parseArgs(): Flags {
  const args = process.argv.slice(2);

  const onlyIdx = args.indexOf("--only");
  let checks = new Set<CheckName>(ALL_CHECKS);

  if (onlyIdx >= 0) {
    const raw = args[onlyIdx + 1];
    if (!raw || raw.startsWith("--")) {
      console.error(`--only requires a check name. Valid: ${ALL_CHECKS.join(", ")}`);
      process.exit(1);
    }
    const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
    // WHY: `--only ,` or `--only " "` reduces to an empty list, which then passes
    //      the unknown-name check vacuously and runs ZERO checks while exiting 0 —
    //      the silent no-op this validation exists to prevent, arrived at from the
    //      other direction.
    if (requested.length === 0) {
      console.error(
        `--only requires at least one check name. Valid: ${ALL_CHECKS.join(", ")}`
      );
      process.exit(1);
    }
    const unknown = requested.filter(
      (name) => !(ALL_CHECKS as readonly string[]).includes(name)
    );
    if (unknown.length > 0) {
      console.error(
        `Unknown check(s): ${unknown.join(", ")}. Valid: ${ALL_CHECKS.join(", ")}`
      );
      process.exit(1);
    }
    checks = new Set(requested as CheckName[]);
  }

  return {
    sendToDiscord: args.includes("--discord"),
    checks,
    skipTarball: args.includes("--skip-tarball"),
  };
}

async function main() {
  const { sendToDiscord, checks, skipTarball } = parseArgs();

  console.error("=== ASTGL Content Freshness Checker ===\n");
  if (checks.size !== ALL_CHECKS.length) {
    console.error(`  [--only ${[...checks].join(",")}]\n`);
  }

  if (!existsSync(KNOWLEDGE_PATH)) {
    console.error("knowledge.db not found. Run 'npm run ingest' first.");
    process.exit(1);
  }

  // WHAT: Use initKnowledgeDb to run schema migrations (adds pub_date, freshness_status, etc.)
  // WHY: The new columns won't exist until migrations run
  const knowledgeDb = initKnowledgeDb();
  const alertDb = initAlertDb();

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

  // WHAT: null, not 0, when the check did not run.
  // WHY:  "0 stale articles" and "we never looked" are different facts. Reporting
  //       the second as the first is how a skipped check reads as a clean bill.
  let staleCount: number | null = null;
  let totalCount: number | null = null;
  let publishDrift: PublishDrift | null = null;

  // Check #1: Stale content
  if (checks.has("stale_content")) {
    console.error("Checking: stale content (90+ days)...");
    checksRun.push("stale_content");
    const result = checkStaleContent(knowledgeDb, alertDb);
    allAlerts.push(...result.alerts);
    staleCount = result.staleCount;
    totalCount = result.totalCount;
    console.error(`  ${staleCount} of ${totalCount} articles are stale\n`);
  }

  // Check #2: npm version changes
  if (checks.has("npm_version_check")) {
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
  }

  // Check #3: GitHub release changes
  if (checks.has("github_release_check")) {
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
  }

  // Check #4: Publish gap — local publishable content vs what npm actually serves
  if (checks.has("publish_gap")) {
    console.error("Checking: publish gap (local vs npm registry)...");
    checksRun.push("publish_gap");
    const { drift, alert } = await runPublishGapCheck(knowledgeDb, { skipTarball });
    publishDrift = drift;

    if (drift.content_measured) {
      console.error(
        `  local ${drift.local_public_articles} publishable vs published ${drift.published_articles}` +
          ` (${drift.published_version}, ${drift.days_since_last_publish}d ago)` +
          ` → delta ${drift.articles_delta}` +
          (drift.measurement_from_cache ? " [cached]" : "")
      );
    } else {
      console.error(`  NOT MEASURED — ${drift.unmeasured_reason}`);
    }

    // WHY: Cooldown is applied here rather than inside publish-drift.ts so the
    //      suppression rules stay in one place across all four checks.
    if (alert) {
      const key = publishGapAlertKey(drift);
      if (wasRecentlyFired(alertDb, "publish_gap", key)) {
        console.error(`  alert suppressed by cooldown (${key})\n`);
      } else {
        recordAlert(alertDb, alert, key);
        allAlerts.push(alert);
        console.error(`  alert fired: ${alert.severity}\n`);
      }
    } else {
      console.error("  no publish gap\n");
    }

    // Surface the published version alongside the ecosystem readings.
    if (drift.published_version) {
      ecosystemVersions.push({
        package: drift.package,
        version: drift.published_version,
        type: "npm-self",
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
    checks_skipped: ALL_CHECKS.filter((c) => !checks.has(c)),
    ecosystem_versions: ecosystemVersions,
    stale_articles: staleCount,
    total_articles: totalCount,
    publish_drift: publishDrift,
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
