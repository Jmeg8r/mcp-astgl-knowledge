/**
 * Two-pass article rewriter.
 *
 * Pass 1 — Ollama (qwen3:32b-fast) generates a structurally faithful rewrite,
 * updating tool versions, deprecated APIs, and stale references.
 *
 * Pass 2 — Claude Sonnet 4.6 polishes the draft against the ASTGL voice
 * profile. The voice profile is sent as a cached system prompt so repeat
 * runs only pay for the user-prompt tokens.
 *
 * Pure: no DB writes, no filesystem side effects, no Telegram. Caller is
 * responsible for those.
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

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const OLLAMA_REWRITE_MODEL = process.env.OLLAMA_REWRITE_MODEL || "gemma4:26b";
const CLAUDE_MODEL = process.env.CLAUDE_REWRITE_MODEL || "claude-sonnet-4-6";
const ANTHROPIC_API_VERSION = "2023-06-01";

export interface RewriteInput {
  title: string;
  url: string;
  description: string | null;
  pub_date: string | null;
  body: string;
}

export interface RewriteOutput {
  markdown: string;
  ollama_chars: number;
  claude_chars: number;
  ollama_ms: number;
  claude_ms: number;
}

let cachedVoiceProfile: string | null = null;

async function loadVoiceProfile(): Promise<string> {
  if (cachedVoiceProfile) return cachedVoiceProfile;
  cachedVoiceProfile = await readFile(VOICE_PROFILE_PATH, "utf-8");
  return cachedVoiceProfile;
}

// WHAT: Ollama draft pass via /api/generate.
// WHY:  Per project memory, /api/chat returns 503 / empty content for some
//       models on Ollama 0.20+. /api/generate is the reliable surface.
async function ollamaDraft(input: RewriteInput): Promise<{ text: string; ms: number }> {
  const prompt = [
    "You are rewriting an article from the As The Geek Learns (ASTGL) blog.",
    "",
    `Original title: ${input.title}`,
    `Original publish date: ${input.pub_date ?? "unknown"}`,
    `Original URL: ${input.url}`,
    "",
    "Your job: produce a faithful rewrite that preserves the article's structure, key claims, and overall length, but corrects anything that has gone stale:",
    "  - Update tool version numbers (e.g. Ollama, MCP SDK, Open WebUI) to current values where you can do so confidently.",
    "  - Replace deprecated APIs with current ones.",
    "  - Fix or note broken / outdated references.",
    "  - Keep the heading structure and paragraph order unless an update demands a small change.",
    "",
    "Do NOT invent benchmarks, statistics, or quotes that weren't in the original. Do NOT change the article's thesis. If you are not sure a fact is current, leave the original wording intact rather than guessing.",
    "",
    "Return only the rewritten markdown body — no preamble, no commentary, no code-fence wrapping.",
    "",
    "ORIGINAL ARTICLE BODY:",
    "---",
    input.body,
    "---",
  ].join("\n");

  const start = Date.now();
  const resp = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_REWRITE_MODEL,
      prompt,
      stream: false,
      options: {
        // Generous output budget — long-form ASTGL articles run ~2-4K tokens.
        num_predict: 6000,
        temperature: 0.5,
      },
    }),
    signal: AbortSignal.timeout(15 * 60 * 1000), // 15 min — local models can be slow
  });

  const ms = Date.now() - start;

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(`ollama draft failed: ${resp.status} ${errBody.slice(0, 500)}`);
  }

  const data = (await resp.json()) as { response?: string; error?: string };
  if (data.error) {
    throw new Error(`ollama draft error: ${data.error}`);
  }
  const text = (data.response ?? "").trim();
  if (!text) {
    throw new Error("ollama draft returned empty response");
  }
  return { text, ms };
}

// WHAT: Claude polish pass with prompt caching on the voice profile.
// WHY:  The voice profile is ~150 lines and identical every run — caching it
//       cuts token spend by ~60% per polish call after the first warm-up.
async function claudePolish(
  input: RewriteInput,
  ollamaDraftText: string
): Promise<{ text: string; ms: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  const voiceProfile = await loadVoiceProfile();

  const userPrompt = [
    `Polish this rewritten ASTGL article to match the voice profile above.`,
    "",
    `Original article URL: ${input.url}`,
    `Original publish date: ${input.pub_date ?? "unknown"}`,
    `Original title: ${input.title}`,
    "",
    "Rules for the polish pass:",
    "  - Apply every voice rule: eliminate AI markers, vary sentence length, lean into senior-engineer tone.",
    "  - Preserve all factual content from the draft. Do not add new claims, statistics, or examples.",
    "  - Preserve the markdown heading structure unless a heading is genuinely awkward.",
    "  - Keep the article roughly the same length; do not pad.",
    "  - Return ONLY the polished markdown — no preamble, no \"Here is the polished version\" line, no code fences.",
    "",
    "DRAFT TO POLISH:",
    "---",
    ollamaDraftText,
    "---",
  ].join("\n");

  const start = Date.now();
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 8000,
      system: [
        {
          type: "text",
          text: voiceProfile,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: userPrompt,
        },
      ],
    }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });

  const ms = Date.now() - start;

  if (!resp.ok) {
    const errBody = await resp.text();
    throw new Error(
      `claude polish failed: ${resp.status} ${errBody.slice(0, 500)}`
    );
  }

  const data = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
    error?: { message?: string };
  };
  if (data.error) {
    throw new Error(`claude polish error: ${data.error.message ?? "unknown"}`);
  }

  const textBlock = (data.content ?? []).find((b) => b.type === "text");
  const text = (textBlock?.text ?? "").trim();
  if (!text) {
    throw new Error("claude polish returned empty content");
  }
  return { text, ms };
}

export async function rewriteArticle(input: RewriteInput): Promise<RewriteOutput> {
  const draft = await ollamaDraft(input);
  const polished = await claudePolish(input, draft.text);
  return {
    markdown: polished.text,
    ollama_chars: draft.text.length,
    claude_chars: polished.text.length,
    ollama_ms: draft.ms,
    claude_ms: polished.ms,
  };
}
