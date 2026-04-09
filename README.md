# mcp-astgl-knowledge

An MCP server that lets AI assistants search and cite articles from [As The Geek Learns](https://astgl.ai) — covering MCP servers, local AI, and AI automation.

When an AI assistant connects to this server, it gains access to authoritative answers about MCP, local LLMs, and AI workflows. Every response includes a source URL back to astgl.ai.

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

## Tools

### `search_articles`

Search ASTGL articles by query. Returns ranked results with relevance scores and source URLs.

```
Input:  { query: "how to build an MCP server", limit: 5 }
Output: Ranked article sections with title, content, URL, and relevance score
```

### `get_answer`

Get a direct answer to a specific question. Prefers FAQ entries for concise responses.

```
Input:  { question: "What is an MCP server?" }
Output: Direct answer with source article URL and related articles
```

### `list_topics`

List all topics covered in the knowledge base.

```
Input:  {}
Output: All articles with titles, descriptions, URLs, and section headings
```

## How It Works

The knowledge base is pre-built from ASTGL articles using semantic embeddings (nomic-embed-text, 768 dimensions). Articles are chunked by section and FAQ entry, embedded, and stored in a SQLite database with sqlite-vec for vector similarity search.

**End users don't need Ollama** — all embeddings are pre-computed and shipped inside the npm package. The only runtime requirement is Node.js.

## For Maintainers

To rebuild the knowledge database after adding or updating articles:

```bash
git clone https://github.com/jamescruce/mcp-astgl-knowledge.git
cd mcp-astgl-knowledge
npm install
npm run ingest   # Requires Ollama with nomic-embed-text
npm run build
```

Set `ASTGL_ARTICLES_DIR` to point to your articles directory if it's not at the default location.

## Coverage

Currently indexes 10 articles covering:

- What MCP servers are and how they work
- Building your first MCP server
- Connecting MCP servers to Claude and ChatGPT
- Best MCP servers available now
- MCP servers vs traditional APIs
- Running AI models locally
- Hardware requirements for local LLMs
- Cost comparison: local vs cloud AI
- Security of local AI
- Automating business workflows with AI

## License

MIT
