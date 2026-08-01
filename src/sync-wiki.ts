#!/usr/bin/env tsx
/**
 * SecondBrain wiki sync.
 *
 * WHAT: Reads ASTGL-tagged concept/entity/synthesis pages from the SecondBrain
 *       Obsidian vault and indexes them into knowledge.db as searchable content.
 * WHY:  The wiki contains pre-compiled, cross-referenced knowledge that improves
 *       the MCP server's ability to answer conceptual and entity questions.
 *
 * Usage:
 *   npm run sync-wiki            # incremental (skip unchanged files)
 *   npm run sync-wiki -- --full  # re-process all files
 *   npm run sync-wiki -- --dry-run  # list changes without touching DB
 *
 * Env: WIKI_ROOT  — path to wiki dir (default: /Volumes/Research/Brain/SecondBrain/wiki)
 *      OLLAMA_URL — Ollama endpoint (default: http://localhost:11434)
 *      EMBED_MODEL — embedding model (default: nomic-embed-text)
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "fs";
import { join, basename } from "path";
import {
  initKnowledgeDb,
  upsertArticle,
  replaceChunksForArticle,
  deleteArticle,
  closeKnowledgeDb,
} from "./knowledge-db.js";
import type { StructuredArticle, Chunk, ContentType } from "./types.js";
import { isPublic } from "./public-allowlist.js";

const WIKI_ROOT =
  process.env.WIKI_ROOT ||
  "/Volumes/Research/Brain/SecondBrain/wiki";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const SYNC_STATE_PATH = join(import.meta.dirname, "..", "data", "wiki-sync-state.json");

const WIKI_DIRS: Array<{ dir: string; type: ContentType }> = [
  { dir: "concepts", type: "concept" },
  { dir: "entities", type: "entity" },
  { dir: "syntheses", type: "synthesis" },
];

const FLAGS = {
  full: process.argv.includes("--full"),
  dryRun: process.argv.includes("--dry-run"),
  // WHAT: Re-apply the publication gate to already-indexed wiki rows and exit.
  // WHY:  Sync is mtime-incremental, so an unchanged page is never re-processed
  //       and would keep whatever `public` value it had — including the
  //       fail-closed 0 every pre-gate row starts with. Editing
  //       public-allowlist.ts must be able to re-gate the corpus WITHOUT
  //       re-embedding 931 chunks to change a boolean.
  reclassify: process.argv.includes("--reclassify"),
};

// --- Sync State ---

interface SyncFileEntry {
  mtime: string;
  sourceFile: string;
}

interface SyncState {
  lastSyncAt: string;
  syncedFiles: Record<string, SyncFileEntry>;
}

function loadSyncState(): SyncState {
  if (existsSync(SYNC_STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(SYNC_STATE_PATH, "utf-8"));
    } catch {
      console.error("  Warning: corrupt sync state, starting fresh");
    }
  }
  return { lastSyncAt: "", syncedFiles: {} };
}

function saveSyncState(state: SyncState): void {
  writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2));
}

// --- Frontmatter Parsing ---

interface WikiFrontmatter {
  type: string;
  entityType?: string;
  aliases: string[];
  tags: string[];
  related: string[];
}

function parseYamlArray(text: string): string[] {
  const trimmed = text.trim();

  // Inline format: [a, b, "c"]
  if (trimmed.startsWith("[")) {
    const inner = trimmed.slice(1, -1);
    if (!inner.trim()) return [];
    return inner.split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
  }

  return [];
}

function parseWikiFrontmatter(raw: string): { fm: WikiFrontmatter; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const fmText = match[1];
  const body = match[2];

  const fm: WikiFrontmatter = {
    type: "",
    aliases: [],
    tags: [],
    related: [],
  };

  let currentKey = "";
  const multilineValues: string[] = [];

  function flushMultiline() {
    if (currentKey && multilineValues.length > 0) {
      const cleaned = multilineValues.map((v) =>
        v.replace(/^["'\s]+|["'\s]+$/g, "").replace(/^\[\[|\]\]$/g, "")
      );
      if (currentKey === "aliases") fm.aliases = cleaned;
      else if (currentKey === "tags") fm.tags = cleaned;
      else if (currentKey === "related") fm.related = cleaned;
    }
    currentKey = "";
    multilineValues.length = 0;
  }

  for (const line of fmText.split("\n")) {
    // Multiline array item: "  - value"
    const itemMatch = line.match(/^\s+-\s+(.+)$/);
    if (itemMatch && currentKey) {
      multilineValues.push(itemMatch[1]);
      continue;
    }

    // Key-value line
    const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (kvMatch) {
      flushMultiline();
      const [, key, value] = kvMatch;
      const cleanVal = value.trim();

      if (key === "type") {
        fm.type = cleanVal;
      } else if (key === "entity_type") {
        fm.entityType = cleanVal;
      } else if (key === "aliases" || key === "tags" || key === "related") {
        if (cleanVal.startsWith("[")) {
          const parsed = parseYamlArray(cleanVal);
          if (key === "aliases") fm.aliases = parsed;
          else if (key === "tags") fm.tags = parsed;
          else if (key === "related") fm.related = parsed.map((r) => r.replace(/^\[\[|\]\]$/g, ""));
        } else if (cleanVal === "" || cleanVal === "[]") {
          // Empty or start of multiline array
          currentKey = key;
        }
      }
      continue;
    }

    // Continuation of multiline without dash (shouldn't happen in well-formed YAML)
    if (!line.trim()) {
      flushMultiline();
    }
  }

  flushMultiline();
  return { fm, body };
}

// --- Wikilink & Callout Stripping ---

function stripWikilinks(text: string): string {
  // [[target|display]] → display
  let result = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  // [[target]] → target
  result = result.replace(/\[\[([^\]]+)\]\]/g, "$1");
  return result;
}

function stripCallouts(text: string): string {
  // > [!note] Title → Title (keep the title if present, drop the callout marker)
  return text.replace(/^>\s*\[!(\w+)\]\s*/gm, "");
}

