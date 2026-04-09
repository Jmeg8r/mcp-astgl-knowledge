#!/usr/bin/env tsx
/**
 * Build-time ingestion script.
 * Reads ASTGL articles, chunks by h2 section + FAQ entries,
 * embeds via Ollama (nomic-embed-text), and writes to SQLite + sqlite-vec.
 *
 * Usage: npm run ingest
 * Requires: Ollama running with nomic-embed-text model
 */

import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { ArticleFrontmatter, Chunk, EMBEDDING_DIM, BASE_URL } from "./types.js";

const ARTICLES_DIR =
  process.env.ASTGL_ARTICLES_DIR ||
  join(process.env.HOME!, "Projects/astgl-site/src/content/answers");

const DB_PATH = join(import.meta.dirname, "..", "data", "knowledge.db");

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

// WHAT: Parse YAML-ish frontmatter without adding a dependency
// WHY: Our frontmatter is simple enough that we don't need gray-matter
function parseFrontmatter(raw: string): {
  frontmatter: ArticleFrontmatter;
  body: string;
} {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) throw new Error("No frontmatter found");

  const fmText = fmMatch[1];
  const body = fmMatch[2];

  // Parse simple key-value pairs
  const fm: Record<string, unknown> = {};
  const faqEntries: Array<{ question: string; answer: string }> = [];
  let currentFaqEntry: Record<string, string> | null = null;
  let inFaq = false;
  let inNext = false;
  const nextObj: Record<string, string> = {};

  for (const line of fmText.split("\n")) {
    if (line === "faq:") {
      inFaq = true;
      inNext = false;
      continue;
    }
    if (line === "next:") {
      inNext = true;
      inFaq = false;
      continue;
    }

    if (inFaq) {
      const itemMatch = line.match(/^\s+-\s+question:\s+"(.+)"$/);
      if (itemMatch) {
        if (currentFaqEntry) faqEntries.push(currentFaqEntry as { question: string; answer: string });
        currentFaqEntry = { question: itemMatch[1] };
        continue;
      }
      const answerMatch = line.match(/^\s+answer:\s+"(.+)"$/);
      if (answerMatch && currentFaqEntry) {
        currentFaqEntry.answer = answerMatch[1];
        continue;
      }
      // Non-indented line means we've left the faq block
      if (!line.startsWith("  ") && line.trim() !== "") {
        if (currentFaqEntry) faqEntries.push(currentFaqEntry as { question: string; answer: string });
        currentFaqEntry = null;
        inFaq = false;
      } else {
        continue;
      }
    }

    if (inNext) {
      const nextMatch = line.match(/^\s+(\w+):\s+"?(.+?)"?$/);
      if (nextMatch) {
        nextObj[nextMatch[1]] = nextMatch[2];
        continue;
      }
      if (!line.startsWith("  ") && line.trim() !== "") {
        inNext = false;
      } else {
        continue;
      }
    }

    const kvMatch = line.match(/^(\w+):\s+"?(.+?)"?$/);
    if (kvMatch) {
      const [, key, value] = kvMatch;
      fm[key] = key === "order" ? parseInt(value, 10) : value;
    }
  }

  // Flush last FAQ entry
  if (currentFaqEntry) faqEntries.push(currentFaqEntry as { question: string; answer: string });

  return {
    frontmatter: {
      ...fm,
      faq: faqEntries,
      next: Object.keys(nextObj).length > 0 ? (nextObj as { slug: string; title: string }) : undefined,
    } as ArticleFrontmatter,
    body,
  };
}

// WHAT: Split article body into chunks by h2 headings
// WHY: h2 sections are self-contained (300-800 tokens), ideal for retrieval
function chunkArticle(
  frontmatter: ArticleFrontmatter,
  body: string,
  slug: string
): Chunk[] {
  const chunks: Chunk[] = [];
  const articleUrl = `${BASE_URL}/${slug}`;

  // Split by ## headings
  const sections = body.split(/^## /m);

  // First section is the intro (before any ## heading)
  const intro = sections[0].trim();
  if (intro) {
    chunks.push({
      articleTitle: frontmatter.title,
      articleUrl,
      articleOrder: frontmatter.order,
      sectionHeading: "Introduction",
      chunkType: "intro",
      content: intro,
    });
  }

  // Remaining sections
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const newlineIdx = section.indexOf("\n");
    const heading = newlineIdx !== -1 ? section.slice(0, newlineIdx).trim() : section.trim();
    const content = newlineIdx !== -1 ? section.slice(newlineIdx + 1).trim() : "";

    if (content) {
      chunks.push({
        articleTitle: frontmatter.title,
        articleUrl,
        articleOrder: frontmatter.order,
        sectionHeading: heading,
        chunkType: "section",
        content: `## ${heading}\n\n${content}`,
      });
    }
  }

  // FAQ entries as separate chunks
  for (const faq of frontmatter.faq) {
    chunks.push({
      articleTitle: frontmatter.title,
      articleUrl,
      articleOrder: frontmatter.order,
      sectionHeading: faq.question,
      chunkType: "faq",
      content: `Q: ${faq.question}\nA: ${faq.answer}`,
    });
  }

  return chunks;
}

