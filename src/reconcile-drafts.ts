#!/usr/bin/env tsx
/**
 * Draft reconciler.
 *
 * WHAT: Retires (hard-deletes) draft entries from knowledge.db whose source
 *       folder under astgl-articles/substack/ has been removed or renamed with
 *       a Published_* prefix — meaning the user has shipped the piece and the
 *       draft index entry is now stale.
 * WHY:  Without this, MCP search returns the same content twice (draft + the
 *       eventual published article) and may cite the rough draft text instead
 *       of the polished published version.
 *
 * Match strategy: source-existence (Option A from the design discussion).
 *   - draft URL: local://astgl-articles/draft/<folder-name>
 *   - retire if <DRAFTS_DIR>/<folder-name>/article.md is missing
 *   - retire if a Published_*-prefixed sibling exists matching the date+slug
 *
 * The topic ledger (local://astgl-articles/topic-ledger) is excluded.
 *
 * Usage:
 *   npm run reconcile-drafts                # live run
 *   npm run reconcile-drafts -- --dry-run   # show what would be retired
 *   npm run reconcile-drafts -- --no-backup # skip the pre-run DB backup
 *
 * Env: ASTGL_DRAFTS_DIR — substack drafts root (default: ~/Projects/astgl-articles/substack)
 */

import { existsSync, readdirSync, copyFileSync } from "fs";
import { join, basename } from "path";
import Database from "better-sqlite3";
import { initKnowledgeDb, deleteArticle, closeKnowledgeDb } from "./knowledge-db.js";

const DRAFTS_DIR =
  process.env.ASTGL_DRAFTS_DIR ||
  "/Volumes/Research/ASTGL Articles/Drafts";

const DB_PATH = join(import.meta.dirname, "..", "data", "knowledge.db");
const DRAFT_URL_PREFIX = "local://astgl-articles/draft/";
const TOPIC_LEDGER_URL = "local://astgl-articles/topic-ledger";
const DATE_SLUG_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

interface DraftRow {
  url: string;
  title: string;
  slug: string;
}

interface RetirementCandidate {
  url: string;
  title: string;
  folderName: string;
  reason: "folder-missing" | "renamed-published" | "url-malformed";
  publishedFolder?: string;
}

function parseArgs(argv: string[]): { dryRun: boolean; backup: boolean } {
  return {
    dryRun: argv.includes("--dry-run"),
    backup: !argv.includes("--no-backup"),
  };
}

function listSiblingFolders(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root);
}

// WHAT: Decide whether a draft folder still represents a live, unpublished draft
// WHY: The drafts ingester filters out `published_*` (lowercase) prefixes, so
//      anything renamed/moved to `Published_*` is implicitly retired upstream.
//      We mirror that filter here, plus the explicit existence check.
function classifyDraft(
  folderName: string,
  siblings: string[],
  draftsRoot: string
): RetirementCandidate["reason"] | null {
  const liveFolder = join(draftsRoot, folderName, "article.md");
  if (existsSync(liveFolder)) {
    return null;
  }

  const match = folderName.match(DATE_SLUG_RE);
  if (!match) {
    return "url-malformed";
  }

  const lowerFolder = folderName.toLowerCase();
  const renamedSibling = siblings.find((s) => {
    const lower = s.toLowerCase();
    return (
      lower.startsWith("published_") &&
      lower.includes(lowerFolder)
    );
  });

  if (renamedSibling) {
    return "renamed-published";
  }

  return "folder-missing";
}

function findRenamedSibling(
  folderName: string,
  siblings: string[]
): string | undefined {
  const lowerFolder = folderName.toLowerCase();
  return siblings.find((s) => {
    const lower = s.toLowerCase();
    return lower.startsWith("published_") && lower.includes(lowerFolder);
  });
}

