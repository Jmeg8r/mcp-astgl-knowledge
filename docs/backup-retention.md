# Backup retention

<!-- WHAT: Why backups are never deleted by hand, the prune-backups policy, and what a verified restore point is.
     Moved out of CLAUDE.md on 2026-10-20 (docs/trim-claude-md); the rules it supports stay there.
     WHY: CLAUDE.md is resent every turn; this is read by hand when the topic comes up. -->

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

## What "verified" means for a restore point (from Mistake #2)

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
