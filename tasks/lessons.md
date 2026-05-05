# Lessons — mcp-astgl-knowledge

## 2026-04-28 — Verify the matching signal against the actual workflow before designing

When asked to retire drafts whose "published counterpart now exists", the
obvious move is title/slug fuzzy match between draft entries and published
articles. Resisted the impulse, opened one real published example
(`Published_02022026_2026-02-01-ironclad-workflow-setup`), grepped for its
slug under `astgl-site/src/content/answers/` — no match. That single check
revealed Substack drafts and astgl.ai answers are separate publishing
channels: the local `Published_` rename is the actual ship signal, not
"shows up at astgl.ai/answers/*". Folder-existence ended up being a
simpler, more reliable signal than fuzzy matching, with zero false
positives for content that ships to Substack only.

**Rule:** Before designing a matcher, verify the implied data model by
opening one real example. The user's framing of "what published means" may
not match what's on disk.
