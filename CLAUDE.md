# mcp-astgl-knowledge — Operating Manual

You are working in production infrastructure: three systems sharing one codebase and one
database. Mistakes here corrupt a live knowledge base, break a published npm package, or
spam real humans on Telegram/Discord/Substack. Read this whole file before your first edit.

## What this repo actually is

1. **A published MCP stdio server** (`src/index.ts` → npm package `mcp-astgl-knowledge`,
   on the MCP registry; **not on Smithery**, though `npm run build-mcpb` builds an MCPB
   bundle for it). 17 tool handlers reading `data/knowledge.db`. Consumed by MAESTER (the
   ClaudeClaw agent) and by strangers on the public internet. Rate-limited (50/day anon,
   500/day registered).
2. **Content pipelines** that keep `knowledge.db` populated: RSS/sitemap discovery → LLM
   structuring (Ollama), nightly draft ingest + reconciler, nightly SecondBrain wiki sync,
   project-docs ingest.
3. **An AEO ops layer**: query analytics, daily reports, content-gap alerts, freshness
   tracking, automated citation testing (Perplexity/Claude/ChatGPT APIs), and a rewrite
   queue (Ollama draft → Claude polish → Telegram approval → Substack publish).

## System map

### Databases (all in `data/`)

| DB | Written by | Read by | Notes |
|---|---|---|---|
| `knowledge.db` | `ingest.ts` (DESTRUCTIVE rebuild), `knowledge-db.ts` (sanctioned incremental path used by structure/drafts/projects/wiki/freshness/rewrite), `ideas.ts`, `related-articles.ts` | MCP server (read-only), everything else | Tracked in git at a deliberately stale revision. **Not shipped** since 2026-07-29: the package ships the pruned `build/knowledge-public.db` instead (ADR-0001). |
| `build/knowledge-public.db` | `build-public-db.ts` only | the published npm package | **Gitignored build artifact, regenerated on every publish.** Contains only `public = 1` rows. Never commit it. |
| `query-log.db` | `query-log.ts` (buffered), `rate-limit.ts` | daily-report, alerts, dashboard, ideas | **WAL journal mode, pinned in code at open**; `-wal`/`-shm` sidecars are normal. Gitignored. `content_cited` is JSON `'[]'`, never NULL — claudeclaw reads it. |
| `discovery.db` | `discover.ts` via `discovery-db.ts` | `structure.ts` (opens it raw — known wart) | Crawl queue; `is_new=1` marks unprocessed. Gitignored. |
| `alerts.db` | `alerts.ts` AND `freshness.ts` (duplicate schema, different cooldowns — 24h vs 7d) | same | Alert dedup history. Gitignored. |
| `citation-test.db` | `citation-test.ts`, `citation-test-auto.ts` | same | AEO citation history. Gitignored. |

`chunks` holds the prose; `articles` holds metadata only; `vec_chunks` is a sqlite-vec
`vec0` virtual table (`float[768] distance_metric=cosine`) keyed by chunk id. Search is
100% vector KNN — there is no FTS table.

### Scheduling — launchd, not cron

- **launchd runs everything.** Plists live in `launchd/` (installed copies in
  `~/Library/LaunchAgents/`): content-pipeline (00/06/12/18h), draft-pipeline (00:00),
  wiki-sync (00:30), draft-reconciler (02:00). Their stdout/stderr go to
  `~/Library/Logs/mcp-astgl-knowledge/` on the home volume (launchd cannot open log paths
  inside the external-volume repo, `EX_CONFIG`); create that directory before installing.
- **`cron/*.json` files are NOT crontab entries.** The crontab is empty; they are
  descriptor/runbook files consumed by MAESTER. Editing them changes nothing about when
  code runs.
- The legacy daily-report / content-alerts / content-freshness jobs were retired to Maester;
  their plists are archived in `~/Library/LaunchAgents.retired/`. Both channels share
  `alerts.db` cooldowns, so whichever scheduler fires first claims the alerts.
