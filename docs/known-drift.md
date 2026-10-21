# Known drift (dated log)

<!-- WHAT: Drift observations with the dates they were verified. Fix opportunistically, never trust; struck-through entries are resolved. The v1.1.0/v1.2.0 line is resolved: package.json, server.json and mcpb/manifest.json all read 1.3.1 on 2026-10-20. The ASTGL_DRAFTS_DIR line is resolved too: ingest-drafts, reconcile-drafts and rewrite-queue share one default on that date.
     Moved out of CLAUDE.md on 2026-10-20 (docs/trim-claude-md); the rules it supports stay there.
     WHY: CLAUDE.md is resent every turn; this is read by hand when the topic comes up. -->

- README.md: tool list (7 vs 17 registered), env-var table, jobs table all stale.
- `server.json` says v1.1.0; package.json is v1.2.0 (registry manifest drift).
- PRs #10, #13, #14 show OPEN on GitHub but their commits are already in main.
- ~~Retired plists still loaded alongside their Maester replacements~~ — resolved
  2026-07-26: booted out and archived in `~/Library/LaunchAgents.retired/`.
- `ASTGL_DRAFTS_DIR` defaults diverge: ingest/reconcile → `/Volumes/Research/ASTGL
  Articles/Drafts`; rewrite-queue/.env.example → `~/Projects/astgl-articles/substack`.
  Set the env var explicitly; never rely on the default.
- ~~`data/*.bak.*` backups accumulate unbounded (~200 MB and growing)~~ — pruned
  2026-07-31 (8 stale files, 323 MB; `data/` 485 MB → 162 MB). A retention rule now
  exists (see *Backup retention* below), but nothing enforces it automatically — the
  directory will grow again and needs a periodic manual pass.
- ~~A 0-byte `knowledge.db` sits at the repo root, untracked and un-gitignored~~ —
  deleted 2026-07-31 and the class is now blocked by a root-anchored `/*.db` rule.
  Investigated: **no code defect exists.** Every DB path in `src/` uses
  `import.meta.dirname`, there is no `process.cwd()` in `src/`, no bare-path example
  in any skill or doc, no launchd log entry at its timestamp, and no other ASTGL repo
  is affected. It was an interactive command run from the repo root instead of
  `data/`. ADR-0001's "something opened a database at `process.cwd()`" reads as a code
  bug; it is not one.
- Asana was retired entirely (2026-07-07): the PAT and `mcp__claude_ai_Asana__*`
  allow rules were removed from `.claude/settings.local.json`; the Teams-to-Asana
  bridge no longer exists. Don't suggest Asana integrations here.
- **`overrides: { tmp: "^0.2.7" }` in package.json is a workaround, not a preference**
  (added 2026-08-01). `@anthropic-ai/mcpb` → `@inquirer/prompts` → `@inquirer/editor` →
  `external-editor` pins `tmp@^0.0.33`, and `^0.0.x` locks to exactly that patch — so
  `tmp` could not reach the patched 0.2.6 by any bump, and mcpb 2.1.2 is already latest.
  `npm audit` reported `fixAvailable: false` for the whole chain. **Remove the override
  once mcpb ships an `@inquirer/prompts` whose `external-editor` allows tmp ≥ 0.2.6** —
  check with `npm audit` after the override is deleted, not by reading version numbers.
  Safe today because `external-editor` calls exactly one tmp API, `tmpNameSync(options)`,
  which still exists in 0.2.7 (verified by constructing a real `ExternalEditor`).
  → This affects **no consumer**: `files` ships `dist` + the pruned DB + README (never
  `node_modules`), the MCPB bundle installs `--omit=dev`, and npm ignores a *dependency's*
  `overrides` — the field only applies at the root of an install.
- **A red `build-mcpb` on main is stale until proven otherwise.** That workflow runs
  only on `workflow_dispatch` and `release` — never on push — so main's Actions view
  shows the latest manual-dispatch or release-triggered run, which can predate any
  number of fixes. On 2026-07-31 it displayed a failure at `b392ff69` (07:15) whose
  cause had been fixed hours later by #36 (`91e4a79`, 09:47) and verified green on that
  PR's branch; nothing had re-run it against main in between, so the red sat there
  looking current. It was reported here as "build-mcpb is failing" before the timestamps
  were checked — don't repeat that. **Compare the run's SHA and time against `main`
  before concluding anything**, and if it is stale, settle it by dispatching
  (`attach_to_release=false` creates workflow artifacts only and does not attach them
  to a GitHub release — the bundles still exist, they are just not published):

  ```bash
  gh workflow run build-mcpb.yml --ref main \
    -f version="$(npm view mcp-astgl-knowledge version)" \
    -f attach_to_release=false
  ```

  The version must already be **published**, since each leg sources `dist/` and the
  pruned database out of the npm tarball via `--from-npm`; reading it from the registry
  rather than hardcoding one keeps the command correct after the next release.
  Last verified **2026-08-01 against `main@3a19f645`, bundling published npm 1.3.1**
  ([run 30710537536](https://github.com/Jmeg8r/mcp-astgl-knowledge/actions/runs/30710537536)):
  all four platforms green, gate verified at **177 articles / 0 withheld / 0 drafts** — the
  first run to carry the post-withdrawal corpus, and the count CI reports here is the
  independent confirmation that the bundle can never carry content the npm package does not.
  (Previously 2026-07-31, `main@4331dd55`, npm 1.3.0,
  [run 30667252610](https://github.com/Jmeg8r/mcp-astgl-knowledge/actions/runs/30667252610),
  178 articles — which established that #36's win32 fix holds on main and not merely on its
  branch.) Record the SHA, the run id AND the npm version when you
  re-verify: the command above resolves the version at dispatch time, so `npm view` will
  return something else after the next release and the record would no longer identify
  which tarball was actually bundled. A bare date is not checkable once main advances,
  and this entry's own rule is to compare SHAs.
  → Corollary for any dispatch-only workflow: **"verified on the branch" and "works on
  main" are different claims**, and only one of them is what a release will run.
