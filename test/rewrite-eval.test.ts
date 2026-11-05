/**
 * Tests for the rewrite evaluation harness.
 *
 * WHAT: Checks fact planting, per-page scoring, the per-model summary, and an end to
 *       end run over the fixture site with a stubbed rewriter.
 * WHY:  James picks the production models from this report (spec R15, F2). A scorer
 *       that misses a dropped fact, or a summary that reads "0 violations" when no
 *       page was examined, would make a bad model look safe.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

import { factKept, plantFacts, runEval, scorePage, summarize, type PageScore } from "../src/rewrite-eval.js";
import type { RewriteResult } from "../src/rewriter.js";
import { withSite } from "./helpers/site-fixture.js";

const NOW = new Date("2026-11-03T12:00:00Z");

describe("plantFacts", () => {
  test("is deterministic and plants facts whose tokens appear in the body", () => {
    const a = plantFacts("Intro.\n\n## Setup\n\nSteps.\n", "some-page");
    const b = plantFacts("Intro.\n\n## Setup\n\nSteps.\n", "some-page");
    assert.deepEqual(a, b);
    assert.ok(a.facts.length > 0);
    for (const fact of a.facts) assert.ok(a.body.includes(fact), fact);
  });
});

describe("scorePage", () => {
  const planted = plantFacts("Intro.\n\nBody.\n", "p");
  const original = `---\ndate: '2025-01-10'\n---\n\n${planted.body}`;

  test("a faithful rewrite keeps every planted fact and adds nothing", () => {
    const output = `---\ndate: '2026-11-03'\n---\n\n${planted.body.replace("Intro.", "An intro.")}`;
    const s = scorePage(original, planted.facts, output, "2026-11-03", 1000);
    assert.equal(s.plantedKept, planted.facts.length);
    assert.deepEqual(s.added, []);
    assert.equal(s.frontmatterOk, true);
  });

  test("a dropped planted fact and an added token are both counted", () => {
    const output = `---\ndate: '2026-11-03'\n---\n\nIntro. Now version 9.9.9 is out.\n`;
    const s = scorePage(original, planted.facts, output, "2026-11-03", 1000);
    assert.equal(s.plantedKept, 0);
    assert.ok(s.added.includes("9.9.9"));
  });

  test("a fact counts as kept only where one sentence still states it", () => {
    const fact = "The MCP specification was first published in November 2024.";
    assert.equal(factKept(fact, "Intro. The MCP spec first appeared, published November 2024."), true);
    assert.equal(factKept(fact, "Intro. Pricing changed in 2024. Nothing about the spec."), false);
  });

  test("a frontmatter change other than date is caught", () => {
    const output = `---\ndate: '2026-11-03'\ntitle: changed\n---\n\n${planted.body}`;
    assert.equal(scorePage(original, planted.facts, output, "2026-11-03", 1000).frontmatterOk, false);
  });
});

describe("summarize", () => {
  test("zero examined pages is UNKNOWN, not clean", () => {
    assert.equal(summarize("pair", []).verdict, "UNKNOWN");
  });

  test("a pair whose every rewrite failed is UNKNOWN", () => {
    const failed: PageScore = { slug: "a", plantedTotal: 2, plantedKept: 0, added: [], frontmatterOk: false, lengthRatio: 0, seconds: 0, error: "model not found" };
    assert.equal(summarize("pair", [failed, { ...failed, slug: "b" }]).verdict, "UNKNOWN");
  });

  test("counts pages with violations, kept facts and errors", () => {
    const scores: PageScore[] = [
      { slug: "a", plantedTotal: 2, plantedKept: 2, added: [], frontmatterOk: true, lengthRatio: 1, seconds: 10 },
      { slug: "b", plantedTotal: 2, plantedKept: 1, added: ["9.9.9"], frontmatterOk: true, lengthRatio: 0.5, seconds: 20 },
      { slug: "c", plantedTotal: 2, plantedKept: 0, added: [], frontmatterOk: false, lengthRatio: 0, seconds: 0, error: "empty output" },
    ];
    const s = summarize("pair", scores);
    assert.equal(s.pagesExamined, 3);
    assert.equal(s.pagesWithAddedTokens, 1);
    assert.equal(s.plantedKeptRate, 0.5);
    assert.equal(s.frontmatterFailures, 1);
    assert.equal(s.errors, 1);
    assert.equal(s.verdict, "MEASURED");
  });
});

describe("runEval", () => {
  test("scores every answer page for every model pair", () =>
    withSite(async ({ wt }) => {
      const rewrite = async (original: string): Promise<RewriteResult> => ({
        page: original.replace(/date: '[^']*'/, "date: '2026-11-03'"),
        originalBody: "",
        draftChars: 1,
        voiceChars: 1,
        draftMs: 1,
        voiceMs: 1,
      });
      const report = await runEval({
        siteDir: wt,
        now: NOW,
        pairs: [
          { draftModel: "d1", voiceModel: "v1" },
          { draftModel: "d1", voiceModel: "v2" },
        ],
        limit: null,
        rewrite,
      });
      assert.deepEqual(
        report.summaries.map((s) => [s.pair, s.pagesExamined, s.plantedKeptRate, s.pagesWithAddedTokens]),
        [
          ["d1 + v1", 3, 1, 0],
          ["d1 + v2", 3, 1, 0],
        ]
      );
    }));

  // A stub rewriter that only moves the date, counting its calls.
  function countingRewrite() {
    const calls = { n: 0 };
    const rewrite = async (original: string): Promise<RewriteResult> => {
      calls.n += 1;
      return {
        page: original.replace(/date: '[^']*'/, "date: '2026-11-03'"),
        originalBody: "",
        draftChars: 1,
        voiceChars: 1,
        draftMs: 1,
        voiceMs: 1,
      };
    };
    return { calls, rewrite };
  }
  const ONE_PAIR = [{ draftModel: "d1", voiceModel: "v1" }];
  // runEval names each pair's output directory after its label, "d1 + v1".
  const PAIR_DIR = "d1_+_v1";

  test("--out writes one file per page and counts each page once", () =>
    withSite(async ({ root, wt }) => {
      const { rewrite } = countingRewrite();
      const outDir = join(root, "out");
      const report = await runEval({ siteDir: wt, now: NOW, pairs: ONE_PAIR, limit: null, rewrite, outDir });
      assert.deepEqual(readdirSync(join(outDir, PAIR_DIR)).sort(), ["fresh-page.md", "old-page.md", "older-page.md"]);
      assert.equal(report.summaries[0].pagesExamined, 3);
      assert.equal(report.summaries[0].errors, 0);
    }));

  test("an --out path that cannot be created fails before any rewrite", () =>
    withSite(async ({ root, wt }) => {
      const { calls, rewrite } = countingRewrite();
      const blocker = join(root, "blocker");
      writeFileSync(blocker, "a file, not a directory");
      await assert.rejects(
        runEval({ siteDir: wt, now: NOW, pairs: ONE_PAIR, limit: null, rewrite, outDir: join(blocker, "out") })
      );
      assert.equal(calls.n, 0);
    }));

  test("a failed output write fails the run instead of scoring the page twice", () =>
    withSite(async ({ root, wt }) => {
      const { rewrite } = countingRewrite();
      const outDir = join(root, "out");
      // A directory where the page's output file should go makes that one write fail.
      mkdirSync(join(outDir, PAIR_DIR, "old-page.md"), { recursive: true });
      await assert.rejects(
        runEval({ siteDir: wt, now: NOW, pairs: ONE_PAIR, limit: null, rewrite, outDir }),
        /EISDIR/
      );
    }));
});