// WHAT: Embed text via Ollama API
// WHY: nomic-embed-text gives 768-dim vectors, already running locally
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

async function main() {
  console.error(`Reading articles from: ${ARTICLES_DIR}`);

  if (!existsSync(ARTICLES_DIR)) {
    throw new Error(`Articles directory not found: ${ARTICLES_DIR}`);
  }

  // Read all article files
  const files = readdirSync(ARTICLES_DIR).filter((f) => f.endsWith(".md"));
  console.error(`Found ${files.length} articles`);

  // Parse and chunk all articles
  const allChunks: Chunk[] = [];
  const articles: Array<{ title: string; description: string; url: string; slug: string }> = [];

  for (const file of files) {
    const raw = readFileSync(join(ARTICLES_DIR, file), "utf-8");
    const slug = basename(file, ".md");
    const { frontmatter, body } = parseFrontmatter(raw);
    const chunks = chunkArticle(frontmatter, body, slug);
    allChunks.push(...chunks);
    articles.push({
      title: frontmatter.title,
      description: frontmatter.description,
      url: `${BASE_URL}/${slug}`,
      slug,
    });
    console.error(`  ${file}: ${chunks.length} chunks`);
  }

  console.error(`\nTotal chunks: ${allChunks.length}`);
  console.error(`Embedding via ${EMBED_MODEL}...`);

  // Embed in batches of 20
  const BATCH_SIZE = 20;
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const embeddings = await embed(batch.map((c) => c.content));
    allEmbeddings.push(...embeddings);
    console.error(`  Embedded ${Math.min(i + BATCH_SIZE, allChunks.length)}/${allChunks.length}`);
  }

  // Initialize SQLite database
  const dataDir = join(import.meta.dirname, "..", "data");
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const db = new Database(DB_PATH);
  sqliteVec.load(db);

  console.error(`\nWriting to: ${DB_PATH}`);

  // Create tables
  db.exec("DROP TABLE IF EXISTS chunks");
  db.exec("DROP TABLE IF EXISTS vec_chunks");
  db.exec("DROP TABLE IF EXISTS articles");

  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      url TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE
    )
  `);

  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_title TEXT NOT NULL,
      article_url TEXT NOT NULL,
      article_order INTEGER NOT NULL,
      section_heading TEXT NOT NULL,
      chunk_type TEXT NOT NULL,
      content TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE vec_chunks USING vec0(
      chunk_id INTEGER PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}] distance_metric=cosine
    )
  `);

  // Insert articles
  const insertArticle = db.prepare(
    "INSERT INTO articles (title, description, url, slug) VALUES (?, ?, ?, ?)"
  );
  for (const article of articles) {
    insertArticle.run(article.title, article.description, article.url, article.slug);
  }

  // Insert chunks and vectors
  const insertChunk = db.prepare(
    `INSERT INTO chunks (article_title, article_url, article_order, section_heading, chunk_type, content)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertVec = db.prepare(
    "INSERT INTO vec_chunks (chunk_id, embedding) VALUES (?, ?)"
  );

  const insertAll = db.transaction(() => {
    for (let i = 0; i < allChunks.length; i++) {
      const chunk = allChunks[i];
      const result = insertChunk.run(
        chunk.articleTitle,
        chunk.articleUrl,
        chunk.articleOrder,
        chunk.sectionHeading,
        chunk.chunkType,
        chunk.content
      );
      const chunkId = result.lastInsertRowid;
      insertVec.run(BigInt(chunkId as number), new Float32Array(allEmbeddings[i]));
    }
  });

  insertAll();

  // Verify
  const chunkCount = (db.prepare("SELECT COUNT(*) as count FROM chunks").get() as { count: number }).count;
  const vecCount = (db.prepare("SELECT COUNT(*) as count FROM vec_chunks").get() as { count: number }).count;
  const articleCount = (db.prepare("SELECT COUNT(*) as count FROM articles").get() as { count: number }).count;

  console.error(`\nDone!`);
  console.error(`  Articles: ${articleCount}`);
  console.error(`  Chunks: ${chunkCount}`);
  console.error(`  Vectors: ${vecCount}`);

  db.close();
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
