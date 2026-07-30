# mcp-astgl-knowledge

An MCP server that lets AI assistants search and cite content from [As The Geek Learns](https://astgl.ai) — covering MCP servers, local AI, AI automation, and ASTGL project documentation.

When an AI assistant connects to this server, it gains access to 49 indexed entries (articles, tutorials, comparisons, guides, and project docs). Every response includes source URLs back to astgl.ai.

## Quick Start

### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "astgl-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-astgl-knowledge"]
    }
  }
}
```

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "astgl-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-astgl-knowledge"]
    }
  }
}
```

### Cursor / Generic MCP Client

```json
{
  "mcpServers": {
    "astgl-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-astgl-knowledge"]
    }
  }
}
```

### With Registration (500 queries/day)

Register via the `register` tool to get an API key, then add it to your config:

```json
{
  "mcpServers": {
    "astgl-knowledge": {
      "command": "npx",
      "args": ["-y", "mcp-astgl-knowledge"],
      "env": {
        "ASTGL_API_KEY": "astgl_your_api_key_here"
      }
    }
  }
}
```

## Tools

### `search_articles`

Search the knowledge base by query. Returns ranked results with relevance scores and source URLs.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., "how to build an MCP server") |
| `limit` | number | No | Max results, 1-20 (default: 5) |
| `content_type` | string | No | Filter by type: article, tutorial, faq, comparison, guide, newsletter, project |

### `get_answer`

Get a direct answer to a specific question. Prefers FAQ entries for concise responses.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | Yes | A specific question (e.g., "What is an MCP server?") |
| `content_type` | string | No | Filter by content type |

### `get_tutorial`

Get step-by-step instructions from tutorial and guide content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | What you want to learn (e.g., "setup Ollama on Mac") |

### `compare_topics`

Side-by-side comparison of two topics.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic_a` | string | Yes | First topic |
| `topic_b` | string | Yes | Second topic |

### `get_latest`

Get the most recently added content.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Max results, 1-20 (default: 5) |

### `list_topics`

Browse all topics in the knowledge base with content types and section headings.

### `register`

Register your email to unlock 500 queries/day (up from 50).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `email` | string | Yes | Your email address |

## Content Types

| Type | Count | Description |
|------|-------|-------------|
| article | 29 | Informational content about MCP, local AI, automation |
| project | 9 | ASTGL project documentation (KlockThingy, Revri, Cortex, etc.) |
| tutorial | 8 | Step-by-step how-to guides |
| comparison | 2 | Side-by-side topic analysis |
| guide | 1 | Comprehensive reference material |
| newsletter | — | Personal updates and announcements |
| faq | — | Primarily Q&A content |

## Rate Limits

| Tier | Limit | How to Get |
|------|-------|------------|
| Public | 50 queries/day | Default (anonymous) |
| Registered | 500 queries/day | Use the `register` tool with your email |

Limits reset at midnight UTC. Rate limit info is included in every response.

## How It Works

The knowledge base is pre-built from ASTGL articles using semantic embeddings (nomic-embed-text, 768 dimensions). Content is chunked by section and FAQ entry, embedded, and stored in a SQLite database with sqlite-vec for vector similarity search.

**End users don't need Ollama** — all embeddings are pre-computed and shipped in the npm package. The only runtime requirement is Node.js.

### Performance

- Typical response time: 100-500ms (embedding lookup + vector search)
- Embedding results are cached in memory (LRU, 200 entries) — repeated queries are near-instant
- Ollama calls include 10s timeout + automatic retry
- Query logging is async/batched to avoid blocking responses
- Rate limit checks are cached for 5 seconds

## For Maintainers

### Setup

```bash
git clone https://github.com/Jmeg8r/mcp-astgl-knowledge.git
cd mcp-astgl-knowledge
npm install
```

### Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Compile TypeScript |
| `npm test` | Run the test suite (node:test via tsx) |
| `npm run dev` | Run MCP server in dev mode (tsx) |
| `npm start` | Run compiled MCP server |
| `npm run ingest` | Rebuild knowledge.db from local markdown (requires Ollama) |
| `npm run ingest-projects` | Index project docs from astgl-site projects.json |
| `npm run discover` | Poll RSS/sitemap for new content |
| `npm run structure` | Process discovered content (classify, embed, index) |
| `npm run pipeline` | Discover + structure in one step |
| `npm run daily-report` | Generate AEO analytics report |
| `npm run alerts` | Run content gap alert checks |
| `npm run freshness` | Check for stale content and ecosystem version changes |
| `npm run publish-drift` | Compare local publishable content against what npm actually serves |
| `npm run citation-test` | Manual AI citation testing |
| `npm run related` | Generate internal article links via vector similarity |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint (dev/rebuild only) |
| `EMBED_MODEL` | `nomic-embed-text` | Embedding model |
| `DISCORD_WEBHOOK_URL` | — | Discord webhook for reports/alerts |
| `ASTGL_API_KEY` | — | Registered tier API key |
| `ASTGL_ARTICLES_DIR` | `~/Projects/astgl-site/src/content/answers` | Local markdown source |
| `ASTGL_PROJECTS_JSON` | `~/Projects/astgl-site/src/data/projects.json` | Projects data source |

### Automated Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| Content pipeline | Every 6h | Discover + structure new content |
| Daily report | 8 AM | Query analytics + health metrics → Discord |
| Content alerts | 9 AM | Gap detection, zero-citation, competitor scan → Discord |
| Freshness check | 10 AM | Stale content + ecosystem version tracking → Discord |

## License

MIT
