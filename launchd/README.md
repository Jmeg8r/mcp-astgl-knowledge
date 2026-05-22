# LaunchAgents — source of truth

This directory holds version-controlled copies of the macOS LaunchAgent
plists that run mcp-astgl-knowledge background jobs. The actual files
that launchd reads live at `~/Library/LaunchAgents/` and are NOT in this
repo. These copies exist so:

1. If the installed file gets accidentally clobbered or corrupted, you
   have a known-good baseline to restore from.
2. Anyone setting up a fresh Mac for this project knows exactly what
   to install.
3. Plist changes get the same review/PR scrutiny as code changes.

## Install / re-install

```bash
# 1. Copy into LaunchAgents
cp launchd/ai.astgl.knowledge.content-pipeline.plist \
   ~/Library/LaunchAgents/

# 2. Reload (idempotent — safe to re-run)
launchctl bootout gui/$(id -u) \
  ~/Library/LaunchAgents/ai.astgl.knowledge.content-pipeline.plist 2>/dev/null
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/ai.astgl.knowledge.content-pipeline.plist

# 3. Smoke-test by triggering a fire immediately
launchctl kickstart -k gui/$(id -u)/ai.astgl.knowledge.content-pipeline

# 4. Watch the result
tail -f logs/content-pipeline.err.log
```

## What's in here

- **`ai.astgl.knowledge.content-pipeline.plist`** — runs `dist/pipeline.js`
  every 6 hours (00:00, 06:00, 12:00, 18:00 local). Discovery + structure
  pass. Load-bearing for the MCP knowledge base.
- **`ai.astgl.knowledge.draft-pipeline.plist`** — runs `dist/ingest-drafts.js`
  nightly at 00:00. Indexes pre-publication drafts under
  `astgl-articles/substack/` and the processed-moments topic ledger.
- **`ai.astgl.knowledge.draft-reconciler.plist`** — runs
  `dist/reconcile-drafts.js` nightly at 02:00 (2h after the drafts ingester).
  Hard-deletes draft entries whose source folder is gone or renamed
  `Published_*`, so MCP search no longer cites stale drafts after a
  piece ships. Auto-backs up `data/knowledge.db` before DELETE.

## What's NOT in here (and why)

The Discord-era plists that retire 2026-04-22 are intentionally excluded
so they don't get re-installed by anyone copying this directory wholesale:

- `ai.astgl.knowledge.daily-report` — replaced by claudeclaw's
  `astgl-daily-report` Maester task
- `ai.astgl.knowledge.content-alerts` — replaced by claudeclaw's
  `astgl-content-alerts` Maester task
- `ai.astgl.knowledge.content-freshness` — replaced by claudeclaw's
  `astgl-content-freshness` Maester task

Their installed files at `~/Library/LaunchAgents/` will be retired by
`claudeclaw/scripts/retire-astgl-discord.sh` on 2026-04-22.

## Why the EnvironmentVariables PATH matters

The plist invokes `node dist/pipeline.js` with an absolute Node path,
which works for the entry point. But `pipeline.js` shells out to
`node_modules/.bin/tsx`, whose `#!/usr/bin/env node` shebang requires
`node` to be on the runtime PATH.

launchd's default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) does NOT
include nvm's node bin or Homebrew. Without the explicit
`EnvironmentVariables.PATH` block, every spawn of `tsx` (or any
shebang script) inside the pipeline fails with:

    env: node: No such file or directory

This is the same root cause as claudeclaw [PR #77](https://github.com/Jmeg8r/claudeclaw/pull/77).
The fix here mirrors that one — pin the nvm node bin first so subprocess
shebangs resolve correctly regardless of what Homebrew has installed.
