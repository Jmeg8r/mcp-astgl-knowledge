# mcp-astgl-knowledge — Operating Manual

You are working in production infrastructure. This repo is three systems sharing one
codebase and one database, and mistakes here corrupt a live knowledge base, break a
published npm package, or spam real humans on Telegram/Discord/Substack. Read this
whole file before your first edit.

## What this repo actually is

1. **A published MCP stdio server** (`src/index.ts` → npm package `mcp-astgl-knowledge`,
   registered on the MCP registry at 1.3.0. **NOT on Smithery** — the earlier claim here
   was wrong; search returns nothing and every qualified-name probe 404s. An MCPB bundle
   for Smithery is built by `npm run build-mcpb` but has not been published). 17 tool
   handlers reading
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
| `knowledge.db` | `ingest.ts` (DESTRUCTIVE rebuild), `knowledge-db.ts` (sanctioned incremental path used by structure/drafts/projects/wiki/freshness/rewrite), `ideas.ts`, `related-articles.ts` | MCP server (read-only), everything else | Tracked in git. **NO LONGER SHIPPED** — as of 2026-07-29 the package ships the pruned `build/knowledge-public.db` instead (ADR-0001). |
| `build/knowledge-public.db` | `build-public-db.ts` only | the published npm package | **Gitignored build artifact, regenerated on every publish.** Contains only `public = 1` rows. Never commit it — two databases in the repo can disagree. |
| `query-log.db` | `query-log.ts` (buffered), `rate-limit.ts` | daily-report, alerts, dashboard, ideas | **WAL journal mode, pinned in code at open** (#48, 2026-08-01) — `-wal`/`-shm` sidecars are normal. #47's brief "`delete`, NOT WAL" correction here had measured a *fresh* database (any checkout whose gitignored `data/` lacks the file — a worktree, a clone), which came up in rollback mode precisely because nothing pinned it; the production file's header and its live sidecars read WAL. That unpinned-fresh-file divergence is what #48 closes. Gitignored. `content_cited` is JSON `'[]'`, never NULL — claudeclaw reads it. |
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
  10:00) were retired to Maester (Telegram via claudeclaw). Their still-installed
  plists kept firing `--discord` until 2026-07-26, when they were booted out and
  archived in `~/Library/LaunchAgents.retired/`. The gotcha that made this urgent:
  both channels share `alerts.db` cooldowns, so whichever scheduler fires first
  claims the alerts — the Discord jobs (:00 sharp) were suppressing Maester's
  Telegram alerts (:00 + ~40s) every day.
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
- **`/Volumes/Research`** external drive: drafts at `Publishing/ASTGL/Articles/Drafts`, wiki at
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
  Nothing ever prunes these — see *Backup retention* below.
- **Timeouts**: every outbound `fetch` gets `AbortSignal.timeout(...)` — 10–30s for
  embeds/API calls, minutes-scale only for local LLM generation (15 min Ollama draft,
  5 min Claude polish). Some older ingest scripts lack timeouts; new code must not.
- **Retry** only where transient failure is expected AND retry is safe (embeds,
  5xx/429 on external APIs). Never retry a non-idempotent write.

### Backup retention (added 2026-07-31)

Every destructive script snapshots `data/knowledge.db` (~80 MB each) and **nothing ever
deletes one**. That is deliberate — they are the last-resort restore point for exactly the
mistakes this manual exists to prevent — but it grew to 8 files and 323 MB before anyone
looked.

**Use `npm run prune-backups`** (dry run by default; `--apply` to delete). It takes a
verified checkpoint first, then removes only backups that fail the rule below. Deleting
backups is **stop-and-ask** — show James the dry-run output and get approval before
`--apply`.

The policy it enforces: a backup is an eligible restore point only if it satisfies
**both** conditions, not either —

1. it is the fresh checkpoint, **or** younger than `--keep-days` (default 30); **and**
2. its `articles` schema matches the live database.

**Schema age is the real expiry, not calendar age.** A backup taken 10 days ago but before
a migration 5 days ago passes the age test and is still useless — restoring it rolls the
schema back. The 8 files pruned on 2026-07-31 were all pre-`public` column: any restore
would have lost the entire publication gate plus two weeks of content. A backup older than
your last schema migration is a rollback wearing a backup's filename.

