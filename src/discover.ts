#!/usr/bin/env tsx
/**
 * Content Discovery script.
 * Polls ASTGL site RSS, Substack RSS, and ASTGL sitemap.xml to detect new content.
 * Stores discovered metadata in SQLite with dedup via URL + content hash.
 *
 * Usage: npm run discover
 * Designed to run as OpenClaw cron job (every 6 hours).
 */

import { createHash } from "crypto";
import Parser from "rss-parser";
import { initDb, upsertItem, closeDb } from "./discovery-db.js";
import type { DiscoveredItem, UpsertResult } from "./discovery-db.js";

const ASTGL_RSS_URL =
  process.env.ASTGL_RSS_URL || "https://astgl.ai/rss.xml";
const SUBSTACK_RSS_URL =
  process.env.SUBSTACK_RSS_URL || "https://astgl.substack.com/feed";
const ASTGL_SITEMAP_URL =
  process.env.ASTGL_SITEMAP_URL || "https://astgl.ai/sitemap-0.xml";

interface SourceResult {
  fetched: number;
  new: number;
  updated: number;
  skipped: number;
  errors: number;
}

interface DiscoverySummary {
  timestamp: string;
  sources: Record<string, SourceResult>;
  totals: { new: number; updated: number; skipped: number };
}

// WHAT: Generate SHA-256 hash for content dedup
// WHY: Detects when content at a URL changes (title/description updated)
function contentHash(
  title: string | null,
  description: string | null,
  url: string
): string {
  const input = `${title || ""}|${description || ""}|${url}`;
  return createHash("sha256").update(input).digest("hex");
}

// WHAT: Fetch and parse an RSS feed into DiscoveredItems
// WHY: rss-parser handles RSS 2.0, Atom, and edge cases cleanly
async function fetchRss(
  url: string,
  source: DiscoveredItem["source"]
): Promise<DiscoveredItem[]> {
  const parser = new Parser();
  const feed = await parser.parseURL(url);

  return (feed.items || []).map((item) => {
    const itemUrl = item.link || item.guid || "";
    const title = item.title || null;
    const description =
      item.contentSnippet || item.content || item.summary || null;
    const pubDate = item.isoDate || item.pubDate || null;

    return {
      url: itemUrl,
      title,
      description: description ? description.slice(0, 500) : null,
      pubDate,
      source,
      contentHash: contentHash(title, description, itemUrl),
    };
  });
}

// WHAT: Fetch sitemap.xml and extract URLs
// WHY: Simple regex is sufficient for well-structured <loc> tags
async function fetchSitemap(url: string): Promise<DiscoveredItem[]> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Sitemap fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const xml = await resp.text();
  const urls: string[] = [];
  const locRegex = /<loc>(.*?)<\/loc>/g;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    urls.push(match[1]);
  }

  return urls.map((itemUrl) => ({
    url: itemUrl,
    title: null,
    description: null,
    pubDate: null,
    source: "astgl-sitemap" as const,
    contentHash: contentHash(null, null, itemUrl),
  }));
}

// WHAT: Upsert a batch of discovered items and tally results
// WHY: Wraps upsert calls with counting for the summary report
function processItems(
  db: ReturnType<typeof initDb>,
  items: DiscoveredItem[]
): SourceResult {
  const result: SourceResult = {
    fetched: items.length,
    new: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
  };

  const upsertAll = db.transaction(() => {
    for (const item of items) {
      if (!item.url) {
        result.errors++;
        continue;
      }
      const status: UpsertResult = upsertItem(db, item);
      result[status]++;
    }
  });

  upsertAll();
  return result;
}

async function main() {
  const db = initDb();
  console.error("Content discovery started");

  const summary: DiscoverySummary = {
    timestamp: new Date().toISOString(),
    sources: {},
    totals: { new: 0, updated: 0, skipped: 0 },
  };

  // WHAT: Define sources to fetch — each source is independent
  // WHY: If one fails, the others still run (cron resilience)
  const sources: Array<{
    name: string;
    fetch: () => Promise<DiscoveredItem[]>;
  }> = [
    {
      name: "astgl-rss",
      fetch: () => fetchRss(ASTGL_RSS_URL, "astgl-rss"),
    },
    {
      name: "substack-rss",
      fetch: () => fetchRss(SUBSTACK_RSS_URL, "substack-rss"),
    },
    {
      name: "astgl-sitemap",
      fetch: () => fetchSitemap(ASTGL_SITEMAP_URL),
    },
  ];

  for (const source of sources) {
    try {
      console.error(`  Fetching ${source.name}...`);
      const items = await source.fetch();
      const result = processItems(db, items);
      summary.sources[source.name] = result;
      console.error(
        `  ${source.name}: ${result.fetched} fetched, ${result.new} new, ${result.updated} updated`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${source.name} failed: ${message}`);
      summary.sources[source.name] = {
        fetched: 0,
        new: 0,
        updated: 0,
        skipped: 0,
        errors: 1,
      };
    }
  }

  // Compute totals
  for (const result of Object.values(summary.sources)) {
    summary.totals.new += result.new;
    summary.totals.updated += result.updated;
    summary.totals.skipped += result.skipped;
  }

  // JSON summary to stdout for OpenClaw logging
  console.log(JSON.stringify(summary, null, 2));

  closeDb();
  console.error("Content discovery complete");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Discovery failed:", err);
    process.exit(1);
  });
