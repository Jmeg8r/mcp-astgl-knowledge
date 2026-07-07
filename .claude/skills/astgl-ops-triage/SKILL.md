---
name: astgl-ops-triage
description: Diagnose the ASTGL knowledge pipeline end-to-end — launchd jobs, logs, databases, Ollama, mounts, dist freshness, stuck rewrite jobs. Use when James says "is the pipeline healthy", "why didn't X run", "triage", "morning check", "something's off with the knowledge base", or when any scheduled job appears to have failed or gone quiet.
---

# ASTGL Ops Triage

Read-only health sweep of the whole system, then a diagnosis mapped to this repo's
KNOWN failure modes. Do not fix anything during the sweep — collect first, diagnose
second, propose fixes third. Everything here is safe to run without asking.

## Phase 1 — Collect (run all of these; batch independent commands)

**1. Scheduler state:**
```bash
launchctl list | grep -E 'astgl|ASTGL'
```
Expected labels: `ai.astgl.knowledge.{content-pipeline,draft-pipeline,draft-reconciler,wiki-sync}`
plus legacy-but-still-live `{daily-report,content-alerts,content-freshness}` and the
unrelated `com.astgl.*` agents. Column 2 is last exit status — any non-zero is a lead.

**2. Log freshness and errors** (a job that "ran fine" yesterday but not today shows
up here first):
```bash
ls -lt logs/ | head -20
for f in logs/*.err.log; do echo "== $f"; tail -5 "$f"; done
```
Compare each log's mtime against its schedule (content-pipeline every 6h; draft 00:00;
wiki-sync 00:30; reconciler 02:00; daily-report 08:00; alerts 09:00; freshness 10:00).
A log older than one full period = the job didn't fire or crashed before logging.

**3. Stale dist check** (production runs `dist/*.js`; a newer `src/` file means
production is running old code):
```bash
for s in src/*.ts; do
  d="dist/$(basename "${s%.ts}").js"
  if [ ! -f "$d" ]; then echo "NO DIST: $s (never built)"
  elif [ "$s" -nt "$d" ]; then echo "STALE: $s newer than $d"; fi
done
```
Compares each source file against its own compiled artifact (a global newest-file
comparison misses stale pairs). Any `STALE`/`NO DIST` line = flag STALE DIST.
`NO DIST` for a script that only ever runs via `tsx` is acceptable — say so explicitly
rather than ignoring it.

**4. Dependencies:**
```bash
curl -s --max-time 5 localhost:11434/api/tags | python3 -c "import json,sys; print(sorted(m['name'] for m in json.load(sys.stdin)['models']))" || echo "OLLAMA DOWN"
ls /Volumes/ | grep -c Research || echo "RESEARCH VOLUME UNMOUNTED"
ls "/Volumes/Research/ASTGL Articles/Drafts" >/dev/null 2>&1 && echo drafts-ok || echo drafts-MISSING
ls "/Volumes/Research/Brain/SecondBrain/wiki" >/dev/null 2>&1 && echo wiki-ok || echo wiki-MISSING
```
Required models: `nomic-embed-text` (embeddings — everything needs it) and
`qwen3-coder:30b` (structure classify + rewrite drafts).

**5. Database state (read-only):**
```bash
sqlite3 "file:data/knowledge.db?mode=ro" "
  SELECT 'articles', COUNT(*) FROM articles
  UNION ALL SELECT 'by_origin: '||COALESCE(source_origin,'NULL'), COUNT(*) FROM articles GROUP BY source_origin
  UNION ALL SELECT 'chunks', COUNT(*) FROM chunks
  UNION ALL SELECT 'vec_chunks', COUNT(*) FROM vec_chunks
  UNION ALL SELECT 'stale_90d', COUNT(*) FROM articles WHERE COALESCE(last_reviewed_at,pub_date,processed_at) < datetime('now','-90 days');"
sqlite3 "file:data/knowledge.db?mode=ro" "SELECT id, article_url, status, created_at FROM rewrite_jobs WHERE status IN ('pending_approval','approved') ORDER BY created_at;"
sqlite3 "file:data/discovery.db?mode=ro" "SELECT COUNT(*) FROM discovered_content WHERE is_new=1;"
```
Red flags: `chunks` count ≠ `vec_chunks` count (orphaned vectors → route to
`/astgl-db-surgeon`); `pending_approval` jobs older than ~3 days (Telegram ping was
missed or ignored); `is_new=1` backlog that persists across pipeline runs (structuring
is failing on those items — grep content-pipeline.err.log for their URLs).

