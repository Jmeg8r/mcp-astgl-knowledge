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
import Database from "better-sqlite3";

const execFileAsync = promisify(execFile);

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

const FLAGS = { dryRun: process.argv.includes("--dry-run") };

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

  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.error(
      `  WARNING: building on ${process.platform}-${process.arch}. The manifest declares\n` +
        `  platforms: ["darwin"] — update mcpb/manifest.json if that is no longer true.\n`
    );
  }

  if (!existsSync(PUBLIC_DB)) {
    fail(
      `pruned database missing at ${PUBLIC_DB} — run 'npm run build-public-db' first`
    );
  }
  if (!existsSync(MANIFEST)) fail(`manifest missing at ${MANIFEST}`);

  const pkg = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf-8")
  ) as { version: string };
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8")) as {
    version: string;
  };

  // WHY: Three files carry the version (package.json, mcpb/manifest.json,
  //      server.json). Two disagreeing is how a client ends up reporting a
  //      version the registry never saw — the drift CodeRabbit caught in #34.
  if (manifest.version !== pkg.version) {
    fail(
      `version mismatch: package.json is ${pkg.version}, mcpb/manifest.json is ${manifest.version}`
    );
  }

  const articles = assertGatePassed(PUBLIC_DB);
  console.error(`  Gate check: ${articles} articles, 0 withheld, 0 drafts`);
  console.error(`  Version:    ${pkg.version}`);

  if (FLAGS.dryRun) {
    console.error("\n  Would assemble: manifest.json, dist/, build/, node_modules/ (prod)");
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

  // --- Stage ---
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(join(STAGE, "build"), { recursive: true });
  copyFileSync(MANIFEST, join(STAGE, "manifest.json"));
  cpSync(join(ROOT, "dist"), join(STAGE, "dist"), { recursive: true });
  copyFileSync(PUBLIC_DB, join(STAGE, "build", "knowledge-public.db"));
  for (const f of ["package.json", "package-lock.json", "README.md"]) {
    copyFileSync(join(ROOT, f), join(STAGE, f));
  }

  // WHY: --omit=dev keeps typescript/tsx out of a distributed artifact. `npm ci`
  //      rather than `npm install` so the tree matches the committed lockfile.
  console.error("\n  Installing production dependencies into the stage…");
  await execFileAsync("npm", ["ci", "--omit=dev"], {
    cwd: STAGE,
    timeout: NPM_CI_TIMEOUT_MS,
  });

  // WHY: The lockfile is only needed to produce node_modules; shipping it inside
  //      the bundle just inflates the archive.
  rmSync(join(STAGE, "package-lock.json"), { force: true });

  mkdirSync(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `astgl-knowledge-${pkg.version}.mcpb`);
  rmSync(outFile, { force: true });

  console.error("  Packing…");
  const { stdout } = await execFileAsync(
    "npx",
    ["--yes", MCPB_CLI, "pack", STAGE, outFile],
    { cwd: ROOT, timeout: PACK_TIMEOUT_MS }
  );
  const shasum = /shasum:\s*([0-9a-f]+)/.exec(stdout)?.[1] ?? "unknown";

  rmSync(STAGE, { recursive: true, force: true });

  if (!existsSync(outFile)) fail("packer reported success but no bundle exists");
  const bytes = statSync(outFile).size;

  console.error(
    `\n=== Built ${outFile} — ${(bytes / 1024 / 1024).toFixed(1)} MB, shasum ${shasum} ===`
  );
  writeFileSync(
    join(OUT_DIR, `astgl-knowledge-${pkg.version}.mcpb.sha1`),
    `${shasum}  astgl-knowledge-${pkg.version}.mcpb\n`
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
    console.error("build-mcpb failed:", err);
    process.exit(1);
  });
