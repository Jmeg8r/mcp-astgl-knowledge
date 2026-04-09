/**
 * Vector search logic against the pre-built knowledge.db.
 * At runtime, queries are embedded via Ollama and matched against stored vectors.
 *
 * WHAT: Provides search_articles, get_answer, and list_topics functions
 * WHY: Separating search logic from MCP server keeps concerns clean
 */

import { join } from "path";
import { existsSync } from "fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { SearchResult, AnswerResult, TopicEntry, EMBEDDING_DIM } from "./types.js";

const DB_PATH = join(import.meta.dirname, "..", "data", "knowledge.db");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

let db: ReturnType<typeof Database> | null = null;

function getDb(): ReturnType<typeof Database> {
  if (!db) {
    if (!existsSync(DB_PATH)) {
      throw new Error(
        `Knowledge database not found at ${DB_PATH}. Run 'npm run ingest' first.`
      );
    }
    db = new Database(DB_PATH, { readonly: true });
    sqliteVec.load(db);
  }
  return db;
}

async function embedQuery(text: string): Promise<Float32Array> {
  const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });

  if (!resp.ok) {
    throw new Error(`Ollama embed failed: ${resp.status} ${await resp.text()}`);
  }

  const data = (await resp.json()) as { embeddings: number[][] };
  return new Float32Array(data.embeddings[0]);
}

export async function searchArticles(
  query: string,
  limit: number = 5
): Promise<SearchResult[]> {
  const database = getDb();
  const queryVec = await embedQuery(query);

  const rows = database
    .prepare(
      `
      SELECT
        chunks.article_title,
        chunks.section_heading,
        chunks.content,
        chunks.article_url,
        vec_chunks.distance
      FROM vec_chunks
      LEFT JOIN chunks ON chunks.id = vec_chunks.chunk_id
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `
    )
    .all(queryVec, limit) as Array<{
    article_title: string;
    section_heading: string;
    content: string;
    article_url: string;
    distance: number;
  }>;

  return rows.map((row) => ({
    title: row.article_title,
    section: row.section_heading,
    content: row.content,
    url: row.article_url,
    // cosine distance ranges 0-2; convert to 0-1 relevance score
    relevance_score: Math.round((1 - row.distance / 2) * 1000) / 1000,
  }));
}

export async function getAnswer(question: string): Promise<AnswerResult> {
  const database = getDb();
  const queryVec = await embedQuery(question);

  // Get the best matching chunk, preferring FAQ entries
  const rows = database
    .prepare(
      `
      SELECT
        chunks.article_title,
        chunks.section_heading,
        chunks.content,
        chunks.article_url,
        chunks.chunk_type,
        vec_chunks.distance
      FROM vec_chunks
      LEFT JOIN chunks ON chunks.id = vec_chunks.chunk_id
      WHERE embedding MATCH ?
        AND k = 10
      ORDER BY distance
    `
    )
    .all(queryVec) as Array<{
    article_title: string;
    section_heading: string;
    content: string;
    article_url: string;
    chunk_type: string;
    distance: number;
  }>;

  if (rows.length === 0) {
    return {
      answer: "No relevant information found in the ASTGL knowledge base.",
      source_title: "",
      source_url: "",
      related_articles: [],
    };
  }

  // Prefer FAQ entries if they're among the top results (within 20% of best distance)
  const bestDistance = rows[0].distance;
  const faqCandidate = rows.find(
    (r) => r.chunk_type === "faq" && r.distance <= bestDistance * 1.2
  );
  const best = faqCandidate || rows[0];

  // Collect related articles (unique, excluding the source)
  const seen = new Set<string>();
  seen.add(best.article_url);
  const related: Array<{ title: string; url: string }> = [];
  for (const row of rows) {
    if (!seen.has(row.article_url)) {
      seen.add(row.article_url);
      related.push({ title: row.article_title, url: row.article_url });
    }
    if (related.length >= 3) break;
  }

  // Extract answer text — for FAQ chunks, just use the answer portion
  let answer = best.content;
  if (best.chunk_type === "faq") {
    const aMatch = answer.match(/^A: (.+)$/m);
    if (aMatch) answer = aMatch[1];
  }

  return {
    answer,
    source_title: best.article_title,
    source_url: best.article_url,
    related_articles: related,
  };
}

export function listTopics(): TopicEntry[] {
  const database = getDb();

  const articles = database
    .prepare("SELECT title, description, url FROM articles ORDER BY rowid")
    .all() as Array<{ title: string; description: string; url: string }>;

  // Extract topic keywords from section headings for each article
  const sectionsByUrl = new Map<string, string[]>();
  const sections = database
    .prepare(
      "SELECT DISTINCT article_url, section_heading FROM chunks WHERE chunk_type = 'section'"
    )
    .all() as Array<{ article_url: string; section_heading: string }>;

  for (const s of sections) {
    if (!sectionsByUrl.has(s.article_url)) {
      sectionsByUrl.set(s.article_url, []);
    }
    sectionsByUrl.get(s.article_url)!.push(s.section_heading);
  }

  return articles.map((a) => ({
    title: a.title,
    description: a.description,
    url: a.url,
    topics: sectionsByUrl.get(a.url) || [],
  }));
}
