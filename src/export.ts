/**
 * Markdown export module.
 *
 * WHAT: Exports knowledge base content as formatted markdown for blog posts
 * WHY: Enables content reuse — articles, roundups, and FAQ compilations from the KB
 */

import { join } from "path";
import { existsSync } from "fs";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { searchArticles } from "./search.js";

const DB_PATH = join(import.meta.dirname, "..", "data", "knowledge.db");

function openReadonly(): InstanceType<typeof Database> {
  if (!existsSync(DB_PATH)) {
    throw new Error(
      `Knowledge database not found at ${DB_PATH}. Run 'npm run ingest' first.`
    );
  }
  const db = new Database(DB_PATH, { readonly: true });
  sqliteVec.load(db);
  return db;
}

// WHAT: Export a single article as blog-ready markdown
// WHY: Reconstructs full article from chunks + Q&A + related links
export function exportArticle(url: string): string {
  const db = openReadonly();

  const article = db
    .prepare("SELECT title, description, url, content_type, pub_date FROM articles WHERE url = ?")
    .get(url) as {
    title: string;
    description: string;
    url: string;
    content_type: string;
    pub_date: string | null;
  } | undefined;

  if (!article) {
    db.close();
    throw new Error(`Article not found: ${url}`);
  }

  // Reconstruct body from chunks in order
  const chunks = db
    .prepare(
      `SELECT section_heading, content, chunk_type
       FROM chunks
       WHERE article_url = ?
       ORDER BY article_order`
    )
    .all(url) as Array<{
    section_heading: string;
    content: string;
    chunk_type: string;
  }>;

  // Get Q&A pairs
  const qaPairs = db
    .prepare("SELECT question, answer FROM article_qa WHERE article_url = ?")
    .all(url) as Array<{ question: string; answer: string }>;

  // Get related articles
  let relatedArticles: Array<{ title: string; url: string }> = [];
  try {
    relatedArticles = db
      .prepare(
        `SELECT a.title, ar.related_url as url
         FROM article_related ar
         JOIN articles a ON a.url = ar.related_url
         WHERE ar.article_url = ?
         ORDER BY ar.rank`
      )
      .all(url) as Array<{ title: string; url: string }>;
  } catch {
    // article_related table may not exist
  }

  db.close();

  // Build markdown
  let md = "---\n";
  md += `title: "${article.title}"\n`;
  md += `description: "${article.description}"\n`;
  md += `date: "${article.pub_date || new Date().toISOString().slice(0, 10)}"\n`;
  md += `author: "James Cruce"\n`;
  md += `series: "ASTGL Definitive Answers"\n`;
  md += `source: "${article.url}"\n`;
  md += "---\n\n";

  md += `# ${article.title}\n\n`;
  md += `${article.description}\n\n`;

  // Body from chunks
  for (const chunk of chunks) {
    if (chunk.chunk_type === "intro") {
      md += `${chunk.content}\n\n`;
    } else if (chunk.chunk_type === "section") {
      md += `## ${chunk.section_heading}\n\n${chunk.content}\n\n`;
    }
    // Skip FAQ chunks — they go in the FAQ section below
  }

  // FAQ section
  if (qaPairs.length > 0) {
    md += "## Frequently Asked Questions\n\n";
    for (const qa of qaPairs) {
      md += `### ${qa.question}\n\n${qa.answer}\n\n`;
    }
  }

  // Related articles
  if (relatedArticles.length > 0) {
    md += "## Related Articles\n\n";
    for (const rel of relatedArticles) {
      md += `- [${rel.title}](${rel.url})\n`;
    }
    md += "\n";
  }

  return md;
}

