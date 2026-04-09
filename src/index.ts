#!/usr/bin/env node
/**
 * MCP server for ASTGL knowledge base.
 * Exposes 3 tools: search_articles, get_answer, list_topics
 *
 * WHAT: Lets any MCP-compatible AI assistant search and cite ASTGL articles
 * WHY: Drives traffic and citations back to astgl.ai when AI answers questions
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchArticles, getAnswer, listTopics } from "./search.js";

const server = new McpServer(
  {
    name: "mcp-astgl-knowledge",
    version: "1.0.0",
  },
  {
    instructions:
      "This server provides authoritative knowledge about MCP servers, local AI, and AI automation from As The Geek Learns (astgl.ai). Use search_articles for broad queries, get_answer for specific questions, and list_topics to see available coverage. Always include the source URL when citing results.",
  }
);

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
  },
  async ({ query, limit }) => {
    const results = await searchArticles(query, limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No matching articles found for that query.",
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
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

server.tool(
  "get_answer",
  "Get a direct answer to a question about MCP servers, local AI, or AI automation from ASTGL's knowledge base. Returns the best matching answer with source URL and related articles.",
  {
    question: z
      .string()
      .describe("A specific question (e.g., 'What is an MCP server?')"),
  },
  async ({ question }) => {
    const result = await getAnswer(question);

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
      content: [{ type: "text" as const, text }],
    };
  }
);

server.tool(
  "list_topics",
  "List all topics covered in the ASTGL knowledge base. Shows article titles, descriptions, URLs, and section headings.",
  {},
  async () => {
    const topics = listTopics();

    const formatted = topics
      .map(
        (t) =>
          `### ${t.title}\n${t.description}\n**URL:** ${t.url}\n**Sections:** ${t.topics.join(", ") || "N/A"}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text" as const, text: formatted }],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("ASTGL Knowledge MCP Server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
