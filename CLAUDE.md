# mcp-astgl-knowledge — Operating Manual

You are working in production infrastructure. This repo is three systems sharing one
codebase and one database, and mistakes here corrupt a live knowledge base, break a
published npm package, or spam real humans on Telegram/Discord/Substack. Read this
whole file before your first edit.

## What this repo actually is

1. **A published MCP stdio server** (`src/index.ts` → npm package `mcp-astgl-knowledge`,
   registered on Smithery and the MCP registry). 17 tool handlers reading
   `data/knowledge.db`. Consumed by MAESTER (the ClaudeClaw agent) and by strangers on
   the public internet. Rate-limited (50/day anon, 500/day registered).
2. **Content pipelines** that keep `knowledge.db` populated: RSS/sitemap discovery →
   LLM structuring (Ollama), nightly draft ingest + reconciler, nightly SecondBrain
   wiki sync, project-docs ingest.
3. **An AEO ops layer**: query analytics, daily reports, content-gap alerts, freshness
   tracking, automated citation testing (Perplexity/Claude/ChatGPT APIs), and a
   rewrite queue (Ollama draft → Claude polish → Telegram approval → Substack publish).

## System map

### Databases (all in `data/`)

| DB | Written by | Read by | Notes |
|---|---|---|---|
| `knowledge.db` | `ingest.ts` (DESTRUCTIVE rebuild), `knowledge-db.ts` (sanctioned incremental path used by structure/drafts/projects/wiki/freshness/rewrite), `ideas.ts`, `related-articles.ts` | MCP server (read-only), everything else | **Tracked in git and shipped in the npm package.** Committing it is deliberate, not an accident. |
| `query-log.db` | `query-log.ts` (buffered), `rate-limit.ts` | daily-report, alerts, dashboard, ideas | WAL mode; `-wal`/`-shm` sidecars are normal. Gitignored. `content_cited` is JSON `'[]'`, never NULL — claudeclaw reads it. |
| `discovery.db` | `discover.ts` via `discovery-db.ts` | `structure.ts` (opens it raw — known wart) | Crawl queue; `is_new=1` marks unprocessed. Gitignored. |
| `alerts.db` | `alerts.ts` AND `freshness.ts` (duplicate schema, different cooldowns — 24h vs 7d) | same | Alert dedup history. Gitignored. |
| `citation-test.db` | `citation-test.ts`, `citation-test-auto.ts` | same | AEO citation history. Gitignored. |

The `chunks` table holds the prose; `articles` holds metadata only; `vec_chunks` is a
sqlite-vec `vec0` virtual table (`float[768] distance_metric=cosine`) keyed by chunk id.
Search is 100% vector KNN — there is no FTS table.

### Scheduling — the single most misunderstood thing here

- **launchd runs everything.** Plists live in `launchd/` (installed copies in
  `~/Library/LaunchAgents/`). Repo-tracked jobs: content-pipeline (00/06/12/18h),
  draft-pipeline (00:00), wiki-sync (00:30), draft-reconciler (02:00).
- **`cron/*.json` files are NOT crontab entries.** The crontab is empty. They are
  descriptor/runbook files consumed by MAESTER. Editing them changes nothing about
  when code runs.
- Three legacy jobs (daily-report 08:00, content-alerts 09:00, content-freshness
  10:00) were "retired to Maester" but **their plists are still loaded and running**
  from `~/Library/LaunchAgents/` even though removed from this repo.
