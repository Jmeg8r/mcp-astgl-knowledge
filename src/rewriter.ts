/**
 * Local two-pass answer-page rewriter.
 *
 * Pass 1 — a local draft model rewrites the page body for clarity and structure,
 * keeping every fact as written.
 *
 * Pass 2 — a local voice model rewrites the draft against the ASTGL voice profile.
 *
 * Both passes run on the local Ollama host only (2026-09-24 decision; spec R4). Only
 * the markdown body reaches a model: the frontmatter is copied byte-for-byte except
 * `date` (spec F4). Facts are not updated from model memory; the caller runs the
 * claim check on the result (spec F1).
 *
 * Pure apart from the Ollama calls and the voice-profile read: no DB writes, no
 * filesystem writes, no notifications. Caller is responsible for those.
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const VOICE_PROFILE_PATH = join(
  homedir(),
  ".claude",
  "commands",
  "astgl-publish",
  "voice",
  "humanizer-astgl.md"
);

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
export const DEFAULT_DRAFT_MODEL = "qwen3-coder:30b";
export const DEFAULT_VOICE_MODEL = "astgl-voice:7b-v1.5";

const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 3000;
// 15 min — local models can be slow; fresh signal each attempt.
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
// Generous output budget — long-form answer pages run ~2-4K tokens.
const NUM_PREDICT = 6000;
// Context window set on every request. A model's own default can be far smaller:
// astgl-voice:7b-v1.5 pins 4096, which silently truncated the voice prompt (an 8 KB
// profile plus the draft) in the first real evaluation (2026-11-03). Prompt plus
// NUM_PREDICT must fit; the voice model supports 32768.
const NUM_CTX = 16384;

export interface RewriteOptions {
  draftModel: string;
  voiceModel: string;
  date: string; // YYYY-MM-DD, written to the frontmatter `date`
}

export interface RewriteDeps {
  loadVoiceProfile: () => Promise<string>;
}

export interface RewriteResult {
  page: string;
  originalBody: string;
  draftChars: number;
  voiceChars: number;
  draftMs: number;
  voiceMs: number;
}

const defaultDeps: RewriteDeps = {
  loadVoiceProfile: () => readFile(VOICE_PROFILE_PATH, "utf-8"),
};

// WHAT: Split a page into its frontmatter block (delimiters and the newline after
//       the closing `---` included) and the body, so frontmatter + body === page.
export function splitFrontmatter(page: string): { frontmatter: string; body: string } {
  const match = page.match(/^---\n[\s\S]*?\n---\n/);
  if (!match) throw new Error("page has no frontmatter block");
  return { frontmatter: match[0], body: page.slice(match[0].length) };
}

// WHAT: Replace the frontmatter `date:` value, keeping its quoting style.
export function setFrontmatterDate(frontmatter: string, date: string): string {
  const dateLine = /^date:(\s*)(['"]?)[^'"\n]*\2\s*$/m;
  if (!dateLine.test(frontmatter)) throw new Error("frontmatter has no date line");
  return frontmatter.replace(
    dateLine,
    (_line, space: string, quote: string) => `date:${space}${quote}${date}${quote}`
  );
}

// WHAT: The Ollama base URL, refused unless it points at this machine.
// WHY:  OLLAMA_BASE_URL is the one setting that could send page text to a remote
//       host; checking it here keeps the local-only rule from resting on config.
function localOllamaBaseUrl(): string {
  const base = process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL;
  const host = new URL(base).hostname;
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(`OLLAMA_BASE_URL must point at a local host, got ${host}`);
  }
  return base;
}

// WHAT: Refuse output that carries its own YAML frontmatter, then strip wrappers the
//       model echoed (a ```markdown fence, the <body> tags, lone `---` lines at the
//       start or end), then refuse empty output.
// WHY:  The first real evaluation run (2026-11-03) showed the draft model echoing the
//       prompt's delimiters around an otherwise good body. A real frontmatter block
//       (`---` then `key: value` lines) is still refused: only the site's own
//       frontmatter may reach the page.
function cleanModelOutput(text: string, pass: string): string {
  let out = text.trim();
  if (/^---\n(?:[\w-]+:.*\n)+---/.test(out)) {
    throw new Error(`${pass} pass returned malformed output (frontmatter)`);
  }
  const fenced = out.match(/^```(?:markdown|md)?\n([\s\S]*?)\n```$/);
  if (fenced) out = fenced[1].trim();
  out = out
    .replace(/^<\/?body>\s*/i, "")
    .replace(/\s*<\/body>$/i, "")
    .replace(/^---\s*\n/, "")
    .replace(/\n---\s*$/, "")
    .trim();
  if (!out) throw new Error(`${pass} pass returned empty output`);
  return out;
}

