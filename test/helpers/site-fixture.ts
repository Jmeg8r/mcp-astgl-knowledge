/**
 * Throwaway astgl-site repos for tests.
 *
 * WHAT: A bare "origin" with three answer pages and one non-answer file, a "seed"
 *       clone standing in for James (merges, pushes), and a "wt" clone standing in
 *       for the job's worktree.
 * WHY:  Shared by the worktree and runner tests so both exercise the same git
 *       shapes. Each repo points core.hooksPath at a fixture directory: a global
 *       hooksPath on the developer's machine would otherwise run real hooks in
 *       tests, and a test can install a hook there deliberately.
 */

import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { gitEnv } from "../../src/site-worktree.js";

export interface SiteFixture {
  root: string;
  origin: string;
  seed: string;
  wt: string;
  hooks: string;
}

// gitEnv(): the suite runs inside git's pre-push hook, whose GIT_DIR would otherwise
// point these commands at the real repository instead of the fixture (2026-11-03).
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf-8" }).trim();
}

export function page(date: string, body = "Body text."): string {
  return `---\ntitle: Example\ndescription: Example page\ndate: '${date}'\norder: 1\n---\n\n${body}\n`;
}

export function withSite(fn: (f: SiteFixture) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "site-wt-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const wt = join(root, "wt");
  const hooks = join(root, "hooks");
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    mkdirSync(hooks);
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    git(root, "clone", "--quiet", origin, seed);
    git(seed, "config", "core.hooksPath", hooks);
    git(seed, "config", "user.email", "test@example.com");
    git(seed, "config", "user.name", "Test");
    mkdirSync(join(seed, "src/content/answers"), { recursive: true });
    mkdirSync(join(seed, "src/pages"), { recursive: true });
    writeFileSync(join(seed, "src/content/answers/old-page.md"), page("2025-01-10"));
    writeFileSync(join(seed, "src/content/answers/older-page.md"), page("2024-06-01"));
    writeFileSync(join(seed, "src/content/answers/fresh-page.md"), page("2026-10-30"));
    writeFileSync(join(seed, "src/pages/index.astro"), "not an answer page\n");
    git(seed, "add", ".");
    git(seed, "commit", "--quiet", "-m", "seed");
    git(seed, "push", "--quiet", "origin", "main");
    git(root, "clone", "--quiet", origin, wt);
    git(wt, "config", "core.hooksPath", hooks);
    git(wt, "config", "user.email", "job@example.com");
    git(wt, "config", "user.name", "Rewrite Job");
    return Promise.resolve(fn({ root, origin, seed, wt, hooks })).finally(cleanup);
  } catch (err) {
    cleanup();
    throw err;
  }
}
