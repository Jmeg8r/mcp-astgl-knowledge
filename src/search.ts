/**
 * Vector search logic against the pre-built knowledge.db.
 * At runtime, queries are embedded via Ollama and matched against stored vectors.
 *
 * WHAT: Provides search_articles, get_answer, list_topics, and related functions
 * WHY: Separating search logic from MCP server keeps concerns clean
 *
 * Performance:
 *   - LRU cache on embeddings (200 entries) avoids redundant Ollama calls
 *   - Ollama calls have 10s timeout + 1 retry with 500ms delay
 *   - Prepared statements cached at module level
 *   - listTopics uses GROUP_CONCAT instead of in-memory join
 */

import { join } from "path";
import { existsSync } from "fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  SearchResult,
  AnswerResult,
  TopicEntry,
  TutorialResult,
  ComparisonResult,
  LatestArticle,
  EMBEDDING_DIM,
} from "./types.js";

const DB_PATH = join(import.meta.dirname, "..", "data", "knowledge.db");
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";

// --- Database Connection (lazy singleton) ---

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

// --- Embedding Cache (LRU) ---
// WHAT: In-memory cache for embedding vectors, keyed by normalized query text
// WHY: Same query → same embedding. At 500 queries/day, even 20% repeats saves 100 Ollama calls

const EMBED_CACHE_MAX = 200;
const embedCache = new Map<string, { vec: Float32Array; ts: number }>();

function cacheKey(text: string): string {
  return text.trim().toLowerCase();
}

function evictOldest(): void {
  if (embedCache.size <= EMBED_CACHE_MAX) return;

  let oldestKey = "";
  let oldestTs = Infinity;
  for (const [key, entry] of embedCache) {
    if (entry.ts < oldestTs) {
      oldestTs = entry.ts;
      oldestKey = key;
    }
  }
  if (oldestKey) embedCache.delete(oldestKey);
}

// --- Embedding with Resilience ---
// WHAT: Embed query text via Ollama with timeout, retry, and caching
// WHY: Ollama is the bottleneck (~100-500ms). Cache eliminates redundant calls,
//      timeout prevents hanging, retry handles transient failures

async function embedQuery(text: string): Promise<Float32Array> {
  const key = cacheKey(text);
  const cached = embedCache.get(key);
  if (cached) {
    cached.ts = Date.now(); // Touch for LRU
    return cached.vec;
  }

  const vec = await embedWithRetry(text);

  embedCache.set(key, { vec, ts: Date.now() });
  evictOldest();

  return vec;
}

