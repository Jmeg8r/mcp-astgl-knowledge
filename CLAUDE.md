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

<!-- COMPOUND:START -->
## Compound Engineering Setup

Learnings are captured by gstack into `~/.gstack/projects/<slug>/learnings.jsonl` and
auto-loaded into context at session start. This repo commits only the human-readable
digest below — the gstack store is the source of truth.

- **View learnings offline:** `./show-learnings.sh` (also `high`, or a type filter)
- **Record a constraint:** `/gstack-learn add` (write constraints, not observations)
- **Refresh the table below** after a session's Compound step: `./refresh-digest.sh`
- **Session logs:** copy `sessions/TEMPLATE.md` → `sessions/SESSION-NNN-<title>.md` and
  follow Brainstorm → Plan → Work → Review → Compound.

## Known Patterns

<!-- LEARNINGS:START -->
_No learnings yet. Run `/gstack-learn add` during a session, then `./refresh-digest.sh`._
<!-- LEARNINGS:END -->
<!-- COMPOUND:END -->
