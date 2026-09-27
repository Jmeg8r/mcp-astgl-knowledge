# LaunchAgent log path recovery — September 27, 2026

## Goal

Restore the four ASTGL knowledge LaunchAgents after the repository moved to the external `/Volumes/Projects` volume. Keep their executables, working directories, schedules, data paths, and stateful behavior unchanged.

| Item | Plan said | Reality (verified September 27) | Decision |
|---|---|---|---|
| Job logs | Write to `~/Projects/mcp-astgl-knowledge/logs/` | At 18:00 launchd could not open the content stdout path: `Operation not permitted`; last exit `78: EX_CONFIG`. Three sibling jobs also show spawn failed/78. | Move only stdout/stderr to `~/Library/Logs/mcp-astgl-knowledge/`. |
| External volume data | Repository and databases under `~/Projects/` | That path became a symlink to `/Volumes/Projects/Repositories/mcp-astgl-knowledge` on September 26. An inert launchd Node job wrote a temporary file there successfully; launchd itself could not open an external-volume stdout path. | Keep working directory and data paths unchanged. |
| Acceptance | A manual fire could prove the pipeline | Discovery/structuring and draft reconciliation are stateful. | Validate plist loading with inert jobs; inspect the next real scheduled executions, not a replay. |

## Invariants

- Preserve existing job labels, schedules, executable arguments, environment, working directories, data stores, and legacy paused rewrite queue.
- Never copy or commit live logs, `data/knowledge.db`, lockfile changes from the dirty primary checkout, or secrets.
- Create the home log directory before installing the plists. Keep old logs as historical evidence.
- Update ClaudeClaw's healthcheck and WATCHMAN readers in a separate PR before claiming recovered monitoring.
- Installing or booting out production jobs waits for James's explicit approval under this repository's operating manual.

## Waves

1. Change the four source plists' `StandardOutPath` and `StandardErrorPath`; update `launchd/README.md` and the new-job path guidance in `CLAUDE.md`. Verify `plutil -lint`, exact plist key diff, and repository status in an isolated worktree.
2. Pass normal current-head review and CI, merge with actual source ancestry verified. Preserve the dirty primary checkout.
3. After approved ClaudeClaw monitoring changes and explicit deployment approval, create `~/Library/Logs/mcp-astgl-knowledge`, install the reviewed plists, bootout/bootstrap the four jobs, and inspect launchd registration. Do not kickstart stateful jobs for acceptance.
4. Observe the next calendar fires and their summaries; verify ClaudeClaw's freshness and WATCHMAN probes read the new location. If a job still fails, diagnose its raw local log/launchd error before changing other settings.

## Decisions settled, September 27

The denial is specific to launchd opening stdout/stderr on the external volume, not an absent Node binary or a general inability of Node to write its data. Moving only logs is the smallest supported repair. The next real content run, not an inert probe, is production acceptance.
