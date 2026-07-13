# Verify a migration's premise against reality before any destructive cutover

**Date:** 2026-07-13
**Context:** A CodeRabbit-flagged one-liner — "the draft-reconciler plist still points at the old
substack path; align it to the Research drive (the current code default)." Taken at face value it
would have hard-deleted 27 live drafts.

## The problem (one line)

The task framed the Research drive as the authoritative drafts archive, but it was a stale copy —
and `reconcile-drafts.ts` hard-deletes DB rows whose source folder is missing from its root, so
obeying the premise would have destroyed 27 current drafts.

## The approach (plain steps)

1. **Treat the premise as a claim to verify, not a fact.** The task said the code default "now
   points at the Research drive." Reading the file showed it still pointed at substack. First
   contradiction → stop trusting the framing.
2. **Find the real invariant.** The reconciler retires drafts whose folder is gone, so it MUST read
   the same archive the *ingester* populates from. The question is not "which path does the task
   name" but "where does the producer actually write, and where did the existing DB rows come from."
3. **Measure BOTH directions against real data.** For every DB draft, check existence under substack
   AND under the Research drive. substack: 0 missing. Research: 27 missing → 27 hard-deletions.
   Filesystem mtimes confirmed substack was live (written today) and Research was a months-old snapshot.
4. **Surface the contradiction; let the human pick direction.** Don't silently "fix" the plist or the
   code once the data disproves the premise — the choice (retire substack vs keep it) is the user's.
5. **Sequence to remove the deletion window.** Once "make Research canonical" was chosen:
   back up → sync data so the target is complete → re-verify 0 deletions via `--dry-run` against a
   copy → redirect PRODUCERS as well as consumers → install launchd against freshly-built dist →
   kickstart-verify live.

## The judgment calls (what was NOT done, and why)

- **Did not edit plist/code to match the premise on the first pass** — the premise was unverified and
  the operation was destructive.
- **Did not verify only "DB rows exist on the target."** That easy one-directional check read 0
  during the data sync but MISSED that the target held 63 extra folders the ingester would later
  index (reverse-direction blindness). For a set migration, always diff both directions.
- **Did not run the launchd install from the feature branch.** Scheduled jobs execute the MAIN
  checkout's `dist/`, so the install waits for merge + rebuild (the stale-dist trap).
- **Did not kickstart the destructive reconciler** until a `--dry-run` against the *production* DB
  (not a worktree snapshot — they diverged) showed `retired: []`.

## The reusable rule

When a task tells you to point a destructive or irreversible operation at a "current" / "authoritative"
resource, prove that resource is actually current — against the filesystem/DB, in BOTH directions of
the diff — before acting. A relocated or renamed resource is stale until proven live, and a
one-directional "everything still exists" check is not proof.
