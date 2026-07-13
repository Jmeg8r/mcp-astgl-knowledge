#!/usr/bin/env tsx
/**
 * Content Structuring pipeline.
 * Takes discovered content (is_new=1 from discovery.db), fetches full article text,
 * classifies via qwen3-coder:30b, extracts Q&A pairs, generates embeddings and JSON-LD,
 * and UPSERTs into knowledge.db.
 *
 * Usage: npm run structure
 * Requires: Ollama running with qwen3-coder:30b and nomic-embed-text models
 */

import Database from "better-sqlite3";
import { join } from "path";
import type { Chunk, QaPair, ClassificationResult, StructuredArticle } from "./types.js";
import { EMBEDDING_DIM } from "./types.js";
import {
  initKnowledgeDb,
  upsertArticle,
  replaceChunksForArticle,
  upsertQaPairs,
  closeKnowledgeDb,
} from "./knowledge-db.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
// WHY: gemma4:26b was the original classify model but was removed 2026-05-19 (Phase 0 LLM cleanup,
//      freed ~114 GB). qwen3-coder:30b is already installed for the rewriter — reuse it here.
const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || "qwen3-coder:30b";
// WHY: Keep qwen3-coder:30b (18 GB) and nomic-embed-text resident for the
//      duration of a structuring run so we pay the cold-load cost once,
//      not per article. 30 min covers a healthy batch with Ollama's
//      default keep_alive (5 min) being too tight for our cadence.
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";

const DISCOVERY_DB_PATH = join(import.meta.dirname, "..", "data", "discovery.db");

interface DiscoveryRow {
  id: number;
  url: string;
  title: string | null;
  description: string | null;
  pub_date: string | null;
  source: string;
}

interface PipelineSummary {
  timestamp: string;
  processed: number;
  failed: number;
  skipped: number;
  articles: Array<{ url: string; title: string; status: string }>;
}

// Tags a step so its failure message pins down which await threw.
// Without this the outer catch's "fetch failed" could be fetchContent, embed,
// classifyContent, or extractQaPairs — all of them end up calling fetch()
// against different services. Node 24's fetch error doesn't include URL.
async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[${label}] ${msg}`);
  }
}

// ─── Content Fetching ────────────────────────────────────────────────

// WHAT: Fetch article URL and convert HTML to clean markdown
// WHY: Discovered content is HTML — we need markdown for chunking and LLM processing
async function fetchContent(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "ASTGL-Knowledge-Bot/1.0" },
  });

  if (!resp.ok) {
    throw new Error(`Fetch failed: ${resp.status} ${resp.statusText}`);
  }

  const html = await resp.text();
  return htmlToMarkdown(html);
}

// WHAT: Lightweight HTML-to-markdown for known source sites
// WHY: Avoids adding jsdom/readability deps; ASTGL and Substack produce clean HTML
function htmlToMarkdown(html: string): string {
  // Extract article/main content
  let content = html;
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  // Substack uses a specific class for article body
  const substackMatch = html.match(
    /<div[^>]*class="[^"]*body markup[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i
  );

  if (articleMatch) content = articleMatch[1];
  else if (mainMatch) content = mainMatch[1];
  else if (substackMatch) content = substackMatch[1];

  // Convert headings
  content = content.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n");
  content = content.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n");
  content = content.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n");
  content = content.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n");

  // Convert inline formatting
  content = content.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  content = content.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  content = content.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Convert links
  content = content.replace(
    /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    "[$2]($1)"
  );

  // Convert lists
  content = content.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");

  // Convert paragraphs and line breaks
  content = content.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n");
  content = content.replace(/<br\s*\/?>/gi, "\n");

  // Remove all remaining HTML tags
  content = content.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  content = content.replace(/&amp;/g, "&");
  content = content.replace(/&lt;/g, "<");
  content = content.replace(/&gt;/g, ">");
  content = content.replace(/&quot;/g, '"');
  content = content.replace(/&#39;/g, "'");
  content = content.replace(/&nbsp;/g, " ");
  content = content.replace(/&#x27;/g, "'");

  // Clean up whitespace
  content = content.replace(/\n{3,}/g, "\n\n");
  return content.trim();
}

// ─── LLM Integration (CLASSIFY_MODEL, default qwen3-coder:30b) ──────

// WHAT: Extract JSON from LLM response, stripping thinking-mode preamble
// WHY: some models with thinking enabled sometimes prepend markdown before JSON
function extractJson(raw: string): string {
  // Try direct parse first
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Look for JSON object in the response
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }
    throw new Error(`No valid JSON found in response: ${trimmed.slice(0, 100)}...`);
  }
}

// WHAT: Classify article content type and extract metadata via Ollama
// WHY: Two focused calls are more reliable than one mega-prompt
async function classifyContent(
  text: string
): Promise<ClassificationResult> {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      format: {
        type: "object",
        properties: {
          content_type: {
            type: "string",
            enum: ["article", "tutorial", "faq", "comparison", "guide", "newsletter"],
          },
          title: { type: "string" },
          description: { type: "string" },
          topics: { type: "array", items: { type: "string" } },
          author: { type: "string" },
        },
        required: ["content_type", "title", "description", "topics", "author"],
      },
      messages: [
        {
          role: "system",
          content:
            "You are a content classifier. Analyze the article and extract metadata. Classify as: article (informational), tutorial (step-by-step how-to), faq (primarily Q&A), comparison (contrasting options), guide (comprehensive reference), or newsletter (personal updates, announcements, behind-the-scenes — not primarily educational). Extract the title, a 1-2 sentence description, 3-5 topic keywords, and the author name.",
        },
        {
          role: "user",
          content: `Classify this article and extract its metadata:\n\n${text.slice(0, 4000)}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(
      `Classification failed: ${resp.status} ${await resp.text()}`
    );
  }

  const data = (await resp.json()) as { message: { content: string } };
  return JSON.parse(extractJson(data.message.content)) as ClassificationResult;
}

