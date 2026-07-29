# ADR-0001: knowledge.db Keeps Its Own Index (Do Not Query qmd)

**Status**: Accepted
**Date**: 2026-07-29
**Author**: James F. Cruce

---

## Context

The SecondBrain wiki (`/Volumes/Research/Brain/SecondBrain/wiki`) is indexed twice:

1. **qmd** indexes the entire vault as the `SecondBrain` collection — a local, on-device
   hybrid search engine used for James's private recall.
2. **`src/sync-wiki.ts`** re-reads the `astgl`-tagged subset nightly at 00:30, chunks it,
   embeds it with `nomic-embed-text`, and writes it into `data/knowledge.db`.

The "Toward Perfect Recall" white paper (§9, v1.0–1.2) flagged this as its first honest
caveat — *"the wiki is embedded twice"* — and §10 carried a roadmap item asking whether
ASTGL Knowledge should query qmd's existing index instead of maintaining its own copy,
"removing the drift risk entirely."

This ADR answers that question and records what the investigation actually found.

### Measurements taken 2026-07-29

Read from the running system, not from documentation:

| Reading | Value |
|---|---|
| `knowledge.db` articles / chunks (local) | 469 / 3,435 |
| — of which `source_origin = 'secondbrain'` | 190 / 931 |
| — of which `source_origin = 'astgl-site'` | 279 / 2,504 |
| Published npm `mcp-astgl-knowledge@1.1.0` (2026-04-13) | **49 / 378** |
| `data/knowledge.db` at git HEAD | 144 / 1,157 (newest 2026-05-05) |
| Wiki pages carrying the `astgl` tag | 190 of 1,381 |
| Nightly wiki-sync work (median, last 20 runs) | 3 pages, ~15 chunks |
| qmd embedding model | `embeddinggemma-300M` |
| `knowledge.db` embedding model | `nomic-embed-text`, `vec0 float[768] cosine` |
| qmd index location | `~/.cache/qmd/index.sqlite` (85.5 MB) |

## Decision

**`knowledge.db` keeps its own copy of the wiki. ASTGL Knowledge will not query qmd.**

Four independent blockers, any one of which is disqualifying:

**1. Deployment topology.** `smithery.yaml` declares `type: stdio`, and `knowledge-db.ts`
resolves the database at a package-relative path
(`join(import.meta.dirname, "..", "data", "knowledge.db")`). The database ships inside the
npm tarball; every consumer runs their own process against their own copy. qmd's index is
a cache directory on one Mac. There is no route from a stranger's install to it, and the
server's stated premise — embeddings pre-computed so end users need no local model —
inverts the moment retrieval depends on a host-side service.

**2. Vector spaces are not interchangeable.** qmd embeds with `embeddinggemma-300M`;
`knowledge.db` embeds with `nomic-embed-text` into a 768-dimension sqlite-vec table. A
query vector must come from the same model that produced the document vectors, so sharing
an index means re-embedding one side entirely. qmd's surface (`query`, `search`, `vsearch`,
`get`) returns documents, never vectors, so there is nothing to lift out even if the models
matched.

**3. The private/public boundary must stay at ingest.** As the 2026-07-29 00:30 sync run saw
the vault, **190 of 1,361 pages** carry the `astgl` tag — 2 synced plus 188 unchanged on the
tagged side, 1,171 skipped as untagged. (Read those four numbers only against each other: the
vault grows daily, and a live `ls` later the same morning counted 1,391 files. Any total here
is a timestamp, not a constant.) qmd indexes all 2,399 SecondBrain
files and exposes no frontmatter filter in its query API. Querying qmd would move the
boundary from build-time filtering to query-time filtering — putting a public MCP server
one missing parameter away from answering out of the private vault. Build-time filtering
fails closed; query-time filtering fails open.

**4. `knowledge.db` is not an index.** It carries `topics`, `qa_pairs`, `jsonLd`, tags,
`rewrite_jobs`, freshness state, and related-article links. It is a publishing database
that happens to contain vectors. qmd cannot hold any of that.

### Scope of what ships (resolved 2026-07-29)

The follow-on question — *should the published package carry the wiki subset at all?* — was
answered by auditing all 931 wiki chunks rather than reasoning about them. Neither
all-or-nothing option is right: **ship the concepts, allowlist the entities.**