- launchd jobs execute **`dist/*.js` with node, not `src/*.ts`** (Mistake #1). Every plist
  pins `/Users/jamescruce/.nvm/versions/node/v24.14.0/bin` first in PATH; omitting it
  causes `env: node: No such file or directory`.

### External dependencies

- **Ollama** at `localhost:11434`: `nomic-embed-text` (all embeddings, 768-dim) and
  `qwen3-coder:30b` (classification + rewrite drafts). `gemma4:26b` was **removed**; never
  reintroduce it as a default.
- **Anthropic API** (`claude-sonnet-4-6` rewrite polish; `claude-opus-4-7` citation tests),
  **Perplexity** (`sonar`), **OpenAI** (`gpt-4o`): keys via pass-cli (Mistake #9).
- **Telegram bot** (rewrite approvals, shared with claudeclaw), **Discord webhooks**,
  **Smithery registry** (competitor scan), **npm registry + GitHub releases** (freshness).
- **`/Volumes/Research`** external drive: drafts at `Publishing/ASTGL/Articles/Drafts`, wiki
  at `Brain/SecondBrain/wiki`. May be unmounted (Mistake #5).
- **Sibling repos referenced by path**: `~/Projects/astgl-site` (ingest source +
  related-links injection), `~/Projects/astgl-articles/substack` (rewrite drafts out),
  `~/Projects/macstudio-openclaw-localllm/scripts/substack-sync/sync_to_substack.py`
  (Substack publisher, hardcoded), and `~/.claude/commands/astgl-publish/voice/humanizer-astgl.md`.

## Conventions — follow these exactly; do not "improve" them

- **Comments**: `// WHAT:` + `// WHY:` pairs on every non-obvious function/module; section
  banners `// --- Section ---`. **Constants**: `SCREAMING_SNAKE_CASE` at module top, no
  magic numbers inline.
- **Paths**: `join(import.meta.dirname, "..", ...)`; never `process.cwd()`, never `~`.
- **Env**: `process.env.X || "default"` at module top; new vars get a placeholder entry in
  `.env.example`, never a real value. **CLI args**: hand-rolled `process.argv` scanning; no
  arg-parsing dependency.
- **Output contract (scripts)**: progress and errors → stderr; exactly ONE final
  `console.log(JSON.stringify(summary))` on stdout, which schedulers and MAESTER parse.
  Exit `0` on success, `1` on fatal.
- **Output contract (MCP server path)**: `index.ts` and everything it imports may NEVER
  write to stdout — stdout is the MCP stdio protocol. stderr only.
- **DB access**: readers open `{ readonly: true }`; analytics scripts guard with `existsSync`
  + `sqlite_master` checks and return defaults; core-DB writers fail loudly if `knowledge.db`
  is missing. Multi-table writes go in `db.transaction()`.
- **Migrations**: idempotent, in `knowledge-db.ts` `runMigrations()` ONLY (`ALTER TABLE ADD
  COLUMN` in try/catch, `CREATE … IF NOT EXISTS`); no other module carries its own DDL.
  **Upserts preserve data**: `COALESCE(?, existing)` for fields the caller may omit.
- **Destructive scripts** support `--dry-run` that names the exact rows/files, and take a
  timestamped `data/knowledge.db.bak.<reason>-<ISO>` backup first. Only
  `npm run prune-backups` removes backups, and that is stop-and-ask: show James the dry run
  and get approval before `--apply` (policy: `docs/backup-retention.md`).
- **Timeouts**: every outbound `fetch` gets `AbortSignal.timeout(...)` (10–30s for
  embeds/API calls; minutes only for local LLM generation). **Retry** only where failure is
  transient AND retry is safe; never retry a non-idempotent write.
- **A run that errors on every item fails loudly and records nothing.** When a writer starts
  marking rows invalid, every reader that aggregates that table skips them in the same PR
  (`src/citation-error-rows.ts` owns the marker for both sides). A rate over an empty
  denominator is `null`, never `0%`.

## Mistakes you will make here — numbered; `src/` comments cite these numbers

1. **The Stale Dist.** The MCP server (`.mcp.json`), launchd jobs, `rewrite-queue` and
   `publish-rewrite` run compiled `dist/*.js`, not `tsx`. → A change under `src/` that a
   server or job executes is not done until `npm run build` has run and you have stated
   which runtime (tsx vs dist) you verified against.
2. **The Destructive Refresh.** `npm run ingest` `DROP TABLE`s articles/chunks/vec_chunks
   and rebuilds only from astgl-site markdown, destroying everything discovery, drafts,
   projects and wiki sync added. → Never run `npm run ingest` (or any DROP) against
   `data/knowledge.db` without (a) a VERIFIED timestamped restore point (`PRAGMA
   integrity_check` ok, article count matches live, content hash identical, whole
   `sqlite_master` schema matches — the standard `src/prune-backups.ts` implements), (b)
   explicit approval from James in this session, and (c) a stated plan to re-run every
   incremental pipeline afterward. Incremental fixes go through `knowledge-db.ts` upserts.
3. **The Cron Mirage.** → Schedules live in launchd plists. A schedule change = edit the
   plist in `launchd/`, copy to `~/Library/LaunchAgents/`, `launchctl bootout` +
   `bootstrap`, smoke-test with `kickstart -k`, AND update the matching `cron/*.json`
   descriptor so MAESTER's runbook stays true. Never touch crontab.
4. **The Naked Vector Delete.** sqlite-vec has no cascading deletes and no REPLACE
   support; deleting from `chunks` directly leaves orphaned embeddings that pollute every
   search. → All chunk mutations go through `replaceChunksForArticle()` / `deleteArticle()`
   in `knowledge-db.ts`, which delete `vec_chunks` by chunk id in a transaction. Raw SQL
   against `chunks`/`vec_chunks` is read-only, always.
5. **The Phantom Deletion.** `/Volumes/Research` unmounted makes every draft/wiki source
   "look deleted". → Preserve and replicate the mount guards: `sync-wiki.ts` exits 0 with
   `{skipped: true, reason: "volume_unmounted"}` (optional sync); `reconcile-drafts.ts`
   refuses with exit 1 (destructive). New code reading `/Volumes/Research` guards the same
   way; never weaken an existing guard to make a pipeline pass.
6. **The Helpful console.log.** → stderr for anything human-readable. stdout is protocol
   (server) or the single final JSON summary (scripts). Nothing else, ever.
7. **The Trusting Reader.** README.md and `server.json` have drifted from the code before.
   → For any factual claim about this system, the code and `launchctl list` are the source
   of truth. Flag a stale doc; never silently trust it or silently fix it.
8. **The Second Schema.** `CREATE TABLE IF NOT EXISTS` never errors, so duplicate DDL
   (`alert_history` in `alerts.ts` and `freshness.ts`) silently diverges. → Before changing
   any table, `grep -rn "<table_name>" src/` and update every definition and query;
   consolidate the duplicate while you are there.
9. **The Secret Shortcut.** → Secret-bearing scripts run via `pass-cli run --env-file .env
   -- …` (see package.json). Never print env values, never commit `.env`; new secrets get a
   placeholder in `.env.example` and go into pass. `.env` values may be referenced, never
   displayed.
10. **The Blanket Commit.** → Stage files by name; if the diff shows `data/` changes you
    did not intend, stop and ask. **NEVER commit `data/knowledge.db`: this repository is
    PUBLIC and the working copy holds rows the publication gate exists to withhold.** The
    gate guards npm, not git; the tracked copy is deliberately stale, and that staleness is
    what keeps withheld rows out of public history, so leave it stale. A fresh clone serves
    the stale copy until the incremental pipelines (`npm run sync-wiki`, `ingest-drafts`,
    `ingest-projects`, `structure`) repopulate it or a populated database is copied in;
    never solve a stale clone with `npm run ingest` (Mistake #2 applies in full) or by
    committing the result. If asked to commit the database, get an explicit decision; do
    not infer consent from "commit the changes". Do not describe the attributes of withheld
    rows anywhere in this public repo. Details: `docs/publication-gate.md`.
11. **The Forced Duplicate.** `rewrite-queue --article-url` bypasses the pending-approval/
    cooldown guard and creates a duplicate Telegram approval. → Before any manual
    `rewrite-queue` run, check `SELECT article_url, status FROM rewrite_jobs WHERE status IN
    ('pending_approval','approved')` and do not force a URL already in flight.
12. **The Cost-Blind Loop.** `structure`, `rewrite-queue` and `citation-test-auto` burn GPU
    minutes, paid API tokens, and can message real humans. → Verify with `--dry-run` /
    `--limit 1` / a copy of the DB first. Anything that posts to Telegram, Discord or
    Substack gets one deliberate run, never a retry loop.
13. **The Patched Instance.** Each fix is correct; the sequence is the failure. → After the
    FIRST instance of a defect class, name the class out loud and grep for every member
    before pushing. Fixes that narrow a window instead of shutting it mean the artifact is
    wrong, not the implementation (`docs/incident-notes.md`).

## Quality bar — checkable, per deliverable

- **Any code change:** `npm run build` (tsc strict) **and `npm test`** (node:test via tsx;
  `test/` sits outside `tsconfig` `rootDir`) both pass; CI asserts both. No TypeScript linter
  is configured (no lint script); lefthook still lints shell, YAML and workflows on commit
  and runs `typecheck-node` + `tests-node` on push, so a fresh worktree needs `npm ci` first. WHAT/WHY comments, named constants; every new `fetch` timed out; every
  multi-table write in a transaction; stdout/stderr contract intact (grep your diff for
  `console.log` outside the summary line); defect class swept (Mistake #13); verified
  against the runtime production uses, with the verification stated in the PR.
- **Pipeline script:** `--dry-run` if it can delete or mutate, and its output names the
  exact rows/files affected; any script that can delete >0 rows prints what it will delete
  under `--dry-run` before a live run is offered; idempotent; mount/dependency
  guards for anything under `/Volumes` or sibling repos, skip-vs-fail chosen deliberately
  (optional → exit 0 `skipped:true`; destructive prerequisite missing → exit 1); single JSON
  summary with counts for every branch; a fully-failed run records nothing and exits 1.
- **MCP server surface (`index.ts`):** zod-validated input, no unguarded `JSON.parse`;
  rate-limit enforcement before the tool body; every call logged via `logQuery` with
  `content_cited` as a JSON array (`'[]'` when none, never NULL); tool errors return a
  payload, never throw the server down; no PII/secrets in output; README tool table updated
  in the same PR, version bumped and `server.json` + `mcpb/manifest.json` synced if the
  public surface changed.
- **Schema change:** defined once in `runMigrations()`, idempotent against a DB that has it
  AND a fresh one; `grep -rn` across `src/` done; upsert paths COALESCE new columns; tested
  on a **copy** of the production DB (copy the `-wal`/`-shm` sidecars too), never the live file.
- **New scheduled job:** meets the pipeline bar; plist pins the nvm PATH, sets
  WorkingDirectory, logs to `~/Library/Logs/mcp-astgl-knowledge/<name>.log` /
  `<name>.err.log`; matching `cron/<name>.json` descriptor; installed via
  bootout/bootstrap; non-stateful jobs may be smoke-tested with `kickstart -k`, but stateful
  indexers and reconcilers are never replayed: verify registration and the next real
  calendar fire, and include the log evidence in the PR or follow-up; runs against `dist/`.
- **PR (Ironclad applies; see global CLAUDE.md):** branch, conventional commits, atomic;
  no `--no-verify`; body states what changed, how it was verified (command + observed
  output) and any deviation; every review thread implemented or answered-and-resolved
  before merge; `/gstack-cso` for anything touching the public tool surface,
  rate limiting, or secrets.

## When uncertain — escalation rules

**Proceed without asking** (reversible, on-branch): reading any file or DB, `--dry-run`
runs, `npm run build`, editing code on a feature branch, creating backups,
`launchctl list`/log tails, queries against a *copy* of a DB.

**Proceed, but say what you did and why:** choosing between two established patterns
(e.g. skip-vs-fail exit semantics), touching a stale doc alongside a code change, adding
an env var (with `.env.example` entry), single `--limit 1` live runs that don't message humans.

**Stop and ask James first — no exceptions:**
- Anything matching Mistake #2 (destructive DB operations, DROP, bulk DELETE, `npm run ingest`).
- Installing/removing/bootout of launchd jobs, or changing a schedule.
- Any run that will post to Telegram, Discord, or Substack, or send email.
- `npm publish`, version bumps intended for release, or changes to the public rate limits /
  registration flow.
- Deleting or rotating secrets; touching the archived plists in `~/Library/LaunchAgents.retired/`
  (they still embed the Discord webhook URL); pruning `data/*.bak.*` files.
- Any operation on the sibling repos (`astgl-site`, `astgl-articles`,
  `macstudio-openclaw-localllm`) beyond reading them.
- Evidence that contradicts this manual or the task's premise. Surface it; don't pick silently.

**When the answer might depend on data you can't see** (Substack conventions, what
"published" means, which channel an article belongs to): open one real example from the
actual data before designing anything (`tasks/lessons.md`).

## Read when touching these areas

- **Publication gate** — `docs/publication-gate.md` (ADR-0001:
  `docs/adr/0001-knowledge-db-keeps-its-own-index.md`). Rules that hold everywhere: never
  add `data/knowledge.db` back to `package.json` `files`; never resolve a DB path directly,
  use `src/db-path.ts` (`resolveKnowledgeDbPath`, `resolveQueryLogDbPath`); `prepack` runs
  build → reclassify → prune and is never reordered; `getSnapshot`/`upsertSnapshot` and the
  `ecosystem_snapshots` DDL live ONLY in `knowledge-db.ts`; `npm pack` does not run
  `prepublishOnly`, which is why the gate chain lives in `prepack`.
- **MCPB bundle** — `docs/mcpb-bundle.md`. Run it via `npm run build-mcpb`; bare
  `tsx src/build-mcpb.ts` is unsupported on every platform. A bundle is valid only on the
  platform that built it; `package.json`, `mcpb/manifest.json` and `server.json` stay in
  step (all 1.3.1 as of 2026-10-20). A red `build-mcpb` on main is stale until its run SHA
  is compared against `main`; the workflow runs only on dispatch and release.
- **Backups** — `docs/backup-retention.md`: schema age, not calendar age, is the expiry.
- **Known drift** — `docs/known-drift.md` (dated; fix opportunistically, never trust).
  Standing items: set `ASTGL_DRAFTS_DIR` explicitly (the historical default divergence is
  resolved: `ingest-drafts`, `reconcile-drafts` and `rewrite-queue` now share one default);
  `overrides: { tmp }` in package.json is a workaround to remove once mcpb's chain allows
  tmp ≥ 0.2.6 (check with `npm audit`, not version numbers); Asana is retired here.

## Skills

Project skills, committed under `.claude/skills/`: `/astgl-ops-triage` (pipeline health:
read-only sweep + known-failure signature table), `/astgl-new-job` (scaffold and ship a
scheduled job end-to-end), `/astgl-db-surgeon` (safe `knowledge.db` operations). gstack
routing: `/gstack-cso` (this is public-facing infrastructure), `/gstack-ship`,
`/gstack-review`, `/gstack-investigate`, `/gstack-office-hours`; `/browse` for web work.