// WHAT: Extract Q&A pairs from article content via Ollama
// WHY: LLM can infer questions from headings and key points that humans would search for
async function extractQaPairs(text: string): Promise<QaPair[]> {
  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CLASSIFY_MODEL,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      format: {
        type: "object",
        properties: {
          qa_pairs: {
            type: "array",
            items: {
              type: "object",
              properties: {
                question: { type: "string" },
                answer: { type: "string" },
              },
              required: ["question", "answer"],
            },
          },
        },
        required: ["qa_pairs"],
      },
      messages: [
        {
          role: "system",
          content:
            "You are a Q&A extractor. Read the article and generate 5-8 natural question-and-answer pairs that someone might search for. Infer questions from headings and key points. Each answer should be 1-3 sentences, factual, and self-contained.",
        },
        {
          role: "user",
          content: `Extract Q&A pairs from this article:\n\n${text.slice(0, 8000)}`,
        },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(
      `Q&A extraction failed: ${resp.status} ${await resp.text()}`
    );
  }

  const data = (await resp.json()) as { message: { content: string } };
  const parsed = JSON.parse(extractJson(data.message.content)) as {
    qa_pairs: QaPair[];
  };
  return parsed.qa_pairs;
}

// ─── JSON-LD Generation (template-based) ─────────────────────────────

// WHAT: Generate JSON-LD structured data from classification + Q&A
// WHY: Deterministic templates are more reliable than LLM-generated JSON-LD
function generateJsonLd(
  meta: ClassificationResult,
  qaPairs: QaPair[],
  url: string
): string {
  const schemas: object[] = [];

  // Article schema (always)
  schemas.push({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: meta.title,
    description: meta.description,
    author: {
      "@type": "Person",
      name: meta.author,
    },
    publisher: {
      "@type": "Organization",
      name: "ASTGL — As The Geek Learns",
      url: "https://astgl.ai",
    },
    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": url,
    },
    keywords: meta.topics.join(", "),
  });

  // FAQPage schema (if Q&A pairs exist)
  if (qaPairs.length > 0) {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: qaPairs.map((qa) => ({
        "@type": "Question",
        name: qa.question,
        acceptedAnswer: {
          "@type": "Answer",
          text: qa.answer,
        },
      })),
    });
  }

  // HowTo schema (if tutorial)
  if (meta.content_type === "tutorial") {
    schemas.push({
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: meta.title,
      description: meta.description,
    });
  }

  return JSON.stringify(schemas);
}

// ─── Chunking (reuses ingest.ts pattern) ─────────────────────────────

