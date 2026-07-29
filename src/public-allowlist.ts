/**
 * Publication allowlist — what may leave this machine.
 *
 * WHAT: The single source of truth for which rows in knowledge.db are eligible
 *       for the published npm artifact.
 * WHY:  `data/knowledge.db` ships inside the package (package.json `files`), so
 *       anything in it is public the moment a release is cut. The DB also holds
 *       201 unpublished article drafts and 90 private-project wiki pages. The
 *       `astgl` vault tag cannot serve as the gate — inside the vault it means
 *       "relates to my subject area" (which is why `Vite` and `Income Investor`
 *       both carry it), not "I chose to publish this". See
 *       docs/adr/0001-knowledge-db-keeps-its-own-index.md and
 *       docs/entity-allowlist.md.
 *
 * Fail-closed: `isPublic()` returns false for anything it does not positively
 * recognize. A new content_type, a new source_origin, or a new wiki entity is
 * withheld until someone adds it here deliberately.
 */

// WHAT: astgl-site content types that represent published newsletter output.
// WHY:  `draft` is deliberately absent — ingest-drafts.ts reads unpublished
//       drafts from the Research volume and they inherit source_origin
//       'astgl-site' from the column default, so origin alone cannot separate
//       published from unpublished.
export const PUBLISHED_SITE_TYPES = new Set([
  "article",
  "tutorial",
  "guide",
  "comparison",
  "newsletter",
  "project",
  "faq",
]);

// WHAT: Wiki concept pages withheld despite carrying the astgl tag.
// WHY:  Internal jargon that reads as noise to anyone outside this machine.
export const CONCEPT_DENYLIST = new Set([
  "editorial glow",
  "learnings-jsonl",
  "Substack safe zone",
  "Extraction pipeline misses vault narrative",
  "Source-Seed Copy Defect",
  "platform char limits vary by url counting",
]);

// WHAT: The 32 wiki entities approved for publication (docs/entity-allowlist.md).
// WHY:  Entities are withheld by default — the bucket holds generic tool stubs
//       an LLM answers better, private ventures, and pipeline internals. Only
//       entries where ASTGL carries genuine authority are listed.
export const ENTITY_ALLOWLIST = new Set([
  // Local-AI hardware substrate
  "Mac Studio",
  "Mac Studio M3 Ultra",
  "M3 Ultra",
  "Apple Silicon",
  // Claude / Anthropic
  "Anthropic",
  "Anthropic API",
  "Claude API",
  "Claude Code",
  "Claude Opus 4.8",
  "Claude Sonnet",
  "Claude Projects",
  "Subagent",
  // Open-weight models
  "Qwen",
  "Qwen2.5-Coder",
  "Qwen3",
  "Qwen3 8B",
  "Qwen3 235B A22B Thinking",
  "Qwen3-Coder 30B",
  // Automation & MCP substrate
  "launchd",
  "mcpaudit",
  "mcp-astgl-knowledge",
  // Own agent stack
  "ClaudeClaw",
  "ClaudeClaw Mission Control",
  "SecureClaw",
  "ClawHub",
  "ClawPad",
  "ClawHavoc",
  "OpenClaw",
  "Paperclip",
  "LAMM — Local Agent Memory Manager",
  // Methodology
  "Ironclad Workflow",
  "Technical Reality Check",
]);

// WHAT: Decide whether one article row may ship in the published package.
// WHY:  Centralised so sync-wiki.ts (write path) and build-public-db.ts (prune
//       path) can never disagree about what "public" means — a second copy of
//       this rule is a second place to drift (Mistake #8).
export function isPublic(
  contentType: string,
  sourceOrigin: string,
  title: string
): boolean {
  if (sourceOrigin === "secondbrain") {
    if (contentType === "concept") return !CONCEPT_DENYLIST.has(title);
    if (contentType === "entity") return ENTITY_ALLOWLIST.has(title);
    return false; // synthesis and anything new: withheld until decided
  }

  if (sourceOrigin === "astgl-site") {
    return PUBLISHED_SITE_TYPES.has(contentType);
  }

  // Unknown origin (drafts pipeline, projects ingest, anything future): withheld.
  return false;
}