- launchd jobs execute **`dist/*.js` with node, not `src/*.ts`** — see Mistake #1.
- launchd's default PATH lacks nvm/homebrew. Every plist pins
  `/Users/jamescruce/.nvm/versions/node/v24.14.0/bin` first. Omitting this causes
  `env: node: No such file or directory` (already bitten once — PR #8).

### External dependencies

- **Ollama** at `localhost:11434`: `nomic-embed-text` (all embeddings, 768-dim) and
  `qwen3-coder:30b` (classification + rewrite drafts). `gemma4:26b` was **removed**
  2026-05-19 — never reintroduce it as a default.
- **Anthropic API** (`claude-sonnet-4-6` rewrite polish; `claude-opus-4-7` citation
  tests), **Perplexity** (`sonar`), **OpenAI** (`gpt-4o`) — keys via pass-cli, see Secrets.
- **Telegram bot** (rewrite approvals — shared with claudeclaw), **Discord webhooks**
  (reports/alerts), **Smithery registry** (competitor scan), **npm registry + GitHub
  releases** (freshness, unauthenticated).
- **`/Volumes/Research`** external drive: drafts at `ASTGL Articles/Drafts`, wiki at
  `Brain/SecondBrain/wiki`. May be unmounted — see Mistake #5.
- **Sibling repos referenced by path**: `~/Projects/astgl-site` (ingest source +
  related-links injection), `~/Projects/astgl-articles/substack` (rewrite drafts out),
  `~/Projects/macstudio-openclaw-localllm/scripts/substack-sync/sync_to_substack.py`
  (Substack publisher — hardcoded, no env override), and the voice profile at
  `~/.claude/commands/astgl-publish/voice/humanizer-astgl.md`.

## Conventions — follow these exactly

Established in the codebase (match them; do not "improve" them):

- **Comments**: `// WHAT:` + `// WHY:` pairs on every non-obvious function/module.
  The WHY states the non-obvious reason, often with a date or PR reference when it
  records a decision. Section banners: `// --- Section ---`.
- **Constants**: `SCREAMING_SNAKE_CASE` at module top. No magic numbers inline.
- **Paths**: built with `join(import.meta.dirname, "..", ...)` — never `process.cwd()`,
  never `~` expansion assumptions.
- **Env**: `process.env.X || "default"` read at module top. New vars get a documented
  entry in `.env.example` (placeholder only, never a real value).
- **CLI args**: hand-rolled `process.argv` scanning (`--dry-run`, `--limit N`, …).
  No commander/yargs. Don't add an arg-parsing dependency.
- **Output contract (scripts)**: progress and errors → `console.error` (stderr);
  exactly ONE final `console.log(JSON.stringify(summary))` (stdout). Schedulers and
  MAESTER parse that stdout line. Exit `0` on success, `1` on fatal, via the
  `.then(() => process.exit(0)).catch(err => { console.error(...); process.exit(1); })`
  pattern.
- **Output contract (MCP server path)**: `index.ts` and everything it imports may
  NEVER write to stdout — stdout is the MCP stdio protocol. stderr only.
- **DB access**: readers open `{ readonly: true }`; analytics scripts guard with
  `existsSync` + `sqlite_master` checks and return defaults; core-DB writers fail
  loudly if `knowledge.db` is missing. Multi-table writes go in `db.transaction()`.
- **Migrations**: idempotent, in `knowledge-db.ts` `runMigrations()` only —
  `ALTER TABLE ADD COLUMN` in try/catch, `CREATE TABLE/INDEX IF NOT EXISTS`.
- **Upserts preserve data**: `COALESCE(?, existing)` for fields the caller may omit
  (tags, pub_date, source_origin) so a sparse re-ingest never wipes richer data.
- **Destructive scripts** support `--dry-run` and take a timestamped
  `data/knowledge.db.bak.<reason>-<ISO>` backup before deleting (see reconcile-drafts).
- **Timeouts**: every outbound `fetch` gets `AbortSignal.timeout(...)` — 10–30s for
  embeds/API calls, minutes-scale only for local LLM generation (15 min Ollama draft,
  5 min Claude polish). Some older ingest scripts lack timeouts; new code must not.
- **Retry** only where transient failure is expected AND retry is safe (embeds,
  5xx/429 on external APIs). Never retry a non-idempotent write.

Additional rules (not yet uniform in the codebase, but required for new code):

- New tables/columns are defined in **one place** (`runMigrations()`); other modules
  may not carry their own copy of the DDL.
- Any script that can delete >0 rows must print what it will delete under `--dry-run`
  before a live run is offered.
- A run that errors on **every** item must fail loudly and record nothing — never let
  a fully-broken run enter historical metrics as a legitimate zero (this is the
  citation-test rule from PR #15; it generalizes).

## Mistakes you will make in this repo — named, with the rule that prevents each

**1. The Stale Dist.** You edit `src/`, test with `tsx`, and declare victory — but the
MCP server (`.mcp.json`), launchd jobs, and `rewrite-queue`/`publish-rewrite` all run
compiled `dist/*.js`. This already caused a production bug (`add_idea` ignoring
`priority`; see `tasks/todo.md`).
→ **Rule: any change under `src/` that a server or scheduled job executes is not done
until `npm run build` has run and you've stated which runtime (tsx vs dist) you
verified against.**

**2. The Destructive Refresh.** You "rebuild the knowledge base" with `npm run ingest`.
It `DROP TABLE`s articles/chunks/vec_chunks and rebuilds **only** from astgl-site
markdown — silently destroying everything added by discovery, drafts, projects, and
wiki sync (the DB grew 8 MB → 50 MB from those sources; ingest would torch it).
→ **Rule: never run `npm run ingest` (or any DROP) against `data/knowledge.db` without
(a) a fresh timestamped backup, (b) explicit approval from James in this session, and
(c) a stated plan to re-run every incremental pipeline afterward. Incremental fixes go
through `knowledge-db.ts` upserts instead.**

**3. The Cron Mirage.** Something runs at the wrong time, so you edit `cron/*.json`
or add a crontab entry. Nothing changes (descriptors), or you've created a duplicate
scheduler (crontab).
→ **Rule: schedules live in launchd plists. A schedule change = edit the plist in
`launchd/`, copy to `~/Library/LaunchAgents/`, `launchctl bootout` + `bootstrap`,
smoke-test with `kickstart -k`, AND update the matching `cron/*.json` descriptor so
MAESTER's runbook stays true. Never touch crontab.**

**4. The Naked Vector Delete.** You delete rows from `chunks` (or `INSERT OR REPLACE`
into it) directly. sqlite-vec has no cascading deletes and no REPLACE support —
`vec_chunks` now holds orphaned embeddings that silently pollute every search.
→ **Rule: all chunk mutations go through `replaceChunksForArticle()` /
`deleteArticle()` in `knowledge-db.ts`, which delete `vec_chunks` by chunk id inside a
transaction. Raw SQL against `chunks`/`vec_chunks` is read-only, always.**

**5. The Phantom Deletion.** `/Volumes/Research` is unmounted; every draft/wiki source
"looks deleted"; a reconciler-style sweep retires the entire index.
→ **Rule: preserve and replicate the mount guards — `sync-wiki.ts` exits 0 with
`{skipped: true, reason: "volume_unmounted"}` (optional sync), `reconcile-drafts.ts`
refuses with exit 1 (destructive). Any new code reading `/Volumes/Research` must guard
the same way, and you may never weaken an existing guard to "make the pipeline pass."**

**6. The Helpful console.log.** You add debug prints. In `index.ts`'s import graph
that corrupts the MCP stdio protocol; in pipeline scripts it corrupts the
one-JSON-line stdout contract that launchd logs and MAESTER parse.
→ **Rule: stderr for anything human-readable. stdout is protocol (server) or the
single final JSON summary (scripts). Nothing else, ever.**

**7. The Trusting Reader.** You quote README.md ("7 tools", env table), `server.json`
(v1.1.0), or the retired-jobs note as current. All are stale: the server registers 17
handlers, package.json is v1.2.0, the "retired" plists still run.
→ **Rule: for any factual claim about this system, the code and `launchctl list` are
the source of truth. If you catch a doc being stale, flag it — don't silently trust or
silently fix without noting it.**

**8. The Second Schema.** You alter the `ideas` table in `knowledge-db.ts` but not the
duplicate DDL in `ideas.ts` (or `alert_history` in `alerts.ts` but not `freshness.ts`).
`CREATE TABLE IF NOT EXISTS` never errors — the copies silently diverge.
→ **Rule: before changing any table, `grep -rn "<table_name>" src/` and update every
definition and every query that touches it. Prefer consolidating the duplicate into
one module while you're there.**

**9. The Secret Shortcut.** You need an API key, so you read `.env`, echo it, paste it
into a command, or hardcode a fallback.
→ **Rule: secret-bearing scripts run via `pass-cli run --env-file .env -- …` (see
package.json). Never print env values, never commit `.env`, new secrets get a
placeholder line in `.env.example` and go into pass. `.env` values may be referenced,
never displayed.**

**10. The Blanket Commit.** You `git add -A` and sweep in `data/*.bak.*`, WAL sidecars,
logs, or an unintended 50 MB `knowledge.db` change.
→ **Rule: stage files by name. A `knowledge.db` commit is a deliberate release act
(it ships in the npm package) — call it out in the commit message and PR body. If the
diff shows `data/` changes you didn't intend, stop and ask.**

**11. The Forced Duplicate.** You re-queue a rewrite with
`--article-url` "to be safe" — that flag bypasses the pending-approval/cooldown guard
and creates a duplicate Telegram approval for the same article.
→ **Rule: before any manual `rewrite-queue` run, check
`SELECT article_url, status FROM rewrite_jobs WHERE status IN ('pending_approval','approved')`
and don't force a URL that's already in flight.**

**12. The Cost-Blind Loop.** You "verify" by running `structure`, `rewrite-queue`, or
`citation-test-auto` repeatedly. These burn real GPU minutes, paid API tokens
(Perplexity/Anthropic/OpenAI), and can send real Telegram/Discord messages.
→ **Rule: verify with `--dry-run` / `--limit 1` / a copy of the DB first. Anything
that posts to Telegram, Discord, or Substack is outward-facing — one deliberate run,
never a retry loop.**

## Quality bar — checkable, per deliverable

**Any code change (baseline):**
- [ ] `npm run build` passes (tsc strict — this is the only compile gate; there are no tests or linter yet).
- [ ] New/changed functions carry `WHAT:`/`WHY:` comments; constants named, no magic numbers.
- [ ] Every new `fetch` has a timeout; every multi-table write is in a transaction.
- [ ] stdout/stderr contract intact (grep your diff for `console.log` outside the summary line).
- [ ] Verified against the runtime that production uses (dist for server/launchd paths), and the verification is stated in the PR, not implied.

**Pipeline script (new or changed):**
- [ ] Supports `--dry-run` if it can delete or mutate; dry-run output names the exact rows/files affected.
- [ ] Idempotent: running it twice produces the same end state (upserts, not blind inserts).
- [ ] Mount/dependency guards for anything under `/Volumes` or sibling repos; skip-vs-fail semantics chosen deliberately (optional → exit 0 `skipped:true`; destructive prerequisite missing → exit 1).
- [ ] Single JSON summary on stdout with counts for every branch (processed / skipped-why / failed-why).
- [ ] A fully-failed run records nothing and exits 1.

**MCP server surface (tools in `index.ts`):**
- [ ] Input validated with zod; no unguarded `JSON.parse` of caller input.
- [ ] Rate-limit enforcement precedes the tool body; every call logged via `logQuery` with `content_cited` as JSON array (`'[]'` when none — never NULL; claudeclaw depends on this).
- [ ] Tool errors return an error payload, they don't throw the server down.
- [ ] No PII/secrets in any tool output (public-facing).
- [ ] README tool table updated in the same PR, and version bumped + `server.json` synced if the public surface changed.

**Schema change:**
- [ ] Defined once in `runMigrations()`, idempotent, safe against a DB that already has it AND against a freshly-ingested DB missing it.
- [ ] `grep -rn` for the table across `src/` done; all duplicate DDL and queries updated.
- [ ] Upsert paths COALESCE new columns so old callers can't null them out.
- [ ] Tested on a **copy** of the production DB (`cp data/knowledge.db /tmp/…` — copy the `-wal`/`-shm` sidecars too if present), not on the live file.

**New scheduled job:**
- [ ] Script meets the pipeline bar above; plist pins the nvm PATH, sets WorkingDirectory, routes stdout/stderr to `logs/<name>.log`/`.err.log` (gitignored).
- [ ] Matching `cron/<name>.json` descriptor written for MAESTER.
- [ ] Installed via bootout/bootstrap; smoke-tested with `launchctl kickstart -k` and the log tail pasted into the PR.
- [ ] Runs against `dist/` (built), not `tsx`.

**PR (Ironclad Phase 4 applies — see global CLAUDE.md):**
- [ ] Branch, conventional commits, atomic; no `--no-verify`.
- [ ] PR body states: what changed, how it was verified (command + observed output), and any deviation from plan.
- [ ] Every CodeRabbit/human review thread implemented or answered-and-resolved before merge.
- [ ] `/gstack-cso` security pass for anything touching the public tool surface, rate limiting, or secrets.

## When uncertain — escalation rules

**Proceed without asking** (reversible, on-branch):
reading any file or DB (read-only queries), `--dry-run` runs, `npm run build`,
editing code on a feature branch, creating backups, `launchctl list`/log tails,
queries against a *copy* of a DB.

**Proceed, but say what you did and why in your report:**
choosing between two established patterns (e.g. skip-vs-fail exit semantics),
touching a stale doc alongside a code change, adding an env var (with `.env.example`
entry), single `--limit 1` live pipeline runs that don't message humans.

**Stop and ask James first — no exceptions:**
- Anything matching Mistake #2 (destructive DB operations, DROP, bulk DELETE, or
  running `npm run ingest`).
- Installing/removing/bootout of launchd jobs, or changing a schedule.
- Any run that will post to Telegram, Discord, or Substack, or send email.
- `npm publish`, version bumps intended for release, or changes to the public rate
  limits / registration flow.
- Deleting or rotating secrets; touching `~/Library/LaunchAgents` for the retired
  jobs; pruning `data/*.bak.*` files.
- Any operation on the sibling repos (`astgl-site`, `astgl-articles`,
  `macstudio-openclaw-localllm`) beyond reading them.
- You found evidence that contradicts this manual or the task's premise (e.g. a
  "deleted" thing that still exists). Surface the contradiction; don't pick silently.