// WHAT: Split markdown into chunks by h2 headings + add FAQ chunks from extracted Q&A
// WHY: h2 sections are self-contained (300-800 tokens), ideal for retrieval
function chunkArticle(
  title: string,
  url: string,
  body: string,
  qaPairs: QaPair[]
): Chunk[] {
  const chunks: Chunk[] = [];

  // Split by ## headings
  const sections = body.split(/^## /m);

  // Intro (before any ## heading)
  const intro = sections[0].trim();
  if (intro) {
    chunks.push({
      articleTitle: title,
      articleUrl: url,
      articleOrder: 0,
      sectionHeading: "Introduction",
      chunkType: "intro",
      content: intro,
    });
  }

  // Remaining sections
  for (let i = 1; i < sections.length; i++) {
    const section = sections[i];
    const newlineIdx = section.indexOf("\n");
    const heading =
      newlineIdx !== -1 ? section.slice(0, newlineIdx).trim() : section.trim();
    const content =
      newlineIdx !== -1 ? section.slice(newlineIdx + 1).trim() : "";

    if (content) {
      chunks.push({
        articleTitle: title,
        articleUrl: url,
        articleOrder: 0,
        sectionHeading: heading,
        chunkType: "section",
        content: `## ${heading}\n\n${content}`,
      });
    }
  }

  // Q&A pairs as FAQ chunks
  for (const qa of qaPairs) {
    chunks.push({
      articleTitle: title,
      articleUrl: url,
      articleOrder: 0,
      sectionHeading: qa.question,
      chunkType: "faq",
      content: `Q: ${qa.question}\nA: ${qa.answer}`,
    });
  }

  return chunks;
}

// ─── Embedding (reuses ingest.ts pattern) ────────────────────────────

// WHAT: nomic-embed-text has an 8192 token context limit (~6000 chars safe)
// WHY: One article had a single intro chunk exceeding the limit, causing embed failure
const MAX_CHUNK_CHARS = 6000;

async function embed(texts: string[]): Promise<number[][]> {
  // Truncate any chunks that exceed the embedding model's context window
  const safeTexts = texts.map((t) =>
    t.length > MAX_CHUNK_CHARS ? t.slice(0, MAX_CHUNK_CHARS) : t
  );
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: safeTexts, keep_alive: OLLAMA_KEEP_ALIVE }),
  });

  if (!resp.ok) {
    throw new Error(
      `Ollama embed failed: ${resp.status} ${await resp.text()}`
    );
  }

  const data = (await resp.json()) as { embeddings: number[][] };
  return data.embeddings;
}

// ─── Slug Derivation ─────────────────────────────────────────────────

function deriveSlug(url: string): string {
  const parsed = new URL(url);
  const segments = parsed.pathname.split("/").filter(Boolean);
  return segments[segments.length - 1] || "unknown";
}

// ─── Main Pipeline ───────────────────────────────────────────────────

