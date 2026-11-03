/**
 * astgl-site worktree operations for the rewrite queue.
 *
 * WHAT: Lists the answer pages on astgl-site's origin/main with their frontmatter
 *       dates, picks stale ones, commits a rewritten page to a new local branch,
 *       and resolves an open job against origin/main.
 * WHY:  The job's only outward effect is a local branch James reviews, pushes and
 *       merges; merging is the approval (intent Q1, spec F5). Everything is read
 *       from git so no state lives outside git and rewrite_jobs. The job never
 *       pushes, and it commits with plain `git commit` so astgl-site's hooks run.
 */

import { execFileSync } from "child_process";
import { renameSync, writeFileSync } from "fs";
import { join } from "path";

const MAIN_REF = "origin/main";
const ANSWERS_DIR = "src/content/answers";
const ANSWERS_URL_BASE = "https://astgl.ai/answers";
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AnswerPage {
  slug: string;
  url: string;
  path: string; // repo-relative
  date: string; // frontmatter `date`, as written
}

export interface SiteCommit {
  branch: string;
  commit: string;
  pagePath: string; // absolute path in the worktree
}

export type JobResolution = "open" | "published" | "rejected" | "superseded";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitSucceeds(dir: string, ...args: string[]): boolean {
  try {
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function fetchSite(dir: string): void {
  git(dir, "fetch", "--quiet", "origin", "main");
}

// WHAT: The `date:` value from a page's YAML frontmatter, unquoted.
function frontmatterDate(content: string): string | null {
  const fm = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const line = fm[1].match(/^date:\s*['"]?([^'"\n]+)['"]?\s*$/m);
  return line ? line[1].trim() : null;
}

export function listAnswerPages(dir: string): AnswerPage[] {
  const names = git(dir, "ls-tree", "--name-only", `${MAIN_REF}:${ANSWERS_DIR}`)
    .split("\n")
    .filter((name) => name.endsWith(".md"));
  return names.map((name) => {
    const path = `${ANSWERS_DIR}/${name}`;
    const slug = name.slice(0, -".md".length);
    const content = git(dir, "show", `${MAIN_REF}:${path}`);
    return { slug, url: `${ANSWERS_URL_BASE}/${slug}`, path, date: frontmatterDate(content) ?? "" };
  });
}

export function readMainPage(dir: string, relPath: string): string {
  return execFileSync("git", ["show", `${MAIN_REF}:${relPath}`], { cwd: dir, encoding: "utf-8" });
}

// WHAT: Pages whose date is older than the threshold, oldest first, minus blocked URLs.
// WHY:  An unparseable date is dropped rather than treated as infinitely stale, so a
//       malformed page cannot monopolize the queue; the build would catch it anyway.
export function staleCandidates(
  pages: AnswerPage[],
  now: Date,
  thresholdDays: number,
  blockedUrls: Set<string>
): AnswerPage[] {
  const cutoff = now.getTime() - thresholdDays * DAY_MS;
  return pages
    .map((page) => ({ page, time: Date.parse(page.date) }))
    .filter(({ page, time }) => !Number.isNaN(time) && time < cutoff && !blockedUrls.has(page.url))
    .sort((a, b) => a.time - b.time)
    .map(({ page }) => page);
}

// WHAT: Commit `content` as the page for `slug` on a new branch cut from origin/main.
// WHY:  Refuses a dirty worktree, an existing branch and an unknown page rather than
//       guessing. The file is written to a temp name and renamed so a crash never
//       leaves a half-written page; the branch is the unit James reviews.
export function commitPage(
  dir: string,
  slug: string,
  content: string,
  date: string,
  message: string
): SiteCommit {
  const relPath = `${ANSWERS_DIR}/${slug}.md`;
  if (git(dir, "status", "--porcelain") !== "") {
    throw new Error(`astgl-site worktree is not clean: ${dir}`);
  }
  if (!gitSucceeds(dir, "cat-file", "-e", `${MAIN_REF}:${relPath}`)) {
    throw new Error(`no answer page ${relPath} on ${MAIN_REF}`);
  }
  const branch = `rewrite/${slug}-${date}`;
  git(dir, "switch", "--quiet", "--create", branch, MAIN_REF);

  const pagePath = join(dir, relPath);
  try {
    const tempPath = `${pagePath}.rewrite-tmp`;
    writeFileSync(tempPath, content);
    renameSync(tempPath, pagePath);
    git(dir, "add", "--", relPath);
    execFileSync("git", ["commit", "--quiet", "--file", "-"], {
      cwd: dir,
      input: message,
      stdio: ["pipe", "ignore", "pipe"],
    });
  } catch (err) {
    // The branch was created by this call and holds no commit of ours yet, so
    // removing it restores the state before the call; a hook refusal stays visible
    // in the rethrown error.
    git(dir, "switch", "--quiet", "--discard-changes", "--detach", MAIN_REF);
    git(dir, "branch", "--quiet", "-D", branch);
    throw err;
  }
  const commit = git(dir, "rev-parse", "HEAD");
  // Leave the worktree detached so the branch is not checked out: James rejects a
  // rewrite by deleting the branch, and git refuses to delete a checked-out branch.
  git(dir, "switch", "--quiet", "--detach", MAIN_REF);
  return { branch, commit, pagePath };
}

function blobAt(dir: string, ref: string, relPath: string): string | null {
  try {
    return git(dir, "rev-parse", `${ref}:${relPath}`);
  } catch {
    return null;
  }
}

// WHAT: Where an open job stands, read from git after a fetch.
// WHY:  Published: the job's commit (or the reviewed branch tip, local or pushed)
//       is merged, or main now holds the exact page one of them holds — a squash
//       merge, with or without review edits made on the branch. Superseded: main's
//       page changed since the rewrite's base in a way none of the job's versions
//       explain (edits made only in the forge, or an unrelated change); the job is
//       stale either way, so it closes without the rejection cooldown and never
//       blocks the page. Rejected: the branch is gone and main's page is still the
//       rewrite's base. Otherwise the review is still open.
export function resolveJob(
  dir: string,
  branch: string,
  commit: string,
  relPath: string
): JobResolution {
  const localTip = `refs/heads/${branch}`;
  const remoteTip = `refs/remotes/origin/${branch}`;
  const branchExists = gitSucceeds(dir, "rev-parse", "--verify", "--quiet", localTip);
  const tips = [commit, ...(branchExists ? [localTip] : [])];
  if (gitSucceeds(dir, "rev-parse", "--verify", "--quiet", remoteTip)) tips.push(remoteTip);

  if (tips.some((tip) => gitSucceeds(dir, "merge-base", "--is-ancestor", tip, MAIN_REF))) return "published";
  const mainPage = blobAt(dir, MAIN_REF, relPath);
  if (mainPage !== null && tips.some((tip) => blobAt(dir, tip, relPath) === mainPage)) return "published";
  if (mainPage !== blobAt(dir, `${commit}^`, relPath)) return "superseded";
  return branchExists ? "open" : "rejected";
}