function cleanWikiContent(text: string): string {
  return stripCallouts(stripWikilinks(text));
}

// --- Chunking ---

function chunkWikiPage(
  slug: string,
  url: string,
  title: string,
  body: string,
  type: ContentType
): Chunk[] {
  const chunks: Chunk[] = [];
  const cleaned = cleanWikiContent(body);
  const sections = cleaned.split(/^## /m);

  // Intro: everything before first ## heading
  const intro = sections[0].trim();
  if (intro) {
    // Strip the h1 title from intro (it's already in articleTitle)
    const introBody = intro.replace(/^# .+\n*/, "").trim();
    if (introBody.length >= 40) {
      chunks.push({
        articleTitle: title,
        articleUrl: url,
        articleOrder: 0,
        sectionHeading: "Overview",
        chunkType: "intro",
        content: `[Wiki — ${type}] ${title}\n\n${introBody}`,
      });
    }
  }

  // Remaining sections
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const newlineIdx = section.indexOf("\n");
    const heading =
      newlineIdx !== -1 ? section.slice(0, newlineIdx).trim() : section.trim();
    const content =
      newlineIdx !== -1 ? section.slice(newlineIdx + 1).trim() : "";

    if (content && content.length >= 40) {
      chunks.push({
        articleTitle: title,
        articleUrl: url,
        articleOrder: i,
        sectionHeading: heading,
        chunkType: "section",
        content: `## ${heading}\n\n${content}`,
      });
    }
  }

  return chunks;
}

// --- Embedding ---

async function embed(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!resp.ok) {
    throw new Error(`Ollama embed failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings;
}

// --- URL & Slug Builders ---

function buildUrl(type: string, fileSlug: string): string {
  return `wiki://secondbrain/${type}/${fileSlug}`;
}

function buildSlug(type: string, fileSlug: string): string {
  return `wiki-${type}-${fileSlug}`;
}

// --- Main ---

// WHAT: Re-derive `public` for every already-indexed wiki row from the current
//       allowlist, touching no embeddings.
// WHY:  The gate must be able to change without a re-sync. This is the path that
//       runs after editing public-allowlist.ts, and the path that classifies rows
//       indexed before the gate existed. Reads no files from the vault, so it
//       works with the Research volume unmounted.
function reclassifyExisting(): void {
  console.error("=== Reclassify publication gate (no embedding) ===\n");

  const db = initKnowledgeDb();
  // WHY: `public` is selected up front rather than re-queried per row — a
  //       prepared statement inside the loop was an avoidable N+1 read.
  const rows = db
    .prepare(
      "SELECT url, title, content_type, public FROM articles WHERE source_origin = 'secondbrain'"
    )
    .all() as Array<{
    url: string;
    title: string;
    content_type: string;
    public: number;
  }>;

  const update = db.prepare("UPDATE articles SET public = ? WHERE url = ?");
  let toPublic = 0;
  let toWithheld = 0;
  let changed = 0;

  const apply = db.transaction(() => {
    for (const row of rows) {
      const want = isPublic(row.content_type, "secondbrain", row.title) ? 1 : 0;
      if (want !== row.public) {
        changed++;
        // WHY: Name every gate flip, in both modes. The gate is fail-closed, so
        //      a page becoming public means someone edited public-allowlist.ts —
        //      printing which page makes the consequence of that edit visible
        //      rather than inferred from a count. prepack runs this
        //      immediately before the prune, so the lines appear at publish time.
        console.error(
          `    ${want === 1 ? "→ PUBLIC  " : "→ withheld"} [${row.content_type}] ${row.title.slice(0, 58)}`
        );
        if (!FLAGS.dryRun) {
          // WHY: Write only on change. An unconditional UPDATE dirtied every
          //      secondbrain row on each run, which makes a no-op reclassify
          //      indistinguishable from a real one in the DB's page churn.
          update.run(want, row.url);
        }
      }
      if (want === 1) toPublic++;
      else toWithheld++;
    }
  });
  apply();

  if (!FLAGS.dryRun) closeKnowledgeDb();

  console.error(
    `\n=== ${rows.length} wiki rows: ${toPublic} public, ${toWithheld} withheld (${changed} changed) ===`
  );
  console.log(
    JSON.stringify({
      reclassified: rows.length,
      pages_public: toPublic,
      pages_withheld: toWithheld,
      pages_changed: changed,
      dry_run: FLAGS.dryRun,
    })
  );
}

async function main() {
  if (FLAGS.reclassify) {
    reclassifyExisting();
    return;
  }

  console.error("=== SecondBrain Wiki Sync ===\n");

  if (FLAGS.dryRun) console.error("  [DRY RUN — no changes will be written]\n");
  if (FLAGS.full) console.error("  [FULL SYNC — ignoring incremental state]\n");

  // Mount guard
  // WHAT: Derive the external-volume mount point from WIKI_ROOT rather than
  //       hardcoding /Volumes/Research.
  // WHY:  A custom WIKI_ROOT not under /Volumes would otherwise be gated on an
  //       unrelated path; and if WIKI_ROOT points at a different volume, we must
  //       check THAT volume. Only /Volumes/* roots need the skip-when-unmounted
  //       guard; a local root falls through to the existsSync check below.
  const volumeMatch = WIKI_ROOT.match(/^(\/Volumes\/[^/]+)/);
  if (volumeMatch && !existsSync(volumeMatch[1])) {
    console.error(`External volume not mounted at ${volumeMatch[1]} — skipping wiki sync.`);
    console.log(JSON.stringify({ skipped: true, reason: "volume_unmounted" }));
    process.exit(0);
  }

  if (!existsSync(WIKI_ROOT)) {
    console.error(`Wiki root not found at ${WIKI_ROOT}`);
    process.exit(1);
  }

  const syncState = loadSyncState();
  const knowledgeDb = FLAGS.dryRun ? null : initKnowledgeDb();

  let synced = 0;
  let skippedUnchanged = 0;
  let skippedNoTag = 0;
  let skippedParseError = 0;
  let chunksTotal = 0;
  let orphansRetired = 0;
  let failed = 0;
  // WHAT: Count how many synced pages the publication gate lets through.
  // WHY: The gap between "indexed" and "publishable" must be a number in the
  //      summary, not an assumption — a silently-shrinking public set is the
  //      same invisible failure as a silently-stale one.
  let publicPages = 0;
  let withheldPages = 0;

  const seenUrls = new Set<string>();

  for (const { dir, type } of WIKI_DIRS) {
    const dirPath = join(WIKI_ROOT, dir);
    if (!existsSync(dirPath)) {
      console.error(`  Skipping ${dir}/ (not found)`);
      continue;
    }

    const files = readdirSync(dirPath).filter((f) => f.endsWith(".md"));
    console.error(`  ${dir}/: ${files.length} files`);

    for (const file of files) {
      const filePath = join(dirPath, file);
      const fileSlug = basename(file, ".md");
      const url = buildUrl(type, fileSlug);
      const slug = buildSlug(type, fileSlug);
      const sourceFile = `${dir}/${file}`;

      seenUrls.add(url);

      // Incremental check
      if (!FLAGS.full) {
        const stat = statSync(filePath);
        const mtime = stat.mtime.toISOString();
        const existing = syncState.syncedFiles[url];
        if (existing && existing.mtime === mtime) {
          skippedUnchanged++;
          continue;
        }
      }

      // Read and parse
      let raw: string;
      try {
        raw = readFileSync(filePath, "utf-8");
      } catch (err) {
        console.error(`    Warning: cannot read ${sourceFile}: ${err}`);
        skippedParseError++;
        continue;
      }

      const parsed = parseWikiFrontmatter(raw);
      if (!parsed) {
        console.error(`    Warning: no frontmatter in ${sourceFile}`);
        skippedParseError++;
        continue;
      }

      // Filter for ASTGL tag
      const hasAstgl = parsed.fm.tags.some(
        (t) => t.toLowerCase() === "astgl"
      );
      if (!hasAstgl) {
        // WHY: a page that still exists but lost its `astgl` tag must become
        //      eligible for orphan retirement. seenUrls.add(url) ran above, so
        //      drop it here — otherwise the orphan sweep never flags it and the
        //      stale page stays indexed forever (contradicting cron/wiki-sync.json).
        seenUrls.delete(url);
        skippedNoTag++;
        continue;
      }

      // Extract title from first h1
      const titleMatch = parsed.body.match(/^# (.+)$/m);
      const title = titleMatch ? titleMatch[1].trim() : fileSlug.replace(/-/g, " ");

      // Build description from first non-empty paragraph after h1
      const bodyAfterH1 = parsed.body.replace(/^# .+\n*/, "").trim();
      const firstPara = bodyAfterH1.split(/\n\n/)[0]?.trim() || "";
      const description = stripWikilinks(
        firstPara.length > 200 ? firstPara.slice(0, 200) + "…" : firstPara
      );

      // Chunk
      const chunks = chunkWikiPage(slug, url, title, parsed.body, type);

      if (chunks.length === 0) {
        console.error(`    Skipping ${sourceFile} (no substantial chunks)`);
        skippedParseError++;
        continue;
      }

      const pageIsPublic = isPublic(type, "secondbrain", title);

      if (FLAGS.dryRun) {
        console.error(
          `    Would sync: ${sourceFile} → ${type} "${title}" (${chunks.length} chunks) [${pageIsPublic ? "public" : "withheld"}]`
        );
        synced++;
        chunksTotal += chunks.length;
        if (pageIsPublic) publicPages++;
        else withheldPages++;
        continue;
      }

      // WHY: isolate per-file failure. A single embedding/index error must not
      //      abort the whole nightly run and discard all prior in-run progress —
      //      count it, skip the file, and let saveSyncState persist the rest.
      try {
        // Embed
        const BATCH_SIZE = 20;
        const allEmbeddings: number[][] = [];
        for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
          const batch = chunks.slice(i, i + BATCH_SIZE);
          const embeddings = await embed(batch.map((c) => c.content));
          allEmbeddings.push(...embeddings);
        }

        // Build article
        const topics: string[] = [];
        if (parsed.fm.entityType) topics.push(parsed.fm.entityType);
        topics.push(...parsed.fm.aliases);
        topics.push(
          ...parsed.fm.related.filter((r) => r.length > 0)
        );

        const article: StructuredArticle = {
          url,
          sourceUrl: `file://${filePath}`,
          slug,
          title,
          description,
          author: "James Cruce",
          contentType: type,
          topics,
          qaPairs: [],
          jsonLd: "",
          markdownBody: cleanWikiContent(parsed.body),
          processedAt: new Date().toISOString(),
          tags: parsed.fm.tags,
          sourceOrigin: "secondbrain",
          // WHAT: Classify publication eligibility at sync time.
          // WHY: The `astgl` tag above gates *indexing*; this gates *publishing*.
          //      They are different questions — `Vite` and `Income Investor` are
          //      both correctly tagged and both correctly withheld. Stored on the
          //      row so build-public-db.ts can prune without re-deriving the rule.
          isPublic: pageIsPublic,
        };

        upsertArticle(knowledgeDb!, article);
        replaceChunksForArticle(knowledgeDb!, url, chunks, allEmbeddings);

        // Update sync state
        const stat = statSync(filePath);
        syncState.syncedFiles[url] = {
          mtime: stat.mtime.toISOString(),
          sourceFile,
        };

        synced++;
        chunksTotal += chunks.length;
        if (pageIsPublic) publicPages++;
        else withheldPages++;
        console.error(
          `    Synced: ${sourceFile} → ${chunks.length} chunks [${pageIsPublic ? "public" : "withheld"}]`
        );
      } catch (err) {
        // WHY: keep url in seenUrls so a transient embed failure never triggers
        //      orphan retirement of an otherwise-valid page.
        failed++;
        console.error(
          `    ERROR indexing ${sourceFile}: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }

  // WHY: if every changed file failed to index (e.g. Ollama down) fail loudly and
  //      mutate nothing — don't report a clean zero or retire orphans while the
  //      embedder is unavailable (generalizes the citation-test rule, PR #15).
  if (!FLAGS.dryRun && failed > 0 && synced === 0) {
    console.error(`\nAll ${failed} changed file(s) failed to index — aborting without changes.`);
    closeKnowledgeDb();
    console.log(
      JSON.stringify({
        pages_synced: 0,
        pages_failed: failed,
        pages_skipped_unchanged: skippedUnchanged,
        error: "all_failed",
        dry_run: FLAGS.dryRun,
        full_sync: FLAGS.full,
      })
    );
    process.exit(1);
  }

  // Orphan detection: find synced URLs whose source files no longer exist
  const orphanUrls: string[] = [];
  for (const [url, entry] of Object.entries(syncState.syncedFiles)) {
    if (!seenUrls.has(url)) {
      // URL was previously synced but the file is gone (or no longer ASTGL-tagged)
      orphanUrls.push(url);
    }
  }

  if (orphanUrls.length > 0) {
    console.error(`\n  Orphan detection: ${orphanUrls.length} pages removed from vault`);
    for (const url of orphanUrls) {
      const entry = syncState.syncedFiles[url];
      if (FLAGS.dryRun) {
        console.error(`    Would retire: ${entry?.sourceFile || url}`);
      } else {
        const result = deleteArticle(knowledgeDb!, url);
        console.error(
          `    Retired: ${entry?.sourceFile || url} (${result.chunksDeleted} chunks removed)`
        );
        delete syncState.syncedFiles[url];
      }
      orphansRetired++;
    }
  }

  // Save state
  if (!FLAGS.dryRun) {
    syncState.lastSyncAt = new Date().toISOString();
    saveSyncState(syncState);
    closeKnowledgeDb();
  }

  const summary = {
    pages_synced: synced,
    pages_failed: failed,
    pages_skipped_unchanged: skippedUnchanged,
    pages_skipped_no_astgl_tag: skippedNoTag,
    pages_skipped_parse_error: skippedParseError,
    orphans_retired: orphansRetired,
    chunks_created: chunksTotal,
    pages_public: publicPages,
    pages_withheld: withheldPages,
    dry_run: FLAGS.dryRun,
    full_sync: FLAGS.full,
  };

  console.error(`\n=== Done: ${synced} synced, ${failed} failed, ${skippedUnchanged} unchanged, ${orphansRetired} orphans retired, ${chunksTotal} chunks ===`);
  console.log(JSON.stringify(summary));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Wiki sync failed:", err);
    process.exit(1);
  });
