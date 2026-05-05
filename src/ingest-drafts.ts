#!/usr/bin/env tsx
/**
 * Draft + topic-ledger ingestion.
 *
 * WHAT: Indexes pre-publication drafts from astgl-articles/substack/ and the
 *       processed-moments.json topic ledger into knowledge.db, tagged so they
 *       are clearly distinguishable from published astgl.ai content.
 * WHY:  Lets the MCP answer "have I drafted/written about X yet?" before we
 *       generate duplicate content. Published Substack articles are handled
 *       separately by the existing 6h content-pipeline once they hit astgl.ai.
 *
 * Usage:
 *   npm run ingest-drafts
 *
 * Env: ASTGL_DRAFTS_DIR  — substack drafts root (default: ~/Projects/astgl-articles/substack)
 *      OLLAMA_URL        — Ollama endpoint (default: http://localhost:11434)
 *      EMBED_MODEL       — embedding model (default: nomic-embed-text)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import {
  initKnowledgeDb,
  upsertArticle,
  replaceChunksForArticle,
  closeKnowledgeDb,
} from "./knowledge-db.js";
import type { StructuredArticle, Chunk } from "./types.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const DRAFTS_DIR =
  process.env.ASTGL_DRAFTS_DIR ||
  join(process.env.HOME || "~", "Projects", "astgl-articles", "substack");

const DATE_SLUG_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

interface ProcessedMoment {
  hash: string;
  source_file: string;
  source_line: number;
  processed_at: string;
  output_folder: string;
  topic: string;
  word_count: number;
}

interface ProcessedMomentsFile {
  version: string;
  description: string;
  processed: ProcessedMoment[];
}

async function embed(texts: string[]): Promise<number[][]> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!resp.ok) {
    throw new Error(`Ollama embed failed: ${resp.status} ${await resp.text()}`);
  }
  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings;
}

function parseDraft(folder: string, articlePath: string): {
  title: string;
  description: string;
  body: string;
  sections: Array<{ heading: string; content: string }>;
} {
  const raw = readFileSync(articlePath, "utf-8");
  const lines = raw.split("\n");

  let title = basename(folder);
  let descriptionLines: string[] = [];
  const sections: Array<{ heading: string; content: string }> = [];
  const hasH2 = lines.some((line) => /^##\s+/.test(line));

  let currentHeading = "Intro";
  let currentBuf: string[] = [];
  let foundTitle = false;
  let collectingDescription = false;
  let hrSectionCount = 0;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    const hr = /^---+\s*$/.test(line);

    if (!foundTitle && h1) {
      title = h1[1].trim();
      foundTitle = true;
      collectingDescription = true;
      continue;
    }

    if (h2) {
      if (currentBuf.length > 0) {
        sections.push({ heading: currentHeading, content: currentBuf.join("\n").trim() });
      }
      currentHeading = h2[1].trim();
      currentBuf = [];
      collectingDescription = false;
      continue;
    }

    if (!hasH2 && hr) {
      if (currentBuf.length > 0) {
        sections.push({ heading: currentHeading, content: currentBuf.join("\n").trim() });
      }
      hrSectionCount += 1;
      currentHeading = `Section ${hrSectionCount + 1}`;
      currentBuf = [];
      collectingDescription = false;
      continue;
    }

    currentBuf.push(line);

    if (collectingDescription && line.trim() !== "") {
      descriptionLines.push(line.trim());
      if (descriptionLines.length >= 3) collectingDescription = false;
    }
  }

  if (currentBuf.length > 0) {
    sections.push({ heading: currentHeading, content: currentBuf.join("\n").trim() });
  }

  const description = descriptionLines.join(" ").slice(0, 280);
  return { title, description, body: raw, sections };
}

function chunkDraft(
  slug: string,
  url: string,
  parsed: ReturnType<typeof parseDraft>,
): Chunk[] {
  const chunks: Chunk[] = [];

  chunks.push({
    articleTitle: parsed.title,
    articleUrl: url,
    articleOrder: 0,
    sectionHeading: "Overview",
    chunkType: "intro",
    content: `[DRAFT — unpublished] ${parsed.title}\n\n${parsed.description}`,
  });

  parsed.sections.forEach((section, idx) => {
    const trimmed = section.content.trim();
    if (trimmed.length < 80) return;
    chunks.push({
      articleTitle: parsed.title,
      articleUrl: url,
      articleOrder: idx + 1,
      sectionHeading: section.heading,
      chunkType: "section",
      content: trimmed,
    });
  });

  return chunks;
}

function chunkLedger(moments: ProcessedMoment[]): Chunk[] {
  const url = "local://astgl-articles/topic-ledger";
  const sorted = [...moments].sort((a, b) => b.processed_at.localeCompare(a.processed_at));

  const overview = `ASTGL Topic Ledger — ${moments.length} moments processed from session captures into rough drafts. Use this to check if a topic has already been written about.`;

  const chunks: Chunk[] = [
    {
      articleTitle: "ASTGL Topic Ledger",
      articleUrl: url,
      articleOrder: 0,
      sectionHeading: "Overview",
      chunkType: "intro",
      content: overview,
    },
  ];

  const batchSize = 25;
  for (let i = 0; i < sorted.length; i += batchSize) {
    const batch = sorted.slice(i, i + batchSize);
    const lines = batch.map(
      (m) =>
        `- ${m.topic} (slug: ${m.output_folder}, processed: ${m.processed_at.slice(0, 10)}, ${m.word_count} words, source: ${basename(m.source_file)}:${m.source_line})`,
    );
    chunks.push({
      articleTitle: "ASTGL Topic Ledger",
      articleUrl: url,
      articleOrder: Math.floor(i / batchSize) + 1,
      sectionHeading: `Processed Moments ${i + 1}-${i + batch.length}`,
      chunkType: "section",
      content: lines.join("\n"),
    });
  }

  return chunks;
}

function listDraftFolders(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => DATE_SLUG_RE.test(name))
    .filter((name) => !name.toLowerCase().startsWith("published_"))
    .map((name) => join(root, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory() && existsSync(join(path, "article.md"));
      } catch {
        return false;
      }
    });
}

async function main() {
  console.error("=== ASTGL Draft + Topic Ledger Ingestion ===\n");

  if (!existsSync(DRAFTS_DIR)) {
    console.error(`Drafts directory not found: ${DRAFTS_DIR}`);
    process.exit(1);
  }

  const knowledgeDb = initKnowledgeDb();

  let draftsIndexed = 0;
  let chunksTotal = 0;

  // Drafts
  const folders = listDraftFolders(DRAFTS_DIR);
  console.error(`Found ${folders.length} draft folder(s) under ${DRAFTS_DIR}\n`);

  for (const folder of folders) {
    const folderName = basename(folder);
    const match = folderName.match(DATE_SLUG_RE);
    if (!match) continue;

    const [, date, slugPart] = match;
    const slug = `draft-${folderName}`;
    const url = `local://astgl-articles/draft/${folderName}`;
    const articlePath = join(folder, "article.md");

    console.error(`  Processing: ${folderName}`);
    const parsed = parseDraft(folder, articlePath);
    const chunks = chunkDraft(slug, url, parsed);
    const embeddings = await embed(chunks.map((c) => c.content));

    const article: StructuredArticle = {
      url,
      sourceUrl: url,
      slug,
      title: parsed.title,
      description: parsed.description,
      author: "James Cruce",
      contentType: "draft",
      topics: ["draft", "unpublished", "astgl", slugPart.replace(/-/g, " ")],
      qaPairs: [],
      jsonLd: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "CreativeWork",
        name: parsed.title,
        description: parsed.description,
        creativeWorkStatus: "Draft",
        dateCreated: date,
      }),
      markdownBody: parsed.body,
      processedAt: new Date().toISOString(),
      pubDate: date,
    };

    upsertArticle(knowledgeDb, article);
    replaceChunksForArticle(knowledgeDb, url, chunks, embeddings);

    draftsIndexed++;
    chunksTotal += chunks.length;
    console.error(`    ${chunks.length} chunks embedded and indexed`);
  }

  // Topic ledger
  const ledgerPath = join(DRAFTS_DIR, "processed-moments.json");
  let ledgerEntries = 0;
  if (existsSync(ledgerPath)) {
    console.error(`\nProcessing topic ledger: ${ledgerPath}`);
    const raw = readFileSync(ledgerPath, "utf-8");
    const data = JSON.parse(raw) as ProcessedMomentsFile;
    ledgerEntries = data.processed.length;

    const url = "local://astgl-articles/topic-ledger";
    const chunks = chunkLedger(data.processed);
    const embeddings = await embed(chunks.map((c) => c.content));

    const article: StructuredArticle = {
      url,
      sourceUrl: url,
      slug: "astgl-topic-ledger",
      title: "ASTGL Topic Ledger",
      description: `Registry of ${data.processed.length} processed ASTGL moments — what has already been written about.`,
      author: "James Cruce",
      contentType: "draft",
      topics: ["draft", "ledger", "astgl", "topic registry"],
      qaPairs: [],
      jsonLd: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Dataset",
        name: "ASTGL Topic Ledger",
        description: "Processed-moments registry",
      }),
      markdownBody: raw,
      processedAt: new Date().toISOString(),
    };

    upsertArticle(knowledgeDb, article);
    replaceChunksForArticle(knowledgeDb, url, chunks, embeddings);

    chunksTotal += chunks.length;
    console.error(`    ${chunks.length} chunks embedded and indexed (${ledgerEntries} ledger entries)`);
  } else {
    console.error(`\nNo topic ledger found at ${ledgerPath} — skipping`);
  }

  closeKnowledgeDb();

  console.error(
    `\n=== Done: ${draftsIndexed} drafts + ${ledgerEntries > 0 ? 1 : 0} ledger indexed, ${chunksTotal} chunks total ===`,
  );

  console.log(
    JSON.stringify({
      drafts_indexed: draftsIndexed,
      ledger_entries: ledgerEntries,
      chunks_created: chunksTotal,
      drafts_dir: DRAFTS_DIR,
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Draft ingestion failed:", err);
    process.exit(1);
  });
