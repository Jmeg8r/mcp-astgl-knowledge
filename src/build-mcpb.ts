#!/usr/bin/env tsx
/**
 * MCPB bundle build.
 *
 * WHAT: Produces dist-mcpb/astgl-knowledge-<version>.mcpb — a self-contained
 *       zip that Smithery distributes and clients run locally.
 * WHY:  Smithery's stdio distribution path is an MCPB bundle, not the npm
 *       tarball, and MCPB requires node_modules to be bundled. That makes the
 *       bundle a SECOND artifact that can ship content, so it has to go through
 *       the same publication gate as the npm package — a bundle assembled by
 *       hand would be exactly the drift ADR-0001 exists to prevent.
 *
 * Usage:
 *   npm run build-mcpb              # build and verify the bundle
 *   npm run build-mcpb -- --dry-run # report what would be assembled
 *
 * PLATFORM: the bundle is darwin-arm64 ONLY. better-sqlite3 compiles a native
 * .node for the host platform and Node ABI, and sqlite-vec resolves its binary
 * through per-platform optionalDependencies (only sqlite-vec-darwin-arm64 is
 * installed here). A bundle built on this machine will not run on Intel macOS,
 * Windows, or Linux. Shipping other platforms needs a CI matrix that runs this
 * script on each one.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import {
  existsSync,
  mkdirSync,
  rmSync,
  cpSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  statSync,
} from "fs";
import { join } from "path";
import { createHash } from "crypto";
import Database from "better-sqlite3";

const EXEC_FILE_ASYNC = promisify(execFile);

const ROOT = join(import.meta.dirname, "..");
const STAGE = join(ROOT, ".mcpb-stage");
const OUT_DIR = join(ROOT, "dist-mcpb");
const PUBLIC_DB = join(ROOT, "build", "knowledge-public.db");
const MANIFEST = join(ROOT, "mcpb", "manifest.json");

// WHAT: Timeouts for the two shell-outs this script makes.
// WHY:  A dependency install or zip that hangs must fail rather than block a
//       release indefinitely. npm ci over ~136 packages is the slow one.
const NPM_CI_TIMEOUT_MS = 300_000;
const PACK_TIMEOUT_MS = 300_000;

// WHAT: Pinned packer version.
// WHY:  The bundle format is versioned; letting npx float to @latest would let
//       the artifact's structure change without a commit here saying so.
const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

// WHAT: Platform-correct executable names for npm and npx.
// WHY:  On Windows both are `.cmd` shims. execFile does not spawn a shell, so
//       execFile("npm", …) fails with ENOENT there — which would break the
//       win32 matrix job while every other platform passed. Resolved here rather
//       than by enabling a shell, since shell:true would reintroduce the quoting
//       and injection surface this script deliberately avoids.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
// WHY: tar is a real executable on every supported runner (Windows 10+ ships
//      bsdtar as tar.exe), so no .cmd shim dance is needed — but it is named
//      here rather than inlined, for the same reason npm and npx are.
const TAR = "tar";

// WHAT: Bytes per mebibyte, for human-readable size reporting.
const BYTES_PER_MB = 1024 * 1024;

// WHAT: The host this build is running on, as MCPB and Node describe it.
// WHY:  MCPB v0.3 `compatibility.platforms` carries NO cpu architecture, so a
//       darwin-arm64 bundle and a darwin-x64 bundle both declare ["darwin"] and
//       are indistinguishable to a client. Architecture therefore lives only in
//       the FILENAME, which makes a mislabelled artifact unrecoverable — nothing
//       downstream can detect it. These two values let the build refuse to
//       produce a bundle whose declared platform or label disagrees with the
//       machine that actually compiled its native binaries.
const HOST_PLATFORM = process.platform;
const HOST_TRIPLE = `${process.platform}-${process.arch}`;

// WHAT: Read a `--flag value` pair from argv.
// WHY:  Matches the repo's hand-rolled argv convention — no arg-parsing dep.
function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const FLAGS = {
  dryRun: process.argv.includes("--dry-run"),
  // WHAT: Source dist/ and the pruned database from a PUBLISHED npm version
  //       instead of the local working tree.
  // WHY:  This is what makes a CI matrix possible. data/knowledge.db is not in
  //       the repo and must never be, so a runner cannot produce the pruned
  //       artifact from source. The published tarball already contains a
  //       gate-verified build/knowledge-public.db, so sourcing from there means
  //       no private data reaches CI, and a bundle can never carry content the
  //       npm package does not. Provenance is the published release.
  fromNpm: argValue("--from-npm"),
  // WHAT: Override compatibility.platforms in the staged manifest.
  // WHY:  Each platform's bundle must advertise only the platform whose native
  //       binaries it actually contains, or a Windows user downloads a bundle
  //       carrying a darwin .node and gets a broken server.
  platforms: argValue("--platforms")?.split(",").map((p) => p.trim()).filter(Boolean),
  // WHAT: Suffix for the output filename, e.g. darwin-arm64.
  // WHY:  A matrix produces several bundles for one version; without a suffix
  //       they overwrite each other.
  label: argValue("--label"),
};

interface Summary {
  built: boolean;
  path?: string;
  version?: string;
  articles_public?: number;
  bytes?: number;
  platform?: string;
  error?: string;
  dry_run: boolean;
}

function fail(error: string, extra: Partial<Summary> = {}): never {
  console.error(`\nbuild-mcpb failed: ${error}`);
  console.log(
    JSON.stringify({ built: false, error, dry_run: FLAGS.dryRun, ...extra })
  );
  process.exit(1);
}

// WHAT: Confirm the database about to be bundled actually passed the gate.
// WHY:  build-public-db.ts verifies the artifact it writes, but this script may
//       run much later against a stale build/ directory. Re-asserting here means
//       a bundle can never carry withheld rows just because the prune ran once
//       and the file was never regenerated (see the npm pack incident: an
//       artifact that exists is not an artifact that is current).
function assertGatePassed(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const q = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    const withheld = q("SELECT COUNT(*) AS n FROM articles WHERE public = 0");
    const drafts = q(
      "SELECT COUNT(*) AS n FROM articles WHERE content_type = 'draft'"
    );
    const total = q("SELECT COUNT(*) AS n FROM articles");
    if (withheld > 0 || drafts > 0) {
      fail(
        `refusing to bundle: ${withheld} withheld row(s), ${drafts} draft(s) present in ${dbPath}`
      );
    }
    if (total === 0) fail("refusing to bundle an empty database");
    return total;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  console.error("=== Build MCPB bundle ===\n");
  if (FLAGS.dryRun) console.error("  [DRY RUN — nothing will be written]\n");

  // WHY: A warning here was not enough (review on #35). Because MCPB cannot
  //       encode architecture, a bundle mislabelled at build time is
  //       indistinguishable from a correct one afterwards — so disagreement
  //       between the host, the declared platform, and the filename label is
  //       fatal rather than advisory.
  if (FLAGS.platforms?.length) {
    if (FLAGS.platforms.length !== 1 || FLAGS.platforms[0] !== HOST_PLATFORM) {
      fail(
        `--platforms ${FLAGS.platforms.join(",")} does not match the build host (${HOST_PLATFORM}). ` +
          `A bundle may only declare the platform whose native binaries it contains.`
      );
    }
  }
  if (FLAGS.label && FLAGS.label !== HOST_TRIPLE) {
    fail(
      `--label ${FLAGS.label} does not match the build host (${HOST_TRIPLE}). ` +
        `Architecture is not expressible in MCPB compatibility, so the filename is the only ` +
        `signal a consumer has — it must be accurate.`
    );
  }

  if (!FLAGS.fromNpm && !existsSync(PUBLIC_DB)) {
    fail(
      `pruned database missing at ${PUBLIC_DB} — run 'npm run build-public-db' first, or pass --from-npm <version>`
    );
  }
  if (!existsSync(MANIFEST)) fail(`manifest missing at ${MANIFEST}`);

  // WHAT: Populate the stage's content (package.json, dist/, build/, README)
  //       from either the published tarball or the local working tree.
  // WHY:  Done before the gate and version checks so those checks run against
  //       what will ACTUALLY be packed, not against whatever the working tree
  //       happens to hold. Checking the local copy and shipping a different one
  //       is how npm pack shipped an empty database.
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  if (FLAGS.fromNpm) {
    console.error(`  Sourcing content from npm: mcp-astgl-knowledge@${FLAGS.fromNpm}`);
    await EXEC_FILE_ASYNC(
      NPM,
      ["pack", `mcp-astgl-knowledge@${FLAGS.fromNpm}`, "--pack-destination", STAGE],
      { cwd: STAGE, timeout: NPM_CI_TIMEOUT_MS }
    );
    const tgz = join(STAGE, `mcp-astgl-knowledge-${FLAGS.fromNpm}.tgz`);
    if (!existsSync(tgz)) fail(`npm pack produced no tarball for ${FLAGS.fromNpm}`);
    // --strip-components=1 unwraps the tarball's "package/" prefix so the stage
    // layout matches a local build exactly.
    await EXEC_FILE_ASYNC(TAR, ["-xzf", tgz, "-C", STAGE, "--strip-components=1"], {
      cwd: STAGE,
      timeout: PACK_TIMEOUT_MS,
    });
    rmSync(tgz, { force: true });
    // WHY: The published tarball omits the lockfile, but `npm ci` requires one.
    //      Take it from the checkout — it is the tree the release was built from.
    copyFileSync(join(ROOT, "package-lock.json"), join(STAGE, "package-lock.json"));
  } else {
    cpSync(join(ROOT, "dist"), join(STAGE, "dist"), { recursive: true });
    mkdirSync(join(STAGE, "build"), { recursive: true });
    copyFileSync(PUBLIC_DB, join(STAGE, "build", "knowledge-public.db"));
    for (const f of ["package.json", "package-lock.json", "README.md"]) {
      copyFileSync(join(ROOT, f), join(STAGE, f));
    }
  }

  const stagedDb = join(STAGE, "build", "knowledge-public.db");
  if (!existsSync(stagedDb)) fail(`staged content has no database at ${stagedDb}`);

  const pkg = JSON.parse(
    readFileSync(join(STAGE, "package.json"), "utf-8")
  ) as { version: string };
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8")) as {
    version: string;
    compatibility?: { platforms?: string[] };
  };

  // WHY: Three files carry the version (package.json, mcpb/manifest.json,
  //      server.json). Two disagreeing is how a client ends up reporting a
  //      version the registry never saw — the drift CodeRabbit caught in #34.
  if (manifest.version !== pkg.version) {
    fail(
      `version mismatch: package.json is ${pkg.version}, mcpb/manifest.json is ${manifest.version}`
    );
  }

  const articles = assertGatePassed(stagedDb);
  console.error(`  Gate check: ${articles} articles, 0 withheld, 0 drafts`);
  console.error(`  Version:    ${pkg.version}`);

  if (FLAGS.dryRun) {
    console.error(
      `\n  Would assemble: manifest.json, dist/, build/, node_modules/ (prod)` +
        `\n  Source: ${FLAGS.fromNpm ? `npm@${FLAGS.fromNpm}` : "local working tree"}` +
        `\n  Platforms: ${(FLAGS.platforms ?? manifest.compatibility?.platforms ?? []).join(", ") || "(manifest default)"}`
    );
    console.log(
      JSON.stringify({
        built: false,
        version: pkg.version,
        articles_public: articles,
        platform: `${process.platform}-${process.arch}`,
        dry_run: true,
      } satisfies Summary)
    );
    return;
  }

  // --- Write the manifest into the stage, platform-stamped ---
  // WHY: compatibility.platforms must describe the native binaries this bundle
  //      actually carries. The matrix passes --platforms per runner.
  if (FLAGS.platforms?.length) {
    manifest.compatibility = { ...manifest.compatibility, platforms: FLAGS.platforms };
    console.error(`  Manifest platforms → ${FLAGS.platforms.join(", ")}`);
  }
  writeFileSync(join(STAGE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // WHY: --omit=dev keeps typescript/tsx out of a distributed artifact. `npm ci`
  //      rather than `npm install` so the tree matches the committed lockfile.
  console.error("\n  Installing production dependencies into the stage…");
  await EXEC_FILE_ASYNC(NPM, ["ci", "--omit=dev"], {
    cwd: STAGE,
    timeout: NPM_CI_TIMEOUT_MS,
  });

  // WHY: The lockfile is only needed to produce node_modules; shipping it inside
  //      the bundle just inflates the archive.
  rmSync(join(STAGE, "package-lock.json"), { force: true });

  mkdirSync(OUT_DIR, { recursive: true });
  const suffix = FLAGS.label ? `-${FLAGS.label}` : "";
  const outFile = join(OUT_DIR, `astgl-knowledge-${pkg.version}${suffix}.mcpb`);
  rmSync(outFile, { force: true });

  console.error("  Packing…");
  const { stdout } = await EXEC_FILE_ASYNC(
    NPX,
    ["--yes", MCPB_CLI, "pack", STAGE, outFile],
    { cwd: ROOT, timeout: PACK_TIMEOUT_MS }
  );

  rmSync(STAGE, { recursive: true, force: true });

  if (!existsSync(outFile)) fail("packer reported success but no bundle exists");
  const bytes = statSync(outFile).size;

  // WHAT: SHA-1 computed from the artifact on disk.
  // WHY:  The packer does print a shasum, but parsing it made the checksum
  //       depend on that tool's stdout format — and the previous fallback would
  //       have written the literal string "unknown" into a .sha1 file, which is
  //       worse than no checksum at all (review on #35). Hashing the file is
  //       authoritative and cannot silently degrade. The packer's own value is
  //       still cross-checked below when present.
  const shasum = createHash("sha1")
    .update(readFileSync(outFile))
    .digest("hex");
  const packerSha = /shasum:\s*([0-9a-f]{40})/.exec(stdout)?.[1];
  if (packerSha && packerSha !== shasum) {
    fail(
      `digest mismatch: packer reported ${packerSha} but the file on disk hashes to ${shasum}`
    );
  }

  console.error(
    `\n=== Built ${outFile} — ${(bytes / BYTES_PER_MB).toFixed(1)} MB, shasum ${shasum} ===`
  );
  writeFileSync(
    `${outFile}.sha1`,
    `${shasum}  astgl-knowledge-${pkg.version}${suffix}.mcpb\n`
  );

  console.log(
    JSON.stringify({
      built: true,
      path: outFile,
      version: pkg.version,
      articles_public: articles,
      bytes,
      platform: `${process.platform}-${process.arch}`,
      dry_run: false,
    } satisfies Summary)
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // WHY: Unexpected throws (fs, JSON.parse, a subprocess) previously exited 1
    //      with nothing on stdout, breaking the one-JSON-summary contract that
    //      schedulers and MAESTER parse. Route them through fail() so EVERY
    //      fatal path emits exactly one machine-readable result.
    fail(err instanceof Error ? err.message : String(err));
  });