// WHAT: Generate a roundup post from related articles on a topic
// WHY: Roundup posts are high-value content that link multiple articles together
export async function exportTopicRoundup(
  topic: string,
  limit: number
): Promise<string> {
  const results = await searchArticles(topic, limit);

  if (results.length === 0) {
    return `# ${topic} — Roundup\n\nNo articles found matching this topic.`;
  }

  // Deduplicate by article URL
  const seen = new Set<string>();
  const unique = results.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  let md = "---\n";
  md += `title: "${topic} — Roundup"\n`;
  md += `description: "A roundup of ASTGL articles covering ${topic}"\n`;
  md += `date: "${new Date().toISOString().slice(0, 10)}"\n`;
  md += `author: "James Cruce"\n`;
  md += `series: "ASTGL Roundups"\n`;
  md += "---\n\n";

  md += `# ${topic} — Roundup\n\n`;
  md += `Here's a collection of ${unique.length} article(s) covering **${topic}** from the ASTGL knowledge base.\n\n`;

  for (const article of unique) {
    md += `## ${article.title}\n\n`;
    md += `**Source:** ${article.url}\n\n`;
    // Truncate content for roundup summary
    const summary =
      article.content.length > 500
        ? article.content.slice(0, 500) + "..."
        : article.content;
    md += `${summary}\n\n---\n\n`;
  }

  return md;
}

// WHAT: Compile Q&A pairs into a FAQ-style markdown document
// WHY: FAQ compilations are high-value for AEO and user reference
export async function exportQaCompilation(
  topic: string | undefined,
  limit: number
): Promise<string> {
  const db = openReadonly();

  let qaPairs: Array<{
    question: string;
    answer: string;
    article_title: string;
    article_url: string;
  }>;

  if (topic) {
    // Use vector search to find relevant articles, then get their Q&A
    const results = await searchArticles(topic, 10);
    const urls = [...new Set(results.map((r) => r.url))];

    if (urls.length === 0) {
      db.close();
      return `# FAQ: ${topic}\n\nNo Q&A pairs found for this topic.`;
    }

    const placeholders = urls.map(() => "?").join(",");
    qaPairs = db
      .prepare(
        `SELECT qa.question, qa.answer, a.title as article_title, qa.article_url
         FROM article_qa qa
         JOIN articles a ON a.url = qa.article_url
         WHERE qa.article_url IN (${placeholders})
         LIMIT ?`
      )
      .all(...urls, limit) as typeof qaPairs;
  } else {
    qaPairs = db
      .prepare(
        `SELECT qa.question, qa.answer, a.title as article_title, qa.article_url
         FROM article_qa qa
         JOIN articles a ON a.url = qa.article_url
         LIMIT ?`
      )
      .all(limit) as typeof qaPairs;
  }

  db.close();

  if (qaPairs.length === 0) {
    const title = topic ? `FAQ: ${topic}` : "ASTGL FAQ Compilation";
    return `# ${title}\n\nNo Q&A pairs found.`;
  }

  const title = topic ? `FAQ: ${topic}` : "ASTGL FAQ Compilation";

  let md = "---\n";
  md += `title: "${title}"\n`;
  md += `description: "Compiled FAQ from ASTGL knowledge base${topic ? ` on ${topic}` : ""}"\n`;
  md += `date: "${new Date().toISOString().slice(0, 10)}"\n`;
  md += `author: "James Cruce"\n`;
  md += "---\n\n";

  md += `# ${title}\n\n`;
  md += `_${qaPairs.length} question(s) compiled from the ASTGL knowledge base._\n\n`;

  // Group by source article
  const byArticle = new Map<string, typeof qaPairs>();
  for (const qa of qaPairs) {
    const key = qa.article_url;
    if (!byArticle.has(key)) byArticle.set(key, []);
    byArticle.get(key)!.push(qa);
  }

  for (const [, group] of byArticle) {
    md += `## From: ${group[0].article_title}\n\n`;
    md += `_Source: ${group[0].article_url}_\n\n`;

    for (const qa of group) {
      md += `### ${qa.question}\n\n${qa.answer}\n\n`;
    }
  }

  return md;
}
