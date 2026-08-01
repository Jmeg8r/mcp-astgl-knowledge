# Entity Allowlist

**Status**: Approved 2026-07-29
**Governs**: which `content_type = 'entity'` wiki pages get `public = 1` (see ADR-0001)

All 116 tagged entities are bucketed below; every one appears exactly once, verified against
`knowledge.db`. Concepts are governed by a separate list of 68 titles in
`CONCEPT_ALLOWLIST` — as of 2026-07-29 they are allowlisted too, not shipped by default.

> **`src/public-allowlist.ts` is authoritative.** This document records *why* each entity
> was bucketed; the code decides what actually ships. If the two disagree, the code wins and
> this file is the thing that is wrong. Keep the Ship section and `ENTITY_ALLOWLIST` in sync
> — 31 entries in both as of 2026-07-31 (32 as originally approved; `OpenClaw` removed).

Anything not in **Ship** stays `public = 0`, which is also the fail-closed default: an
entity accidentally omitted from this file does not ship.

---

## Ship (31 as of 2026-07-31; 32 as approved)

**Local-AI hardware substrate (4)**
`Mac Studio` · `Mac Studio M3 Ultra` · `M3 Ultra` · `Apple Silicon`

**Claude / Anthropic (8)**
`Anthropic` · `Anthropic API` · `Claude API` · `Claude Code` · `Claude Opus 4.8` ·
`Claude Sonnet` · `Claude Projects` · `Subagent`

**Open-weight models (6)**
`Qwen` · `Qwen2.5-Coder` · `Qwen3` · `Qwen3 8B` · `Qwen3 235B A22B Thinking` ·
`Qwen3-Coder 30B`

**Automation & MCP substrate (3)**
`launchd` · `mcpaudit` · `mcp-astgl-knowledge`

**Own agent stack (8 as of 2026-07-31; 9 as approved)** — approved 2026-07-29. Shipping these builds authority and doubles
as discovery for projects covered in the newsletter. See the OpenClaw note below.
`ClaudeClaw` · `ClaudeClaw Mission Control` · `SecureClaw` · `ClawHub` · `ClawPad` ·
`ClawHavoc` · `Paperclip` · `LAMM — Local Agent Memory Manager`  
(`OpenClaw` was in this group and was **removed 2026-07-31** — see the note below.)

**Methodology (2)** — approved 2026-07-29.
`Ironclad Workflow` · `Technical Reality Check`

### Note — the OpenClaw page's "retired" framing is stale (and why it is now withheld)

The page presents itself as describing something archived in April 2026. Checked
2026-07-29: that framing does not hold — enough of what the page documents is still in use
that its content should be read as current rather than historical. The specifics are
deliberately not restated here; this file is public, and enumerating why a withheld page is
sensitive re-discloses what withholding it prevents.

Consequence: the page publishes the directory layout of something that still exists rather
than something deleted. It names no credentials — the pre-hardening posture is explicitly
paired with the SecureClaw remediation that followed — so this is a disclosure-hygiene
question, not an exposure.

**Pulled 2026-07-31.** It was shipped as approved on the "retired case study" reading; once
that framing was confirmed stale — the page documents the layout of something that still
exists — James decided to withhold it. Removed from `ENTITY_ALLOWLIST`; the fail-closed
default handles the rest. Note this does **not** retract npm 1.3.0, which already contains
the page and cannot be altered; the change takes effect on the next publish.

---

## Exclude — generic developer stubs (24)

An LLM answers these better than a 200-word page. Shipping them invites citations to content
carrying no ASTGL authority.

`Git` · `Python` · `React` · `Next.js` · `Node.js` · `TypeScript` · `Vite` · `Electron` ·
`FastAPI` · `Homebrew` · `Xcode` · `Swift` · `SwiftFormat` · `URLSession` · `UnsafePointer` ·
`CoreServices Framework` · `LaunchServices` · `Sparkle` · `WebSocket` ·
`Semantic Versioning Specification` · `BlockNote` · `Bolt Slack SDK` · `GitHub Releases` ·
`Google`

## Exclude — commercial products & third-party services (13)

Excluded 2026-07-29. A knowledge server that returns storefront listings reads as an ad and
erodes the citation trust the server exists to earn; third-party service pages describe the
vendor rather than carrying ASTGL-specific insight.

`AI Employees Guide` · `AI Request Deflection Toolkit` · `Homelab DR Kit` ·
`SSH Key Hygiene Kit` · `journey-kits` · `UpdateKit` · `Substack` · `Discord` ·
`ElevenLabs` · `Resend` · `Convex` · `Gitleaks` · `pass-cli`

## Exclude — off-topic media & desktop tools (8)

`Blender` · `Mixamo` · `CapCut` · `Cascadeur` · `Higgsfield` · `Calendar.app` ·
`MacUpdater` · `Wispr Flow`

## Exclude — private projects & personal ventures (17)

`Income Investor` carries unlaunched-product and business-status detail. (Redacted
2026-07-31: this line previously spelled out what it discloses, which defeated the purpose
in a public repository — see the note in ADR-0001's *Scope of what ships*.)

`Income Investor` · `Dividend Portfolio Tracker` · `Social Media Scheduling App` ·
`Geekspace` · `Geekspace MCP` · `revri` · `quorum` · `trevin-creator` · `Tars` ·
`ARCHITECT` · `FrontierCode` · `Grok Build` · `The Geek` · `Cal` · `hyperframes` ·
`hyperframes-integration` · `Autonomous Commerce Agent (ACA)`

## Exclude — pipeline internals & slash commands (22)

`astgl-gtm` additionally exposes the existence and local path of a private go-to-market
workspace.

`/astgl-breaking` · `/astgl-promote` · `/brain-capture` · `/capture-session` ·
`/process-inbox` · `/schedule-astgl-notes` · `ASTGL Publish` · `astgl articles` ·
`astgl site` · `astgl-animated-channel` · `astgl-store` · `astgl-gtm` ·
`publish-to-substack` · `pseo-astgl` · `substack-scheduler` · `render astgl cover` ·
`CURATOR` · `factcheck-db` · `summarize` · `Autonomous Content Agent` · `last30days` ·
`Port Drift Detector`

---

## Resulting scope

| | Entities | Concepts | Total |
|---|---|---|---|
| **Published** | **31** | **68** | **99** |
| Withheld | 85 | 6 | 91 |
| Currently indexed | 116 | 74 | 190 |

The 68 published concepts are the 74 tagged concept pages less six internal-jargon pages
(`editorial glow`,
`learnings-jsonl`, `Substack safe zone`, `Extraction pipeline misses vault narrative`,
`Source-Seed Copy Defect`, `platform char limits vary by url counting`).

## Known issue — not in scope here

Every wiki article's `description` column in `knowledge.db` is the literal string
`# <Title>` rather than the first paragraph; `sync-wiki.ts`'s h1 strip is not taking on the
stored path. Cosmetic for search (descriptions are not embedded) but user-visible in
`find_articles` output. Fix separately.
