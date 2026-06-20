#!/usr/bin/env bash
# refresh-digest.sh — regenerate the committed "Known Patterns" digest in CLAUDE.md
# from this repo's gstack learnings store. Run at the Compound step of a session.
#
# WHAT: rewrites only the content between the LEARNINGS markers in CLAUDE.md.
# WHY:  hybrid model — gstack's per-slug store is the working source of truth;
#       CLAUDE.md carries a human-readable, version-controlled snapshot of the
#       high-confidence learnings (>= 7) so they're visible in the repo and in
#       every future session's context.
set -euo pipefail

CLAUDE_FILE="${1:-CLAUDE.md}"
THRESHOLD="${DIGEST_MIN_CONFIDENCE:-7}"

resolve_slug_bin() {
  if command -v gstack-slug >/dev/null 2>&1; then echo "gstack-slug"; return; fi
  for p in "$HOME/.claude/skills/gstack/bin/gstack-slug" \
           "$HOME/Projects/gstack/bin/gstack-slug"; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  return 1
}

command -v jq >/dev/null 2>&1 || { echo "jq is required." >&2; exit 1; }
[ -f "$CLAUDE_FILE" ] || { echo "No $CLAUDE_FILE here." >&2; exit 1; }
grep -q '<!-- LEARNINGS:START -->' "$CLAUDE_FILE" || {
  echo "No LEARNINGS markers in $CLAUDE_FILE — run compound-init.sh first." >&2; exit 1; }

SLUG_BIN="$(resolve_slug_bin)" || { echo "gstack-slug not found." >&2; exit 1; }
SLUG=""
eval "$("$SLUG_BIN" 2>/dev/null)" || true
[ -n "${SLUG:-}" ] || { echo "Could not resolve slug." >&2; exit 1; }

LEARNINGS_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG}/learnings.jsonl"

# WHAT: build the markdown table body into a temp file.
TABLE="$(mktemp)"
trap 'rm -f "$TABLE"' EXIT

if [ ! -s "$LEARNINGS_FILE" ]; then
  printf '_No learnings yet. Run `/gstack-learn add` during a session, then `./refresh-digest.sh`._\n' > "$TABLE"
else
  {
    echo "| Key | Type | Conf | Insight |"
    echo "|-----|------|------|---------|"
    # dedupe by key+type (latest ts wins) → keep confidence >= THRESHOLD → sort desc.
    jq -rs --argjson min "$THRESHOLD" '
      group_by(.key + "|" + .type)
      | map(max_by(.ts // ""))
      | map(select((.confidence // 0) >= $min))
      | sort_by(-(.confidence // 0))
      | .[]
      | "| `\(.key)` | \(.type) | \(.confidence) | "
        + ((.insight | gsub("\\|"; "\\|") | gsub("\n"; " "))
           | if (length > 110) then (.[0:107] + "…") else . end)
        + " |"
    ' "$LEARNINGS_FILE"
    COUNT=$(jq -rs --argjson min "$THRESHOLD" '
      group_by(.key + "|" + .type) | map(max_by(.ts // ""))
      | map(select((.confidence // 0) >= $min)) | length' "$LEARNINGS_FILE")
    echo ""
    echo "_${COUNT} learning(s) at confidence ≥ ${THRESHOLD}. Full set: \`./show-learnings.sh\`._"
  } > "$TABLE"
fi

# WHAT: splice TABLE between the markers, preserving everything else. Idempotent.
TMP="$(mktemp)"
awk -v rf="$TABLE" '
  /<!-- LEARNINGS:START -->/ { print; while ((getline line < rf) > 0) print line; close(rf); skip=1; next }
  /<!-- LEARNINGS:END -->/   { skip=0; print; next }
  skip { next }
  { print }
' "$CLAUDE_FILE" > "$TMP" && mv "$TMP" "$CLAUDE_FILE"

echo "Refreshed Known Patterns digest in $CLAUDE_FILE (slug: $SLUG)."