**Privacy audit — essentially clean.** Zero credentials or connection strings
(`://user:pw@` matched 0 chunks), zero webhook or bot-token URLs, zero UF Health / day-job
content, zero private IPs, no email addresses. The eight `sk-`/`ghp_`/`AKIA` pattern hits
are all false positives — slugs such as `task-group-cancellation`, plus one page that
*describes* secret-detection regexes as teaching material.

Four items would nonetheless go public that should not:

| Page | Exposure |
|---|---|
| `Income Investor` | Unlaunched product, its stack, and that monetization is "gated on a Florida securities-attorney review" — business-legal status and state of residence |
| `astgl-gtm` | Existence and local path of a private go-to-market workspace |
| `OpenClaw` | James's own pre-hardening security posture (plaintext credentials in `.bak` files, `bypassPermissions` on the main agent, auto-loaded plugins) |
| `Autonomous Commerce Agent (ACA)` | `/Users/jamescruce/…` — macOS username embedded in a shipped artifact |

None is catastrophic; OpenClaw is retired and reads as a before/after case study. But these
are facts that should be *disclosed by choice*, not published by tag.

**Usefulness audit — this is the binding constraint.** Of 190 pages, roughly 40 are generic
tool stubs (Git, React, Next.js, Vite, Xcode, Swift, Sparkle, Homebrew, Blender, CapCut)
and roughly 45 are personal-project internals meaningless to outsiders (`/brain-capture`,
`CURATOR`, `quorum`, `factcheck-db`, `revri`, `trevin-creator`). For an AEO/citation server
that is worse than neutral: a stub answer invites a citation to content carrying no ASTGL
authority, teaching downstream assistants that this server returns filler on topics it has
no standing in.

**The cut.** The `concept` / `entity` split is very nearly the right line already:

- **74 concepts** — `Cost-Chokepoint Pattern`, `Three-Layer Defense`, `Hard-fail over
  silent degradation`, `Loop Engineering`, `Free Tier as Marketing Channel`. Portable,
  distinctive, original. Ship these, less ~6 pages of internal jargon (`editorial glow`,
  `learnings-jsonl`, `Substack safe zone`).
- **116 entities** — where all four privacy exceptions and nearly every generic stub live.
  Ship by explicit allowlist only; `Claude Code`, `Anthropic API`, `Qwen3-Coder 30B`,
  `Mac Studio`, and `Apple Silicon` earn their place, `Vite` and `Income Investor` do not.

Net, once the allowlist was actually drafted and approved: **100 pages** — 68 concepts (74
less the 6 internal-jargon pages) plus 32 allowlisted entities — instead of 190 pages of
mixed signal. See `docs/entity-allowlist.md` for the per-entity buckets.

**Why a second gate is required.** The `astgl` tag is doing two incompatible jobs. Inside
the vault it means "relates to my newsletter's subject area," which is why `Vite` and
`Income Investor` both carry it; for a public index it would need to mean "I chose to
publish this." An organizing label is applied generously; a disclosure gate must fail
closed. One field cannot be both.

> [!NOTE]
> **Implemented 2026-07-29.** This subsection described planned work when the ADR merged;
> the gate now exists and is verified. `articles.public` (fail-closed), classification in
> `sync-wiki.ts`, `npm run reclassify-wiki`, and `npm run build-public-db` are all live, and
> `package.json` `files` ships `build/knowledge-public.db` rather than `data/knowledge.db`.
> Measured result: **178 of 469 articles publish** — 78 published newsletter pieces, 68
> concepts, 32 allowlisted entities; 291 withheld, of which **201 are unpublished drafts**
> (see the amendment below).

**Where the gate sits: publish time, not ingest time (decided 2026-07-29).** MAESTER and
local use keep the full 190-page tagged set, so the gate cannot be a `sync-wiki.ts` skip —
that would strip content the local consumer wants. Instead `articles` gains a `public`
column (default `0`, fail-closed), `sync-wiki.ts` sets it from the concept/entity rule
plus an allowlist, and the working `knowledge.db` continues to hold everything.

**The load-bearing distinction: prune the artifact, do not filter the query.** "Publish-time
filter" means a build step that emits a *pruned copy* of the database for the tarball.
Filtering inside the MCP tool handlers instead would be a security defect wearing the
costume of a fix: the private rows would still ship inside the published package, one SQL
query or one `better-sqlite3` open away from anyone who downloaded it. The gate is only
real if the excluded rows are absent from the shipped file. Accordingly:

Mechanisms, all shipped 2026-07-29:

- `npm run build-public-db` copies `data/knowledge.db` to `build/knowledge-public.db`,
  deletes rows where `public = 0` — routed through `deleteArticle()` so `vec_chunks` is
  cleaned transactionally (Mistake #4) — `VACUUM`s, and asserts a non-zero remaining count.
  It never mutates the source. `--dry-run` reports the full classification and a sample of
  what would be pruned.
- `package.json` `files` ships `build/knowledge-public.db`; `data/knowledge.db` is no longer
  in the package. `prepublishOnly` runs the build, so a publish cannot skip the prune.
- `src/db-path.ts` resolves which database to read — the full one locally, the pruned one on
  an installed package — so the server, `ideas.ts`, and `export.ts` cannot disagree.
- Post-prune verification asserts on the artifact itself: zero withheld rows, zero orphan
  chunks, and **zero orphan embeddings**. That last check is the one that matters — sqlite-vec
  has no cascading delete, so withheld vectors could otherwise survive their rows and keep
  matching KNN searches. Verified functionally: semantic queries aimed at withheld draft
  titles return zero drafts from the artifact.

### What the investigation found instead

The duplication is real but cheap: a median night re-embeds 3 pages and ~15 chunks on a
local model. It is not worth an architecture change.

The expensive problem is downstream and was not on the roadmap at all. **The published
package has not been refreshed since 2026-04-13.** It serves 49 articles; the local file
holds 469. The wiki-sync feature (PR #22, July) has never shipped, so the 190 wiki pages it
indexes nightly reach no consumer outside this machine. The white paper's "424 articles ·
public" figure described the local file, not the published package — an instance of the
same §9 irony the paper documents.

The old `knowledge.db` health tile measured the local file's size delta against its own
history (`61MB drift`) and never compared it to the published tarball. **A drift metric
that does not cross the boundary it is meant to police reports motion, not divergence.**

## Consequences

- The double-embedding stays. §9's first caveat is reframed rather than retired: two
  indexes is a defensible design choice, and the paper now says so.
- Roadmap item #2 is replaced by **"close the publish gap"**: cut a release, then
  instrument the local-vs-published delta so it cannot go unread again.
- **A release is a content-review event, not a version bump** — but the review is now
  front-loaded into the `public: true` gate rather than repeated per release. The `astgl`
  tag alone is not a sufficient boundary between a private vault and a public npm tarball
  (see *Scope of what ships*); the allowlist **is** the review, and it is auditable in git.
- `sync-wiki.ts` gains a second filter and a counter
  (`pages_skipped_not_public`) in its stdout summary, so the gap between tagged and
  published is a number rather than an assumption.
- Because the gate moved to publish time, the working `knowledge.db` is **not** re-scoped
  and the orphan-retirement hazard is avoided entirely: no already-indexed page is dropped,
  it is merely marked `public = 0`. The ~110 excluded articles disappear only from the
  pruned build artifact. This is the main reason publish-time filtering is the safer
  placement, independent of MAESTER's needs.
- The pruned artifact is a new build output that must be gitignored and regenerated, not
  committed — otherwise the repo carries two databases that can disagree, which is the
  original defect in a new costume.
- Two sync holes remain open, both of which can silently stale the data:
  - `sync-wiki.ts` detects change by **mtime only**. A content edit that preserves mtime
    (rsync, git checkout, some Obsidian sync paths) is skipped permanently. Content-hashing
    the file closes it.
  - The mount guard exits `0` with `{skipped: true, reason: "volume_unmounted"}`. This is
    correct (Mistake #5), but it is **silent** — a month of unmounted `/Volumes/Research`
    is indistinguishable from a month of no wiki changes. An alert after N consecutive
    skipped runs closes it. Same shape as the standing "a negative sweep needs a control"
    rule.
- Unrelated but found in the same sweep: `data/` is 401 MB, mostly unbounded `.bak.*`
  files, and a 0-byte `knowledge.db` sits at the repo root — untracked *and* un-gitignored,
  created 2026-07-28. Something opened a database at `process.cwd()`, which the path
  convention in CLAUDE.md forbids. Worth finding before it gets committed.

## Alternatives considered

**Query qmd's index from the MCP server.** Rejected — see all four blockers above. The
proposal is only coherent for a server that runs exclusively on James's machine, which this
one is explicitly not.

**Run qmd as a local HTTP service and have the server fall back to it when present.**
Rejected. It would help exactly one user (James), add a second retrieval path to test and
keep consistent with the shipped one, and re-introduce the query-time filtering hazard from
blocker 3. Graceful degradation in this codebase runs the other direction — vector search
degrades to plain SQL metadata, never to an external dependency.

**Drop the wiki sync entirely and ship only `astgl-site` content.** Rejected. The wiki
pages are 40% of the articles and answer conceptual/entity questions the article corpus
cannot. The sync is doing useful work; it simply has never been published.

**Re-embed the wiki once into a shared store both consumers read.** Rejected on the same
model-mismatch and topology grounds, and it would violate P1 ("no new stores") by adding a
sixth place to look.

## Open questions

- ~~Should the published package ship the wiki subset at all, or should the public corpus
  be articles-only?~~ **Resolved 2026-07-29** — neither; ship concepts, allowlist entities,
  behind a `public: true` gate. See *Scope of what ships* under Decision.
- What is the right republish cadence once the gap is closed — every wiki-sync, weekly, or
  on article publish? The instrument should be built first; the cadence follows from what
  it shows.
- ~~Does MAESTER's local usage want the full 190-page tagged set while the public package
  gets the ~75-page allowlist?~~ **Resolved 2026-07-29 — yes.** MAESTER keeps the full set;
  the gate is a publish-time prune against a `public` column, not an ingest-time skip. See
  *Where the gate sits* under Decision.
- Where does the entity allowlist live — a checked-in list in the repo, or `public: true`
  stamped in the vault's own frontmatter? The repo version is auditable in git and reviewable
  in a PR; the vault version keeps the decision next to the content. Leaning repo, because
  the publish decision belongs to the thing that publishes.

---

## Amendment (2026-07-29) — the drafts finding

Implementing the gate surfaced a larger exposure than the one this ADR was written to
address.

`ingest-drafts.ts` reads **unpublished** article drafts from
`/Volumes/Research/Publishing/ASTGL/Articles/Drafts` and does not set `sourceOrigin`, so
those rows inherit `'astgl-site'` from the column default. At the time of writing that is
**201 articles and 1,725 searchable chunks** — 43% of the database — sitting in the file
that `package.json` shipped verbatim. A release cut before this change would have published
every unpublished draft in full text, searchable by vector.

Consequences for the design:

- **`source_origin` alone cannot decide publication.** The gate keys on `content_type` as
  well, via an explicit `PUBLISHED_SITE_TYPES` allowlist that deliberately omits `draft`.
- **The gate is a publication filter, not a wiki filter.** The wiki question that prompted
  this ADR turned out to be the smaller half: 90 wiki pages withheld against 201 drafts.
- **Fail-closed earns its keep on unknown origins too.** `ingest-projects.ts` and any future
  pipeline produce rows the allowlist does not recognise, and those are withheld by default
  rather than leaked by omission.

Also added: `npm run reclassify-wiki`, which re-derives `public` for already-indexed rows
without re-embedding. Without it, `sync-wiki.ts`'s mtime-incremental skip meant an unchanged
page would keep whatever gate value it had, and **editing the allowlist would re-gate
nothing** — the allowlist would have been decorative for existing content.

## Amendment (2026-07-29, later) — concepts moved to an allowlist

The gate shipped with concepts governed by a *denylist* (`CONCEPT_DENYLIST`) while entities
used an allowlist. The reasoning was that concepts are portable original writing and
per-page approval is friction that discourages producing them.

Review surfaced the flaw: under a denylist a **newly written concept published without ever
having been looked at**, and the audit behind the original decision only covered the 74
concepts that existed on 2026-07-29. The module simultaneously claimed to be fail-closed,
which was false for exactly that path.

The first response was to keep the policy and add visibility — `reclassify-wiki` names every
gate flip and runs immediately before the prune, so a newly-public concept prints at publish
time. On reflection that is a weaker control than simply naming what ships: it depends on
someone reading publish output and reacting, which is the same human-memory dependency the
`prepublishOnly` fix had just removed.

**Concepts are now allowlisted** (`CONCEPT_ALLOWLIST`, 68 titles). The gate is fail-closed
with no exceptions: an unrecognized content type, an unrecognized origin, an unnamed entity,
and an unnamed concept are all withheld. Nothing publishes by default; every published page
is named in `src/public-allowlist.ts`.

Classification is unchanged — still 100 wiki pages public, 90 withheld — because the
allowlist was generated from the rows the denylist was already publishing. What changed is
the behaviour for content that does not exist yet.

Verified across all input classes, including the case that motivated the change: a concept
title absent from the allowlist resolves to withheld rather than public.
