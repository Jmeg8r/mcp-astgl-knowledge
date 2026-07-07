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

`data/*.bak.*` grows unbounded (reconciler snapshots ~50 MB each). List with sizes and
dates, propose keeping the newest of each kind plus anything younger than 30 days, and
delete only what James approves, by name. These are the LAST-RESORT restore points
for every mistake this skill exists to prevent — when in doubt, keep.

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
