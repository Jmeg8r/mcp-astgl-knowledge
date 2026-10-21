# Incident notes behind the rules

<!-- WHAT: The stories that produced several rules in CLAUDE.md: the launchd log-path move, the retired Discord jobs, the citation-report error rows, and the PR #41 defect-class sweep.
     Moved out of CLAUDE.md on 2026-10-20 (docs/trim-claude-md); the rules it supports stay there.
     WHY: CLAUDE.md is resent every turn; this is read by hand when the topic comes up. -->

## launchd log paths (September 2026 external-volume move)

  Their stdout/stderr now go to `~/Library/Logs/mcp-astgl-knowledge/`, on the
  home volume. The September 2026 external-volume move left launchd unable to
  open log paths inside the repository (`EX_CONFIG`), although Node could still
  write ordinary data files there. Create the home log directory before
  installing the plists; leave historical repo logs intact.

## The retired Discord jobs and shared alert cooldowns

- Three legacy jobs (daily-report 08:00, content-alerts 09:00, content-freshness
  10:00) were retired to Maester (Telegram via claudeclaw). Their still-installed
  plists kept firing `--discord` until 2026-07-26, when they were booted out and
  archived in `~/Library/LaunchAgents.retired/`. The gotcha that made this urgent:
  both channels share `alerts.db` cooldowns, so whichever scheduler fires first
  claims the alerts — the Discord jobs (:00 sharp) were suppressing Maester's
  Telegram alerts (:00 + ~40s) every day.

## Citation report error rows: the reader half of the "fully-failed run" rule

- **The reader half of that rule is separate, and was missing for three months.** PR #15
  stopped a fully-failed run from being *written*; it did not stop the ones already
  written from being *read* as legitimate. The citation report counted every
  `test_results` row as a test, including the 184 of 745 (25%) that
  `citation-test-auto.ts` stamps `ERROR:` when a query throws — nine of those runs were
  100% errors and still reported "0% cited, tested 20". Fixed in
  `src/citation-error-rows.ts`, which owns the marker for both sides.
  → **Rule: whenever a writer starts marking rows as invalid, find every reader that
  aggregates that table in the same PR.** A guard on the write path is half a fix, and
  the unfixed half is the one that quietly reshapes a metric you already trust.
  Two traps this specific fix had to survive, both of which produce a plausible wrong
  number rather than an error: a bare `NOT LIKE 'ERROR:%'` also discards the manual
  path's `snippet = NULL` rows (SQL `NULL NOT LIKE x` is NULL, not TRUE — 496 rows
  survive instead of 561), and moving the predicate into a `WHERE` clause collapses the
  report's `LEFT JOIN`s and makes fully-errored runs vanish entirely instead of showing
  as degraded. **A rate over an empty denominator is reported as `null`, never `0%`** —
  same standard as `publish-drift.ts`.

## PR #41: three rounds on one defect class (Mistake #13)

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
