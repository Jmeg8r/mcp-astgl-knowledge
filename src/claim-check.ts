/**
 * Deterministic claim check for local rewrites.
 *
 * WHAT: Extracts the checkable tokens of a text (URLs, version strings, quoted spans,
 *       numbers), reports every token a rewrite adds that the original and the
 *       verified-facts table do not contain, and lists the original's dated facts.
 * WHY:  A local model has no source for current facts, so a version or statistic it
 *       "updates" comes from training memory: an unsupported claim (spec F1). The
 *       model rewrites prose; this check guards the facts; James corrects dated facts
 *       during review.
 *
 * Pure: no I/O.
 */

export interface ClaimCheckResult {
  added: string[];
}

const URL_RE = /https?:\/\/[^\s)<>\]"'`]+/g;
const VERSION_RE = /(?<![\w.])v?\d+(?:\.\d+){2,3}(?:-[0-9A-Za-z.]+)?(?![\w])/g;
const QUOTE_RE = /["“]([^"”\n]{12,})["”]/g;
const NUMBER_RE = /(?<![\w.])\d[\d,]*(?:\.\d+)?/g;
// A sentence-ending period may follow a year; a decimal digit may not.
const YEAR_RE = /(?<![\w.])(?:19|20)\d\d(?!\w|\.\d)/g;
// "1. Step" at the start of a line is markdown list numbering, not a claim.
const LIST_MARKER_RE = /^(\s*)\d+\.\s/gm;

function normalizeUrl(url: string): string {
  return url.replace(/[.,;:!?]+$/, "").replace(/\/+$/, "").toLowerCase();
}

function normalizeVersion(version: string): string {
  return version.replace(/^v/i, "");
}

function normalizeNumber(num: string): string {
  return num.replace(/,+$/, "").replace(/,/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

// Curly quotes and apostrophes are typography, not content: a rewrite that turns
// it's into it’s has not changed what the page says.
function straightenQuotes(text: string): string {
  return text.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

const collapseSpace = (text: string) => text.replace(/\s+/g, " ").trim();

// WHAT: The text's tokens in category order, normalized so formatting changes match.
// WHY:  Each category is removed from the text once extracted, so a version is not
//       also counted as numbers and a URL's digits are not counted at all.
export function extractClaimTokens(text: string): string[] {
  let rest = straightenQuotes(text);
  const urls = (rest.match(URL_RE) ?? []).map(normalizeUrl);
  rest = rest.replace(URL_RE, " ");
  const versions = (rest.match(VERSION_RE) ?? []).map(normalizeVersion);
  rest = rest.replace(VERSION_RE, " ");
  const quotes = [...rest.matchAll(QUOTE_RE)].map((m) => `"${collapseSpace(m[1]).toLowerCase()}"`);
  rest = rest.replace(QUOTE_RE, " ").replace(LIST_MARKER_RE, "$1");
  const numbers = (rest.match(NUMBER_RE) ?? []).map(normalizeNumber);
  return unique([...urls, ...versions, ...quotes, ...numbers]);
}

export function checkClaims(
  original: string,
  rewritten: string,
  verifiedFacts: string[] = []
): ClaimCheckResult {
  const allowed = new Set([
    ...extractClaimTokens(original),
    ...verifiedFacts.flatMap((fact) => extractClaimTokens(fact)),
  ]);
  // A quoted span is supported when its words already appear in the original, quoted
  // or not: putting quote marks around the page's own sentence adds no claim. The
  // original is reduced the same way the quote was (URLs and versions removed,
  // quotes straightened, whitespace collapsed) so the two compare like for like.
  const originalProse = collapseSpace(
    straightenQuotes(original).replace(URL_RE, " ").replace(VERSION_RE, " ")
  ).toLowerCase();
  const supported = (token: string) =>
    allowed.has(token) || (token.startsWith('"') && originalProse.includes(token.slice(1, -1)));
  return { added: extractClaimTokens(rewritten).filter((t) => !supported(t)) };
}

// WHAT: The original's version strings and years, for James to verify in review.
export function datedFacts(original: string): string[] {
  const withoutUrls = original.replace(URL_RE, " ");
  const versions = (withoutUrls.match(VERSION_RE) ?? []).map(normalizeVersion);
  const years = withoutUrls.replace(VERSION_RE, " ").match(YEAR_RE) ?? [];
  return unique([...versions, ...years]);
}