function backupDatabase(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${DB_PATH}.bak.pre-reconcile-${stamp}`;
  copyFileSync(DB_PATH, dest);
  return dest;
}

async function main() {
  const { dryRun, backup } = parseArgs(process.argv.slice(2));

  console.error("=== ASTGL Draft Reconciler ===");
  console.error(`Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);
  console.error(`Drafts root: ${DRAFTS_DIR}`);
  console.error(`DB: ${DB_PATH}\n`);

  if (!existsSync(DB_PATH)) {
    console.error(`Knowledge database not found at ${DB_PATH}`);
    process.exit(1);
  }

  // WHAT: Refuse to reconcile if the drafts root is missing entirely.
  // WHY: The archive lives on an external volume (/Volumes/Research). If that
  //      drive is unmounted when this runs, every folder would look "missing"
  //      and ALL drafts would be hard-deleted. Aborting is the safe default —
  //      a genuinely empty/removed root should be handled deliberately, not by
  //      a 2am cron firing against an unmounted disk.
  if (!existsSync(DRAFTS_DIR)) {
    console.error(
      `Drafts root not found: ${DRAFTS_DIR}\n` +
        `Refusing to reconcile — the volume may be unmounted. No rows deleted.\n` +
        `If the drafts directory has genuinely moved, set ASTGL_DRAFTS_DIR or update the default.`
    );
    process.exit(1);
  }

  const db = initKnowledgeDb();

  const drafts = db
    .prepare(
      `SELECT url, title, slug FROM articles
       WHERE content_type = 'draft' AND url LIKE ? AND url != ?`
    )
    .all(`${DRAFT_URL_PREFIX}%`, TOPIC_LEDGER_URL) as DraftRow[];

  console.error(`Examining ${drafts.length} draft entries\n`);

  const siblings = listSiblingFolders(DRAFTS_DIR);

  // WHAT: Refuse to reconcile if the DB has drafts but the mounted root is empty.
  // WHY:  existsSync(DRAFTS_DIR) passing is not enough — a mounted-but-empty root
  //       (wrong path, partial mount, or a genuinely emptied dir) makes every draft
  //       look "missing", so a live run would hard-delete ALL of them. Aborting is
  //       the safe default; a real full clear-out should be handled deliberately.
  if (drafts.length > 0 && siblings.length === 0) {
    console.error(
      `Drafts root ${DRAFTS_DIR} contains no folders, but the DB has ${drafts.length} draft(s).\n` +
        `Refusing to reconcile — this would retire every draft. No rows deleted.\n` +
        `If the archive was genuinely emptied, handle it deliberately rather than via this sweep.`
    );
    process.exit(1);
  }

  const candidates: RetirementCandidate[] = [];

  for (const draft of drafts) {
    const folderName = draft.url.slice(DRAFT_URL_PREFIX.length);
    const reason = classifyDraft(folderName, siblings, DRAFTS_DIR);
    if (reason) {
      candidates.push({
        url: draft.url,
        title: draft.title,
        folderName,
        reason,
        publishedFolder:
          reason === "renamed-published"
            ? findRenamedSibling(folderName, siblings)
            : undefined,
      });
    }
  }

  if (candidates.length === 0) {
    console.error("Nothing to retire — all draft folders still present.\n");
    closeKnowledgeDb();
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        mode: dryRun ? "dry-run" : "live",
        examined: drafts.length,
        retired: [],
        backup_path: null,
      })
    );
    return;
  }

  console.error(`Candidates for retirement: ${candidates.length}`);
  for (const c of candidates) {
    const extra = c.publishedFolder ? ` → ${c.publishedFolder}` : "";
    console.error(`  - ${c.url}  [${c.reason}]${extra}`);
    console.error(`      title: ${c.title}`);
  }
  console.error("");

  if (dryRun) {
    console.error("DRY RUN — no rows deleted.\n");
    closeKnowledgeDb();
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        mode: "dry-run",
        examined: drafts.length,
        retired: candidates.map((c) => ({
          url: c.url,
          title: c.title,
          reason: c.reason,
          published_folder: c.publishedFolder ?? null,
        })),
        backup_path: null,
      })
    );
    return;
  }

  let backupPath: string | null = null;
  let workingDb: InstanceType<typeof Database> = db;
  if (backup) {
    closeKnowledgeDb();
    backupPath = backupDatabase();
    console.error(`Backed up DB → ${backupPath}\n`);
    workingDb = initKnowledgeDb();
  }

  const retired: Array<{
    url: string;
    title: string;
    reason: string;
    chunks_deleted: number;
    qa_deleted: number;
  }> = [];

  for (const c of candidates) {
    const result = deleteArticle(workingDb, c.url);
    console.error(
      `  retired ${c.url} — chunks: ${result.chunksDeleted}, qa: ${result.qaDeleted}, article: ${result.articleDeleted}`
    );
    retired.push({
      url: c.url,
      title: c.title,
      reason: c.reason,
      chunks_deleted: result.chunksDeleted,
      qa_deleted: result.qaDeleted,
    });
  }

  closeKnowledgeDb();

  console.error(`\n=== Done: ${retired.length} draft(s) retired ===`);

  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      mode: "live",
      examined: drafts.length,
      retired,
      backup_path: backupPath,
    })
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Reconcile failed:", err);
    process.exit(1);
  });