→ **Rule: do not re-implement this by hand.** The bash recipe this replaced took eleven
review findings across four rounds, three of which shell could not fix at all — `lsof`
observes writers rather than excluding them, delimiter-joined schema signatures collide,
and a failed shell query returns `""` which compares equal to another `""`. The script
holds `BEGIN EXCLUSIVE` across the copy, compares schemas structurally, and treats an
unreadable backup as never-matching. See `src/prune-backups.ts` and its tests.

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
(a) a VERIFIED timestamped restore point, (b) explicit approval from James in this
session, and (c) a stated plan to re-run every incremental pipeline afterward.
Incremental fixes go through `knowledge-db.ts` upserts instead.**

"Verified" is the standard `src/prune-backups.ts` implements — `PRAGMA integrity_check`
returns `ok`, the copy's article count matches live, its content hash is byte-identical,
and its **whole** `sqlite_master` schema matches (not `pragma_table_info('articles')`
alone; a change to `chunks`, `vec_chunks`, `ideas`, `rewrite_jobs` or
`ecosystem_snapshots` is invisible to a single-table check). A copy that has not passed
those four is a restore point you have assumed, and the day you need it is the day the
assumption was wrong. Eligibility is a conjunction, not a
choice: **(newest checkpoint OR within `--keep-days`, default 30) AND all four checks
above**, schema compatibility included. The newest checkpoint is not exempt — it is the
most likely candidate, not an automatically valid one. See *Backup retention*.

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

**7. The Trusting Reader.** You quote README.md ("7 tools", env table) or `server.json`
(v1.1.0) as current. Both are stale: the server registers 17 handlers and package.json
is v1.2.0.
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
logs, or an unintended 80 MB `knowledge.db` change.
→ **Rule: stage files by name. If the diff shows `data/` changes you didn't intend, stop
and ask.**

→ **Rule: NEVER commit `data/knowledge.db`. This repository is PUBLIC, and the working
copy holds hundreds of rows the publication gate exists to withhold.** Measured
**2026-07-31** (later than ADR-0001's 469/471-article figures elsewhere in this file and
in the ADR itself — the database grows daily, so any two counts written on different days
will disagree and neither is wrong): 475 articles, of which **178 are `public = 1` and 297
are withheld** — 206
unpublished drafts in full searchable text, 85 non-allowlisted entities, 6
internal-jargon concepts, as of that date — read every count here as a timestamp, not a
constant. Three of the four pages ADR-0001 called out are among the withheld; **do not
restate what makes them sensitive in this file.** CLAUDE.md is itself public, so
describing the attributes of withheld rows re-discloses exactly what withholding them was
meant to prevent. The categories above are the right level of detail here.

