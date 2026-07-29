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
 * Fail-closed, with no exceptions. `isPublic()` returns false for an unrecognized
 * content_type, an unrecognized source_origin, any wiki entity not named in
 * ENTITY_ALLOWLIST, and any wiki concept not named in CONCEPT_ALLOWLIST. Nothing
 * publishes by default; every published page is named somewhere in this file.
 *
 * Concepts were denylist-governed when the gate first shipped, on the reasoning
 * that per-page approval is friction that discourages writing them. That was
 * reversed on 2026-07-29: under a denylist a newly written concept published
 * without ever having been looked at, and the audit behind the original decision
 * only ever covered the 74 concepts that existed that day. Visibility at publish
 * time was a weaker control than simply naming what ships.
 *
 * Adding a title here IS the publication decision. After editing, run
 * `npm run reclassify-wiki` — or just publish, since `prepublishOnly` runs it.
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

// WHAT: The 68 wiki concept pages approved for publication.
// WHY:  Concepts moved from a denylist to an allowlist on 2026-07-29. Under the
//       denylist a newly written concept published by default, so the corpus
//       could grow public pages nobody had reviewed — the audit only ever
//       covered the 74 concepts that existed that day. An allowlist makes the
//       whole module fail closed: new writing is withheld until it is named
//       here, which is a deliberate act rather than an omission.
//       Adding an entry is the publication decision. After editing, run
//       `npm run reclassify-wiki` (or just publish — prepublishOnly runs it).
export const CONCEPT_ALLOWLIST = new Set([
  "A Keyframe Stores the End State, Not the Motion",
  "AI-Assisted Single-Session Application Development",
  "Agent-Backed Workspace from Export",
  "Automated Secret Prevention via Pre-Commit",
  "Automation Feedback Loops Without Boundaries",
  "Autoresearch",
  "Autoresearch Discipline Pattern",
  "Byte-Offset Seeking",
  "Cache Coherence Pattern: Authoritative Source",
  "Cascading Failures",
  "Character as Code",
  "Cheap production removes the validation forcing function, not the need for it",
  "Clear-Then-Save Pattern",
  "Code Deletion as Improvement",
  "Code Smell",
  "Compound Engineering",
  "Compound Engineering Workflow",
  "Confidence over boolean",
  "Confidence scoring",
  "Content as MCP Knowledge Server",
  "Context-loaded AI coworker system",
  "Cost-Chokepoint Pattern",
  "De-Fabrication Gate",
  "Dependency Inversion for Community Features",
  "Dual-Instance Architecture",
  "Event Sourcing Pattern",
  "Fallback Chains",
  "File Ownership Determines Permissions",
  "Filesystem as Queue",
  "Fixed-Font Canvas Sizing",
  "Fleet-Scale SSH Key Auditing",
  "Framework choice as a multiplier",
  "Framing determines the economics, structurally",
  "Free Tier as Marketing Channel",
  "Git Hooks",
  "GitHub Actions as Monetized Wrappers",
  "Grounding Changes the Thesis",
  "Hard-fail over silent degradation",
  "Hidden Dependencies",
  "Honor the source's stated scope",
  "Infrastructure Reuse Over Custom Implementation",
  "Library-Executable Split",
  "Local-First Pipeline Architecture",
  "Loop Engineering",
  "Loop Engineering Leverage Shift",
  "MCP Server Security Audit Framework",
  "Matrix Builds for Configuration Coverage",
  "Mermaid Mindmap Dark-Theme Fails",
  "Migration-First Schema Design",
  "NOT NULL Column Migration Pattern",
  "Owned-Audience Engine",
  "Pattern Mining from AI Config",
  "Prompt-Based Guardrails Illusion",
  "Prove a behavior-preserving refactor byte-identical",
  "Provenance-Clean AI Content",
  "Real-Data Testing",
  "Render-Verification Catches Code-Invisible Bugs",
  "SEO Doc 16-Section Standard",
  "Scheduler stores a path, uploads the image at post time",
  "Self-Hosted AI Agents for Transparency and Autonomy",
  "Self-Taught AI Engineering via Shipping",
  "Simplicity Over Premature Abstraction",
  "Speak the Downstream Tool's Conventions",
  "Strategy Pattern for Switch Statement Refactoring",
  "System Registry Pattern",
  "The 9-Step Operational Loop for AI-Assisted Senior Engineering",
  "Three-Layer Defense",
  "Version Mismatch Gotcha",
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
    if (contentType === "concept") return CONCEPT_ALLOWLIST.has(title);
    if (contentType === "entity") return ENTITY_ALLOWLIST.has(title);
    return false; // synthesis and anything new: withheld until decided
  }

  if (sourceOrigin === "astgl-site") {
    return PUBLISHED_SITE_TYPES.has(contentType);
  }

  // Unknown origin (drafts pipeline, projects ingest, anything future): withheld.
  return false;
}
