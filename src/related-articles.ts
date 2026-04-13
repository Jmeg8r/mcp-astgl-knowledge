#!/usr/bin/env tsx
/**
 * Internal linking automation via vector similarity.
 *
 * WHAT: Computes pairwise article similarity and injects related article links
 * WHY: Cross-referencing boosts SEO, AI discoverability, and reader engagement
 *
 * Usage:
 *   npm run related                        Compute + print JSON map
 *   npm run related -- --inject            Also inject into Astro markdown frontmatter
 *   npm run related -- --top 3             Number of related articles per article (default: 3)
 *
 * Requires: Ollama running with nomic-embed-text
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "fs";
import Database from "better-sqlite3";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const KNOWLEDGE_PATH = join(DATA_DIR, "knowledge.db");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const ASTRO_ANSWERS_DIR =
  process.env.ASTRO_ANSWERS_DIR ||
  join(import.meta.dirname, "..", "..", "astgl-site", "src", "content", "answers");
const BASE_URL = "https://astgl.ai/answers";

interface ArticleMeta {
  title: string;
  description: string;
  url: string;
  slug: string;
}

interface RelatedEntry {
  slug: string;
  title: string;
  score: number;
}

interface RelatedMap {
  [slug: string]: {
    title: string;
    url: string;
    related: RelatedEntry[];
  };
}

// --- Embedding ---
async function embedTexts(texts: string[]): Promise<number[][]> {
  // WHAT: Batch embed via Ollama /api/embed (single call, multiple inputs)
  // WHY: 1 API call for all articles is faster than 20 separate calls
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

// WHAT: Cosine similarity between two vectors
// WHY: Standard similarity metric for embedding comparison (same as sqlite-vec uses)
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Knowledge DB: Store related articles ---
function storeRelatedInDb(
  db: InstanceType<typeof Database>,
  relatedMap: RelatedMap
): void {
  // WHAT: Create table + upsert related article links
  // WHY: MCP server can serve related articles alongside search results
  db.exec(`
    CREATE TABLE IF NOT EXISTS article_related (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_url TEXT NOT NULL,
      related_url TEXT NOT NULL,
      related_title TEXT NOT NULL,
      similarity_score REAL NOT NULL,
      rank INTEGER NOT NULL,
      UNIQUE(article_url, related_url)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_related_article ON article_related(article_url)"
  );

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO article_related (article_url, related_url, related_title, similarity_score, rank)
     VALUES (?, ?, ?, ?, ?)`
  );

  const upsertAll = db.transaction(() => {
    // Clear existing data
    db.prepare("DELETE FROM article_related").run();

    for (const [slug, entry] of Object.entries(relatedMap)) {
      const articleUrl = entry.url;
      for (let i = 0; i < entry.related.length; i++) {
        const rel = entry.related[i];
        upsert.run(
          articleUrl,
          `${BASE_URL}/${rel.slug}`,
          rel.title,
          rel.score,
          i + 1
        );
      }
    }
  });

  upsertAll();
}

// --- Astro Frontmatter Injection ---
// WHAT: Parse YAML frontmatter from a markdown file
// WHY: Need to read existing frontmatter, add/update `related` field, write back
function injectRelatedFrontmatter(
  filePath: string,
  related: RelatedEntry[]
): boolean {
  const content = readFileSync(filePath, "utf-8");

  // Split frontmatter from body
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    console.error(`  Skipping ${filePath}: no frontmatter found`);
    return false;
  }

  let frontmatter = fmMatch[1];
  const body = fmMatch[2];

  // Remove existing `related:` block if present
  frontmatter = frontmatter.replace(
    /related:\n(?:- slug:[\s\S]*?(?=\n\w|\n---|\z))/g,
    ""
  );
  // Cleaner regex: remove the related block entirely
  frontmatter = frontmatter.replace(
    /related:\n(?:(?:- (?:slug|title):.*\n|  .*\n)*)/g,
    ""
  );
  // Remove trailing whitespace
  frontmatter = frontmatter.trimEnd();

  // Build the related YAML block
  const relatedYaml = related
    .map(
      (r) =>
        `- slug: ${r.slug}\n  title: "${r.title.replace(/"/g, '\\"')}"`
    )
    .join("\n");

  frontmatter += `\nrelated:\n${relatedYaml}`;

  const updated = `---\n${frontmatter}\n---\n${body}`;
  writeFileSync(filePath, updated, "utf-8");
  return true;
}

// --- CLI ---
function parseArgs(): { inject: boolean; top: number } {
  const args = process.argv.slice(2);
  return {
    inject: args.includes("--inject"),
    top: (() => {
      const idx = args.indexOf("--top");
      return idx >= 0 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 3;
    })(),
  };
}

async function main() {
  const { inject, top } = parseArgs();

  console.error("=== Related Articles Generator ===\n");

  if (!existsSync(KNOWLEDGE_PATH)) {
    console.error("knowledge.db not found. Run 'npm run ingest' first.");
    process.exit(1);
  }

  const db = new Database(KNOWLEDGE_PATH);

  // WHAT: Only process astgl.ai canonical articles (not Substack mirrors)
  // WHY: These are the articles we control and can inject links into
  const articles = db
    .prepare(
      `SELECT title, description, url, slug
       FROM articles
       WHERE url LIKE 'https://astgl.ai/answers/%'
       ORDER BY rowid`
    )
    .all() as ArticleMeta[];

  console.error(`Found ${articles.length} astgl.ai articles to process\n`);

  if (articles.length === 0) {
    console.error("No articles found.");
    db.close();
    process.exit(0);
  }

  // Step 1: Embed all articles (title + description)
  console.error("Embedding articles...");
  const texts = articles.map((a) => `${a.title}. ${a.description}`);
  const embeddings = await embedTexts(texts);
  console.error(`  ${embeddings.length} embeddings generated\n`);

  // Step 2: Compute pairwise similarity
  console.error("Computing pairwise similarity...");
  const relatedMap: RelatedMap = {};

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const similarities: Array<{ index: number; score: number }> = [];

    for (let j = 0; j < articles.length; j++) {
      if (i === j) continue;
      const score =
        Math.round(cosineSimilarity(embeddings[i], embeddings[j]) * 1000) / 1000;
      similarities.push({ index: j, score });
    }

    // Sort by similarity descending, take top N
    similarities.sort((a, b) => b.score - a.score);
    const topRelated = similarities.slice(0, top).map((s) => ({
      slug: articles[s.index].slug,
      title: articles[s.index].title,
      score: s.score,
    }));

    relatedMap[article.slug] = {
      title: article.title,
      url: article.url,
      related: topRelated,
    };

    console.error(
      `  ${article.slug}: ${topRelated.map((r) => `${r.slug} (${r.score})`).join(", ")}`
    );
  }

  // Step 3: Store in knowledge.db
  console.error("\nStoring in knowledge.db...");
  storeRelatedInDb(db, relatedMap);
  console.error(`  ${Object.keys(relatedMap).length * top} relationships stored`);

  db.close();

  // Step 4: Inject into Astro frontmatter (optional)
  if (inject) {
    console.error("\nInjecting into Astro frontmatter...");

    if (!existsSync(ASTRO_ANSWERS_DIR)) {
      console.error(`  Astro answers dir not found: ${ASTRO_ANSWERS_DIR}`);
      console.error("  Set ASTRO_ANSWERS_DIR env var to override.");
    } else {
      const mdFiles = readdirSync(ASTRO_ANSWERS_DIR).filter((f) =>
        f.endsWith(".md")
      );

      let injected = 0;
      for (const file of mdFiles) {
        const slug = file.replace(/\.md$/, "");
        const entry = relatedMap[slug];
        if (!entry) {
          console.error(`  ${slug}: not in knowledge base, skipping`);
          continue;
        }

        const filePath = join(ASTRO_ANSWERS_DIR, file);
        if (injectRelatedFrontmatter(filePath, entry.related)) {
          console.error(`  ${slug}: injected ${entry.related.length} related links`);
          injected++;
        }
      }
      console.error(`\n  ${injected} files updated`);
    }
  }

  // Output JSON map to stdout
  console.log(JSON.stringify(relatedMap, null, 2));

  console.error("\n=== Done ===");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Related articles failed:", err);
    process.exit(1);
  });