async function embedWithRetry(
  text: string,
  retries: number = 1
): Promise<Float32Array> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: text }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        throw new Error(
          `Ollama embed failed: ${resp.status} ${await resp.text()}`
        );
      }

      const data = (await resp.json()) as { embeddings: number[][] };
      return new Float32Array(data.embeddings[0]);
    } catch (err) {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Embedding unavailable after ${retries + 1} attempt(s): ${message}. ` +
            "Ensure Ollama is running with the nomic-embed-text model loaded."
        );
      }
      // Wait before retry
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error("Embedding failed");
}

// --- Prepared Statement Cache ---
// WHAT: Cache the content_type lookup statement used in post-filtering
// WHY: Avoid re-preparing the same statement on every search call

let contentTypeStmt: ReturnType<ReturnType<typeof Database>["prepare"]> | null =
  null;

function getContentTypeStmt(
  database: ReturnType<typeof Database>
): ReturnType<ReturnType<typeof Database>["prepare"]> {
  if (!contentTypeStmt) {
    contentTypeStmt = database.prepare(
      "SELECT content_type FROM articles WHERE url = ?"
    );
  }
  return contentTypeStmt;
}

// --- Helper: Post-filter by content type ---
function filterByContentType<T extends { article_url: string }>(
  rows: T[],
  contentType: string | undefined,
  database: ReturnType<typeof Database>
): T[] {
  if (!contentType) return rows;

  const stmt = getContentTypeStmt(database);
  return rows.filter((row) => {
    const article = stmt.get(row.article_url) as
      | { content_type: string }
      | undefined;
    return article?.content_type === contentType;
  });
}

// --- search_articles ---

export async function searchArticles(
  query: string,
  limit: number = 5,
  contentType?: string
): Promise<SearchResult[]> {
  const database = getDb();
  const queryVec = await embedQuery(query);

  // WHAT: Over-fetch when filtering by content_type, then post-filter
  // WHY: sqlite-vec applies k before joins, so we can't pre-filter on content_type
  const fetchK = contentType ? limit * 3 : limit;

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
    .all(queryVec, fetchK) as Array<{
    article_title: string;
    section_heading: string;
    content: string;
    article_url: string;
    distance: number;
  }>;

  const filtered = filterByContentType(rows, contentType, database);

  return filtered.slice(0, limit).map((row) => ({
    title: row.article_title,
    section: row.section_heading,
    content: row.content,
    url: row.article_url,
    // cosine distance ranges 0-2; convert to 0-1 relevance score
    relevance_score: Math.round((1 - row.distance / 2) * 1000) / 1000,
  }));
}

// --- get_answer ---

export async function getAnswer(
  question: string,
  contentType?: string
): Promise<AnswerResult> {
  const database = getDb();
  const queryVec = await embedQuery(question);

  // WHAT: Over-fetch when filtering by content_type
  // WHY: Same sqlite-vec k-before-join constraint as searchArticles
  const fetchK = contentType ? 30 : 10;

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
        AND k = ?
      ORDER BY distance
    `
    )
    .all(queryVec, fetchK) as Array<{
    article_title: string;
    section_heading: string;
    content: string;
    article_url: string;
    chunk_type: string;
    distance: number;
  }>;

  const filteredRows = filterByContentType(rows, contentType, database);

  if (filteredRows.length === 0) {
    return {
      answer: "No relevant information found in the ASTGL knowledge base.",
      source_title: "",
      source_url: "",
      related_articles: [],
      confidence_score: 0,
    };
  }

  // WHAT: Select best answer using non-FAQ chunks as the baseline, with FAQ as a bonus
  // WHY: FAQ chunks are short "What is X?" text that embeds with heavy structural weight,
  //       causing them to rank #1 for any "What is..." query regardless of topic.
  //       By anchoring on the best non-FAQ chunk first, we ensure topical relevance,
  //       then only promote a FAQ if it's from the same article (topically confirmed).
  const bestNonFaq = filteredRows.find((r) => r.chunk_type !== "faq");
  const bestOverall = filteredRows[0];

  let best: (typeof filteredRows)[0];
  if (!bestNonFaq) {
    // All results are FAQ — use the top one
    best = bestOverall;
  } else {
    // Prefer a FAQ only if it's from the same article as the best non-FAQ result
    const faqFromSameArticle = filteredRows.find(
      (r) =>
        r.chunk_type === "faq" && r.article_url === bestNonFaq.article_url
    );
    best = faqFromSameArticle || bestNonFaq;
  }

  // Collect related articles (unique, excluding the source)
  const seen = new Set<string>();
  seen.add(best.article_url);
  const related: Array<{ title: string; url: string }> = [];
  for (const row of filteredRows) {
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

  // WHAT: Cosine distance 0-2 → confidence 0-1
  // WHY: Gives consumers a normalized quality signal for the answer
  const confidence = Math.round((1 - best.distance / 2) * 1000) / 1000;

  return {
    answer,
    source_title: best.article_title,
    source_url: best.article_url,
    related_articles: related,
    confidence_score: confidence,
  };
}

// --- get_tutorial ---
// WHAT: Find tutorial/guide content and return ordered steps from section headings
// WHY: AI assistants asking "how do I X" benefit from structured step-by-step answers
export async function getTutorial(query: string): Promise<TutorialResult> {
  const database = getDb();
  const queryVec = await embedQuery(query);

  const rows = database
    .prepare(
      `
      SELECT
        chunks.article_title,
        chunks.article_url,
        chunks.section_heading,
        chunks.content,
        chunks.chunk_type,
        chunks.article_order,
        vec_chunks.distance
      FROM vec_chunks
      LEFT JOIN chunks ON chunks.id = vec_chunks.chunk_id
      LEFT JOIN articles ON articles.url = chunks.article_url
      WHERE embedding MATCH ?
        AND k = 30
      ORDER BY distance
    `
    )
    .all(queryVec) as Array<{
    article_title: string;
    article_url: string;
    section_heading: string;
    content: string;
    chunk_type: string;
    article_order: number;
    distance: number;
  }>;

  if (rows.length === 0) {
    return {
      title: "",
      url: "",
      description: "No matching tutorials found.",
      steps: [],
      confidence_score: 0,
    };
  }

  // WHAT: Pick the best-matching article and collect all its section chunks in order
  // WHY: Tutorial steps come from the sequential sections of a single article
  const bestUrl = rows[0].article_url;
  const bestDistance = rows[0].distance;

  const articleChunks = database
    .prepare(
      `SELECT section_heading, content, chunk_type, article_order
       FROM chunks
       WHERE article_url = ? AND chunk_type = 'section'
       ORDER BY article_order`
    )
    .all(bestUrl) as Array<{
    section_heading: string;
    content: string;
    chunk_type: string;
    article_order: number;
  }>;

  const description = database
    .prepare("SELECT description FROM articles WHERE url = ?")
    .get(bestUrl) as { description: string } | undefined;

  const steps = articleChunks.map(
    (c) => `**${c.section_heading}**\n${c.content}`
  );

  return {
    title: rows[0].article_title,
    url: bestUrl,
    description: description?.description || "",
    steps,
    confidence_score: Math.round((1 - bestDistance / 2) * 1000) / 1000,
  };
}

