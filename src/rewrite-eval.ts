#!/usr/bin/env tsx
/**
 * Evaluation harness for the local rewrite models.
 *
 * WHAT: Plants known stale facts into each astgl.ai answer page, runs every
 *       draft+voice model pair over the pages, and scores each output: planted facts
 *       kept, tokens added (the claim check), frontmatter preserved, length change,
 *       time per page. Prints one summary per pair; optionally writes every output.
 * WHY:  James picks the production models from measured numbers, not assumption
 *       (intent outcome 2, spec R15). astgl-site's history holds no stale-then-fresh
 *       prose pairs, so the harness plants facts whose correct handling is known:
 *       a model must keep them exactly, never "update" them (spec F1, F2).
 *
 * Usage:
 *   npm run rewrite-eval -- --pairs "qwen3-coder:30b+astgl-voice:7b-v1.5,qwen3-coder:30b+qwen3.6:35b-a3b"
 *   npm run rewrite-eval -- --pairs "<draft>+<voice>" --limit 3 --out /tmp/rewrite-eval
 *
 * Exit codes: 0 report produced for every pair; 1 any pair examined zero pages.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";

import { rewritePage, setFrontmatterDate, splitFrontmatter, type RewriteOptions, type RewriteResult } from "./rewriter.js";
import { checkClaims, extractClaimTokens } from "./claim-check.js";
import { listAnswerPages, readPageAt } from "./site-worktree.js";

// Stale facts with known-correct handling: each must survive a rewrite verbatim in
// its tokens. None claims to be current, so keeping them is always the right call.
const PLANTED_FACT_BANK = [
  "As of 2024, Ollama 0.1.29 was the current release.",
  "The MCP specification was first published in November 2024.",
  "In 2025 testing, a 7B model ran at about 40 tokens per second on a 16 GB laptop.",
  "Claude 3.5 Sonnet was the default model when this section was written.",
  "Open WebUI 0.3.10 added the pipelines feature this setup relies on.",
];
const FACTS_PER_PAGE = 2;
// A sentence keeps a planted fact when it holds all of the fact's claim tokens and at
// least this share of its content words, so a stray "2024" elsewhere does not count.
const KEPT_WORD_SHARE = 0.5;
const CONTENT_WORD_MIN_LENGTH = 4;

export interface PageScore {
  slug: string;
  plantedTotal: number;
  plantedKept: number;
  added: string[];
  frontmatterOk: boolean;
  lengthRatio: number;
  seconds: number;
  error?: string;
}

export interface PairSummary {
  pair: string;
  verdict: "MEASURED" | "UNKNOWN";
  pagesExamined: number;
  pagesWithAddedTokens: number;
  plantedKeptRate: number;
  frontmatterFailures: number;
  errors: number;
  meanLengthRatio: number;
  meanSeconds: number;
}

export interface ModelPair {
  draftModel: string;
  voiceModel: string;
}

function slugHash(slug: string): number {
  let h = 0;
  for (const ch of slug) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

// WHAT: Insert FACTS_PER_PAGE bank facts after the body's first paragraph, chosen by
//       the slug so every run plants the same facts in the same page.
export function plantFacts(body: string, slug: string): { body: string; facts: string[] } {
  const start = slugHash(slug) % PLANTED_FACT_BANK.length;
  const facts = Array.from({ length: FACTS_PER_PAGE }, (_, i) => PLANTED_FACT_BANK[(start + i) % PLANTED_FACT_BANK.length]);
  const paragraphs = body.split(/\n\n/);
  const at = Math.min(1, paragraphs.length);
  paragraphs.splice(at, 0, facts.join(" "));
  return { body: paragraphs.join("\n\n"), facts };
}

function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => w.length >= CONTENT_WORD_MIN_LENGTH);
}

// WHAT: Whether one sentence of the output still states the planted fact.
export function factKept(fact: string, outputBody: string): boolean {
  const tokens = extractClaimTokens(fact);
  const words = contentWords(fact);
  const sentences = outputBody.split(/(?<=[.!?])\s+|\n+/);
  return sentences.some((sentence) => {
    const sentenceTokens = new Set(extractClaimTokens(sentence));
    const sentenceWords = new Set(contentWords(sentence));
    const sharedWords = words.filter((w) => sentenceWords.has(w)).length;
    return tokens.every((t) => sentenceTokens.has(t)) && sharedWords >= words.length * KEPT_WORD_SHARE;
  });
}

export function scorePage(
  original: string,
  facts: string[],
  output: string,
  date: string,
  ms: number
): PageScore {
  const orig = splitFrontmatter(original);
  const out = splitFrontmatter(output);
  const plantedKept = facts.filter((f) => factKept(f, out.body)).length;
  return {
    slug: "",
    plantedTotal: facts.length,
    plantedKept,
    added: checkClaims(orig.body, out.body).added,
    frontmatterOk: setFrontmatterDate(orig.frontmatter, date) === out.frontmatter,
    lengthRatio: orig.body.length > 0 ? out.body.length / orig.body.length : 0,
    seconds: ms / 1000,
  };
}

const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function summarize(pair: string, scores: PageScore[]): PairSummary {
  const ok = scores.filter((s) => !s.error);
  const plantedTotal = scores.reduce((n, s) => n + s.plantedTotal, 0);
  return {
    pair,
    // Error entries are not measurements: a pair whose every rewrite failed (say, a
    // misspelled model) measured nothing and must not read as a result.
    verdict: ok.length === 0 ? "UNKNOWN" : "MEASURED",
    pagesExamined: scores.length,
    pagesWithAddedTokens: scores.filter((s) => s.added.length > 0).length,
    plantedKeptRate: plantedTotal > 0 ? scores.reduce((n, s) => n + s.plantedKept, 0) / plantedTotal : 0,
    frontmatterFailures: scores.filter((s) => !s.frontmatterOk).length,
    errors: scores.length - ok.length,
    meanLengthRatio: mean(ok.map((s) => s.lengthRatio)),
    meanSeconds: mean(ok.map((s) => s.seconds)),
  };
}

export interface EvalOptions {
  siteDir: string;
  now: Date;
  pairs: ModelPair[];
  limit: number | null;
  rewrite: (page: string, opts: RewriteOptions) => Promise<RewriteResult>;
  outDir?: string;
}

export async function runEval(opts: EvalOptions): Promise<{ summaries: PairSummary[]; pages: Record<string, PageScore[]> }> {
  const date = opts.now.toISOString().slice(0, 10);
  const all = listAnswerPages(opts.siteDir).sort((a, b) => a.slug.localeCompare(b.slug));
  const pages = opts.limit === null ? all : all.slice(0, opts.limit);
  const summaries: PairSummary[] = [];
  const byPair: Record<string, PageScore[]> = {};

  for (const pair of opts.pairs) {
    const label = `${pair.draftModel} + ${pair.voiceModel}`;
    const scores: PageScore[] = [];
    for (const page of pages) {
      const { frontmatter, body } = splitFrontmatter(readPageAt(opts.siteDir, "origin/main", page.path));
      const planted = plantFacts(body, page.slug);
      const input = frontmatter + planted.body;
      const start = Date.now();
      try {
        const result = await opts.rewrite(input, { ...pair, date });
        scores.push({ ...scorePage(input, planted.facts, result.page, date, Date.now() - start), slug: page.slug });
        if (opts.outDir) {
          const dir = join(opts.outDir, label.replace(/[^A-Za-z0-9.+-]+/g, "_"));
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `${page.slug}.md`), result.page);
        }
      } catch (err) {
        scores.push({
          slug: page.slug,
          plantedTotal: planted.facts.length,
          plantedKept: 0,
          added: [],
          frontmatterOk: false,
          lengthRatio: 0,
          seconds: (Date.now() - start) / 1000,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      console.error(`  ${label} ${page.slug}: ${scores[scores.length - 1].error ?? "scored"}`);
    }
    byPair[label] = scores;
    summaries.push(summarize(label, scores));
  }
  return { summaries, pages: byPair };
}

function parsePairs(spec: string | null): ModelPair[] {
  if (!spec) return [];
  return spec.split(",").map((p) => {
    const [draftModel, voiceModel] = p.split("+").map((s) => s.trim());
    if (!draftModel || !voiceModel) throw new Error(`bad pair "${p}": expected <draft>+<voice>`);
    return { draftModel, voiceModel };
  });
}

function argValue(args: string[], flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const pairs = parsePairs(argValue(args, "--pairs"));
  if (pairs.length === 0) {
    console.error('usage: rewrite-eval --pairs "<draft>+<voice>[,...]" [--limit N] [--out DIR]');
    process.exitCode = 1;
    return;
  }
  const limitArg = argValue(args, "--limit");
  const report = await runEval({
    siteDir: process.env.ASTGL_SITE_WORKTREE || join(import.meta.dirname, "..", ".rewrite-site"),
    now: new Date(),
    pairs,
    limit: limitArg ? parseInt(limitArg, 10) : null,
    rewrite: (page, opts) => rewritePage(page, opts),
    outDir: argValue(args, "--out") ?? undefined,
  });
  console.log(JSON.stringify(report, null, 2));
  for (const s of report.summaries) {
    console.error(
      `${s.pair}: ${s.verdict}, ${s.pagesExamined} pages, ${s.pagesWithAddedTokens} with added tokens, ` +
        `planted kept ${(s.plantedKeptRate * 100).toFixed(0)}%, ${s.frontmatterFailures} frontmatter failures, ` +
        `${s.errors} errors, length x${s.meanLengthRatio.toFixed(2)}, ${s.meanSeconds.toFixed(0)}s/page`
    );
  }
  if (report.summaries.some((s) => s.verdict === "UNKNOWN")) process.exitCode = 1;
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  main().catch((err) => {
    console.error("rewrite-eval failed:", err);
    process.exitCode = 1;
  });
}
