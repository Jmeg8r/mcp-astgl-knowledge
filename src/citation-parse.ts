/**
 * Response parsers for the automated citation test.
 *
 * WHAT: Pure functions that turn a parsed JSON response from Perplexity, Claude,
 *       or ChatGPT into a QueryResult. No network, no database, no I/O.
 * WHY:  Split out of citation-test-auto.ts so the parsing can be unit tested
 *       without spending API tokens (CLAUDE.md Mistake #12 forbids verifying by
 *       re-running the live test) and without importing a module whose bottom
 *       line calls main().
 *
 *       These parsers read fields off untyped external JSON. Every iteration
 *       over such a field goes through asArray() — see its WHY.
 */

// WHAT: Hostname that counts as an ASTGL citation. Compared by isAstglUrl().
const ASTGL_HOST = "astgl.ai";

const SNIPPET_MAX_CHARS = 500;

export interface QueryResult {
  cited: boolean;
  citedUrl: string | null;
  position: number | null;
  snippet: string | null;
}

// --- The non-array guard ---

// WHAT: Return `value` when it is genuinely an array, otherwise an empty array.
// WHY:  `x || []` guards null and undefined ONLY. A truthy non-array — an error
//       object, a string, a number — passes that guard and then throws
//       "x is not iterable" inside for...of, failing the whole question. That is
//       not hypothetical: Anthropic returns web_search failures as an ERROR
//       OBJECT in a field otherwise documented as an array (see parseClaude),
//       which produced 'ERROR: block.content is not iterable' rows in
//       citation-test.db on 2026-07-27 (run #32) and 2026-08-03 (run #35).
//
//       Applied at EVERY boundary where a parsed API field is iterated, not just
//       the field that failed — the defect class is "iterating a field whose
//       array-ness is an assumption", and these three responses have seven such
//       fields between them (CLAUDE.md Mistake #13).
export function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// WHAT: True when a value can safely have properties read off it.
// WHY:  asArray guards the container; this guards the MEMBERS. A `null` inside
//       an otherwise valid array throws on the first property access
//       (`block.type`), which is the same defect one level down — the container
//       being an array says nothing about what the vendor put in it.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// --- Shared ---

// WHAT: Decide whether one URL counts as an ASTGL citation.
// WHY:  By HOSTNAME, not substring — `notastgl.ai` and
//       `example.com/?target=astgl.ai` both contain the substring and would
//       have written false-positive rows into test_results. The scheme-less
//       retry exists because nothing guarantees an engine's citation strings
//       carry a scheme, and in a series whose entire point is catching the
//       first real citation, silently dropping one is the costlier error.
function isAstglUrl(value: string): boolean {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  try {
    const hostname = new URL(candidate).hostname;
    return hostname === ASTGL_HOST || hostname.endsWith(`.${ASTGL_HOST}`);
  } catch {
    return false;
  }
}

// WHAT: Find the first ASTGL URL in an ordered citation list.
// WHY:  Position is 1-indexed because it is reported to humans as "cited at
//       position N", not used as an array index.
export function findAstglInUrls(urls: string[]): {
  citedUrl: string | null;
  position: number | null;
} {
  for (let i = 0; i < urls.length; i++) {
    if (isAstglUrl(urls[i])) {
      return { citedUrl: urls[i], position: i + 1 };
    }
  }
  return { citedUrl: null, position: null };
}

function toResult(urls: string[], text: string): QueryResult {
  const { citedUrl, position } = findAstglInUrls(urls);
  return {
    cited: citedUrl !== null,
    citedUrl,
    position,
    snippet: text.slice(0, SNIPPET_MAX_CHARS) || null,
  };
}

// --- Perplexity ---

interface PerplexityResponse {
  citations?: unknown;
  choices?: unknown;
}

interface PerplexityChoice {
  message?: { content?: string };
}

// WHAT: Parse a Perplexity Sonar chat-completions response.
// WHY:  Sonar always searches and returns a flat `citations` array of URLs.
//       Guarding it matters even though findAstglInUrls never throws on a
//       non-array: reading `.length` off an object yields undefined, the loop
//       never runs, and the question would silently record "not cited" — a wrong
//       measurement is worse than a loud one.
export function parsePerplexity(data: unknown): QueryResult {
  const body = (data ?? {}) as PerplexityResponse;
  const urls = asArray<string>(body.citations).filter(
    (u): u is string => typeof u === "string"
  );
  const choices = asArray<PerplexityChoice>(body.choices);
  // WHY typeof, not ||: a numeric `content` is truthy, survives `|| ""`, and
  //     then throws on .slice() in toResult. Optional chaining already makes
  //     null/primitive choices safe; the FIELD's type is the remaining hole.
  const content = choices[0]?.message?.content;
  return toResult(urls, typeof content === "string" ? content : "");
}

// --- Claude ---

// WHAT: One entry of a successful web_search_tool_result.
interface ClaudeSearchResult {
  url?: string;
  title?: string;
}