// --- compare_topics ---
// WHAT: Side-by-side comparison of two topics using vector search
// WHY: "X vs Y" queries are common in AI-assisted research
export async function compareTopics(
  topicA: string,
  topicB: string
): Promise<ComparisonResult> {
  const database = getDb();
  // WHAT: Enrich topics into comparison-oriented queries for better embeddings
  // WHY: Bare topic words like "Ollama" produce vague embeddings (distance 0.36+);
  //       comparison-oriented phrasing anchors the embedding in the right semantic space
  const enrichedA = `${topicA} vs ${topicB} comparison for ${topicA}`;
  const enrichedB = `${topicA} vs ${topicB} comparison for ${topicB}`;

  const [vecA, vecB] = await Promise.all([
    embedQuery(enrichedA),
    embedQuery(enrichedB),
  ]);

  // WHAT: Get best-matching non-FAQ chunks for each topic
  // WHY: FAQ chunks are short "Q: What is X?" text that match on pattern, not topic.
  //       Comparisons need substantive section/intro content, not Q&A pairs.
  const getTopChunks = (vec: Float32Array) => {
    const rows = database
      .prepare(
        `
        SELECT
          chunks.article_title,
          chunks.article_url,
          chunks.section_heading,
          chunks.content,
          chunks.chunk_type,
          vec_chunks.distance
        FROM vec_chunks
        LEFT JOIN chunks ON chunks.id = vec_chunks.chunk_id
        WHERE embedding MATCH ?
          AND k = 15
        ORDER BY distance
      `
      )
      .all(vec) as Array<{
      article_title: string;
      article_url: string;
      section_heading: string;
      content: string;
      chunk_type: string;
      distance: number;
    }>;
    return rows.filter((r) => r.chunk_type !== "faq");
  };

  const rowsA = getTopChunks(vecA);
  const rowsB = getTopChunks(vecB);

  const buildSide = (rows: typeof rowsA) => {
    if (rows.length === 0) {
      return { title: "No matching content", url: "", key_points: [] };
    }
    // WHAT: Collect key points from top chunks, preferring different sections
    // WHY: Diversity of sections gives a better comparison than repeated content
    const seen = new Set<string>();
    const points: string[] = [];
    for (const row of rows) {
      const key = `${row.article_url}:${row.section_heading}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const point =
        row.content.length > 300
          ? row.content.slice(0, 300) + "..."
          : row.content;
      points.push(`**${row.section_heading}:** ${point}`);
      if (points.length >= 3) break;
    }
    return {
      title: rows[0].article_title,
      url: rows[0].article_url,
      key_points: points,
    };
  };

  const worstDistance = Math.max(
    rowsA[0]?.distance ?? 2,
    rowsB[0]?.distance ?? 2
  );

  return {
    topic_a: buildSide(rowsA),
    topic_b: buildSide(rowsB),
    confidence_score: Math.round((1 - worstDistance / 2) * 1000) / 1000,
  };
}

// --- get_latest ---
// WHAT: Return most recently added articles
// WHY: "What's new" queries help users discover fresh content
export function getLatest(limit: number = 5): LatestArticle[] {
  const database = getDb();

  // WHAT: Order by processed_at (structuring pipeline) then rowid (ingest order)
  // WHY: Original ingested articles lack processed_at; rowid is the fallback
  const rows = database
    .prepare(
      `SELECT title, description, url, content_type, processed_at
       FROM articles
       ORDER BY COALESCE(processed_at, '') DESC, rowid DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
    title: string;
    description: string;
    url: string;
    content_type: string;
    processed_at: string | null;
  }>;

  return rows.map((r) => ({
    title: r.title,
    description: r.description,
    url: r.url,
    content_type: r.content_type || "article",
    added_at: r.processed_at,
  }));
}

// --- find_articles (structured, non-vector) ---
// WHAT: Filter the article index by tag, content type, date range, and/or title
//       substring — a metadata query, not a semantic one.
// WHY:  Lets an agent answer "what have I written tagged 'MCP' since April?" or
//       "list my drafts about Swift" without embeddings, so it works even when
//       Ollama is down. Complements the semantic searchArticles().
export interface ArticleHit {
  title: string;
  description: string;
  url: string;
  slug: string;
  content_type: string;
  pub_date: string | null;
  tags: string[];
}

export interface FindArticlesFilters {
  tag?: string;
  content_type?: string;
  title?: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
}

export function findArticles(filters: FindArticlesFilters): ArticleHit[] {
  const database = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.content_type) {
    conditions.push("content_type = ?");
    params.push(filters.content_type);
  }
  // WHY: escape LIKE metacharacters so a literal % or _ in the user's value
  //      (e.g. a title containing "50%") matches literally, not as a wildcard.
  const escapeLike = (value: string): string => value.replace(/[%_]/g, (ch) => `\\${ch}`);

  if (filters.title) {
    conditions.push("LOWER(title) LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(filters.title.toLowerCase())}%`);
  }
  if (filters.tag) {
    // tags is a JSON array string; match case-insensitively on the tag token.
    conditions.push("LOWER(COALESCE(tags, '[]')) LIKE ? ESCAPE '\\'");
    params.push(`%"${escapeLike(filters.tag.toLowerCase())}"%`);
  }
  // WHY: compare on date() both sides so a full ISO timestamp in processed_at
  //      still falls within a date-only boundary (date_to '2026-06-30' must
  //      include a draft processed at '2026-06-30T14:00:00Z').
  if (filters.date_from) {
    conditions.push("date(COALESCE(pub_date, processed_at)) >= date(?)");
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push("date(COALESCE(pub_date, processed_at)) <= date(?)");
    params.push(filters.date_to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filters.limit ?? 25, 1), 200);
  params.push(limit);

  const rows = database
    .prepare(
      `SELECT title, description, url, slug,
              COALESCE(content_type, 'article') AS content_type,
              pub_date,
              COALESCE(tags, '[]') AS tags
       FROM articles
       ${where}
       ORDER BY COALESCE(pub_date, processed_at, '') DESC, rowid DESC
       LIMIT ?`
    )
    .all(...params) as Array<{
    title: string;
    description: string;
    url: string;
    slug: string;
    content_type: string;
    pub_date: string | null;
    tags: string;
  }>;

  return rows.map((r) => {
    let tags: string[] = [];
    try {
      const parsed = JSON.parse(r.tags);
      if (Array.isArray(parsed)) tags = parsed.map((t) => String(t));
    } catch {
      tags = [];
    }
    return { ...r, tags };
  });
}

// WHAT: List every distinct tag with how many articles carry it.
// WHY: Gives an agent (or the user) the vocabulary to filter by.
export function listTags(): Array<{ tag: string; count: number }> {
  const database = getDb();
  const rows = database
    .prepare("SELECT COALESCE(tags, '[]') AS tags FROM articles")
    .all() as Array<{ tags: string }>;

  const counts = new Map<string, number>();
  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.tags);
      if (Array.isArray(parsed)) {
        for (const t of parsed) {
          const tag = String(t).trim();
          if (tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }
    } catch {
      // skip malformed
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// --- list_topics ---
// WHAT: List all topics with their content types and section headings
// WHY: Gives AI assistants an overview of available coverage
export function listTopics(): TopicEntry[] {
  const database = getDb();

  // WHAT: Single query with GROUP_CONCAT instead of two queries + in-memory join
  // WHY: Reduces to one DB round-trip and eliminates the Map construction overhead
  const rows = database
    .prepare(
      `SELECT a.title, a.description, a.url,
              COALESCE(a.content_type, 'article') as content_type,
              GROUP_CONCAT(DISTINCT c.section_heading) as sections
       FROM articles a
       LEFT JOIN chunks c ON c.article_url = a.url AND c.chunk_type = 'section'
       GROUP BY a.url
       ORDER BY a.rowid`
    )
    .all() as Array<{
    title: string;
    description: string;
    url: string;
    content_type: string;
    sections: string | null;
  }>;

  return rows.map((r) => ({
    title: r.title,
    description: r.description,
    url: r.url,
    content_type: r.content_type,
    topics: r.sections ? r.sections.split(",") : [],
  }));
}
