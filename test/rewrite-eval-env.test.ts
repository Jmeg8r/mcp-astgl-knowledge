/**
 * Tests that `npm run rewrite-eval` reads its settings from `.env`.
 *
 * WHAT: Runs the `rewrite-eval` command line from package.json, unchanged, in a temp
 *       directory whose `dist/rewrite-eval.js` is a stub that prints the two settings
 *       the eval reads.
 * WHY:  The eval must measure the same astgl-site checkout and Ollama the queue uses.
 *       Run without `.env`, it silently fell back to the defaults (2026-11-05). The
 *       stub keeps the test on the script's behavior, not its wording.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SCRIPT: string = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")).scripts[
  "rewrite-eval"
];

const STUB = `console.log(JSON.stringify({
  site: process.env.ASTGL_SITE_WORKTREE ?? null,
  ollama: process.env.OLLAMA_BASE_URL ?? null,
}));
`;

// Only what node needs to start: the developer's own ASTGL_* or OLLAMA_* values must
// not leak in and make a test pass.
function runScript(dir: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("/bin/sh", ["-c", SCRIPT], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...extraEnv },
    encoding: "utf-8",
  });
}

function withStub(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "eval-env-"));
  try {
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "rewrite-eval.js"), STUB);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("npm run rewrite-eval", () => {
  test("passes the settings in .env to the eval", () =>
    withStub((dir) => {
      writeFileSync(join(dir, ".env"), "ASTGL_SITE_WORKTREE=/srv/site\nOLLAMA_BASE_URL=http://127.0.0.1:11434\n");
      const r = runScript(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { site: "/srv/site", ollama: "http://127.0.0.1:11434" });
    }));

  test("a value set in the shell wins over .env", () =>
    withStub((dir) => {
      writeFileSync(join(dir, ".env"), "ASTGL_SITE_WORKTREE=/srv/site\n");
      const r = runScript(dir, { ASTGL_SITE_WORKTREE: "/tmp/other-site" });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).site, "/tmp/other-site");
    }));

  test("a missing .env fails instead of falling back to the defaults", () =>
    withStub((dir) => {
      const r = runScript(dir);
      assert.notEqual(r.status, 0, `expected a failure, got stdout: ${r.stdout}`);
    }));
});
