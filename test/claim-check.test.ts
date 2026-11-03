/**
 * Tests for the deterministic claim check.
 *
 * WHAT: Table-driven cases for which tokens a rewrite may and may not introduce, and
 *       for the "check these" list of dated facts.
 * WHY:  A local model has no source for current facts, so any number, version, URL
 *       or quote it adds is unsupported (spec F1). The check is the only thing
 *       standing between a confident hallucination and a published page, so the
 *       cases that matter most are additions that look harmless.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { checkClaims, datedFacts } from "../src/claim-check.js";

const ORIGINAL = [
  "# Set up Ollama",
  "",
  "Install Ollama 0.5.1 from https://ollama.com/download and pull a model.",
  "On a 32 GB Mac it handles 1,200 tokens per second for small models.",
  'As the docs put it, "local models keep your data on your machine".',
  "",
  "1. Install it.",
  "2. Pull a model.",
  "",
  "This guide was written in 2025.",
].join("\n");

describe("checkClaims", () => {
  const cases: Array<{ name: string; rewritten: string; verified?: string[]; added: string[] }> = [
    {
      name: "a reworded sentence with no new tokens passes",
      rewritten: ORIGINAL.replace("pull a model", "grab a model to start with"),
      added: [],
    },
    {
      name: "a new version string fails",
      rewritten: ORIGINAL.replace("0.5.1", "0.9.4"),
      added: ["0.9.4"],
    },
    {
      name: "a version in the verified-facts table passes",
      rewritten: ORIGINAL.replace("0.5.1", "0.9.4"),
      verified: ["0.9.4"],
      added: [],
    },
    {
      name: "a v-prefixed version matches the bare original",
      rewritten: ORIGINAL.replace("0.5.1", "v0.5.1"),
      added: [],
    },
    {
      name: "a new number fails",
      rewritten: ORIGINAL + "\nIt is 3x faster than last year.",
      added: ["3"],
    },
    {
      name: "a number reformatted with or without separators passes",
      rewritten: ORIGINAL.replace("1,200", "1200"),
      added: [],
    },
    {
      name: "a new URL fails",
      rewritten: ORIGINAL + "\nSee https://example.com/benchmarks for numbers.",
      added: ["https://example.com/benchmarks"],
    },
    {
      name: "a URL differing only by a trailing slash or final punctuation passes",
      rewritten: ORIGINAL.replace(
        "https://ollama.com/download and",
        "https://ollama.com/download/. Then"
      ),
      added: [],
    },
    {
      name: "a new quoted span fails",
      rewritten: ORIGINAL + '\nOne user said "this changed how I work entirely".',
      added: ['"this changed how i work entirely"'],
    },
    {
      name: "renumbered list markers are not claims",
      rewritten: ORIGINAL.replace("1. Install it.\n2. Pull a model.", "1. Install it.\n2. Start it.\n3. Pull a model."),
      added: [],
    },
    {
      name: "removing content is never a violation",
      rewritten: "# Set up Ollama\n\nInstall it.",
      added: [],
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      assert.deepEqual(checkClaims(ORIGINAL, c.rewritten, c.verified ?? []).added, c.added);
    });
  }

  test("an empty original makes every token an addition", () => {
    assert.deepEqual(checkClaims("", "Ollama 0.5.1").added, ["0.5.1"]);
  });
});

describe("datedFacts", () => {
  test("lists the original's versions and years for James to check", () => {
    assert.deepEqual(datedFacts(ORIGINAL), ["0.5.1", "2025"]);
  });

  test("returns nothing for text without dated facts", () => {
    assert.deepEqual(datedFacts("Just prose, nothing dated."), []);
  });
});
