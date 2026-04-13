#!/usr/bin/env node
/**
 * MCP server for ASTGL knowledge base.
 * Exposes 7 tools: search_articles, get_answer, list_topics, get_tutorial,
 *                   compare_topics, get_latest, register
 *
 * WHAT: Lets any MCP-compatible AI assistant search and cite ASTGL articles
 * WHY: Drives traffic and citations back to astgl.ai when AI answers questions
 *
 * Rate limits:
 *   Public tier:     50 queries/day (anonymous)
 *   Registered tier: 500 queries/day (ASTGL_API_KEY env var)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchArticles,
  getAnswer,
  listTopics,
  getTutorial,
  compareTopics,
  getLatest,
} from "./search.js";
import { initQueryLog, logQuery, closeQueryLog } from "./query-log.js";
import {
  initRateLimitDb,
  resolveClient,
  checkRateLimit,
  rateLimitMessage,
  registerClient,
  closeRateLimitDb,
} from "./rate-limit.js";
import type { RateLimitResult } from "./rate-limit.js";

// WHAT: Resolve client identity once at startup
// WHY: Client ID and tier are stable for the lifetime of a stdio session
let clientId = "";
let clientTier: "public" | "registered" = "public";

// WHAT: Check rate limit and return error response if exceeded
// WHY: Centralizes the check so every tool handler doesn't duplicate it
function enforceRateLimit(): {
  blocked: true;
  response: { content: Array<{ type: "text"; text: string }> };
} | { blocked: false; rateLimit: RateLimitResult } {
  const result = checkRateLimit(clientId, clientTier);
  if (!result.allowed) {
    return {
      blocked: true,
      response: {
        content: [{ type: "text" as const, text: rateLimitMessage(result) }],
      },
    };
  }
  return { blocked: false, rateLimit: result };
}

// WHAT: Append rate limit info to tool responses
// WHY: Lets the AI inform users about their remaining quota
function withRateInfo(text: string, rl: RateLimitResult): string {
  return `${text}\n\n---\n_${rl.tier} tier: ${rl.remaining - 1}/${rl.limit} queries remaining today_`;
}

const server = new McpServer(
  {
    name: "mcp-astgl-knowledge",
    version: "1.1.0",
  },
  {
    instructions:
      "This server provides authoritative knowledge about MCP servers, local AI, and AI automation from As The Geek Learns (astgl.ai). Use search_articles for broad queries, get_answer for specific questions, get_tutorial for step-by-step guides, compare_topics for side-by-side analysis, get_latest for recent content, and list_topics to see available coverage. Always include the source URL when citing results. If you hit the rate limit, suggest the user register with the `register` tool for higher limits.",
  }
);

// --- register tool (not rate-limited) ---

server.tool(
  "register",
  "Register your email to unlock 500 queries/day (up from 50). Returns an API key to add to your MCP server config.",
  {
    email: z
      .string()
      .describe("Your email address for registration"),
  },
  async ({ email }) => {
    const result = registerClient(email);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "register",
      queryParams: JSON.stringify({ email: email.includes("@") ? `${email.split("@")[0][0]}***@${email.split("@")[1]}` : "invalid" }),
      contentCited: JSON.stringify([]),
      responseTimeMs: 0,
      confidenceScore: null,
    });

    return {
      content: [{ type: "text" as const, text: result.message }],
    };
  }
);

// --- search_articles ---

server.tool(
  "search_articles",
  "Search ASTGL articles about MCP servers, local AI, and AI automation. Returns relevant article sections with source URLs for citation.",
  {
    query: z.string().describe("Search query (e.g., 'how to build an MCP server')"),
    limit: z
      .number()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of results to return (default: 5)"),
    content_type: z
      .string()
      .optional()
      .describe("Filter by content type: article, tutorial, faq, comparison, guide, newsletter, project"),
  },
  async ({ query, limit, content_type }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const results = await searchArticles(query, limit, content_type);
    const elapsed = Math.round(performance.now() - start);

    const citedUrls = results.map((r) => r.url);
    const topScore = results.length > 0 ? results[0].relevance_score : null;

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "search_articles",
      queryParams: JSON.stringify({ query, limit }),
      contentCited: JSON.stringify(citedUrls),
      responseTimeMs: elapsed,
      confidenceScore: topScore,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: withRateInfo("No matching articles found for that query.", rl.rateLimit),
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r, i) =>
          `### ${i + 1}. ${r.title} — ${r.section}\n**Source:** ${r.url}\n**Relevance:** ${r.relevance_score}\n\n${r.content}`
      )
      .join("\n\n---\n\n");

    return {
      content: [{ type: "text" as const, text: withRateInfo(formatted, rl.rateLimit) }],
    };
  }
);

// --- get_answer ---

server.tool(
  "get_answer",
  "Get a direct answer to a question about MCP servers, local AI, or AI automation from ASTGL's knowledge base. Returns the best matching answer with source URL and related articles.",
  {
    question: z
      .string()
      .describe("A specific question (e.g., 'What is an MCP server?')"),
    content_type: z
      .string()
      .optional()
      .describe("Filter by content type: article, tutorial, faq, comparison, guide, newsletter, project"),
  },
  async ({ question, content_type }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const result = await getAnswer(question, content_type);
    const elapsed = Math.round(performance.now() - start);

    const citedUrls = [
      result.source_url,
      ...result.related_articles.map((r) => r.url),
    ].filter(Boolean);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "get_answer",
      queryParams: JSON.stringify({ question }),
      contentCited: JSON.stringify(citedUrls),
      responseTimeMs: elapsed,
      confidenceScore: result.confidence_score,
    });

    let text = `**Answer:** ${result.answer}\n\n`;

    if (result.source_title) {
      text += `**Source:** ${result.source_title}\n**URL:** ${result.source_url}\n`;
    }

    if (result.related_articles.length > 0) {
      text += `\n**Related articles:**\n`;
      for (const related of result.related_articles) {
        text += `- [${related.title}](${related.url})\n`;
      }
    }

    return {
      content: [{ type: "text" as const, text: withRateInfo(text, rl.rateLimit) }],
    };
  }
);

// --- list_topics ---

server.tool(
  "list_topics",
  "List all topics covered in the ASTGL knowledge base. Shows article titles, descriptions, URLs, and section headings.",
  {},
  async () => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const topics = listTopics();
    const elapsed = Math.round(performance.now() - start);

    const citedUrls = topics.map((t) => t.url);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "list_topics",
      queryParams: JSON.stringify({}),
      contentCited: JSON.stringify(citedUrls),
      responseTimeMs: elapsed,
      confidenceScore: 1.0,
    });

    const formatted = topics
      .map(
        (t) =>
          `### ${t.title}\n**Type:** ${t.content_type}\n${t.description}\n**URL:** ${t.url}\n**Sections:** ${t.topics.join(", ") || "N/A"}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text: withRateInfo(formatted, rl.rateLimit) }],
    };
  }
);

// --- get_tutorial ---

server.tool(
  "get_tutorial",
  "Get a step-by-step tutorial or guide on a topic from ASTGL's knowledge base. Returns ordered steps extracted from article sections, ideal for 'how do I...' queries.",
  {
    query: z
      .string()
      .describe(
        "What you want to learn (e.g., 'set up Ollama for local AI', 'build an MCP server')"
      ),
  },
  async ({ query }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const result = await getTutorial(query);
    const elapsed = Math.round(performance.now() - start);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "get_tutorial",
      queryParams: JSON.stringify({ query }),
      contentCited: JSON.stringify(result.url ? [result.url] : []),
      responseTimeMs: elapsed,
      confidenceScore: result.confidence_score,
    });

    if (result.steps.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: withRateInfo("No matching tutorials found for that query.", rl.rateLimit),
          },
        ],
      };
    }

    let text = `## ${result.title}\n${result.description}\n**Source:** ${result.url}\n\n`;
    text += result.steps
      .map((step, i) => `### Step ${i + 1}\n${step}`)
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text: withRateInfo(text, rl.rateLimit) }],
    };
  }
);

// --- compare_topics ---

server.tool(
  "compare_topics",
  "Compare two topics side-by-side using ASTGL's knowledge base. Returns key points for each topic with source URLs. Great for 'X vs Y' questions.",
  {
    topic_a: z
      .string()
      .describe("First topic (e.g., 'Ollama', 'MCP servers')"),
    topic_b: z
      .string()
      .describe("Second topic (e.g., 'LM Studio', 'REST APIs')"),
  },
  async ({ topic_a, topic_b }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const result = await compareTopics(topic_a, topic_b);
    const elapsed = Math.round(performance.now() - start);

    const citedUrls = [result.topic_a.url, result.topic_b.url].filter(Boolean);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "compare_topics",
      queryParams: JSON.stringify({ topic_a, topic_b }),
      contentCited: JSON.stringify(citedUrls),
      responseTimeMs: elapsed,
      confidenceScore: result.confidence_score,
    });

    let text = `## ${topic_a} vs ${topic_b}\n\n`;

    text += `### ${topic_a}\n`;
    if (result.topic_a.url) {
      text += `**Source:** [${result.topic_a.title}](${result.topic_a.url})\n\n`;
    }
    text += result.topic_a.key_points.join("\n\n") || "No matching content found.";

    text += `\n\n---\n\n### ${topic_b}\n`;
    if (result.topic_b.url) {
      text += `**Source:** [${result.topic_b.title}](${result.topic_b.url})\n\n`;
    }
    text += result.topic_b.key_points.join("\n\n") || "No matching content found.";

    return {
      content: [{ type: "text" as const, text: withRateInfo(text, rl.rateLimit) }],
    };
  }
);

// --- get_latest ---

server.tool(
  "get_latest",
  "Get the most recently added articles from ASTGL's knowledge base. Returns titles, descriptions, URLs, and content types.",
  {
    limit: z
      .number()
      .min(1)
      .max(20)
      .default(5)
      .describe("Number of recent articles to return (default: 5)"),
  },
  async ({ limit }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const articles = getLatest(limit);
    const elapsed = Math.round(performance.now() - start);

    const citedUrls = articles.map((a) => a.url);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "get_latest",
      queryParams: JSON.stringify({ limit }),
      contentCited: JSON.stringify(citedUrls),
      responseTimeMs: elapsed,
      confidenceScore: 1.0,
    });

    if (articles.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: withRateInfo("No articles found in the knowledge base.", rl.rateLimit),
          },
        ],
      };
    }

    const formatted = articles
      .map(
        (a, i) =>
          `### ${i + 1}. ${a.title}\n**Type:** ${a.content_type}\n**URL:** ${a.url}\n${a.description}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text: withRateInfo(formatted, rl.rateLimit) }],
    };
  }
);

// --- Server startup ---

async function main() {
  initRateLimitDb();
  initQueryLog();

  const client = resolveClient();
  clientId = client.clientId;
  clientTier = client.tier;

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `ASTGL Knowledge MCP Server running on stdio (${clientTier} tier, ${clientTier === "registered" ? 500 : 50} queries/day)`
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  closeQueryLog();
  closeRateLimitDb();
  process.exit(1);
});