(The fourth, `OpenClaw`, was allowlisted and shipped in npm 1.3.0, but was **removed from
`src/public-allowlist.ts` on 2026-07-31** — ADR-0001's "it is retired" justification was
stale on inspection. It is withheld from the next publish
onward; 1.3.0 is immutable and still carries it. Noted so nobody re-reads the ADR's table as
four uniformly-withheld pages, as this rule's first draft did.)

**The gate guards npm, not git.** ADR-0001 reasoned carefully about the tarball —
`package.json` `files` ships `build/knowledge-public.db`, and `prepack` runs the prune —
and never addressed the second channel. Committing `data/knowledge.db` walks straight
past all of it, into public history, permanently. The file is still *tracked* at an old
144-article revision from 2026-07-13; **leave it stale.** That staleness is load-bearing
rather than neglect — it is the only thing keeping the withheld rows out of public
history.

But it is NOT inert. `resolveKnowledgeDbPath()` returns `data/knowledge.db` whenever it
exists and only falls back to the pruned artifact otherwise, so **a fresh clone reads the
stale 144-article database** — the MCP server and every tool will serve 2026-07-13 content
until the pipelines repopulate it. On a working machine the file has long since been
overwritten by the incremental pipelines, which is why this is invisible day to day.
A fresh clone that needs real data should populate it through the **incremental** paths,
each a real npm script:

```bash
npm run sync-wiki        # SecondBrain wiki subset (needs /Volumes/Research mounted)
npm run ingest-drafts    # unpublished drafts
npm run ingest-projects  # project docs from astgl-site projects.json
npm run structure        # discovered astgl.ai content (needs Ollama)
```

or by copying a populated database in:

```bash
cp /path/to/populated/knowledge.db data/knowledge.db
```

**Not `npm run ingest`:** that is the destructive rebuild of Mistake #2, and
because `resolveKnowledgeDbPath()` selects `data/knowledge.db` whenever it exists, running
it here targets the tracked file and drops whatever the incremental pipelines have already
built. If `ingest` genuinely is the right tool, **Mistake #2's preconditions apply in full** —
including its definition of a *verified* restore point, which is stated there and not
repeated here so the two cannot drift. Either way, do not solve a stale clone by committing
the result.

Corollary: the earlier version of this rule said a `knowledge.db` commit is "a deliberate
release act (it ships in the npm package)". That stopped being true on 2026-07-29 and
framed the risk as *release hygiene* rather than *disclosure* — which is the more
dangerous half. If someone asks you to commit the database, surface these numbers and get
an explicit decision; do not infer consent from "commit the changes".

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

**13. The Patched Instance.** A review names a defect, you fix exactly that line, and
you push. The same defect is sitting three functions away in a form nobody has looked
at yet, so the next round finds it, and the round after that finds the third. Each fix
is correct; the sequence is the failure.
→ **Rule: after the FIRST instance of a defect class, grep for the rest before pushing.
Name the class out loud ("an exit path that skips the summary", "a check that prints
instead of aborting", "a comparison that treats empty as equal"), then search for every
member of it.**

This repo already applies the reflex to schema — Mistake #8 is `grep -rn "<table_name>"
src/` before changing a table. Extend it to control flow, which is where it was missed:
PR #41 took three review rounds on one class (something bypassing the single-JSON-summary
contract). Round 1 fixed an escaping throw in the deletion loop; round 2 found two
sibling `process.exit(1)` calls doing the same thing four lines apart; round 3 found the
entry-point `.catch()` emitting nothing at all — the path most likely to be hit in
practice. One sweep after round 1 would have closed all three.

The tell that you are patching instances rather than sweeping a class: **your fixes are
mitigations rather than closures.** If each round narrows a window instead of shutting
it, the artifact is wrong, not the implementation — that is how the bash pruning recipe
became `src/prune-backups.ts` (see *Backup retention*).

## Quality bar — checkable, per deliverable

**Any code change (baseline):**
- [ ] `npm run build` passes (tsc strict) **and `npm test` passes** (node:test via tsx; added 2026-07-30). There is still no linter.
- [ ] New/changed functions carry `WHAT:`/`WHY:` comments; constants named, no magic numbers.
- [ ] Every new `fetch` has a timeout; every multi-table write is in a transaction.
- [ ] stdout/stderr contract intact (grep your diff for `console.log` outside the summary line).
- [ ] Fixing a review finding? The defect class was swept, not just the named instance (Mistake #13).
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
- Deleting or rotating secrets; touching the archived retired-job plists in
  `~/Library/LaunchAgents.retired/` (they still embed the Discord webhook URL);
  pruning `data/*.bak.*` files.
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
- ~~Retired plists still loaded alongside their Maester replacements~~ — resolved
  2026-07-26: booted out and archived in `~/Library/LaunchAgents.retired/`.
- `ASTGL_DRAFTS_DIR` defaults diverge: ingest/reconcile → `/Volumes/Research/ASTGL
  Articles/Drafts`; rewrite-queue/.env.example → `~/Projects/astgl-articles/substack`.
  Set the env var explicitly; never rely on the default.
- ~~`data/*.bak.*` backups accumulate unbounded (~200 MB and growing)~~ — pruned
  2026-07-31 (8 stale files, 323 MB; `data/` 485 MB → 162 MB). A retention rule now
  exists (see *Backup retention* below), but nothing enforces it automatically — the
  directory will grow again and needs a periodic manual pass.
- ~~A 0-byte `knowledge.db` sits at the repo root, untracked and un-gitignored~~ —
  deleted 2026-07-31 and the class is now blocked by a root-anchored `/*.db` rule.
  Investigated: **no code defect exists.** Every DB path in `src/` uses
  `import.meta.dirname`, there is no `process.cwd()` in `src/`, no bare-path example
  in any skill or doc, no launchd log entry at its timestamp, and no other ASTGL repo
  is affected. It was an interactive command run from the repo root instead of
  `data/`. ADR-0001's "something opened a database at `process.cwd()`" reads as a code
  bug; it is not one.
- Asana was retired entirely (2026-07-07): the PAT and `mcp__claude_ai_Asana__*`
  allow rules were removed from `.claude/settings.local.json`; the Teams-to-Asana
  bridge no longer exists. Don't suggest Asana integrations here.
- **`overrides: { tmp: "^0.2.7" }` in package.json is a workaround, not a preference**
  (added 2026-08-01). `@anthropic-ai/mcpb` → `@inquirer/prompts` → `@inquirer/editor` →
  `external-editor` pins `tmp@^0.0.33`, and `^0.0.x` locks to exactly that patch — so
  `tmp` could not reach the patched 0.2.6 by any bump, and mcpb 2.1.2 is already latest.
  `npm audit` reported `fixAvailable: false` for the whole chain. **Remove the override
  once mcpb ships an `@inquirer/prompts` whose `external-editor` allows tmp ≥ 0.2.6** —
  check with `npm audit` after the override is deleted, not by reading version numbers.
  Safe today because `external-editor` calls exactly one tmp API, `tmpNameSync(options)`,
  which still exists in 0.2.7 (verified by constructing a real `ExternalEditor`).
  → This affects **no consumer**: `files` ships `dist` + the pruned DB + README (never
  `node_modules`), the MCPB bundle installs `--omit=dev`, and npm ignores a *dependency's*
  `overrides` — the field only applies at the root of an install.
- **A red `build-mcpb` on main is stale until proven otherwise.** That workflow runs
  only on `workflow_dispatch` and `release` — never on push — so main's Actions view
  shows the latest manual-dispatch or release-triggered run, which can predate any
  number of fixes. On 2026-07-31 it displayed a failure at `b392ff69` (07:15) whose
  cause had been fixed hours later by #36 (`91e4a79`, 09:47) and verified green on that
  PR's branch; nothing had re-run it against main in between, so the red sat there
  looking current. It was reported here as "build-mcpb is failing" before the timestamps
  were checked — don't repeat that. **Compare the run's SHA and time against `main`
  before concluding anything**, and if it is stale, settle it by dispatching
  (`attach_to_release=false` creates workflow artifacts only and does not attach them
  to a GitHub release — the bundles still exist, they are just not published):

  ```bash
  gh workflow run build-mcpb.yml --ref main \
    -f version="$(npm view mcp-astgl-knowledge version)" \
    -f attach_to_release=false
  ```

  The version must already be **published**, since each leg sources `dist/` and the
  pruned database out of the npm tarball via `--from-npm`; reading it from the registry
  rather than hardcoding one keeps the command correct after the next release.
  Last verified **2026-07-31 against `main@4331dd55`, bundling published npm 1.3.0**
  ([run 30667252610](https://github.com/Jmeg8r/mcp-astgl-knowledge/actions/runs/30667252610)):
  all four platforms green, gate verified at 178 articles / 0 withheld / 0 drafts,
  confirming #36's win32 fix holds on main and not merely on its branch — which the
  branch-only run never established. Record the SHA, the run id AND the npm version when you
  re-verify: the command above resolves the version at dispatch time, so `npm view` will
  return something else after the next release and the record would no longer identify
  which tarball was actually bundled. A bare date is not checkable once main advances,
  and this entry's own rule is to compare SHAs.
  → Corollary for any dispatch-only workflow: **"verified on the branch" and "works on
  main" are different claims**, and only one of them is what a release will run.

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

## The publication gate (added 2026-07-29, ADR-0001)

`data/knowledge.db` holds more than the public is meant to see: 201 unpublished article
drafts (43% of rows) and 90 private-project wiki pages. It is no longer shipped.

- **`articles.public`** — `INTEGER NOT NULL DEFAULT 0`, fail-closed. A row nobody classified
  is withheld, never leaked.
- **`src/public-allowlist.ts`** — the only definition of "public". `isPublic()` is shared by
  the write path and the prune path so they cannot drift (Mistake #8).
- **`npm run build-public-db`** — copies, prunes `public = 0` via `deleteArticle()`, VACUUMs,
  and verifies the artifact (zero withheld rows, zero orphan chunks, **zero orphan
  embeddings** — sqlite-vec has no cascading delete, so withheld vectors could otherwise stay
  searchable). Never mutates the source. `--dry-run` supported.
- **`npm run reclassify-wiki`** — re-derives `public` for already-indexed rows without
  re-embedding. Sync is mtime-incremental, so an unchanged page is never re-processed and an
  allowlist edit would otherwise change nothing. Available to run by hand, but you do not
  have to remember to: it is wired into `prepack`.
- **`prepack`** runs build → **reclassify** → prune, in that order, so a publish can
  neither skip the gate nor ship flags that predate the current allowlist. Do not reorder or
  drop the reclassify step — without it, editing `public-allowlist.ts` and publishing would
  ship stale `public = 1` rows.

→ **Rule: never add `data/knowledge.db` back to `package.json` `files`, and never resolve a
DB path directly — use `src/db-path.ts`.** Anything that publishes must go through the prune.
That rule now covers `query-log.db` too (added 2026-08-01): six modules had hardcoded it —
`query-log.ts`, `rate-limit.ts`, `ideas.ts`, `dashboard.ts`, `daily-report.ts`, `alerts.ts` —
and **`rate-limit.ts` deliberately shares that same file**, so redirecting one of them would
have split the writer from five readers *and* from rate limiting. Use
`resolveQueryLogDbPath()`. `ASTGL_QUERY_LOG_DB` overrides it and is a test seam only.

→ **Rule: the gate covers npm, NOT git.** This repo is public, and `data/knowledge.db` is
tracked at a stale 144-article revision. Committing the working file would put its withheld
rows into public history with no gate in the way — 297 of 475 as measured 2026-07-31, and
growing daily; see Mistake #10 for the dated breakdown. ADR-0001
reasoned about the tarball and never addressed this second channel; the only thing holding
it closed is that nobody stages the file.

### The publish-gap instrument (added 2026-07-30, ADR-0001 amendment)

`src/publish-drift.ts` answers "is what we ship still what we have?" by comparing the local
`public = 1` count against the article count **inside the published npm tarball** — it
downloads it, extracts `build/knowledge-public.db`, and counts rows. It runs as check #4 of
`npm run freshness`; `npm run publish-drift` is `freshness --only publish_gap`.

- **The comparator is `public = 1`, never `COUNT(*)`.** 471 local vs 178 published is the
  gate working; only 178-vs-178 is a real comparison. Comparing totals would report a
  permanent ~293-row "gap", and an alert that always fires gets muted.
- **A failed measurement reports `null`, never `0`,** and fires a warning about its own
  blindness. `content_measured: false` and `articles_delta: 0` must never be confusable.
- Measurements are cached in `ecosystem_snapshots.metrics` keyed by published version —
  safe because npm versions are immutable — so the 4.7 MB download happens once per
  release. `--skip-tarball` reports from cache without fetching.
- Only a **positive** delta alerts. A negative one is the normal state of a fresh clone,
  where `data/knowledge.db` is the older git-tracked copy.
- **A content withdrawal therefore never alerts** (found 2026-08-01, first republish after
  a pull). Removing something makes the delta negative — indistinguishable from the
  fresh-clone state — so "the published package still carries what we withdrew" is silent
  by design. Republishing after a withdrawal is a manual act tracked wherever the removal
  was decided, and every publish ends with `npm run publish-drift` confirming the delta
  returned to zero.

→ **Rule: `getSnapshot`/`upsertSnapshot` and the `ecosystem_snapshots` DDL now live ONLY in
`knowledge-db.ts`.** `freshness.ts` used to carry a second copy of all three; do not
reintroduce one (Mistake #8). `runMigrations()` is exported so tests build fixtures from the
real schema rather than a fourth copy.

### Tests exist now

`npm test` runs `node:test` through tsx — no test framework dependency, and `test/` is
outside `tsconfig.json`'s `rootDir`, so it never reaches `dist/`. The compile gate is no
longer the only gate; a change to `publish-drift.ts` or the snapshot helpers should come
with a test. Note this supersedes the older "there are no tests or linter yet" line in the
quality bar below.

## The MCPB bundle (added 2026-07-30)

Smithery's stdio distribution path is an **MCPB bundle**, not the npm tarball — clients
download and run it locally. Because MCPB requires bundling `node_modules`, the bundle is a
SECOND artifact that can ship content, so it goes through the same publication gate.

- **`npm run build-mcpb`** — stages `manifest.json` + `dist/` + `build/knowledge-public.db`
  + production-only `node_modules`, packs to `dist-mcpb/`, writes a `.sha1`. `--dry-run`
  supported. Output is gitignored: a distributable artifact, never source.
- **It re-asserts the gate** before packing, and refuses with a row count if the database
  carries withheld rows or drafts. `build-public-db` verifies the artifact it writes, but
  this script can run much later against a stale `build/` — an artifact that exists is not
  an artifact that is current (see the `npm pack` incident below).
- **Version agreement is enforced**: `package.json` and `mcpb/manifest.json` must match or
  the build fails. `server.json` is the third copy — keep all three in step.

→ **PLATFORM: a bundle is only valid on the platform that built it.** `better-sqlite3`
compiles a native `.node` per platform and Node ABI; `sqlite-vec` resolves its binary through
per-platform `optionalDependencies`. Multi-platform bundles come from
`.github/workflows/build-mcpb.yml`, which runs this script on macos-15 (arm64),
macos-15-intel (x64), ubuntu-latest, and windows-latest.

### The CI matrix and why it sources from npm

The workflow **requires the npm version to be published first**, because `build/knowledge-public.db`
derives from `data/knowledge.db`, which is not in the repo and must never be — a runner cannot
produce the pruned artifact from source. Each job instead passes `--from-npm <version>`, which
pulls dist/ and the database out of the **published tarball**, already gate-verified.

Two consequences worth keeping: no private content ever reaches CI, and a bundle can never
carry content the npm package does not.

- Runner labels are **verified against actions/runner-images, not assumed** — `macos-13` was
  retired and `macos-14` is deprecated, so the macOS legs are `macos-15` (arm64) and
  `macos-15-intel` (x64).
- **MCPB cannot express CPU architecture.** `compatibility.platforms` is Node platform values
  only, so a darwin-arm64 and a darwin-x64 bundle both declare `["darwin"]` and are
  indistinguishable to a client — architecture lives *only* in the filename. A mislabelled
  bundle is therefore unrecoverable, which is why `build-mcpb.ts` **fails** (not warns) when
  `--platforms` or `--label` disagrees with the build host.
- Node is **pinned** in the workflow (`24.14.0`). better-sqlite3's binary is tied to the Node
  ABI, so a floating runner version would silently emit bundles that fail at `require()` on
  clients using the older ABI. Bump deliberately and re-verify.
- Each job stamps `compatibility.platforms` to its own platform via `--platforms`, so a
  Windows user never downloads a bundle full of darwin binaries.
- Each job **re-verifies its own artifact** — manifest platform and version, gate counts —
  then smoke-tests the extracted bundle with a real MCP handshake. `list_tags` is the chosen
  probe because it is the non-vector path, proving the native binary loaded without a model.
- `fail-fast: false`, so a broken prebuild on one platform still yields the others.
- Cross-platform gotcha, found by the first matrix run: on Windows `npm`/`npx` are `.cmd`
  shims, and since the fix for **CVE-2024-27980** Node *refuses* to spawn `.cmd`/`.bat`
  without a shell — it throws `spawn EINVAL`. Naming `npm.cmd` explicitly was necessary but
  NOT sufficient; the win32 leg failed while all three POSIX legs passed. `build-mcpb.ts`
  now skips the shim entirely: npm sets `npm_execpath` to the absolute path of `npm-cli.js`
  for any script it runs, so the script invokes `node <npm-cli.js> …` — no shell, identical
  on every platform, and `shell: true` (with its quoting surface) stays off the table.
  **Consequence: run it via `npm run build-mcpb`. Direct `tsx src/build-mcpb.ts` execution is
  unsupported on EVERY platform** — `npm_execpath` is only set for npm-run scripts, and the
  script now fails uniformly rather than working on POSIX and breaking on win32. A fallback
  that succeeded on three platforms and failed on the one you cannot test locally is worse
  than no fallback. (`npx tsx …` happens to work because npx sets the variable itself, but
  do not rely on that.)
- Workflow injection: every `${{ }}` value reaching a `run:` block goes through `env:` and is
  referenced as a quoted shell variable, and the resolved version is semver-validated before
  it touches npm or a filename.

→ **`npm pack` does not run `prepublishOnly`.** That is why the gate chain lives in
`prepack`. Before this was found, `npm pack` silently produced a 145 kB tarball with no
database at all, and npm did not complain that a `files` entry pointed at a missing path.
