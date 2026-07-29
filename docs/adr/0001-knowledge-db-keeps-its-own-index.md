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

**3. The private/public boundary must stay at ingest.** 190 of 1,381 wiki pages carry the
`astgl` tag; last night's run skipped 1,171 as untagged. qmd indexes all 2,399 SecondBrain
files and exposes no frontmatter filter in its query API. Querying qmd would move the
boundary from build-time filtering to query-time filtering — putting a public MCP server
one missing parameter away from answering out of the private vault. Build-time filtering
fails closed; query-time filtering fails open.

**4. `knowledge.db` is not an index.** It carries `topics`, `qa_pairs`, `jsonLd`, tags,
`rewrite_jobs`, freshness state, and related-article links. It is a publishing database
that happens to contain vectors. qmd cannot hold any of that.

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
- **A release is now a content-review event, not a version bump.** The `astgl` tag is the
  only boundary between a private vault and a public npm tarball, and shipping would make
  931 wiki chunks public for the first time. The tagged set gets read before it ships.
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

- Should the published package ship the wiki subset at all, or should the public corpus be
  articles-only with the wiki reserved for MAESTER and local use? This is a content
  decision, not an architecture one, and it gates the release above.
- What is the right republish cadence once the gap is closed — every wiki-sync, weekly, or
  on article publish? The instrument should be built first; the cadence follows from what
  it shows.
