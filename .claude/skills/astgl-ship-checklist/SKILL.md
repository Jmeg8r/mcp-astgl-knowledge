---
name: astgl-ship-checklist
description: Per-deliverable quality bar for this repo — checkable items for a baseline code change, a pipeline script, the MCP server surface, a schema change, a new scheduled job, and a PR. Use before opening or merging a PR, or whenever verifying a change is ready to ship.
---

# ASTGL Ship Checklist

Relocated from `CLAUDE.md` ("Quality bar — checkable, per deliverable"). Run the
section(s) that match what you touched; not every deliverable needs every section.

**Any code change (baseline):**
- [ ] `npm run build` passes (tsc strict — this is the only compile gate; there are no tests or linter yet).
- [ ] New/changed functions carry `WHAT:`/`WHY:` comments; constants named, no magic numbers.
- [ ] Every new `fetch` has a timeout; every multi-table write is in a transaction.
- [ ] stdout/stderr contract intact (grep your diff for `console.log` outside the summary line).
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
