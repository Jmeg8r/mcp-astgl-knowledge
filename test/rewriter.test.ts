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

import { markdownStructure, matchQuoteStyle, rewritePage, setFrontmatterDate, splitFrontmatter } from "../src/rewriter.js";

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
// A draft that keeps PAGE's one heading, so the structure check passes.
const DRAFT = "# What is an MCP server?\n\nDraft body.";

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
    responses = [DRAFT, "# What is an MCP server?\n\nVoiced body."];
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
    responses = [DRAFT, "   "];
    await assert.rejects(rewritePage(PAGE, opts, deps), /empty/);
  });

  test("fails when the draft pass stopped at the output budget", async () => {
    responses = [{ response: "Draft cut off mid-", done_reason: "length" }, "# Title\n\nVoiced body."];
    await assert.rejects(rewritePage(PAGE, opts, deps), /draft-model.*output budget/);
    assert.equal(calls.length, 1, "a truncated draft must not reach the voice pass");
  });

  test("fails when the voice pass stopped at the output budget", async () => {
    responses = [DRAFT, { response: "# Title\n\nVoiced but cut off mid-", done_reason: "length" }];
    await assert.rejects(rewritePage(PAGE, opts, deps), /voice-model.*output budget/);
  });

  test("fails when the draft pass turns a table into prose", async () => {
    const tablePage = `${FRONTMATTER}\n# Compare\n\n| Without | With |\n|---|---|\n| copy | pull |\n`;
    responses = ["# Compare\n\nWithout it you copy; with it, it pulls.", "# Compare\n\nVoiced."];
    await assert.rejects(rewritePage(tablePage, opts, deps), /draft pass changed the page structure.*table rows 3 -> 0/);
    assert.equal(calls.length, 1, "a draft that lost its structure must not reach the voice pass");
  });

  test("fails when a table without outer pipes becomes prose", async () => {
    const tablePage = `${FRONTMATTER}\n# Compare\n\nWithout | With\n--- | ---\ncopy | pull\n`;
    responses = ["# Compare\n\nWithout it you copy; with it, it pulls.", "# Compare\n\nVoiced."];
    await assert.rejects(rewritePage(tablePage, opts, deps), /draft pass changed the page structure.*table rows 3 -> 0/);
  });

  test("fails when a list numbered with ) becomes prose", async () => {
    const listPage = `${FRONTMATTER}\n# Steps\n\n1) Install the server.\n2) Start the client.\n`;
    responses = ["# Steps\n\nInstall the server, then start the client.", "# Steps\n\nVoiced."];
    await assert.rejects(rewritePage(listPage, opts, deps), /draft pass changed the page structure.*list items 2 -> 0/);
  });

  test("fails when a pass swaps a closing fence for one that does not close", async () => {
    const codePage = `${FRONTMATTER}\n# Run\n\n\`\`\`bash\necho hi\n\`\`\`\n\nDone.\n`;
    responses = ["# Run\n\n```bash\necho hi\n~~~\n\nDone.", "# Run\n\nVoiced."];
    await assert.rejects(rewritePage(codePage, opts, deps), /draft pass changed the page structure.*code fences 2 -> 1/);
  });

  test("fails when a pass drops a diagram", async () => {
    const imagePage = `${FRONTMATTER}\n# Flow\n\n![The flow](/images/flow.png)\n\nText.\n`;
    responses = ["# Flow\n\nText.", "# Flow\n\nVoiced."];
    await assert.rejects(rewritePage(imagePage, opts, deps), /draft pass changed the page structure.*images 1 -> 0/);
  });

  test("fails when the voice pass collapses a list", async () => {
    const listPage = `${FRONTMATTER}\n# Steps\n\n- one\n- two\n- three\n`;
    responses = ["# Steps\n\n- one\n- two\n- three", "# Steps\n\nOne, two and three."];
    await assert.rejects(rewritePage(listPage, opts, deps), /voice pass changed the page structure.*list items 3 -> 0/);
  });

  test("both prompts tell the model to keep tables, lists and code blocks", async () => {
    responses = [DRAFT, "# What is an MCP server?\n\nVoiced body."];
    await rewritePage(PAGE, opts, deps);
    for (const c of calls) assert.match(c.prompt, /table, list and code block/);
    // The profile's Substack-only rule against markdown tables must be overridden.
    assert.match(calls[1].prompt, /rule against markdown tables does not apply/);
  });

  test("fails when the model emits its own frontmatter", async () => {
    responses = [DRAFT, "---\ntitle: x\n---\nBody"];
    await assert.rejects(rewritePage(PAGE, opts, deps), /malformed/);
  });

  test("fails when the model wraps its own frontmatter in a fence", async () => {
    responses = [DRAFT, "```yaml\n---\ntitle: Model title\n---\nBody\n```"];
    await assert.rejects(rewritePage(PAGE, opts, deps), /malformed/);
  });

  test("strips delimiters the model echoed around a good body", async () => {
    responses = ["---\n# Title\n\nDraft body.\n---", "<body>\n# Title\n\nBody.\n</body>"];
    const out = await rewritePage(PAGE, opts, deps);
    assert.ok(out.page.endsWith("\n# Title\n\nBody.\n"));
  });

  test("never follows a redirect from the Ollama host", async () => {
    const seen: RequestInit[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init ?? {});
      return new Response(JSON.stringify({ response: "# Title\n\nBody." }), { status: 200 });
    }) as typeof fetch;
    await rewritePage(PAGE, opts, deps);
    assert.ok(seen.length > 0 && seen.every((i) => i.redirect === "error"));
  });

  test("unwraps a response the model fenced as markdown", async () => {
    responses = [DRAFT, "```markdown\n# Title\n\nBody.\n```"];
    const out = await rewritePage(PAGE, opts, deps);
    assert.ok(out.page.endsWith("\n# Title\n\nBody.\n"));
  });

  // The 2026-11-06c eval put curly quotes on 5 of 20 pages whose originals have none.
  test("straightens curly quotes a pass added to a page that has none", async () => {
    responses = [
      "# What is an MCP server?\n\nLet\u2019s draft.",
      "# What is an MCP server?\n\nIt\u2019s \u201cvoiced\u201d.",
    ];
    const out = await rewritePage(PAGE, opts, deps);
    assert.ok(calls[1].prompt.includes("Let's draft."), "the voice pass gets a straightened draft");
    assert.ok(out.page.endsWith("\n# What is an MCP server?\n\nIt's \"voiced\".\n"));
  });
});

