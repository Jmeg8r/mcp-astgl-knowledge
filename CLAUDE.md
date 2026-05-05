# mcp-astgl-knowledge

MCP server providing knowledge-base search + citation reminders for the ASTGL ecosystem. Consumed by MAESTER (ClaudeClaw agent) for daily/weekly reporting.

## gstack

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted workflows. Skills are installed under `~/.claude/skills/` with the `gstack-` prefix. To install on a new machine:

```bash
git clone --depth 1 https://github.com/garrytan/gstack.git ~/Projects/gstack
cd ~/Projects/gstack && ./setup --prefix --team
```

**Routing directives:**
- `/gstack-cso` — OWASP + STRIDE security audit (this is public-facing infrastructure).
- `/gstack-ship` — PR open + CI verify (preferred over direct push).
- `/gstack-review` — pre-landing PR review.
- `/gstack-investigate` — systematic root-cause debugging.
- `/gstack-office-hours` — product interrogation before code.

**Browser:** use `/browse` (gstack's persistent Chromium binary) for web work.

**Learnings:** project-specific operational learnings persist at `~/.gstack/projects/mcp-astgl-knowledge/learnings.jsonl` and are auto-surfaced in skill preambles.
