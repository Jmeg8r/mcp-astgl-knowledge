/**
 * Tests for the local two-pass rewriter.
 *
 * WHAT: Runs rewritePage() against a stubbed fetch that answers only localhost
 *       Ollama calls and throws on anything else, and checks the frontmatter rules.
 * WHY:  Local-only generation is a hard constraint (2026-09-24 decision, spec R4):
 *       the proof is a run where any other host would have failed the test. The
 *       frontmatter must survive byte-for-byte except `date` (spec F4), because a
 *       model-edited YAML block is the easiest way to break the site build.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { rewritePage, setFrontmatterDate, splitFrontmatter } from "../src/rewriter.js";

const FRONTMATTER = [
  "---",
  "author: James Cruce",
  "date: '2026-04-09'",
  "description: A plain explanation.",
  "faq:",
  "- answer: An MCP server is a small program.",
  "  question: What is an MCP server?",
  "order: 1",
  "title: What is an MCP server?",
  "---",
  "",
].join("\n");
const PAGE = `${FRONTMATTER}\n# What is an MCP server?\n\nOriginal body.\n`;

interface Call {
  url: string;
  model: string;
  prompt: string;
  numCtx: number | undefined;
  think: unknown;
}

// A stubbed reply: the response text, or the text plus Ollama's `done_reason`.
type StubReply = string | { response: string; done_reason: string };

const realFetch = globalThis.fetch;
let calls: Call[] = [];
let responses: StubReply[] = [];

function stubFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const host = new URL(url).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") {
      throw new Error(`non-local request attempted: ${url}`);
    }
    const body = JSON.parse(String(init?.body)) as {
      model: string;
      prompt: string;
      options?: { num_ctx?: number };
      think?: unknown;
    };
    calls.push({ url, model: body.model, prompt: body.prompt, numCtx: body.options?.num_ctx, think: body.think });
    const reply = responses.shift() ?? "";
    const payload = typeof reply === "string" ? { response: reply, done_reason: "stop" } : reply;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

const deps = { loadVoiceProfile: async () => "VOICE PROFILE TEXT" };
const opts = { draftModel: "draft-model", voiceModel: "voice-model", date: "2026-11-03" };

describe("rewritePage", () => {
  beforeEach(() => {
    calls = [];
    responses = [];
    delete process.env.OLLAMA_BASE_URL;
    stubFetch();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.OLLAMA_BASE_URL;
  });

  test("runs both passes on local Ollama and keeps the frontmatter except date", async () => {
    responses = ["Draft body.", "# What is an MCP server?\n\nVoiced body."];
    const out = await rewritePage(PAGE, opts, deps);

    assert.deepEqual(
      calls.map((c) => [new URL(c.url).hostname, c.model]),
      [
        ["localhost", "draft-model"],
        ["localhost", "voice-model"],
      ]
    );
    assert.ok(calls[0].prompt.includes("Original body."));
    assert.ok(!calls[0].prompt.includes("author: James Cruce"), "frontmatter must not reach the model");
    assert.ok(calls[1].prompt.includes("VOICE PROFILE TEXT"));
    assert.ok(calls[1].prompt.includes("Draft body."));
    // A model's own small default context must never truncate the prompt.
    assert.ok(calls.every((c) => (c.numCtx ?? 0) >= 16384));
    // A thinking model's hidden reasoning would spend the output budget (2026-11-06).
    assert.ok(calls.every((c) => c.think === false));

    const expectedFrontmatter = FRONTMATTER.replace("date: '2026-04-09'", "date: '2026-11-03'");
    assert.equal(out.page, `${expectedFrontmatter}\n# What is an MCP server?\n\nVoiced body.\n`);
    assert.equal(out.originalBody.trim(), "# What is an MCP server?\n\nOriginal body.");
  });

  test("refuses a non-local Ollama host before any request", async () => {
    process.env.OLLAMA_BASE_URL = "https://ollama.example.com";
    await assert.rejects(rewritePage(PAGE, opts, deps), /local/);
    assert.equal(calls.length, 0);
  });

  test("fails on an empty model response", async () => {
    responses = ["Draft body.", "   "];
    await assert.rejects(rewritePage(PAGE, opts, deps), /empty/);
  });

  test("fails when the draft pass stopped at the output budget", async () => {
    responses = [{ response: "Draft cut off mid-", done_reason: "length" }, "Voiced body."];
    await assert.rejects(rewritePage(PAGE, opts, deps), /draft-model.*output budget/);
    assert.equal(calls.length, 1, "a truncated draft must not reach the voice pass");
  });

  test("fails when the voice pass stopped at the output budget", async () => {
    responses = ["Draft body.", { response: "# Title\n\nVoiced but cut off mid-", done_reason: "length" }];
    await assert.rejects(rewritePage(PAGE, opts, deps), /voice-model.*output budget/);
  });

  test("fails when the model emits its own frontmatter", async () => {
    responses = ["Draft body.", "---\ntitle: x\n---\nBody"];
    await assert.rejects(rewritePage(PAGE, opts, deps), /malformed/);
  });

  test("fails when the model wraps its own frontmatter in a fence", async () => {
    responses = ["Draft body.", "```yaml\n---\ntitle: Model title\n---\nBody\n```"];
    await assert.rejects(rewritePage(PAGE, opts, deps), /malformed/);
  });

  test("strips delimiters the model echoed around a good body", async () => {
    responses = ["---\nDraft body.\n---", "<body>\n# Title\n\nBody.\n</body>"];
    const out = await rewritePage(PAGE, opts, deps);
    assert.ok(out.page.endsWith("\n# Title\n\nBody.\n"));
  });

  test("never follows a redirect from the Ollama host", async () => {
    const seen: RequestInit[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ response: "Body." }), { status: 200 });
    }) as typeof fetch;
    await rewritePage(PAGE, opts, deps);
    assert.ok(seen.length > 0 && seen.every((i) => i.redirect === "error"));
  });

  test("unwraps a response the model fenced as markdown", async () => {
    responses = ["Draft body.", "```markdown\n# Title\n\nBody.\n```"];
    const out = await rewritePage(PAGE, opts, deps);
    assert.ok(out.page.endsWith("\n# Title\n\nBody.\n"));
  });
});

describe("frontmatter helpers", () => {
  test("splitFrontmatter separates the block byte-for-byte", () => {
    const { frontmatter, body } = splitFrontmatter(PAGE);
    assert.equal(frontmatter + body, PAGE);
    assert.equal(frontmatter, FRONTMATTER);
  });

  test("splitFrontmatter refuses a page without frontmatter", () => {
    assert.throws(() => splitFrontmatter("# No frontmatter\n"), /frontmatter/);
  });

  test("setFrontmatterDate keeps the quoting style", () => {
    assert.equal(setFrontmatterDate("---\ndate: '2026-04-09'\n---\n", "2026-11-03"), "---\ndate: '2026-11-03'\n---\n");
    assert.equal(setFrontmatterDate('---\ndate: "2026-04-09"\n---\n', "2026-11-03"), '---\ndate: "2026-11-03"\n---\n');
    assert.equal(setFrontmatterDate("---\ndate: 2026-04-09\n---\n", "2026-11-03"), "---\ndate: 2026-11-03\n---\n");
  });

  test("setFrontmatterDate refuses frontmatter without a date line", () => {
    assert.throws(() => setFrontmatterDate("---\ntitle: x\n---\n", "2026-11-03"), /date/);
  });
});
