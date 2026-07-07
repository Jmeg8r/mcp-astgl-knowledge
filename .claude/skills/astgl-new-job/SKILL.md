---
name: astgl-new-job
description: Scaffold and ship a new scheduled automation for the ASTGL knowledge system end-to-end — pipeline script with the stdout/stderr contract, launchd plist with pinned PATH, Maester cron descriptor, build, bootstrap, smoke test, and PR. Use when James wants a "nightly/daily/hourly job", "new pipeline", "schedule a script", or to change when an existing job runs.
---

# ASTGL New Scheduled Job

Every scheduled job in this repo is the same five artifacts shipped together. Past
jobs missed one and broke in production (PATH → PR #8, stale dist → the add_idea bug).
This skill ships all five, in order, with verification between steps.

## Step 0 — Interview (keep it short, answers change the design)

Ask James, one at a time, only what the request leaves open:
1. Schedule (exact times — launchd uses `StartCalendarInterval`, not cron strings) and
   whether it must order against existing jobs (00:00 drafts → 00:30 wiki → 02:00 reconciler).
2. Does it write `knowledge.db`? (→ must use `knowledge-db.ts` upserts) Delete anything?
   (→ needs `--dry-run` AND the backup contract: copy to
   `data/knowledge.db.bak.<name>-<ISO timestamp>` before the first delete, with a
   `--no-backup` opt-out — replicate `reconcile-drafts.ts` exactly) Touch
   `/Volumes/Research`? (→ needs a mount guard; ask whether skip-clean or
   refuse-loudly semantics fit).
3. Does it need secrets? (→ pass-cli wrapper in package.json, placeholders in `.env.example`)
   Message humans (Telegram/Discord)? (→ flag: outward-facing, test path must be silent).

## Step 1 — The script (`src/<name>.ts`)

Scaffold from this skeleton — it encodes every repo contract (WHAT/WHY comments,
stderr/stdout split, exit codes, mount guard, JSON summary with per-branch counts):

```typescript
#!/usr/bin/env tsx
/**
 * <Name>.
 *
 * WHAT: <one sentence — what it reads, what it writes>
 * WHY:  <the reason this exists / what breaks without it>
 *
 * Usage:
 *   npm run <name>              # normal run
 *   npm run <name> -- --dry-run # list changes without touching anything
 * Env: <VAR> — <purpose> (default: <default>)
 */

import { initKnowledgeDb, closeKnowledgeDb } from "./knowledge-db.js";

const FLAGS = {
  dryRun: process.argv.includes("--dry-run"),
  noBackup: process.argv.includes("--no-backup"), // only for jobs that delete rows
};

async function main() {
  console.error("=== <Name> ===\n");

  // Mount guard — pick ONE semantics deliberately:
  // optional sync   → exit 0 + {skipped:true} (pattern: sync-wiki.ts)
  // destructive job → refuse, exit 1          (pattern: reconcile-drafts.ts)
  // if (!existsSync("/Volumes/Research")) { ... }

  // Backup contract — REQUIRED if this job deletes or overwrites knowledge.db rows:
  // before the first write, copy data/knowledge.db →
  // data/knowledge.db.bak.<name>-<ISO timestamp>, skipped only by --no-backup
  // (pattern: reconcile-drafts.ts). Read-only and pure-upsert jobs omit this.

  let processed = 0, skipped = 0, failed = 0;

  // ... work; per-item try/catch so one bad item doesn't kill the batch;
  // every fetch gets AbortSignal.timeout(30_000);
  // all knowledge.db writes via knowledge-db.ts helpers, never raw chunk SQL.

  // WHY: a fully-failed run must not enter logs/metrics as a legitimate zero.
  if (processed === 0 && failed > 0) {
    throw new Error(`all ${failed} items failed — refusing to record this run`);
  }

  const summary = { processed, skipped, failed, dry_run: FLAGS.dryRun };
  console.error(`\n=== Done: ${processed} processed, ${skipped} skipped, ${failed} failed ===`);
  console.log(JSON.stringify(summary)); // the ONLY stdout line
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("<Name> failed:", err);
    process.exit(1);
  });
```

Add to `package.json` scripts: plain `"<name>": "tsx src/<name>.ts"`, or
`"<name>": "pass-cli run --env-file .env -- node dist/<name>.js"` if it needs secrets
(match `rewrite-queue`'s pattern exactly).

**Verify** on real data, against the production runtime (`node dist/`, not npm — the
npm banner and local shell shims pollute stdout and break the count):
```bash
npm run build
out=$(node dist/<name>.js --dry-run 2>/dev/null)
[ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ] && printf '%s' "$out" | jq -e . >/dev/null \
  && echo "stdout contract OK" || echo "FAIL: stdout must be exactly ONE valid JSON line"
```
Also eyeball `node dist/<name>.js --dry-run 2>&1 >/dev/null | head` to confirm stderr
progress is readable.

## Step 2 — The launchd plist (`launchd/ai.astgl.knowledge.<name>.plist`)

Copy this template verbatim — the PATH block and `dist/` (not tsx) are the two things
that have broken before:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.astgl.knowledge.<name></string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/jamescruce/.nvm/versions/node/v24.14.0/bin/node</string>
    <string>/Users/jamescruce/Projects/mcp-astgl-knowledge/dist/<name>.js</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/jamescruce/Projects/mcp-astgl-knowledge</string>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>HH</integer><key>Minute</key><integer>MM</integer></dict>
  <key>StandardOutPath</key><string>/Users/jamescruce/Projects/mcp-astgl-knowledge/logs/<name>.log</string>
  <key>StandardErrorPath</key><string>/Users/jamescruce/Projects/mcp-astgl-knowledge/logs/<name>.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/Users/jamescruce/.nvm/versions/node/v24.14.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- job-specific env vars here, e.g. ASTGL_DRAFTS_DIR — set explicitly, never rely on divergent defaults -->
  </dict>
</dict>
</plist>
```

For multiple daily runs use an array of `StartCalendarInterval` dicts (see
content-pipeline). If the script needs pass-cli secrets, the plist must invoke the
pass-cli wrapper form instead — check how `rewrite-queue` is actually scheduled before
inventing a pattern.

## Step 3 — The Maester descriptor (`cron/<name>.json`)

Match the existing files' shape exactly (open `cron/wiki-sync.json` as the reference):
name, cron-format schedule mirroring the plist times, the command, and plain-English
instructions for what Maester should check/report. This file does NOT schedule
anything — it keeps Maester's runbook truthful. Skipping it means the daily report
lies about what runs.

## Step 4 — Build, install, smoke-test (get James's approval before installing —
launchd changes are an ask-first operation per CLAUDE.md)

```bash
npm run build                      # dist/<name>.js must exist — launchd runs dist
cp launchd/ai.astgl.knowledge.<name>.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.astgl.knowledge.<name>.plist
launchctl kickstart -k gui/$(id -u)/ai.astgl.knowledge.<name>   # fire it NOW
sleep 5 && tail -20 logs/<name>.err.log && tail -3 logs/<name>.log
launchctl list | grep <name>       # exit status must be 0
```

For a schedule *change* to an existing job: `launchctl bootout gui/$(id -u)
~/Library/LaunchAgents/<plist>` first, then bootstrap the edited plist, then kickstart.

The smoke test is not optional: a kickstart run with exit 0, sane stderr, and a valid
JSON summary line in the `.log` is the definition of "installed".

## Step 5 — Ship

- Stage by name: `src/<name>.ts`, `package.json`, `launchd/*.plist`, `cron/*.json`.
  Never `git add -A` (data/ and logs/ traps).
- Confirm `logs/` entries need no gitignore change (whole dir already ignored).
- Update the README "Automated Jobs" table — it is already stale; at minimum don't
  make it staler.
- Conventional commit (`feat(<name>): …`), PR via `/gstack-ship`, and paste the
  kickstart smoke-test output into the PR body as the verification evidence.

## Definition of done (all boxes, no exceptions)

- [ ] Script passes the "Pipeline script" quality bar in CLAUDE.md (dry-run, idempotent, guards, JSON summary, all-failed→abort).
- [ ] `npm run build` clean; job points at `dist/`.
- [ ] Plist has pinned PATH + WorkingDirectory + log routing; installed and kickstart-verified exit 0.
- [ ] `cron/<name>.json` descriptor exists and matches the plist schedule.
- [ ] README jobs table updated; PR open with smoke-test evidence; James approved the launchd install.
