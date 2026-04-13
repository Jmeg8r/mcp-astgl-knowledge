#!/usr/bin/env tsx
/**
 * Project documentation ingestion.
 *
 * WHAT: Reads projects.json from the Astro site and indexes project docs into knowledge.db
 * WHY: Makes ASTGL project information (KlockThingy, Revri, Cortex, etc.) searchable
 *       via MCP tools alongside articles and tutorials
 *
 * Usage:
 *   npm run ingest-projects
 *
 * Env: ASTGL_PROJECTS_JSON — path to projects.json (default: ~/Projects/astgl-site/src/data/projects.json)
 *      OLLAMA_URL           — Ollama endpoint (default: http://localhost:11434)
 *      EMBED_MODEL          — embedding model (default: nomic-embed-text)
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import {
  initKnowledgeDb,
  upsertArticle,
  replaceChunksForArticle,
  closeKnowledgeDb,
} from "./knowledge-db.js";
import type { StructuredArticle, Chunk, ContentType } from "./types.js";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBED_MODEL = process.env.EMBED_MODEL || "nomic-embed-text";
const PROJECTS_JSON_PATH =
  process.env.ASTGL_PROJECTS_JSON ||
  join(process.env.HOME || "~", "Projects", "astgl-site", "src", "data", "projects.json");

// --- Types for projects.json ---
interface Milestone {
  name: string;
  completed: boolean;
}

interface Project {
  id: string;
  name: string;
  description: string;
  status: string;
  progress: number;
  launchDate: string;
  icon: string;
  color: string;
  featured: boolean;
  githubUrl?: string;
  milestones: Milestone[];
}

interface ProjectsData {
  projects: Project[];
}

// --- Embedding ---
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

// --- Synthesize markdown from project data ---
function projectToMarkdown(project: Project): string {
  const lines: string[] = [];

  lines.push(`# ${project.name}`);
  lines.push("");
  lines.push(project.description);
  lines.push("");

  // Status section
  lines.push("## Status");
  const statusLabel =
    project.status === "released"
      ? "Released"
      : project.status === "beta"
        ? "Beta"
        : "In Development";
  lines.push(`**Status:** ${statusLabel} — ${project.progress}% complete`);
  if (project.launchDate && project.launchDate !== "Released") {
    lines.push(`**Target Launch:** ${project.launchDate}`);
  }
  lines.push("");

  // Milestones
  if (project.milestones.length > 0) {
    const completed = project.milestones.filter((m) => m.completed);
    const remaining = project.milestones.filter((m) => !m.completed);

    if (completed.length > 0) {
      lines.push("## Completed Milestones");
      for (const m of completed) {
        lines.push(`- ${m.name}`);
      }
      lines.push("");
    }

    if (remaining.length > 0) {
      lines.push("## Remaining Milestones");
      for (const m of remaining) {
        lines.push(`- ${m.name}`);
      }
      lines.push("");
    }
  }

  // Links
  if (project.githubUrl) {
    lines.push("## Links");
    lines.push(`- GitHub: ${project.githubUrl}`);
    lines.push("");
  }

  return lines.join("\n");
}

// --- Chunk project into searchable pieces ---
function chunkProject(project: Project, markdown: string): Chunk[] {
  const chunks: Chunk[] = [];
  const url = `https://astgl.ai/projects#${project.id}`;

  // Intro chunk: description + status
  const statusLabel =
    project.status === "released"
      ? "Released"
      : project.status === "beta"
        ? "Beta"
        : "In Development";
  chunks.push({
    articleTitle: project.name,
    articleUrl: url,
    articleOrder: 0,
    sectionHeading: "Overview",
    chunkType: "intro",
    content: `${project.name}: ${project.description}\n\nStatus: ${statusLabel} — ${project.progress}% complete${project.launchDate && project.launchDate !== "Released" ? `. Target launch: ${project.launchDate}` : ""}`,
  });

  // Milestones chunk (if any)
  if (project.milestones.length > 0) {
    const completed = project.milestones
      .filter((m) => m.completed)
      .map((m) => `- [x] ${m.name}`)
      .join("\n");
    const remaining = project.milestones
      .filter((m) => !m.completed)
      .map((m) => `- [ ] ${m.name}`)
      .join("\n");

    chunks.push({
      articleTitle: project.name,
      articleUrl: url,
      articleOrder: 1,
      sectionHeading: "Milestones",
      chunkType: "section",
      content: `${project.name} Milestones:\n${completed}\n${remaining}`,
    });
  }

  // WHAT: Skip Links chunks — they're just GitHub URLs with no semantic value
  // WHY: Short URL-only chunks produce vague embeddings that pollute vector search results

  return chunks;
}

async function main() {
  console.error("=== ASTGL Project Documentation Ingestion ===\n");

  if (!existsSync(PROJECTS_JSON_PATH)) {
    console.error(`projects.json not found at: ${PROJECTS_JSON_PATH}`);
    console.error("Set ASTGL_PROJECTS_JSON env var to the correct path.");
    process.exit(1);
  }

  console.error(`Reading: ${PROJECTS_JSON_PATH}`);
  const raw = readFileSync(PROJECTS_JSON_PATH, "utf-8");
  const data = JSON.parse(raw) as ProjectsData;
  console.error(`Found ${data.projects.length} projects\n`);

  const knowledgeDb = initKnowledgeDb();

  let indexed = 0;
  let chunks_total = 0;

  for (const project of data.projects) {
    console.error(`  Processing: ${project.name} (${project.id})`);

    const url = `https://astgl.ai/projects#${project.id}`;
    const slug = `project-${project.id}`;
    const markdown = projectToMarkdown(project);
    const chunks = chunkProject(project, markdown);

    // Embed all chunks
    const embeddings = await embed(chunks.map((c) => c.content));

    // Build article
    const article: StructuredArticle = {
      url,
      sourceUrl: url,
      slug,
      title: project.name,
      description: project.description,
      author: "James Cruce",
      contentType: "project" as ContentType,
      topics: [project.name.toLowerCase(), project.status, "astgl project"],
      qaPairs: [],
      jsonLd: JSON.stringify({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: project.name,
        description: project.description,
        applicationCategory: "Developer Tools",
        operatingSystem: "macOS",
      }),
      markdownBody: markdown,
      processedAt: new Date().toISOString(),
    };

    upsertArticle(knowledgeDb, article);
    replaceChunksForArticle(knowledgeDb, url, chunks, embeddings);

    indexed++;
    chunks_total += chunks.length;
    console.error(`    ${chunks.length} chunks embedded and indexed`);
  }

  closeKnowledgeDb();

  console.error(`\n=== Done: ${indexed} projects indexed, ${chunks_total} chunks total ===`);

  console.log(
    JSON.stringify({
      projects_indexed: indexed,
      chunks_created: chunks_total,
      source: PROJECTS_JSON_PATH,
    })
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Project ingestion failed:", err);
    process.exit(1);
  });
