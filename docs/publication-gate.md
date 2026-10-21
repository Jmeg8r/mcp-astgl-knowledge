# The publication gate

<!-- WHAT: The npm-vs-git disclosure channels, the public flag, build-public-db, reclassify-wiki, prepack, and the publish-gap instrument (ADR-0001 and its amendment).
     Moved out of CLAUDE.md on 2026-10-20 (docs/trim-claude-md); the rules it supports stay there.
     WHY: CLAUDE.md is resent every turn; this is read by hand when the topic comes up. -->

## Why `data/knowledge.db` is never committed (from Mistake #10)

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
- **A content withdrawal may not alert** (found 2026-08-01, first republish after a pull).
  An isolated withdrawal makes the delta negative — indistinguishable from the fresh-clone
  state — so "the published package still carries what we withdrew" is silent by design.
  Republishing after a withdrawal is a manual act, tracked wherever the removal was decided.
- **And a zero delta is not proof the withdrawn page is gone.** `publish_gap` compares
  *counts*, not identities: publish one new article in the same release as one withdrawal
  and the delta reads zero while the withheld page still ships. Counting is not checking.
  So after any publish that withdraws content, assert the row's **absence** in the
  published tarball directly, not via the aggregate:

  ```bash
  TITLE="<the withdrawn title>"; CONTROL="<a title you know still ships>"; VERSION="<the release you just cut>"
  DIR="$(mktemp -d)"
  TARBALL="$(npm pack "mcp-astgl-knowledge@$VERSION" --pack-destination "$DIR" --silent)"
  tar -xzOf "$DIR/$TARBALL" package/build/knowledge-public.db > "$DIR/pub.db"
  sqlite3 -readonly "$DIR/pub.db" "SELECT 'withdrawn=' || COUNT(*) FROM articles WHERE title = '${TITLE//\'/\'\'}';"
  sqlite3 -readonly "$DIR/pub.db" "SELECT 'control='   || COUNT(*) FROM articles WHERE title = '${CONTROL//\'/\'\'}';"
  ```

  `withdrawn=0` **with `control=1`** is the pass. The control is not decoration: without a
  title known to be present, `0` is equally consistent with the query being wrong, the
  wrong tarball, or an empty database — the same "the probe never ran" ambiguity that makes
  a silent check indistinguishable from a passing one.

  Three details are load-bearing. **Pin `VERSION` to the release you just cut**, never
  `npm view … version` — that follows the mutable `latest` tag, so a later release silently
  redirects the check. **Extract into `mktemp -d`**, never a `/tmp/*.tgz` glob, which can
  match a stale tarball or hand `tar` several paths. **Escape the title** (`${TITLE//\'/\'\'}`
  doubles single quotes) — ASCII apostrophes are common in these titles and would otherwise
  break the SQL literal.

  `npm run publish-drift` remains the aggregate check and answers a different question —
  whether the corpus as a whole drifted — so run both.

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