**When the answer might be "it depends on data you can't see"** (Substack conventions,
what "published" means, which channel an article belongs to): open one real example
from the actual data before designing anything — this is the standing lesson in
`tasks/lessons.md` (the draft-reconciler false-match near-miss).

## Known drift (verified 2026-07-07 — fix opportunistically, never trust)

- README.md: tool list (7 vs 17 registered), env-var table, jobs table all stale.
- `server.json` says v1.1.0; package.json is v1.2.0 (registry manifest drift).
- PRs #10, #13, #14 show OPEN on GitHub but their commits are already in main.
- Retired plists (daily-report, content-alerts, content-freshness) still loaded in
  launchd alongside their Maester replacements.
- `ASTGL_DRAFTS_DIR` defaults diverge: ingest/reconcile → `/Volumes/Research/ASTGL
  Articles/Drafts`; rewrite-queue/.env.example → `~/Projects/astgl-articles/substack`.
  Set the env var explicitly; never rely on the default.
- `.claude/settings.local.json` embeds a literal Asana PAT in an allow rule
  (gitignored, but should move to pass).
- `data/*.bak.*` backups accumulate unbounded (~200 MB and growing).

## gstack

This project uses [gstack](https://github.com/garrytan/gstack) for AI-assisted
workflows. Skills are installed under `~/.claude/skills/` with the `gstack-` prefix.
To install on a new machine:

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

**Learnings:** project-specific operational learnings persist at
`~/.gstack/projects/mcp-astgl-knowledge/learnings.jsonl` and are auto-surfaced in
skill preambles.

## Project skills (repo-local)

Distinct from the gstack suite above (which is installed globally at
`~/.claude/skills/` with the `gstack-` prefix), these are committed in this repo
under `.claude/skills/`:

- `/astgl-ops-triage` — pipeline health diagnosis: read-only sweep + known-failure
  signature table.
- `/astgl-new-job` — scaffold and ship a scheduled job end-to-end: script contract →
  plist → Maester descriptor → bootstrap + smoke test.
- `/astgl-db-surgeon` — safe `knowledge.db` operations: integrity checks, article
  retirement, re-index routing, WAL checkpoints, backup management.