**6. Disk hygiene:**
```bash
du -sh data/*.bak* 2>/dev/null; ls -lt data/*.bak* 2>/dev/null | head
```

## Phase 2 — Diagnose against known failure signatures

Match findings to this table before inventing new theories. These have all actually
happened (or are documented footguns) in this repo:

| Signature | Root cause | Fix (get approval where noted) |
|---|---|---|
| `env: node: No such file or directory` in an err.log | Plist missing the pinned nvm PATH (PR #8 regression) | Re-add `EnvironmentVariables.PATH` with `~/.nvm/versions/node/v24.14.0/bin` first; bootout/bootstrap (**ask first — launchd change**) |
| Job runs but behavior doesn't match `src/` | STALE DIST (the `add_idea` priority bug pattern) | `npm run build`; restart the MCP server session |
| `Ollama embed failed` / `fetch failed` to :11434 | Ollama down or model evicted | Start Ollama; verify both required models present; re-run failed pipeline once |
| wiki-sync summary `{skipped: true, reason: "volume_unmounted"}` | Research drive unmounted — by design, not a bug | Mount the drive; next 00:30 run catches up (or `npm run sync-wiki` manually) |
| reconcile-drafts exit 1 "drafts root missing" | Same unmount — the guard REFUSING to mass-delete | Mount the drive. Never "fix" the guard |
| Rewrite job stuck `pending_approval`, no Telegram message | `TELEGRAM_BOT_TOKEN`/`CHAT_ID` unset for that run → ping silently skipped | Report job IDs to James; he approves via claudeclaw or the job is re-pinged |
| Citation run all-errors then rows deleted + loud throw | Broken API key (the PR #15 pattern — working as designed) | Check pass-cli resolution of the failing engine's key |
| GitHub 403 in freshness.err.log | Anonymous GitHub API rate limit | Ignore unless persistent across days |
| alerts/daily-report ran but nothing in Discord | `DISCORD_WEBHOOK_URL` unset (silent for alerts/freshness; loud only for daily-report --discord) | Check env in the plist/Maester task |
| discovery finds items but structure processes 0, repeatedly | Items stranded with per-item errors | `grep -A2 'failed' logs/content-pipeline.err.log` — per-step tags `[fetch]`/`[classify]`/`[qa-extract]`/`[embed]` name the failing stage |

## Phase 3 — Report

Produce a compact health report in this exact shape:

1. **Verdict line**: `HEALTHY` / `DEGRADED (n issues)` / `BROKEN (job X down since Y)`.
2. **Per-subsystem table**: scheduler / pipelines / DBs / Ollama / mounts / rewrite
   queue — each with ✅/⚠️/❌ and a one-line finding.
3. **Diagnosis** for every ⚠️/❌, citing the signature table row or explaining why
   it's novel.
4. **Proposed fixes**, split into "safe, will do now if you confirm" vs "needs your
   call" (per the escalation rules in CLAUDE.md — launchd changes, deletions, and
   anything outward-facing always need James's call).

**Sharing boundary:** raw log excerpts, draft URLs, and `rewrite_jobs.article_url`
values are fine in the local chat report to James, but if any part of the report
leaves this machine (PR body, GitHub issue, Discord), replace them with counts and
error *signatures* — unpublished draft titles/URLs are pre-publication content.

Do NOT auto-apply fixes in this skill. Triage ends at the report; fixing is a
separate, approved step.
