#!/usr/bin/env tsx
/**
 * Publish a rewrite job to Substack as a draft.
 *
 * WHAT: Shells out to the existing sync_to_substack.py against the job's draft
 *       path, captures the resulting Substack draft URL, marks the article
 *       reviewed (resets the freshness clock), and updates the job row.
 *
 * WHY:  Called by the claudeclaw bot's astgl-rw:approve handler so the bot
 *       process never needs to know the substack-sync internals or own
 *       knowledge.db transactions.
 *
 * Usage:
 *   node dist/publish-rewrite.js --job <id>
 *
 * Output: JSON to stdout with shape
 *   { ok: true, job_id, substack_url, article_url }
 *   { ok: false, job_id, error }
 */

import "dotenv/config";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { initKnowledgeDb, updateFreshnessStatus } from "./knowledge-db.js";
import { getJob, markPublished, markFailed } from "./db-rewrite-jobs.js";

const SUBSTACK_SYNC_DIR = join(
  homedir(),
  "Projects",
  "macstudio-openclaw-localllm",
  "scripts",
  "substack-sync"
);
const SUBSTACK_SYNC_SCRIPT = join(SUBSTACK_SYNC_DIR, "sync_to_substack.py");

interface ParsedFrontmatter {
  description: string | null;
}

function parseFrontmatterDescription(draftPath: string): ParsedFrontmatter {
  if (!existsSync(draftPath)) return { description: null };
  const text = readFileSync(draftPath, "utf-8");
  if (!text.startsWith("---")) return { description: null };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { description: null };
  const frontmatter = text.slice(3, end);
  const match = frontmatter.match(/^description:\s*"?([^"\n]*?)"?\s*$/m);
  return { description: match ? match[1] : null };
}

function runSubstackSync(
  draftPath: string,
  subtitle: string | null
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const args = [SUBSTACK_SYNC_SCRIPT, draftPath];
    if (subtitle) args.push("--subtitle", subtitle);
    const child = spawn("python3", args, {
      cwd: SUBSTACK_SYNC_DIR,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout, stderr, code: code ?? -1 })
    );
  });
}

function extractSubstackUrl(stdout: string): string | null {
  const match = stdout.match(/URL:\s*(https?:\/\/\S+)/);
  return match ? match[1] : null;
}

interface CliFlags {
  jobId: number;
}

function parseArgs(): CliFlags {
  const args = process.argv.slice(2);
  let jobId = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--job") {
      jobId = parseInt(args[++i] ?? "0", 10);
    }
  }
  if (!jobId) {
    console.error("usage: publish-rewrite.js --job <id>");
    process.exit(1);
  }
  return { jobId };
}

async function main(): Promise<void> {
  const { jobId } = parseArgs();
  const db = initKnowledgeDb();

  const job = getJob(db, jobId);
  if (!job) {
    db.close();
    console.log(JSON.stringify({ ok: false, job_id: jobId, error: "job not found" }));
    process.exit(1);
  }
  if (!job.draft_path || !existsSync(job.draft_path)) {
    const err = `draft missing: ${job.draft_path ?? "(null)"}`;
    markFailed(db, jobId, err);
    db.close();
    console.log(JSON.stringify({ ok: false, job_id: jobId, error: err }));
    process.exit(1);
  }
  if (job.status !== "pending_approval") {
    db.close();
    console.log(
      JSON.stringify({
        ok: false,
        job_id: jobId,
        error: `job status is ${job.status}, expected pending_approval`,
      })
    );
    process.exit(1);
  }

  const { description } = parseFrontmatterDescription(job.draft_path);
  console.error(`publishing job #${jobId} (${job.draft_path})`);

  const result = await runSubstackSync(job.draft_path, description);
  if (result.code !== 0) {
    const err = `sync_to_substack exited ${result.code}: ${result.stderr.slice(0, 500)}`;
    markFailed(db, jobId, err);
    db.close();
    console.log(JSON.stringify({ ok: false, job_id: jobId, error: err }));
    process.exit(1);
  }

  const substackUrl = extractSubstackUrl(result.stdout);
  if (!substackUrl) {
    const err = `no Substack URL in sync output: ${result.stdout.slice(-300)}`;
    markFailed(db, jobId, err);
    db.close();
    console.log(JSON.stringify({ ok: false, job_id: jobId, error: err }));
    process.exit(1);
  }

  // Reset the article's freshness clock — it's now reviewed via this rewrite,
  // even though publication is technically still manual on Substack.
  updateFreshnessStatus(db, job.article_url, "current", new Date().toISOString());
  markPublished(db, jobId, substackUrl);

  db.close();
  console.log(
    JSON.stringify({
      ok: true,
      job_id: jobId,
      substack_url: substackUrl,
      article_url: job.article_url,
    })
  );
}

main().catch((err) => {
  console.error("publish-rewrite failed:", err);
  console.log(
    JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
  );
  process.exit(1);
});