// WHAT: One generation via /api/generate, retried on connection-level failures.
// WHY:  Per project memory, /api/chat returns 503 / empty content for some models
//       on Ollama 0.20+; /api/generate is the reliable surface. The Mac Studio host
//       juggles 20-65GB models, so a cold load can refuse or reset the socket — a
//       bare `TypeError: fetch failed` that a short backoff fixes. HTTP errors and
//       the timeout are not retried: 4xx/5xx are deterministic, and a genuine
//       15-minute stall is not fixed by trying again.
async function ollamaGenerate(
  baseUrl: string,
  model: string,
  prompt: string
): Promise<{ text: string; ms: number }> {
  const requestBody = JSON.stringify({
    model,
    prompt,
    stream: false,
    options: { num_ctx: NUM_CTX, num_predict: NUM_PREDICT, temperature: 0.5 },
  });

  const start = Date.now();
  let resp: Awaited<ReturnType<typeof fetch>> | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      resp = await fetch(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody,
        // A redirect could carry page text off this machine past the local-host check.
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      break;
    } catch (err) {
      const isTimeout =
        err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      if (isTimeout || attempt === MAX_ATTEMPTS) throw err;
      const waitMs = RETRY_BASE_MS * attempt;
      console.error(
        `  ollama fetch attempt ${attempt}/${MAX_ATTEMPTS} failed ` +
          `(${err instanceof Error ? err.message : String(err)}); retrying in ${waitMs}ms`
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  if (!resp) throw new Error(`ollama ${model} failed: exhausted retries with no response`);

  const ms = Date.now() - start;
  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`ollama ${model} failed: ${resp.status} ${errBody.slice(0, 500)}`);
  }
  const data = (await resp.json()) as { response?: string; error?: string };
  if (data.error) throw new Error(`ollama ${model} error: ${data.error}`);
  return { text: data.response ?? "", ms };
}

function draftPrompt(body: string): string {
  return [
    "You are revising an answer page from the As The Geek Learns (ASTGL) site.",
    "",
    "Rewrite it for clarity and flow: tighten wordy sentences, fix awkward structure, and keep the heading structure and section order.",
    "",
    "Keep every fact exactly as written. Do NOT change, add or remove any version number, statistic, date, URL, product name or quotation, even if you believe it is out of date. Do NOT add examples, benchmarks or claims that are not in the original.",
    "",
    "The original body is between the <body> tags below. Return only the rewritten markdown body: no tags, no preamble, no commentary, no frontmatter, no code-fence wrapping.",
    "",
    "<body>",
    body,
    "</body>",
  ].join("\n");
}

function voicePrompt(voiceProfile: string, draft: string): string {
  return [
    voiceProfile,
    "",
    "Rewrite the article body below to match the voice profile above.",
    "",
    "Rules:",
    "  - Apply the voice rules: remove AI markers, vary sentence length, keep the senior-engineer tone.",
    "  - Keep every fact, number, version, date, URL and quotation exactly as written. Add nothing new.",
    "  - Keep the markdown heading structure and roughly the same length.",
    "  - The body is between the <body> tags below. Return ONLY the markdown body: no tags, no preamble, no frontmatter, no code fences.",
    "",
    "<body>",
    draft,
    "</body>",
  ].join("\n");
}

export async function rewritePage(
  page: string,
  opts: RewriteOptions,
  deps: RewriteDeps = defaultDeps
): Promise<RewriteResult> {
  const baseUrl = localOllamaBaseUrl();
  const { frontmatter, body } = splitFrontmatter(page);
  const newFrontmatter = setFrontmatterDate(frontmatter, opts.date);

  const draft = await ollamaGenerate(baseUrl, opts.draftModel, draftPrompt(body));
  const draftText = cleanModelOutput(draft.text, "draft");
  const voiceProfile = await deps.loadVoiceProfile();
  const voiced = await ollamaGenerate(baseUrl, opts.voiceModel, voicePrompt(voiceProfile, draftText));
  const voicedText = cleanModelOutput(voiced.text, "voice");

  return {
    page: `${newFrontmatter}\n${voicedText}\n`,
    originalBody: body,
    draftChars: draftText.length,
    voiceChars: voicedText.length,
    draftMs: draft.ms,
    voiceMs: voiced.ms,
  };
}
