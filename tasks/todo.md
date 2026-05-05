# Tasks — mcp-astgl-knowledge

## Bugs

### [x] BUG: `add_idea` tool ignores `priority` parameter, defaults to "medium" — RESOLVED

**Discovered:** 2026-04-15 during competitor batch review session.
**Resolved:** 2026-04-15 (same session).

**Root cause:** Stale `dist/` build. The compiled `dist/index.js` in use by the MCP server (registered in `~/.claude/.mcp.json` as `node dist/index.js`) was out of date relative to `src/`. The current source handles `priority` correctly — verified by (a) direct `node`-level call to `addIdea()` after rebuild storing `high` correctly, and (b) two post-rebuild MCP tool calls (test ideas #6 with `low` and #7 with `high`) both stored the requested value.

**Fix:** `npm run build` (already run during investigation).

**Prevention:** Add a `prestart` hook or document that `dist/` must be rebuilt after any `src/` change before the MCP server picks it up — `dist/` is in `.gitignore` and there's no build-on-install. Consider:
- Adding `"prestart": "npm run build"` to package.json
- Or using `tsx` directly in the MCP server registration to skip the build step entirely

**Data cleanup:** Ideas #1–#4 priority/source fields were hand-corrected via SQL during the session. Test ideas #5, #6, #7 deleted.

---

## Active

### [x] FEATURE: Draft reconciler — retire stale draft entries from knowledge.db

**Branch:** `feat/draft-reconciler` (off `fix/content-pipeline-launchagent-path`)
**Started:** 2026-04-28
**Status:** Code + smoke test complete; awaiting plist install + first live run.

**What it does:** Hard-deletes draft entries (`content_type='draft'`, url
prefix `local://astgl-articles/draft/`) whose source folder under
`astgl-articles/substack/` is missing or has been renamed `Published_*`.
Removes article row + chunks + vec_chunks + article_qa in one transaction.

**Matching strategy:** Source-existence (Option A). Slug/title fuzzy match
against published `astgl.ai/answers/*` was rejected — Substack drafts and
astgl.ai answers are separate publishing channels with no slug overlap, so
fuzzy match would produce mostly false negatives. The on-disk signal
(folder gone or renamed) is the actual workflow.

**Files added:**
- `src/reconcile-drafts.ts` — main script, supports `--dry-run` and `--no-backup`
- `src/knowledge-db.ts` — new `deleteArticle()` helper
- `package.json` — `reconcile-drafts` script
- `launchd/ai.astgl.knowledge.draft-reconciler.plist` — 02:00 nightly
- `cron/draft-reconciler.json` — descriptor

**Smoke test:** Injected a fake orphan into a temp DB copy. Reconciler
detected it (`folder-missing`), dry-run preview reported 1 candidate, live
run deleted the row, original DB never touched.

**First-run dry-run on live DB (2026-04-28):** 91 draft entries examined,
0 candidates. Correct — substack/ folder count (94) exceeds DB draft
count (91), so DB is a strict subset of disk.

**Remaining steps:**
1. Land PR.
2. `npm run build` then `cp launchd/ai.astgl.knowledge.draft-reconciler.plist ~/Library/LaunchAgents/`
3. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.astgl.knowledge.draft-reconciler.plist`
4. Smoke-test `launchctl kickstart -k gui/$(id -u)/ai.astgl.knowledge.draft-reconciler` and check `logs/draft-reconciler.err.log`.

---

## Content Ideas (tracked in idea journal)

See `list_ideas` via MCP. Current queue as of 2026-04-15:
1. Hosted RAG-as-a-Service vs Self-Hosted (high)
2. Agent Memory Systems 2026 Roundup — include AgentBay + memoryOSS (high)
3. AI Search Visibility & Citation Tracking Tools (high)
4. MCP Discovery in 2026 — Refresh (medium)