async function main() {
  console.error("Content structuring pipeline started");

  // Open discovery.db to find new items
  const discoveryDb = new Database(DISCOVERY_DB_PATH, { readonly: false });
  const newItems = discoveryDb
    .prepare("SELECT id, url, title, description, pub_date, source FROM discovered_content WHERE is_new = 1")
    .all() as DiscoveryRow[];

  if (newItems.length === 0) {
    console.error("No new items to process");
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        processed: 0,
        failed: 0,
        skipped: 0,
        articles: [],
      })
    );
    discoveryDb.close();
    return;
  }

  console.error(`Found ${newItems.length} new items to process`);

  // Open knowledge.db for writing
  const knowledgeDb = initKnowledgeDb();

  const summary: PipelineSummary = {
    timestamp: new Date().toISOString(),
    processed: 0,
    failed: 0,
    skipped: 0,
    articles: [],
  };

  const BATCH_SIZE = 20;
  const markProcessed = discoveryDb.prepare(
    "UPDATE discovered_content SET is_new = 0 WHERE id = ?"
  );

  for (const item of newItems) {
    try {
      console.error(`\n  Processing: ${item.url}`);

      // 0. Slug-based deduplication. Two cases:
      //  (a) Substack dupe of canonical astgl.ai article.
      //  (b) Same astgl.ai article re-discovered with URL variation
      //      (e.g., RSS now returns trailing-slash URLs for already-indexed
      //      articles stored without the slash → UNIQUE constraint on slug).
      const slug = deriveSlug(item.url);
      const existingBySlug = knowledgeDb
        .prepare("SELECT url FROM articles WHERE slug = ?")
        .get(slug) as { url: string } | undefined;

      if (existingBySlug) {
        const stripSlash = (u: string) => u.replace(/\/+$/, "");
        const isSubstackDupe =
          existingBySlug.url.includes("astgl.ai") &&
          !item.url.includes("astgl.ai");
        const isSameArticle =
          stripSlash(existingBySlug.url) === stripSlash(item.url);

        if (isSubstackDupe || isSameArticle) {
          const reason = isSameArticle
            ? `already indexed as ${existingBySlug.url}`
            : `duplicate of canonical ${existingBySlug.url}`;
          console.error(`    Skipped: ${reason}`);
          summary.skipped++;
          summary.articles.push({
            url: item.url,
            title: item.title || "unknown",
            status: isSameArticle ? "skipped-already-indexed" : "skipped-duplicate",
          });
          markProcessed.run(item.id);
          continue;
        }
      }

      // 1. Fetch full content
      console.error("    Fetching content...");
      const markdown = await step("fetch", () => fetchContent(item.url));

      if (markdown.length < 100) {
        console.error("    Skipped: content too short");
        summary.skipped++;
        summary.articles.push({
          url: item.url,
          title: item.title || "unknown",
          status: "skipped-short",
        });
        continue;
      }

      // 2. Classify content
      console.error(`    Classifying via ${CLASSIFY_MODEL}...`);
      const classification = await step("classify", () => classifyContent(markdown));
      console.error(
        `    Type: ${classification.content_type} | Title: ${classification.title}`
      );

      // 3. Extract Q&A pairs — non-fatal; proceed with empty array on failure.
      console.error("    Extracting Q&A pairs...");
      let qaPairs: QaPair[] = [];
      try {
        qaPairs = await step("qa-extract", () => extractQaPairs(markdown));
        console.error(`    Extracted ${qaPairs.length} Q&A pairs`);
      } catch (qaErr) {
        console.error(
          `    Q&A extraction failed (continuing without): ${qaErr instanceof Error ? qaErr.message : qaErr}`
        );
      }

      // 4. Generate JSON-LD
      const jsonLd = generateJsonLd(classification, qaPairs, item.url);

      // 5. Chunk content (slug already derived in dedup step above)
      const chunks = chunkArticle(
        classification.title,
        item.url,
        markdown,
        qaPairs
      );
      console.error(`    ${chunks.length} chunks created`);

      // 6. Embed all chunks
      console.error("    Embedding chunks...");
      const allEmbeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const embeddings = await step("embed", () => embed(batch.map((c) => c.content)));
        allEmbeddings.push(...embeddings);
      }

      // 7. UPSERT into knowledge.db
      const article: StructuredArticle = {
        url: item.url,
        sourceUrl: item.url,
        slug,
        title: classification.title,
        description: classification.description,
        author: classification.author,
        contentType: classification.content_type,
        topics: classification.topics,
        qaPairs,
        jsonLd,
        markdownBody: markdown,
        processedAt: new Date().toISOString(),
        pubDate: item.pub_date || undefined,
      };

      upsertArticle(knowledgeDb, article);
      replaceChunksForArticle(knowledgeDb, item.url, chunks, allEmbeddings);
      upsertQaPairs(knowledgeDb, item.url, qaPairs);

      // 8. Mark as processed in discovery.db
      markProcessed.run(item.id);

      summary.processed++;
      summary.articles.push({
        url: item.url,
        title: classification.title,
        status: "processed",
      });

      console.error("    Done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`    FAILED: ${message}`);
      summary.failed++;
      summary.articles.push({
        url: item.url,
        title: item.title || "unknown",
        status: `failed: ${message.slice(0, 100)}`,
      });
    }
  }

  // Print summary
  console.log(JSON.stringify(summary, null, 2));

  closeKnowledgeDb();
  discoveryDb.close();
  console.error("\nContent structuring complete");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Structuring pipeline failed:", err);
    process.exit(1);
  });