// WHAT: The web_search_tool_result_error shape Anthropic substitutes for the
//       result array when a search fails (max_uses_exceeded, too_many_requests,
//       query_too_long, unavailable, …).
// WHY:  Declared explicitly rather than cast away, so the union is visible at
//       the call site and the compiler forces a branch. The old declaration said
//       this field was always ClaudeSearchResult[], which is exactly why the
//       for...of typechecked cleanly and only failed in production.
interface ClaudeSearchError {
  type?: string;
  error_code?: string;
}

interface ClaudeBlock {
  type?: string;
  text?: string;
  // WHAT: A UNION, not an array. Array on search success, error object on
  //       search failure. Anthropic reports tool failures as HTTP 200 with an
  //       error-shaped block, never as a non-2xx status.
  content?: ClaudeSearchResult[] | ClaudeSearchError;
  citations?: unknown;
}

interface ClaudeResponse {
  content?: unknown;
}

interface ClaudeCitation {
  url?: string;
}

// WHAT: Parse an Anthropic messages response that used the web_search server tool.
// WHY:  Citations arrive two ways — attached to text blocks, and as the search
//       results themselves — so both are collected.
//
//       A search error does NOT fail the question. One block erroring while
//       others succeed still yields a real, grounded answer, and recording it as
//       "not cited" is the correct measurement. Only a response in which EVERY
//       search errored is unmeasurable, and that one throws: see the comment on
//       the throw below.
export function parseClaude(data: unknown): QueryResult {
  const body = (data ?? {}) as ClaudeResponse;

  const urls: string[] = [];
  let textOut = "";
  let searchesOk = 0;
  let searchesFailed = 0;
  let firstErrorCode: string | null = null;

  // WHY isRecord on every member and typeof on every leaf: asArray only proves
  //     the CONTAINER is an array. A null member throws on `block.type`; a
  //     numeric `url` survives a truthiness check and throws inside URL parsing;
  //     a numeric `text` coerces into the snippet. Same defect class, one level
  //     down — validate the record, then the field.
  for (const block of asArray<ClaudeBlock>(body.content)) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      textOut += block.text;
      for (const c of asArray<ClaudeCitation>(block.citations)) {
        if (isRecord(c) && typeof c.url === "string") urls.push(c.url);
      }
    } else if (block.type === "web_search_tool_result") {
      if (Array.isArray(block.content)) {
        searchesOk++;
        for (const r of block.content) {
          if (isRecord(r) && typeof r.url === "string") urls.push(r.url);
        }
      } else if (block.content) {
        searchesFailed++;
        if (firstErrorCode === null) {
          const code = isRecord(block.content)
            ? block.content.error_code
            : undefined;
          firstErrorCode = typeof code === "string" ? code : "unknown";
        }
      }
    }
  }

  // WHAT: Fail the question only when every web search in the response errored.
  // WHY:  With no successful search, the model answered without web grounding,
  //       so "astgl.ai was not cited" measures nothing about citation behavior —
  //       recording cited=0 would enter a fabricated data point into the
  //       historical AEO report. This is the per-question form of the rule in
  //       runEngine (PR #15): a run that failed entirely must record nothing
  //       rather than masquerade as a legitimate zero.
  //
  //       A response with NO search blocks at all is deliberately not covered:
  //       the model chose to answer from parametric knowledge, which is a real
  //       (and interesting) not-cited result.
  if (searchesFailed > 0 && searchesOk === 0) {
    throw new Error(
      `Anthropic web_search failed on all ${searchesFailed} attempt(s) (${firstErrorCode}) — no web-grounded answer to measure`
    );
  }

  return toResult(urls, textOut);
}

// --- ChatGPT ---

interface ChatGPTAnnotation {
  type?: string;
  url?: string;
}

interface ChatGPTContent {
  type?: string;
  text?: string;
  annotations?: unknown;
}

interface ChatGPTItem {
  type?: string;
  content?: unknown;
}

interface ChatGPTResponse {
  output?: unknown;
}

// WHAT: Parse an OpenAI Responses API result that used web_search_preview.
// WHY:  Cited URLs arrive as `url_citation` annotations on output_text items.
//       `content` and `annotations` carry the same non-array risk as Claude's
//       blocks — the previous `!item.content` check was a truthiness guard, one
//       error-shaped payload away from the identical crash.
export function parseChatGPT(data: unknown): QueryResult {
  const body = (data ?? {}) as ChatGPTResponse;

  const urls: string[] = [];
  let textOut = "";

  // WHY isRecord/typeof on members and leaves: see the same comment in
  //     parseClaude — the container being an array proves nothing about what
  //     the vendor put in it.
  for (const item of asArray<ChatGPTItem>(body.output)) {
    if (!isRecord(item) || item.type !== "message") continue;
    for (const c of asArray<ChatGPTContent>(item.content)) {
      if (!isRecord(c)) continue;
      if (c.type === "output_text" && typeof c.text === "string") {
        textOut += c.text;
      }
      for (const a of asArray<ChatGPTAnnotation>(c.annotations)) {
        if (isRecord(a) && a.type === "url_citation" && typeof a.url === "string") {
          urls.push(a.url);
        }
      }
    }
  }

  return toResult(urls, textOut);
}
