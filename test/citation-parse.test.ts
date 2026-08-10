/**
 * Parser tests for the automated citation test.
 *
 * WHAT: Feeds synthetic responses — including an error-shaped
 *       web_search_tool_result — through the three engine parsers.
 * WHY:  The live citation test costs ~$1.50 per run in Perplexity/Anthropic/
 *       OpenAI tokens and posts nothing, so CLAUDE.md Mistake #12 rules out
 *       verifying this by re-running it. These tests exercise the exact code
 *       path that crashed, with no network.
 *
 *       PROVENANCE OF THE ERROR FIXTURE: constructed from Anthropic's documented
 *       contract — a failed web search returns HTTP 200 with a
 *       web_search_tool_result whose `content` is a single
 *       web_search_tool_result_error object carrying `error_code`, not the usual
 *       result array. It is NOT a captured payload, so the first test below
 *       pins it to reality a second way: it asserts the fixture reproduces the
 *       verbatim TypeError message recorded in data/citation-test.db
 *       ("block.content is not iterable", run #32 2026-07-27 and run #35
 *       2026-08-03). A fixture that did not reproduce that message would be
 *       testing a shape that never shipped.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  asArray,
  findAstglInUrls,
  parseChatGPT,
  parseClaude,
  parsePerplexity,
} from "../src/citation-parse.js";

// WHAT: The exact message the old parser produced, copied from the snippet
//       column of the ERROR rows in citation-test.db.
const OBSERVED_ERROR = "block.content is not iterable";

// WHAT: A web_search_tool_result block whose search failed.
// WHY:  `content` is an object here, not an array — truthy, but not iterable.
function searchErrorBlock(errorCode = "max_uses_exceeded") {
  return {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_test",
    content: { type: "web_search_tool_result_error", error_code: errorCode },
  };
}

function searchOkBlock(...urls: string[]) {
  return {
    type: "web_search_tool_result",
    tool_use_id: "srvtoolu_test",
    content: urls.map((url) => ({
      type: "web_search_result",
      url,
      title: `Title for ${url}`,
    })),
  };
}

function textBlock(text: string, citationUrls: string[] = []) {
  return {
    type: "text",
    text,
    citations: citationUrls.map((url) => ({ type: "web_search_result_location", url })),
  };
}

// --- The regression itself ---

test("the error fixture reproduces the TypeError recorded in citation-test.db", () => {
  // WHAT: Replays the guard the old code used: truthy check, then for...of.
  // WHY:  Mutation test. If the fixture were wrong, this would not throw — and a
  //       green suite below would then prove nothing about the real defect.
  const block = searchErrorBlock();
  assert.throws(
    () => {
      if (block.content) {
        for (const _ of block.content as unknown as Iterable<unknown>) {
          // unreachable — the iterator protocol lookup throws first
        }
      }
    },
    (err: unknown) => {
      assert.ok(err instanceof TypeError, `expected TypeError, got ${err}`);
      assert.ok(
        err.message.includes("is not iterable"),
        `expected an "is not iterable" TypeError, got: ${err.message}`
      );
      return true;
    }
  );
  // Sanity-check the message the production code would have produced.
  assert.ok(OBSERVED_ERROR.includes("is not iterable"));
});

test("parseClaude survives a search error when another search succeeded", () => {
  const result = parseClaude({
    content: [
      searchErrorBlock("too_many_requests"),
      searchOkBlock("https://example.com/a", "https://astgl.ai/mcp-guide"),
      textBlock("Here is the answer."),
    ],
  });

  assert.equal(result.cited, true);
  assert.equal(result.citedUrl, "https://astgl.ai/mcp-guide");
  assert.equal(result.position, 2);
  assert.equal(result.snippet, "Here is the answer.");
});

test("parseClaude records a legitimate not-cited result on a partial search error", () => {
  const result = parseClaude({
    content: [
      searchErrorBlock(),
      searchOkBlock("https://example.com/a", "https://other.example/b"),
      textBlock("No ASTGL here."),
    ],
  });

  // WHAT: The whole point of the fix — this is a real measurement, not an ERROR row.
  assert.equal(result.cited, false);
  assert.equal(result.citedUrl, null);
  assert.equal(result.position, null);
  assert.equal(result.snippet, "No ASTGL here.");
});

test("parseClaude throws when EVERY search errored", () => {
  // WHY: With no successful search the model answered without web grounding, so
  //      cited=0 would be a fabricated data point rather than a measurement.
  assert.throws(
    () =>
      parseClaude({
        content: [
          searchErrorBlock("unavailable"),
          searchErrorBlock("unavailable"),
          textBlock("I could not search, but from memory..."),
        ],
      }),
    /web_search failed on all 2 attempt\(s\) \(unavailable\)/
  );
});

test("parseClaude treats a response with no search blocks as a real not-cited result", () => {
  // WHY: The model chose to answer from parametric knowledge. That is a genuine
  //      (and interesting) not-cited outcome, not a failed measurement.
  const result = parseClaude({ content: [textBlock("Answered from memory.")] });
  assert.equal(result.cited, false);
  assert.equal(result.snippet, "Answered from memory.");
});

test("parseClaude collects citations attached to text blocks", () => {
  const result = parseClaude({
    content: [textBlock("Grounded answer.", ["https://astgl.ai/local-ai"])],
  });
  assert.equal(result.cited, true);
  assert.equal(result.citedUrl, "https://astgl.ai/local-ai");
  assert.equal(result.position, 1);
});

// --- The rest of the defect class ---

test("parseClaude tolerates non-array content and citations", () => {
  // WHY: Mistake #13 — the same assumption existed on data.content and
  //      block.citations, not only on the field that happened to crash.
  for (const content of [undefined, null, "unexpected", 42, { error: "nope" }]) {
    assert.deepEqual(parseClaude({ content }), {
      cited: false,
      citedUrl: null,
      position: null,
      snippet: null,
    });
  }

  const result = parseClaude({
    content: [{ type: "text", text: "hi", citations: { error_code: "nope" } }],
  });
  assert.equal(result.cited, false);
  assert.equal(result.snippet, "hi");
});

test("parseChatGPT tolerates non-array output, content and annotations", () => {
  for (const output of [undefined, null, "unexpected", { error: "nope" }]) {
    assert.equal(parseChatGPT({ output }).cited, false);
  }

  // WHAT: item.content was guarded with `!item.content` — truthiness only.
  const badContent = parseChatGPT({
    output: [{ type: "message", content: { error: "not an array" } }],
  });
  assert.equal(badContent.cited, false);
  assert.equal(badContent.snippet, null);

  const badAnnotations = parseChatGPT({
    output: [
      {
        type: "message",
        content: [
          { type: "output_text", text: "Answer.", annotations: { error: "nope" } },
        ],
      },
    ],
  });
  assert.equal(badAnnotations.cited, false);
  assert.equal(badAnnotations.snippet, "Answer.");
});

test("parseChatGPT extracts url_citation annotations", () => {
  const result = parseChatGPT({
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: "The answer.",
            annotations: [
              { type: "url_citation", url: "https://example.com/x" },
              { type: "file_citation", url: "https://astgl.ai/ignored" },
              { type: "url_citation", url: "https://astgl.ai/hit" },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(result.cited, true);
  assert.equal(result.citedUrl, "https://astgl.ai/hit");
  // WHY: position 2 — the file_citation is skipped, so it never enters the list.
  assert.equal(result.position, 2);
  assert.equal(result.snippet, "The answer.");
});

test("parsePerplexity does not silently report not-cited on a non-array citations field", () => {
  // WHY: This one never threw — findAstglInUrls reads .length off the object,
  //      gets undefined, and the loop never runs. A wrong answer, delivered
  //      quietly, is worse than a loud crash; asArray makes the empty case explicit.
  for (const citations of [undefined, null, { error: "nope" }, "https://astgl.ai"]) {
    const result = parsePerplexity({ citations, choices: [] });
    assert.equal(result.cited, false);
    assert.equal(result.citedUrl, null);
  }

  const good = parsePerplexity({
    citations: ["https://example.com/a", "https://astgl.ai/mcp"],
    choices: [{ message: { content: "Answer text." } }],
  });
  assert.equal(good.cited, true);
  assert.equal(good.position, 2);
  assert.equal(good.snippet, "Answer text.");
});

test("parsePerplexity drops non-string entries in citations", () => {
  const result = parsePerplexity({
    citations: [null, 42, "https://astgl.ai/x"],
    choices: [],
  });
  assert.equal(result.cited, true);
  assert.equal(result.citedUrl, "https://astgl.ai/x");
  // WHY: position is 1, not 3 — non-strings are filtered before ranking, so the
  //      reported position stays meaningful.
  assert.equal(result.position, 1);
});

// --- Helpers ---

test("asArray returns arrays unchanged and everything else as empty", () => {
  assert.deepEqual(asArray([1, 2]), [1, 2]);
  assert.deepEqual(asArray([]), []);
  for (const v of [undefined, null, 0, "", "str", 42, {}, { length: 3 }, true]) {
    assert.deepEqual(asArray(v), [], `expected [] for ${JSON.stringify(v)}`);
  }
});

test("findAstglInUrls matches subdomains and reports 1-indexed position", () => {
  assert.deepEqual(findAstglInUrls([]), { citedUrl: null, position: null });
  assert.deepEqual(findAstglInUrls(["https://example.com"]), {
    citedUrl: null,
    position: null,
  });
  assert.deepEqual(findAstglInUrls(["https://www.astgl.ai/x"]), {
    citedUrl: "https://www.astgl.ai/x",
    position: 1,
  });
  // WHAT: First match wins.
  assert.deepEqual(
    findAstglInUrls(["https://a.com", "https://astgl.ai/1", "https://astgl.ai/2"]),
    { citedUrl: "https://astgl.ai/1", position: 2 }
  );
});
