/**
 * Tests for the astgl-site worktree operations.
 *
 * WHAT: Builds throwaway git repos (a bare "origin" and a clone standing in for the
 *       job's worktree) and checks page listing, staleness ordering, the local
 *       commit, and how open jobs resolve.
 * WHY:  The job's only outward effect is a local branch James reviews and pushes
 *       (intent Q1). The cases that matter most: it never pushes, it commits through
 *       the normal hook path, and a merged rewrite is never misread as rejected.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  commitPage,
  fetchSite,
  listAnswerPages,
  resolveJob,
  staleCandidates,
  type AnswerPage,
} from "../src/site-worktree.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function page(date: string, body = "Body text."): string {
  return `---\ntitle: Example\ndescription: Example page\ndate: '${date}'\norder: 1\n---\n\n${body}\n`;
}

interface Fixture {
  root: string;
  origin: string;
  seed: string;
  wt: string;
}

function withSite(fn: (f: Fixture) => void): void {
  const root = mkdtempSync(join(tmpdir(), "site-wt-"));
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const wt = join(root, "wt");
  try {
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
    git(root, "clone", "--quiet", origin, seed);
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
    git(wt, "config", "user.email", "job@example.com");
    git(wt, "config", "user.name", "Rewrite Job");
    fn({ root, origin, seed, wt });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const NOW = new Date("2026-11-03T12:00:00Z");

describe("listAnswerPages", () => {
  test("lists only answer pages on origin/main, with their dates", () => {
    withSite(({ wt }) => {
      writeFileSync(join(wt, "src/content/answers/uncommitted.md"), page("2020-01-01"));
      const pages = listAnswerPages(wt).sort((a, b) => a.slug.localeCompare(b.slug));
      assert.deepEqual(
        pages.map((p) => [p.slug, p.url, p.date]),
        [
          ["fresh-page", "https://astgl.ai/answers/fresh-page", "2026-10-30"],
          ["old-page", "https://astgl.ai/answers/old-page", "2025-01-10"],
          ["older-page", "https://astgl.ai/answers/older-page", "2024-06-01"],
        ]
      );
    });
  });
});

describe("staleCandidates", () => {
  const pages: AnswerPage[] = [
    { slug: "a", url: "https://astgl.ai/answers/a", path: "src/content/answers/a.md", date: "2025-01-10" },
    { slug: "b", url: "https://astgl.ai/answers/b", path: "src/content/answers/b.md", date: "2024-06-01" },
    { slug: "c", url: "https://astgl.ai/answers/c", path: "src/content/answers/c.md", date: "2026-10-30" },
    { slug: "d", url: "https://astgl.ai/answers/d", path: "src/content/answers/d.md", date: "not a date" },
  ];

  test("orders stale pages oldest first and drops fresh or undated ones", () => {
    assert.deepEqual(
      staleCandidates(pages, NOW, 90, new Set()).map((p) => p.slug),
      ["b", "a"]
    );
  });

  test("drops blocked URLs", () => {
    assert.deepEqual(
      staleCandidates(pages, NOW, 90, new Set(["https://astgl.ai/answers/b"])).map((p) => p.slug),
      ["a"]
    );
  });
});

describe("commitPage", () => {
  test("commits the page on a new branch from origin/main and pushes nothing", () => {
    withSite(({ wt, origin }) => {
      const result = commitPage(wt, "old-page", page("2026-11-03", "New body."), "2026-11-03", "rewrite message");
      assert.equal(result.branch, "rewrite/old-page-2026-11-03");
      assert.equal(git(wt, "rev-parse", `${result.commit}^`), git(wt, "rev-parse", "origin/main"));
      assert.equal(
        git(wt, "show", `${result.commit}:src/content/answers/old-page.md`),
        page("2026-11-03", "New body.").trim()
      );
      assert.equal(git(wt, "status", "--porcelain"), "");
      assert.equal(git(origin, "branch", "--list", "rewrite/*"), "");
    });
  });

  test("runs the repository's commit hooks", () => {
    withSite(({ wt }) => {
      const marker = join(wt, "..", "hook-ran");
      const hook = join(wt, ".git/hooks/pre-commit");
      writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(hook, 0o755);
      commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg");
      assert.ok(existsSync(marker));
    });
  });

  test("refuses when the branch already exists", () => {
    withSite(({ wt }) => {
      commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg");
      git(wt, "switch", "--quiet", "--detach", "origin/main");
      assert.throws(() => commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg"));
    });
  });

  test("refuses a dirty worktree", () => {
    withSite(({ wt }) => {
      writeFileSync(join(wt, "stray.txt"), "left behind\n");
      assert.throws(() => commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg"), /not clean/);
    });
  });

  test("refuses a page that is not on origin/main", () => {
    withSite(({ wt }) => {
      assert.throws(() => commitPage(wt, "no-such-page", page("2026-11-03"), "2026-11-03", "msg"));
    });
  });
});

describe("resolveJob", () => {
  test("open while the branch exists and is not merged", () => {
    withSite(({ wt }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg");
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "open");
    });
  });

  test("published once the commit is merged into origin/main", () => {
    withSite(({ wt, seed }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg");
      git(wt, "push", "--quiet", "origin", r.branch);
      git(seed, "fetch", "--quiet", "origin");
      git(seed, "merge", "--quiet", "--no-ff", "-m", "merge", `origin/${r.branch}`);
      git(seed, "push", "--quiet", "origin", "main");
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "published");
    });
  });

  test("published when a squash merge left the page identical", () => {
    withSite(({ wt, seed }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03", "Squashed."), "2026-11-03", "msg");
      writeFileSync(join(seed, "src/content/answers/old-page.md"), page("2026-11-03", "Squashed."));
      git(seed, "commit", "--quiet", "-am", "squash");
      git(seed, "push", "--quiet", "origin", "main");
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "published");
    });
  });

  test("rejected when the branch was deleted without merging", () => {
    withSite(({ wt }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg");
      git(wt, "switch", "--quiet", "--detach", "origin/main");
      git(wt, "branch", "--quiet", "-D", r.branch);
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "rejected");
    });
  });
});
