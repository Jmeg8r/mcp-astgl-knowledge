# The MCPB bundle and its CI matrix

<!-- WHAT: Smithery's MCPB distribution path, why it re-asserts the publication gate, the platform rule, and why build-mcpb.yml sources from npm.
     Moved out of CLAUDE.md on 2026-10-20 (docs/trim-claude-md); the rules it supports stay there.
     WHY: CLAUDE.md is resent every turn; this is read by hand when the topic comes up. -->

Smithery's stdio distribution path is an **MCPB bundle**, not the npm tarball — clients
download and run it locally. Because MCPB requires bundling `node_modules`, the bundle is a
SECOND artifact that can ship content, so it goes through the same publication gate.

- **`npm run build-mcpb`** — stages `manifest.json` + `dist/` + `build/knowledge-public.db`
  + production-only `node_modules`, packs to `dist-mcpb/`, writes a `.sha1`. `--dry-run`
  supported. Output is gitignored: a distributable artifact, never source.
- **It re-asserts the gate** before packing, and refuses with a row count if the database
  carries withheld rows or drafts. `build-public-db` verifies the artifact it writes, but
  this script can run much later against a stale `build/` — an artifact that exists is not
  an artifact that is current (see the `npm pack` incident below).
- **Version agreement is enforced**: `package.json` and `mcpb/manifest.json` must match or
  the build fails. `server.json` is the third copy — keep all three in step.

→ **PLATFORM: a bundle is only valid on the platform that built it.** `better-sqlite3`
compiles a native `.node` per platform and Node ABI; `sqlite-vec` resolves its binary through
per-platform `optionalDependencies`. Multi-platform bundles come from
`.github/workflows/build-mcpb.yml`, which runs this script on macos-15 (arm64),
macos-15-intel (x64), ubuntu-latest, and windows-latest.

### The CI matrix and why it sources from npm

The workflow **requires the npm version to be published first**, because `build/knowledge-public.db`
derives from `data/knowledge.db`, which is not in the repo and must never be — a runner cannot
produce the pruned artifact from source. Each job instead passes `--from-npm <version>`, which
pulls dist/ and the database out of the **published tarball**, already gate-verified.

Two consequences worth keeping: no private content ever reaches CI, and a bundle can never
carry content the npm package does not.

- Runner labels are **verified against actions/runner-images, not assumed** — `macos-13` was
  retired and `macos-14` is deprecated, so the macOS legs are `macos-15` (arm64) and
  `macos-15-intel` (x64).
- **MCPB cannot express CPU architecture.** `compatibility.platforms` is Node platform values
  only, so a darwin-arm64 and a darwin-x64 bundle both declare `["darwin"]` and are
  indistinguishable to a client — architecture lives *only* in the filename. A mislabelled
  bundle is therefore unrecoverable, which is why `build-mcpb.ts` **fails** (not warns) when
  `--platforms` or `--label` disagrees with the build host.
- Node is **pinned** in the workflow (`24.14.0`). better-sqlite3's binary is tied to the Node
  ABI, so a floating runner version would silently emit bundles that fail at `require()` on
  clients using the older ABI. Bump deliberately and re-verify.
- Each job stamps `compatibility.platforms` to its own platform via `--platforms`, so a
  Windows user never downloads a bundle full of darwin binaries.
- Each job **re-verifies its own artifact** — manifest platform and version, gate counts —
  then smoke-tests the extracted bundle with a real MCP handshake. `list_tags` is the chosen
  probe because it is the non-vector path, proving the native binary loaded without a model.
- `fail-fast: false`, so a broken prebuild on one platform still yields the others.
- Cross-platform gotcha, found by the first matrix run: on Windows `npm`/`npx` are `.cmd`
  shims, and since the fix for **CVE-2024-27980** Node *refuses* to spawn `.cmd`/`.bat`
  without a shell — it throws `spawn EINVAL`. Naming `npm.cmd` explicitly was necessary but
  NOT sufficient; the win32 leg failed while all three POSIX legs passed. `build-mcpb.ts`
  now skips the shim entirely: npm sets `npm_execpath` to the absolute path of `npm-cli.js`
  for any script it runs, so the script invokes `node <npm-cli.js> …` — no shell, identical
  on every platform, and `shell: true` (with its quoting surface) stays off the table.
  **Consequence: run it via `npm run build-mcpb`. Direct `tsx src/build-mcpb.ts` execution is
  unsupported on EVERY platform** — `npm_execpath` is only set for npm-run scripts, and the
  script now fails uniformly rather than working on POSIX and breaking on win32. A fallback
  that succeeded on three platforms and failed on the one you cannot test locally is worse
  than no fallback. (`npx tsx …` happens to work because npx sets the variable itself, but
  do not rely on that.)
- Workflow injection: every `${{ }}` value reaching a `run:` block goes through `env:` and is
  referenced as a quoted shell variable, and the resolved version is semver-validated before
  it touches npm or a filename.

→ **`npm pack` does not run `prepublishOnly`.** That is why the gate chain lives in
`prepack`. Before this was found, `npm pack` silently produced a 145 kB tarball with no
database at all, and npm did not complain that a `files` entry pointed at a missing path.
