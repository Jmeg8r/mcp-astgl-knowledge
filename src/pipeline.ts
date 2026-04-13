#!/usr/bin/env tsx
/**
 * Unified content pipeline: Discovery → Structuring → Indexed.
 *
 * WHAT: Runs discover.ts then structure.ts in sequence with smart skipping
 * WHY: Single entry point for the full publish → queryable pipeline,
 *       skips structuring when no new content saves LLM compute
 *
 * Usage: npm run pipeline
 * Designed to run as a single OpenClaw cron job (every 6 hours).
 */

import { execSync } from "child_process";
import { join } from "path";

const PROJECT_DIR = join(import.meta.dirname, "..");

interface DiscoverySummary {
  timestamp: string;
  sources: Record<
    string,
    { fetched: number; new: number; updated: number; skipped: number; errors: number }
  >;
  totals: { new: number; updated: number; skipped: number };
}

interface StructuringSummary {
  timestamp: string;
  processed: number;
  failed: number;
  skipped: number;
  articles: Array<{ url: string; title: string; status: string }>;
}

interface PipelineSummary {
  timestamp: string;
  discovery: DiscoverySummary | { error: string };
  structuring: StructuringSummary | { skipped: true; reason: string } | { error: string };
  duration_ms: number;
}

// WHAT: Run a script and capture its JSON stdout
// WHY: Each step is its own process — isolates DB handles and crashes
function runStep(script: string): string {
  return execSync(`tsx ${script}`, {
    cwd: PROJECT_DIR,
    encoding: "utf-8",
    // WHAT: Pipe stdout (JSON) back, let stderr flow to console
    // WHY: stderr has progress logs, stdout has the structured summary
    stdio: ["pipe", "pipe", "inherit"],
    timeout: 300_000, // 5 min per step
  });
}

async function main() {
  const pipelineStart = performance.now();
  console.error("=== Content Pipeline Started ===\n");

  const summary: PipelineSummary = {
    timestamp: new Date().toISOString(),
    discovery: { error: "not run" },
    structuring: { skipped: true, reason: "not run" },
    duration_ms: 0,
  };

  // --- Step 1: Discovery ---
  console.error("--- Step 1: Content Discovery ---");
  let newItems = 0;

  try {
    const discoveryOutput = runStep("src/discover.ts");
    const discoveryResult: DiscoverySummary = JSON.parse(discoveryOutput);
    summary.discovery = discoveryResult;
    newItems = discoveryResult.totals.new;
    console.error(
      `\nDiscovery complete: ${newItems} new, ${discoveryResult.totals.updated} updated, ${discoveryResult.totals.skipped} skipped\n`
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nDiscovery FAILED: ${message}\n`);
    summary.discovery = { error: message };
  }

  // --- Step 2: Structuring (conditional) ---
  if (newItems > 0) {
    console.error("--- Step 2: Content Structuring ---");
    try {
      const structuringOutput = runStep("src/structure.ts");
      const structuringResult: StructuringSummary = JSON.parse(structuringOutput);
      summary.structuring = structuringResult;
      console.error(
        `\nStructuring complete: ${structuringResult.processed} processed, ${structuringResult.failed} failed\n`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`\nStructuring FAILED: ${message}\n`);
      summary.structuring = { error: message };
    }
  } else if ("error" in summary.discovery) {
    console.error("--- Step 2: Skipped (discovery failed) ---\n");
    summary.structuring = { skipped: true, reason: "discovery failed" };
  } else {
    console.error("--- Step 2: Skipped (no new content) ---\n");
    summary.structuring = { skipped: true, reason: "no new content discovered" };
  }

  summary.duration_ms = Math.round(performance.now() - pipelineStart);
  console.error(
    `=== Content Pipeline Complete (${(summary.duration_ms / 1000).toFixed(1)}s) ===`
  );

  // JSON summary to stdout for OpenClaw logging
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error("Pipeline fatal error:", err);
  process.exit(1);
});