describe("matchQuoteStyle", () => {
  test("straightens all four curly quotes when the original has none", () => {
    assert.equal(
      matchQuoteStyle("It's \"plain\".", "\u2018a\u2019 \u201cb\u201d"),
      "'a' \"b\""
    );
  });

  test("leaves the output alone when the original has a curly quote", () => {
    const output = "It\u2019s \u201ccurly\u201d.";
    assert.equal(matchQuoteStyle("It\u2019s mixed, it's here.", output), output);
  });
});

describe("markdownStructure", () => {
  test("counts headings, table rows, list items and code fences", () => {
    const body = "# Title\n\n## Part\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- one\n* two\n  - nested\n1. first\n\n```bash\necho hi\n```\n";
    assert.deepEqual(markdownStructure(body), { headings: 2, tableRows: 3, listItems: 4, codeFences: 2, images: 0, blockquoteLines: 0 });
  });

  test("counts a table written without outer pipes", () => {
    const body = "Without | With\n--- | :---:\ncopy | pull\nwait | push\n\nAfter the table.\n";
    assert.deepEqual(markdownStructure(body), { headings: 0, tableRows: 4, listItems: 0, codeFences: 0, images: 0, blockquoteLines: 0 });
  });

  test("a line with a pipe outside a table is not a table row", () => {
    assert.equal(markdownStructure("Run `a | b` to pipe.\n\nThen this | that.\n").tableRows, 0);
  });

  test("counts ordered list items with either delimiter", () => {
    assert.equal(markdownStructure("1. one\n2) two\n3) three\n").listItems, 3);
  });

  test("counts a setext heading, and a rule after a blank line is not one", () => {
    const body = "Title\n=====\n\nPart\n----\n\nText.\n\n---\n\nMore.\n";
    assert.equal(markdownStructure(body).headings, 2);
  });

  test("a fence closes only on the same character, at least as long", () => {
    // Inside a ``` block, ~~~ and a shorter `` are code lines, not closers.
    const body = "```\ncode\n~~~\n``\n````\n\n# After\n";
    assert.deepEqual(markdownStructure(body), { headings: 1, tableRows: 0, listItems: 0, codeFences: 2, images: 0, blockquoteLines: 0 });
  });

  test("counts images and blockquote lines", () => {
    const body = "![A diagram](/images/a.png) and ![B](/b.png)\n\n> Quoted.\n> Still quoted.\n\n| Icon | Name |\n|---|---|\n| ![i](/i.png) | x |\n";
    const got = markdownStructure(body);
    assert.equal(got.images, 3);
    assert.equal(got.blockquoteLines, 2);
  });

  test("ignores lines inside a fenced code block", () => {
    const body = "```bash\n# a comment, not a heading\n- not a list item\n| not | a row |\n> not a quote ![x](y)\n```\n";
    assert.deepEqual(markdownStructure(body), { headings: 0, tableRows: 0, listItems: 0, codeFences: 2, images: 0, blockquoteLines: 0 });
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
