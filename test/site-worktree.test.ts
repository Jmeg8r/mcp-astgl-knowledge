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
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  commitPage,
  fetchSite,
  listAnswerPages,
  readPageAt,
  resolveJob,
  staleCandidates,
  type AnswerPage,
} from "../src/site-worktree.js";
import { git, page, withSite } from "./helpers/site-fixture.js";

const NOW = new Date("2026-11-03T12:00:00Z");

describe("listAnswerPages", () => {
  test("lists only answer pages on origin/main, with their dates", () => {
    return withSite(({ wt }) => {
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
    return withSite(({ wt, origin }) => {
      const result = commitPage(wt, "old-page", page("2026-11-03", "New body."), "2026-11-03", "rewrite message", "origin/main");
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

  test("leaves the worktree detached so James can delete the branch to reject", () => {
    return withSite(({ wt }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main");
      assert.equal(git(wt, "rev-parse", "HEAD"), git(wt, "rev-parse", "origin/main"));
      git(wt, "branch", "--quiet", "-D", r.branch);
      assert.equal(git(wt, "branch", "--list", "rewrite/*"), "");
    });
  });

  test("branches from the revision the page was read at, not a newer main", () => {
    return withSite(({ wt, seed }) => {
      const base = git(wt, "rev-parse", "origin/main");
      writeFileSync(join(seed, "src/content/answers/old-page.md"), page("2026-11-02", "Edited meanwhile."));
      git(seed, "commit", "--quiet", "-am", "edit during rewrite");
      git(seed, "push", "--quiet", "origin", "main");
      fetchSite(wt);
      const r = commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", base);
      assert.equal(git(wt, "rev-parse", `${r.commit}^`), base);
    });
  });

  test("runs the repository's commit hooks", () => {
    return withSite(({ wt }) => {
      const marker = join(wt, "..", "hook-ran");
      const hook = join(wt, "..", "hooks", "pre-commit");
      writeFileSync(hook, `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(hook, 0o755);
      commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main");
      assert.ok(existsSync(marker));
    });
  });

  test("a hook refusal leaves no branch and a clean worktree", () => {
    return withSite(({ wt }) => {
      const hook = join(wt, "..", "hooks", "pre-commit");
      writeFileSync(hook, "#!/bin/sh\nexit 1\n");
      chmodSync(hook, 0o755);
      assert.throws(() => commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main"));
      assert.equal(git(wt, "branch", "--list", "rewrite/*"), "");
      assert.equal(git(wt, "status", "--porcelain"), "");
    });
  });

  test("refuses when the branch already exists", () => {
    return withSite(({ wt }) => {
      commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main");
      git(wt, "switch", "--quiet", "--detach", "origin/main");
      assert.throws(() => commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main"));
    });
  });

  test("refuses while another running process holds the worktree lock", () => {
    return withSite(({ wt }) => {
      writeFileSync(join(wt, ".git", "rewrite-queue.lock"), String(process.pid));
      assert.throws(() => commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main"), /busy/);
      assert.equal(git(wt, "branch", "--list", "rewrite/*"), "");
    });
  });

  test("takes over a lock left by a process that is no longer running", () => {
    return withSite(({ wt }) => {
      const lock = join(wt, ".git", "rewrite-queue.lock");
      writeFileSync(lock, "999999");
      commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main");
      assert.equal(existsSync(lock), false);
    });
  });

  test("works in a linked git worktree, the production setup", () => {
    return withSite(({ wt, root, origin }) => {
      const linked = join(root, "linked");
      git(wt, "worktree", "add", "--quiet", "--detach", linked, "origin/main");
      const r = commitPage(linked, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main");
      assert.equal(git(linked, "rev-parse", `${r.commit}^`), git(linked, "rev-parse", "origin/main"));
      assert.equal(git(origin, "branch", "--list", "rewrite/*"), "");
    });
  });

  test("a GIT_DIR inherited from a git hook never reaches another repository", async () => {
    const decoy = mkdtempSync(join(tmpdir(), "decoy-repo-"));
    const saved = process.env.GIT_DIR;
    try {
      git(decoy, "init", "--quiet", "--initial-branch=main");
      git(decoy, "-c", "user.name=Decoy", "-c", "user.email=decoy@example.com", "commit", "--quiet", "--allow-empty", "-m", "decoy");
      const headBefore = git(decoy, "rev-parse", "HEAD");
      const configBefore = git(decoy, "config", "--local", "--list");
      process.env.GIT_DIR = join(decoy, ".git");
      await withSite(({ wt }) => {
        commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main");
      });
      delete process.env.GIT_DIR;
      assert.equal(git(decoy, "rev-parse", "HEAD"), headBefore);
      assert.equal(git(decoy, "config", "--local", "--list"), configBefore);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  test("refuses a dirty worktree", () => {
    return withSite(({ wt }) => {
      writeFileSync(join(wt, "stray.txt"), "left behind\n");
      assert.throws(() => commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main"), /not clean/);
    });
  });

  test("refuses a page that is not on origin/main", () => {
    return withSite(({ wt }) => {
      assert.throws(() => commitPage(wt, "no-such-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main"));
    });
  });
});

describe("resolveJob", () => {
  test("open while the branch exists and is not merged", () => {
    return withSite(({ wt }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main");
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "open");
    });
  });

  test("published once the commit is merged into origin/main", () => {
    return withSite(({ wt, seed }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main");
      git(wt, "push", "--quiet", "origin", r.branch);
      git(seed, "fetch", "--quiet", "origin");
      git(seed, "merge", "--quiet", "--no-ff", "-m", "merge", `origin/${r.branch}`);
      git(seed, "push", "--quiet", "origin", "main");
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "published");
    });
  });

  test("published when a squash merge left the page identical", () => {
    return withSite(({ wt, seed }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03", "Squashed."), "2026-11-03", "msg", "origin/main");
      writeFileSync(join(seed, "src/content/answers/old-page.md"), page("2026-11-03", "Squashed."));
      git(seed, "commit", "--quiet", "-am", "squash");
      git(seed, "push", "--quiet", "origin", "main");
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "published");
    });
  });

  test("published when review edits on the branch were squash-merged", () => {
    return withSite(({ wt, seed }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03", "Draft."), "2026-11-03", "msg", "origin/main");
      git(wt, "switch", "--quiet", r.branch);
      writeFileSync(join(wt, "src/content/answers/old-page.md"), page("2026-11-03", "Corrected in review."));
      git(wt, "commit", "--quiet", "-am", "review fix");
      git(wt, "switch", "--quiet", "--detach", "origin/main");
      writeFileSync(join(seed, "src/content/answers/old-page.md"), page("2026-11-03", "Corrected in review."));
      git(seed, "commit", "--quiet", "-am", "squash");
      git(seed, "push", "--quiet", "origin", "main");
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "published");
    });
  });

  test("superseded when main's page changed in a way the job cannot explain", () => {
    return withSite(({ wt, seed }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03", "Draft."), "2026-11-03", "msg", "origin/main");
      writeFileSync(join(seed, "src/content/answers/old-page.md"), page("2026-11-04", "Edited in the forge."));
      git(seed, "commit", "--quiet", "-am", "squash with web edits");
      git(seed, "push", "--quiet", "origin", "main");
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "superseded");
      git(wt, "branch", "--quiet", "-D", r.branch);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "superseded");
    });
  });

  test("rejected when the branch was deleted without merging", () => {
    return withSite(({ wt }) => {
      const r = commitPage(wt, "old-page", page("2026-11-03"), "2026-11-03", "msg", "origin/main");
      git(wt, "switch", "--quiet", "--detach", "origin/main");
      git(wt, "branch", "--quiet", "-D", r.branch);
      fetchSite(wt);
      assert.equal(resolveJob(wt, r.branch, r.commit, "src/content/answers/old-page.md"), "rejected");
    });
  });
});

// A missing worktree made git spawns fail as "spawnSync git ENOENT", which reads as
// git not being installed (18 failed keeps, 2026-11-05), and made resolveJob report
// "rejected" because every probe came back false.
describe("missing worktree", () => {
  function withMissingDir(fn: (dir: string) => void): void {
    const root = mkdtempSync(join(tmpdir(), "site-missing-"));
    try {
      fn(join(root, "absent"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const namesTheWorktree = (dir: string) => (err: unknown) =>
    err instanceof Error &&
    err.message.includes(`astgl-site worktree not found: ${dir}`) &&
    err.message.includes("ASTGL_SITE_WORKTREE");

  test("fetchSite names the missing directory", () =>
    withMissingDir((dir) => assert.throws(() => fetchSite(dir), namesTheWorktree(dir))));

  test("listAnswerPages and readPageAt name the missing directory", () =>
    withMissingDir((dir) => {
      assert.throws(() => listAnswerPages(dir), namesTheWorktree(dir));
      assert.throws(() => readPageAt(dir, "origin/main", "src/content/answers/old-page.md"), namesTheWorktree(dir));
    }));

  test("resolveJob throws instead of reporting rejected", () =>
    withMissingDir((dir) =>
      assert.throws(
        () => resolveJob(dir, "rewrite/old-page-2026-11-03", "0".repeat(40), "src/content/answers/old-page.md"),
        namesTheWorktree(dir)
      )));
});
