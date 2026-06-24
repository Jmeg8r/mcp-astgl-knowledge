#!/usr/bin/env node
/**
 * MCP server for ASTGL knowledge base.
 * Exposes 15 tools: search, Q&A, tutorials, comparisons, export, ideas, dashboard
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
  findArticles,
  listTags,
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
import {
  suggestIdeas,
  addIdea,
  listIdeas,
  exportIdeasMarkdown,
} from "./ideas.js";
import {
  exportArticle,
  exportTopicRoundup,
  exportQaCompilation,
} from "./export.js";
import { generateDashboardData } from "./dashboard.js";

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
    version: "1.2.0",
  },
  {
    instructions:
      "This server provides authoritative knowledge about MCP servers, local AI, and AI automation from As The Geek Learns (astgl.ai). Use search_articles for broad queries, get_answer for specific questions, get_tutorial for step-by-step guides, compare_topics for side-by-side analysis, get_latest for recent content, and list_topics to see available coverage. Always include the source URL when citing results. If you hit the rate limit, suggest the user register with the `register` tool for higher limits. Additional tools: suggest_ideas/add_idea/list_ideas/export_ideas for content planning, export_article/export_topic_roundup/export_qa_compilation for markdown export, and generate_dashboard_data for analytics.",
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

// --- suggest_ideas ---

server.tool(
  "suggest_ideas",
  "Auto-generate article topic suggestions from query analytics — surfaces content gaps, low-confidence queries, and trending topics that don't have good coverage.",
  {
    days: z
      .number()
      .min(1)
      .max(90)
      .default(7)
      .describe("Look back N days for query analytics (default: 7)"),
    limit: z
      .number()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum suggestions to return (default: 5)"),
  },
  async ({ days, limit }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const suggestions = suggestIdeas(days, limit);
    const elapsed = Math.round(performance.now() - start);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "suggest_ideas",
      queryParams: JSON.stringify({ days, limit }),
      contentCited: JSON.stringify([]),
      responseTimeMs: elapsed,
      confidenceScore: null,
    });

    if (suggestions.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: withRateInfo(
              "No idea suggestions available. The query log may not have enough data yet — try increasing the `days` parameter.",
              rl.rateLimit
            ),
          },
        ],
      };
    }

    const formatted = suggestions
      .map(
        (s, i) =>
          `### ${i + 1}. ${s.title}\n**Source:** ${s.source} | **Priority:** ${s.priority}\n\n${s.description}\n\n**Related queries:** ${s.related_queries.join("; ")}`
      )
      .join("\n\n---\n\n");

    return {
      content: [
        { type: "text" as const, text: withRateInfo(formatted, rl.rateLimit) },
      ],
    };
  }
);

// --- add_idea ---

server.tool(
  "add_idea",
  "Add a content idea to the ASTGL idea journal. Use this when you spot a topic gap, get a question you can't answer well, or think of a blog post idea.",
  {
    title: z
      .string()
      .describe("Idea title (e.g., 'How to use MCP with VS Code')"),
    description: z
      .string()
      .default("")
      .describe("Longer description of the idea"),
    source: z
      .enum(["manual", "query-gap", "low-confidence", "trending", "alert"])
      .default("manual")
      .describe("Where this idea came from"),
    priority: z
      .enum(["high", "medium", "low"])
      .default("medium")
      .describe("Priority level"),
    tags: z
      .array(z.string())
      .default([])
      .describe("Tags for categorization"),
    related_queries: z
      .array(z.string())
      .default([])
      .describe("Related query strings that inspired this idea"),
  },
  async ({ title, description, source, priority, tags, related_queries }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();

    try {
      const result = addIdea({
        title,
        description,
        source,
        priority,
        tags,
        related_queries,
      });
      const elapsed = Math.round(performance.now() - start);

      logQuery({
        timestamp: new Date().toISOString(),
        clientId,
        toolName: "add_idea",
        queryParams: JSON.stringify({ title, source, priority }),
        contentCited: JSON.stringify([]),
        responseTimeMs: elapsed,
        confidenceScore: null,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: withRateInfo(result.message, rl.rateLimit),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: withRateInfo(`Error: ${message}`, rl.rateLimit),
          },
        ],
      };
    }
  }
);

// --- list_ideas ---

server.tool(
  "list_ideas",
  "Browse and filter ideas in the ASTGL idea journal by status, priority, or source.",
  {
    status: z
      .enum(["new", "in-progress", "published", "rejected"])
      .optional()
      .describe("Filter by status"),
    priority: z
      .enum(["high", "medium", "low"])
      .optional()
      .describe("Filter by priority"),
    source: z
      .enum(["manual", "query-gap", "low-confidence", "trending", "alert"])
      .optional()
      .describe("Filter by source"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum ideas to return (default: 10)"),
  },
  async ({ status, priority, source, limit }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const ideas = listIdeas({ status, priority, source, limit });
    const elapsed = Math.round(performance.now() - start);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "list_ideas",
      queryParams: JSON.stringify({ status, priority, source, limit }),
      contentCited: JSON.stringify([]),
      responseTimeMs: elapsed,
      confidenceScore: null,
    });

    if (ideas.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: withRateInfo("No ideas found matching the filters.", rl.rateLimit),
          },
        ],
      };
    }

    const formatted = ideas
      .map(
        (idea) =>
          `### #${idea.id}: ${idea.title}\n**Status:** ${idea.status} | **Priority:** ${idea.priority} | **Source:** ${idea.source}\n${idea.description || "_No description_"}\n**Tags:** ${idea.tags.length > 0 ? idea.tags.join(", ") : "none"}`
      )
      .join("\n\n---\n\n");

    return {
      content: [
        { type: "text" as const, text: withRateInfo(formatted, rl.rateLimit) },
      ],
    };
  }
);

// --- export_ideas ---

server.tool(
  "export_ideas",
  "Export ideas from the idea journal as a formatted markdown document.",
  {
    status: z
      .enum(["new", "in-progress", "published", "rejected"])
      .optional()
      .describe("Filter by status (default: all)"),
    priority: z
      .enum(["high", "medium", "low"])
      .optional()
      .describe("Filter by priority"),
  },
  async ({ status, priority }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const markdown = exportIdeasMarkdown({ status, priority });
    const elapsed = Math.round(performance.now() - start);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "export_ideas",
      queryParams: JSON.stringify({ status, priority }),
      contentCited: JSON.stringify([]),
      responseTimeMs: elapsed,
      confidenceScore: null,
    });

    return {
      content: [
        { type: "text" as const, text: withRateInfo(markdown, rl.rateLimit) },
      ],
    };
  }
);

// --- export_article ---

server.tool(
  "export_article",
  "Export a single ASTGL article as a formatted markdown blog post with Q&A, metadata, and related links.",
  {
    url: z
      .string()
      .describe("Article URL (e.g., 'https://astgl.ai/answers/what-is-an-mcp-server')"),
  },
  async ({ url }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();

    try {
      const markdown = exportArticle(url);
      const elapsed = Math.round(performance.now() - start);

      logQuery({
        timestamp: new Date().toISOString(),
        clientId,
        toolName: "export_article",
        queryParams: JSON.stringify({ url }),
        contentCited: JSON.stringify([url]),
        responseTimeMs: elapsed,
        confidenceScore: null,
      });

      return {
        content: [
          { type: "text" as const, text: withRateInfo(markdown, rl.rateLimit) },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text" as const,
            text: withRateInfo(`Error: ${message}`, rl.rateLimit),
          },
        ],
      };
    }
  }
);

// --- export_topic_roundup ---

server.tool(
  "export_topic_roundup",
  "Generate a roundup blog post combining multiple related ASTGL articles on a topic.",
  {
    topic: z
      .string()
      .describe("Topic to generate roundup for (e.g., 'local AI tools')"),
    limit: z
      .number()
      .min(2)
      .max(10)
      .default(5)
      .describe("Number of articles to include (default: 5)"),
  },
  async ({ topic, limit }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const markdown = await exportTopicRoundup(topic, limit);
    const elapsed = Math.round(performance.now() - start);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "export_topic_roundup",
      queryParams: JSON.stringify({ topic, limit }),
      contentCited: JSON.stringify([]),
      responseTimeMs: elapsed,
      confidenceScore: null,
    });

    return {
      content: [
        { type: "text" as const, text: withRateInfo(markdown, rl.rateLimit) },
      ],
    };
  }
);

// --- export_qa_compilation ---

server.tool(
  "export_qa_compilation",
  "Compile Q&A pairs from ASTGL articles into a FAQ-style markdown document, optionally filtered by topic.",
  {
    topic: z
      .string()
      .optional()
      .describe("Filter Q&A to articles about this topic (optional)"),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(20)
      .describe("Maximum Q&A pairs to include (default: 20)"),
  },
  async ({ topic, limit }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const markdown = await exportQaCompilation(topic, limit);
    const elapsed = Math.round(performance.now() - start);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "export_qa_compilation",
      queryParams: JSON.stringify({ topic, limit }),
      contentCited: JSON.stringify([]),
      responseTimeMs: elapsed,
      confidenceScore: null,
    });

    return {
      content: [
        { type: "text" as const, text: withRateInfo(markdown, rl.rateLimit) },
      ],
    };
  }
);

// --- generate_dashboard_data ---

server.tool(
  "generate_dashboard_data",
  "Generate a comprehensive JSON snapshot of ASTGL analytics for the dashboard — query trends, content coverage, citation tracking, content gaps, and ecosystem status.",
  {
    days: z
      .number()
      .min(1)
      .max(90)
      .default(30)
      .describe("Look back N days for analytics (default: 30)"),
    output_file: z
      .boolean()
      .default(false)
      .describe("Also write to data/dashboard.json for Astro site consumption"),
  },
  async ({ days, output_file }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const data = generateDashboardData(days, output_file);
    const elapsed = Math.round(performance.now() - start);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "generate_dashboard_data",
      queryParams: JSON.stringify({ days, output_file }),
      contentCited: JSON.stringify([]),
      responseTimeMs: elapsed,
      confidenceScore: null,
    });

    const formatted = JSON.stringify(data, null, 2);
    return {
      content: [
        { type: "text" as const, text: withRateInfo(formatted, rl.rateLimit) },
      ],
    };
  }
);

// --- find_articles ---

server.tool(
  "find_articles",
  "Find ASTGL articles by metadata — tag, content type (article, tutorial, draft, comparison, guide, newsletter, project), title text, and/or publication date range. This is a structured lookup over the article index (no semantic embedding), so use it for questions like 'list my drafts tagged Swift' or 'what did I write between April and June'. For meaning-based search use search_articles instead.",
  {
    tag: z
      .string()
      .optional()
      .describe("Filter to articles carrying this tag (case-insensitive, e.g. 'MCP', 'Python')"),
    content_type: z
      .string()
      .optional()
      .describe("Filter by content type: article, tutorial, draft, comparison, guide, newsletter, project"),
    title: z
      .string()
      .optional()
      .describe("Case-insensitive substring match on the article title"),
    date_from: z
      .string()
      .optional()
      .describe("Earliest publication date, ISO format (e.g. '2026-04-01')"),
    date_to: z
      .string()
      .optional()
      .describe("Latest publication date, ISO format (e.g. '2026-06-30')"),
    limit: z
      .number()
      .min(1)
      .max(200)
      .default(25)
      .describe("Maximum number of results to return (default: 25)"),
  },
  async ({ tag, content_type, title, date_from, date_to, limit }) => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const results = findArticles({ tag, content_type, title, date_from, date_to, limit });
    const elapsed = Math.round(performance.now() - start);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "find_articles",
      queryParams: JSON.stringify({ tag, content_type, title, date_from, date_to, limit }),
      contentCited: JSON.stringify(results.map((r) => r.url)),
      responseTimeMs: elapsed,
      confidenceScore: null,
    });

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: withRateInfo("No articles matched those filters.", rl.rateLimit),
          },
        ],
      };
    }

    const formatted = results
      .map((r, i) => {
        const tagStr = r.tags.length > 0 ? ` _[${r.tags.join(", ")}]_` : "";
        const date = r.pub_date ? r.pub_date.slice(0, 10) : "undated";
        return `### ${i + 1}. ${r.title}\n**Type:** ${r.content_type} · **Date:** ${date} · **Source:** ${r.url}${tagStr}\n\n${r.description}`;
      })
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: withRateInfo(`Found ${results.length} article(s):\n\n${formatted}`, rl.rateLimit),
        },
      ],
    };
  }
);

// --- list_tags ---

server.tool(
  "list_tags",
  "List every tag in the ASTGL article index with how many articles carry it. Useful for discovering the available tag vocabulary before calling find_articles.",
  {},
  async () => {
    const rl = enforceRateLimit();
    if (rl.blocked) return rl.response;

    const start = performance.now();
    const tags = listTags();
    const elapsed = Math.round(performance.now() - start);

    logQuery({
      timestamp: new Date().toISOString(),
      clientId,
      toolName: "list_tags",
      queryParams: JSON.stringify({}),
      contentCited: JSON.stringify([]),
      responseTimeMs: elapsed,
      confidenceScore: null,
    });

    if (tags.length === 0) {
      return {
        content: [
          { type: "text" as const, text: withRateInfo("No tags indexed yet.", rl.rateLimit) },
        ],
      };
    }

    const formatted = tags.map((t) => `- ${t.tag} (${t.count})`).join("\n");
    return {
      content: [
        { type: "text" as const, text: withRateInfo(`${tags.length} tags:\n\n${formatted}`, rl.rateLimit) },
      ],
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
