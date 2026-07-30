# Verification must cross the boundary it polices

**Date:** 2026-07-30
**Context:** ADR-0001 roadmap item #2 — "instrument the local-vs-published delta so it cannot go
unread again" (PR #37, merged a7ceb32). The same defect then appeared twice more, in my own tests,
found by CodeRabbit.

## The problem (one line)

A drift metric had reported "green" nightly while the published npm package sat 3.5 months and
420 articles behind — because it compared the local file's size against *its own history*, never
against the registry.

## The approach (plain steps)

1. **Establish ground truth before designing.** Read both sides first: local `data/knowledge.db`
   (471 articles / 178 public / 3450 chunks) and the live registry (`1.3.0`, published
   2026-07-30T04:24Z). Never design a comparison against numbers you have not personally read.
2. **Reject the cheap proxy.** Registry metadata (`unpackedSize`, `fileCount`) is one fetch and no
   parsing — but it moves when `dist/` changes and stays flat when only content does. It would have
   been the original bug wearing a new costume. Download the tarball, extract the shipped database,
   count its rows.
3. **Prototype the risky path before writing the feature.** Fetched the real tarball, hand-parsed
   the tar header, extracted the DB, counted it — all in a scratch dir, before a line of `src/`.
   That surfaced the two facts the whole design rests on: it is only 4.7 MB compressed (not 76 MB),
   and it is plain `ustar` with the DB as the first member.
4. **Find the free invariant that bounds cost.** npm forbids republishing a version with different
   content, so a measurement keyed by published version is true *forever*. That single fact turns
   "download nightly" into "download once per release." Caching is normally a correctness risk; here
   the domain hands you a safe one.
5. **Pick the comparator that will not cry wolf.** Local must be `public = 1`, never `COUNT(*)` —
   the publication gate withholds 293 of 471 rows *on purpose*, so comparing totals reports a
   permanent 293-article "gap" that is the gate working correctly. An alert that always fires gets
   muted, which is the exact mechanism by which the original gap went unread.
6. **Make "could not tell" loud and distinct from "in sync."** On any failure the delta is `null`,
   never `0`, and the check fires a warning *about its own blindness*.
7. **Give the negative result a control.** A zero-delta reading on publish day proves almost nothing.
   Flipped 30 withheld rows public on a DB *copy* → delta 30, critical alert. Stubbed `fetch` to
   throw → `null`, warning. Only then was "delta 0" believable.

## The judgment calls (what was NOT done, and why)

- **Did not alert on a negative delta** (registry ahead of local). That is the normal state of every
  fresh clone and CI runner, since `data/knowledge.db` is tracked at an older revision. Reported, not
  alerted — same anti-mute reasoning as the comparator choice.
- **Did not shell out to `tar` or add a tar dependency.** Spawning is what broke the win32 MCPB leg
  (PR #36); ~60 lines of buffer arithmetic is testable and has no platform surface.
- **Did not add a launchd job or send to Discord.** Both are "stop and ask" in CLAUDE.md. The
  instrument ships; scheduling it is a separate approved change.
- **Did not skip the duplicate-DDL cleanup.** `freshness.ts` carried a second
  `CREATE TABLE ecosystem_snapshots`; this change needed the same helpers, which would have made a
  third copy. Consolidating was cheaper than adding to the drift.

## The part I got wrong — twice, the same way

CodeRabbit found the identical class of defect in two consecutive rounds, both in my own tests:

- **Round 1 (critical):** the failure reason was derived by substring-matching a thrown message.
  The message interpolated the full member path, so the match never fired and
  `tarball_member_missing` was unreachable — a database-less package would have alerted *warning*
  instead of *critical*. My test passed because it **hand-constructed the drift object with the
  reason already set**: it asserted the shape and never the wiring.
- **Round 2:** the alert headline announced "0 article(s) ready but unpublished" for a
  version-bump-only alert. My test for that path asserted on `details` and **never on `title`**.

Both are the same shape as the bug the whole PR was written to fix: something verified against
itself, reporting green. Fix pattern: reasons now ride on a typed `MeasurementError`, and six
integration tests drive the orchestrator through a stubbed registry so `error → reason → severity`
runs for real. **Mutation-checked** — reintroducing the old mapping fails exactly one test.

## The reusable rule

**A check is only worth its green if the thing being measured and the thing doing the measuring sit
on opposite sides of the boundary in question.** Local-vs-its-own-history is motion, not divergence;
a test asserting on a fixture it built itself proves the assertion, not the behavior. When you write
a verification, name the boundary out loud and confirm one side of every headline number is on the
far side of it — then mutation-test the check by reintroducing the bug, because a test that cannot
fail is indistinguishable from one that passes.
