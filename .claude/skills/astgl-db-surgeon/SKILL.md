---
name: astgl-db-surgeon
description: Safe operations on the ASTGL knowledge base databases — inspect, verify integrity, re-index or retire specific articles, fix orphaned vectors, checkpoint WAL, manage backups. Use when James wants to "fix the database", "remove an article", "re-index X", "why is search returning Y", "check DB integrity", "clean up backups", or any manual read/write against data/*.db.
---

# ASTGL DB Surgeon

`data/knowledge.db` is production: the live MCP server reads it, five pipelines write
it, it's tracked in git, and it ships inside the npm package. This skill exists
because the two ways to destroy it — raw chunk SQL that orphans sqlite-vec rows, and
"refreshing" via `npm run ingest` — both look completely reasonable to an assistant
that hasn't read the code.

## Iron rules (from CLAUDE.md, restated because this is where they bite)

1. **Backup before ANY write**: `cp data/knowledge.db "data/knowledge.db.bak.<reason>-$(date -u +%Y-%m-%dT%H-%M-%S)"`.
   If `-wal`/`-shm` sidecars exist for the file, checkpoint first (see below) or copy them too.
2. **Never raw-write `chunks` or `vec_chunks`.** sqlite-vec has no REPLACE and no
   cascade — mutations go through `replaceChunksForArticle()` / `deleteArticle()` in
   `src/knowledge-db.ts`, or through the recipes below that replicate their
   transaction exactly.
3. **Never `npm run ingest` as a fix.** It DROPs the tables and rebuilds only from
   astgl-site markdown, destroying discovered/draft/project/wiki content.
4. **Destructive steps show the rows first** (SELECT before DELETE, count + titles),
   and bulk deletes (>5 articles) need James's explicit approval in this session.
5. Read-only exploration uses read-only connections: `sqlite3 "file:data/knowledge.db?mode=ro" "..."`.

## Recipe: Inspect / answer "what's in the DB?"

```bash
sqlite3 "file:data/knowledge.db?mode=ro" -header -column "
  SELECT source_origin, content_type, COUNT(*) n FROM articles GROUP BY 1,2 ORDER BY 1,2;"
# One article, fully:
sqlite3 "file:data/knowledge.db?mode=ro" -header -column "
  SELECT id, title, url, slug, content_type, source_origin, pub_date, last_reviewed_at,
         freshness_status, tags FROM articles WHERE url LIKE '%<fragment>%' OR title LIKE '%<fragment>%';"
sqlite3 "file:data/knowledge.db?mode=ro" "
  SELECT article_order, section_heading, length(content) FROM chunks
  WHERE article_url = '<url>' ORDER BY article_order;"
```
URL shapes by origin: astgl.ai articles `https://astgl.ai/answers/<slug>/` (beware
trailing-slash drift — PR #7), drafts `draft://...`-style local URLs from
ingest-drafts, wiki `wiki://secondbrain/<type>/<slug>`, projects from projects.json.
Match with LIKE first; operate on the exact url string you found, never a guess.

## Recipe: Integrity check (run before AND after any surgery)

```bash
sqlite3 "file:data/knowledge.db?mode=ro" "
  SELECT 'chunks', COUNT(*) FROM chunks
  UNION ALL SELECT 'vec_chunks', COUNT(*) FROM vec_chunks
  UNION ALL SELECT 'vec_orphans (vector, no chunk)', COUNT(*) FROM vec_chunks v
    WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = v.chunk_id)
  UNION ALL SELECT 'chunk_orphans (chunk, no vector)', COUNT(*) FROM chunks c
    WHERE NOT EXISTS (SELECT 1 FROM vec_chunks v WHERE v.chunk_id = c.id)
  UNION ALL SELECT 'chunks w/o article', COUNT(*) FROM chunks c
    WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.url = c.article_url)
  UNION ALL SELECT 'qa w/o article', COUNT(*) FROM article_qa q
    WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.url = q.article_url);"
sqlite3 "file:data/knowledge.db?mode=ro" "PRAGMA integrity_check;"
```
All orphan counts must be 0. Non-zero orphans explain "search returns weird/dead
results" — fix with the repair recipe below.

## Recipe: Retire an article (and all its dependents)

The `deleteArticle()` cascade, as one transaction. Show first, then delete:

```bash
sqlite3 "file:data/knowledge.db?mode=ro" -header -column "
  SELECT a.title, a.url, (SELECT COUNT(*) FROM chunks WHERE article_url=a.url) chunks,
         (SELECT COUNT(*) FROM article_qa WHERE article_url=a.url) qa
  FROM articles a WHERE a.url = '<url>';"
```
After James (or the task) confirms this exact row — backup, then:
```bash
sqlite3 data/knowledge.db "
  BEGIN;
  DELETE FROM vec_chunks WHERE chunk_id IN (SELECT id FROM chunks WHERE article_url='<url>');
  DELETE FROM chunks WHERE article_url='<url>';
  DELETE FROM article_qa WHERE article_url='<url>';
  DELETE FROM articles WHERE url='<url>';
  COMMIT;"
```
**Then check for resurrection**: if the source still exists (draft folder, wiki page
with `astgl` tag, RSS-discoverable URL, or an entry in `data/wiki-sync-state.json`),
the nightly pipelines will re-ingest it. Retire the *source* (or its state entry) too,
or the delete is cosmetic.

## Recipe: Re-index one article (embeddings/chunks look wrong)

Don't hand-write embeddings. Route through the pipeline that owns the article:
- **Wiki page**: `touch` the source file in the vault (or delete its entry from
  `data/wiki-sync-state.json`), then `npm run sync-wiki` (mtime change → re-embed).
- **Draft**: delete the article row via the retire recipe, then `npm run ingest-drafts`.
- **Discovered astgl.ai article**: `sqlite3 data/discovery.db "UPDATE discovered_content
  SET is_new=1 WHERE url='<url>';"` then `npm run structure` (requires Ollama with
  `qwen3-coder:30b` + `nomic-embed-text`; costs a real LLM classify pass).
- **Project docs**: `npm run ingest-projects` (idempotent upsert).

## Recipe: Repair orphaned vectors / chunks

Backup first. Then, orphaned vectors (vector without chunk) are pure garbage:
```bash
sqlite3 data/knowledge.db "DELETE FROM vec_chunks WHERE chunk_id NOT IN (SELECT id FROM chunks);"
```
Chunks without vectors mean those sections are invisible to search — re-index the
affected articles (recipe above) rather than embedding by hand:
```bash
sqlite3 "file:data/knowledge.db?mode=ro" "SELECT DISTINCT article_url FROM chunks c
  WHERE NOT EXISTS (SELECT 1 FROM vec_chunks v WHERE v.chunk_id = c.id);"
```
Re-run the integrity check; report before/after counts.

## Recipe: WAL checkpoint (before copying/committing a DB)

WAL sidecars (`-wal`/`-shm`) hold un-checkpointed writes; a bare `cp file.db` can
snapshot a stale or inconsistent state. Checkpoint **the DB you are about to copy or
commit** — substitute its actual filename:
```bash
ls "data/<db>.db-wal" "data/<db>.db-shm" 2>/dev/null   # sidecars present?
sqlite3 "data/<db>.db" "PRAGMA wal_checkpoint(TRUNCATE);"
```
(As of 2026-07 only `query-log.db` runs in WAL mode, but check for sidecars rather
than assuming.) Safe anytime — readers/writers tolerate it. Do this before backing up
any DB that has sidecars, including `knowledge.db` before committing it: it's
git-tracked, and a checkpoint changes the file git sees.

## Recipe: Backup pruning (ask-first — this deletes files)

`data/*.bak.*` grows unbounded (reconciler snapshots ~80 MB each). These are the
LAST-RESORT restore points for every mistake this skill exists to prevent — when in
doubt, keep. List with sizes and dates, propose a retention, and delete only what James
approves, **by explicit name**.

Retention rule — a backup is an eligible restore point only if it is **both**:

1. the newest checkpoint, **or** younger than 30 days; **and**
2. **schema-compatible with the live database.**

Both conditions, not either. Age alone is not enough: a backup taken 10 days ago but
before a migration 5 days ago passes the age test and is still useless — restoring it
would roll the schema back. Check compatibility directly rather than guessing a
migration date (verified both directions before this was written: a fixture missing the
`public` column is rejected, the real checkpoint is accepted).

```bash
set -euo pipefail   # every check below ABORTS; none of them merely print

# 0. Preflight — BEFORE the checkpoint and long before any delete.
#    Scheduled jobs: 00/06/12/18 content-pipeline, 00:00 draft-pipeline,
#    00:30 wiki-sync, 02:00 draft-reconciler. If one fires mid-prune the
#    checkpoint is a torn snapshot. Confirm none is imminent, then:
command -v lsof >/dev/null 2>&1 \
  || { echo "ABORT: lsof unavailable — cannot verify the database is idle"; exit 1; }
# WHY tri-state: `! lsof … || abort` treats EVERY nonzero exit as "no handles",
# so a missing binary (127) or an lsof error (2) would read as idle and proceed.
# Only exit 1 — "ran fine, found nothing" — is safe.
LSOF_RC=0; lsof data/knowledge.db >/dev/null 2>&1 || LSOF_RC=$?
case "$LSOF_RC" in
  0) echo "ABORT: database is in use"; exit 1 ;;
  1) : ;;   # idle — the only case that may proceed
  *) echo "ABORT: lsof failed (exit $LSOF_RC) — cannot verify idle state"; exit 1 ;;
esac

# 1. Inventory — always show sizes and dates before proposing anything
ls -la data/*.bak.* | awk '{printf "%8.1f MB  %s %s %s  %s\n", $5/1024/1024, $6,$7,$8, $9}'
du -ch data/*.bak.* | tail -1

# 2. Checkpoint WAL before copying, or `cp` snapshots an inconsistent state (iron rule #1)
[ -f data/knowledge.db-wal ] && sqlite3 data/knowledge.db "PRAGMA wal_checkpoint(TRUNCATE);"

# 3. Fresh checkpoint, VERIFIED — each check aborts and removes the bad copy
BAK="data/knowledge.db.bak.checkpoint-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
cp data/knowledge.db "$BAK"

[ "$(sqlite3 "file:${BAK}?mode=ro" 'PRAGMA integrity_check;')" = "ok" ] \
  || { echo "ABORT: checkpoint failed integrity_check"; rm -f "$BAK"; exit 1; }

LIVE_N=$(sqlite3 "file:data/knowledge.db?mode=ro" "SELECT COUNT(*) FROM articles;")
BAK_N=$(sqlite3 "file:${BAK}?mode=ro" "SELECT COUNT(*) FROM articles;")
[ "$LIVE_N" = "$BAK_N" ] \
  || { echo "ABORT: count mismatch (live $LIVE_N vs backup $BAK_N)"; rm -f "$BAK"; exit 1; }

[ "$(md5 -q "$BAK")" = "$(md5 -q data/knowledge.db)" ] \
  || { echo "ABORT: checkpoint is not byte-identical"; rm -f "$BAK"; exit 1; }

echo "checkpoint verified: $BAK ($BAK_N articles)"

# 4. Classify every OTHER backup by schema compatibility, not just age.
#    WHY the full signature: column NAMES alone cannot see a type, NOT NULL,
#    DEFAULT, pk or ordering change. Verified — a backup whose `public` column
#    lost `NOT NULL DEFAULT 0` (the gate's fail-closed property) passes a
#    names-only check and is rejected by this one.
SCHEMA_SQL="SELECT group_concat(sig,'|') FROM (
  SELECT cid||':'||name||':'||type||':'||\"notnull\"||':'||COALESCE(dflt_value,'')||':'||pk AS sig
  FROM pragma_table_info('articles') ORDER BY cid);"

LIVE_SCHEMA=$(sqlite3 "file:data/knowledge.db?mode=ro" "$SCHEMA_SQL")
# WHY this guard: a failed query returns "", and "" = "" compares EQUAL — every
# backup would be reported SCHEMA-OK by comparing nothing to nothing. This exact
# false match happened while developing this recipe (a double-quoted SQL literal
# made both sides empty), so the emptiness is checked rather than assumed.
[ -n "$LIVE_SCHEMA" ] \
  || { echo "ABORT: could not read live schema — cannot classify backups"; exit 1; }

for f in data/knowledge.db.bak.*; do
  [ "$f" = "$BAK" ] && continue
  S=$(sqlite3 "file:${f}?mode=ro" "$SCHEMA_SQL" 2>/dev/null || true)
  if [ -z "$S" ]; then echo "  UNREADABLE    $f   <- treat as NOT a restore point"
  elif [ "$S" = "$LIVE_SCHEMA" ]; then echo "  SCHEMA-OK     $f"
  else echo "  STALE-SCHEMA  $f   <- not a restore point regardless of age"; fi
done

# 5. Delete by explicit name from the approved list — NEVER `rm data/*.bak.*`,
#    which would take the checkpoint you just made.
```

Three things learned pruning 323 MB on 2026-07-31:

- **Schema age is the real expiry, not calendar age.** All 8 files removed predated the
  `public` column, so restoring any would have lost the entire publication gate plus two
  weeks of content. A backup older than your last schema migration is not a restore
  point — it is a rollback wearing a backup's filename.
- **Prune only with a verified checkpoint in hand.** Otherwise you trade clutter for
  exposure — the newest file was 17 days stale and was the *only* full restore point.
- **A verification that prints is not a verification.** The first version of this recipe
  ended in `[ "$(md5 …)" = "$(md5 …)" ] && echo "byte-identical"`, which prints nothing
  on mismatch and falls through to the delete step. Every check here now aborts.
- **Ordering is part of a safety procedure.** The scheduled-job warning used to sit
  *below* the code block — after the step that says "delete". Anything an operator must
  know before acting belongs in preflight, not in the epilogue.
- **A comparison of two empty strings succeeds.** Three of the checks above can return
  empty on failure (`lsof` unavailable, an unreadable backup, a malformed schema query),
  and every one of those would otherwise read as agreement. Assert non-empty before
  comparing — this is the same defect as the printing verification, wearing a different
  hat.

## Recipe: Restore from backup (disaster path — ask first, always)

```bash
ls -lt data/knowledge.db.bak.*                      # pick restore point WITH James
cp data/knowledge.db data/knowledge.db.PRE-RESTORE-$(date -u +%Y-%m-%dT%H-%M-%S)  # save current state first
cp "data/knowledge.db.bak.<chosen>" data/knowledge.db
```
Then run the integrity check, and state clearly what window of pipeline writes was
lost (backup timestamp → now) so James can decide whether to replay pipelines
(`npm run pipeline`, `sync-wiki`, `ingest-drafts`, `ingest-projects`).

## After any write

- [ ] Integrity check clean (all orphan counts 0, `integrity_check` = ok).
- [ ] Spot-check via the live surface: one `search_articles` MCP call (or
      `npm run dev` + a query) touching the affected content.
- [ ] Report: what changed (counts before/after), which backup file is the rollback
      point, and whether `knowledge.db`'s git diff is intended (it ships in the npm
      package — an unintended diff means restore or explain).
