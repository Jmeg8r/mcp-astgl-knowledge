#!/usr/bin/env bash
# show-learnings.sh — view this project's compound-engineering learnings offline.
#
# WHAT: Pretty-print the gstack learnings for THIS repo (resolved by slug).
# WHY:  gstack already stores + auto-loads learnings per project. This gives a
#       readable, offline view without invoking the /gstack-learn skill.
#       Hybrid model: the gstack store is the source of truth; CLAUDE.md holds
#       the committed digest (see ./refresh-digest.sh).
#
# Usage:
#   ./show-learnings.sh            # all learnings (latest-wins per key)
#   ./show-learnings.sh high       # confidence >= 8 only
#   ./show-learnings.sh pitfall    # filter by type (pattern|pitfall|preference|…)
set -euo pipefail

# WHAT: locate gstack-slug whether or not it's on PATH.
resolve_slug_bin() {
  if command -v gstack-slug >/dev/null 2>&1; then echo "gstack-slug"; return; fi
  for p in "$HOME/.claude/skills/gstack/bin/gstack-slug" \
           "$HOME/Projects/gstack/bin/gstack-slug"; do
    [ -x "$p" ] && { echo "$p"; return; }
  done
  return 1
}

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required. Install with: brew install jq" >&2; exit 1
fi

SLUG_BIN="$(resolve_slug_bin)" || { echo "gstack-slug not found — is gstack installed?" >&2; exit 1; }
SLUG=""
eval "$("$SLUG_BIN" 2>/dev/null)" || true   # sets SLUG (and BRANCH)
if [ -z "${SLUG:-}" ]; then echo "Could not resolve project slug (no git remote?)." >&2; exit 1; fi

LEARNINGS_FILE="${GSTACK_HOME:-$HOME/.gstack}/projects/${SLUG}/learnings.jsonl"
if [ ! -s "$LEARNINGS_FILE" ]; then
  echo "No learnings yet for '${SLUG}'."
  echo "(store: $LEARNINGS_FILE)"
  echo "Record one with: /gstack-learn add"
  exit 0
fi

FILTER="${1:-}"
if   [ "$FILTER" = "high" ]; then SEL='select((.confidence // 0) >= 8)'
elif [ -n "$FILTER" ];        then SEL="select(.type == \"$FILTER\")"
else                               SEL='.'
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Compound Engineering Learnings — ${SLUG}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# WHAT: dedupe by key+type keeping the newest ts (gstack is append-only, latest wins),
#       then apply the filter and print.
jq -rs '
  group_by(.key + "|" + .type)
  | map(max_by(.ts // ""))
  | sort_by(-(.confidence // 0))
  | .[]
  | '"$SEL"'
  | "\n[\(.type | ascii_upcase)] \(.key)  (confidence: \(.confidence))\n  \(.insight)"
' "$LEARNINGS_FILE"

echo ""
TOTAL=$(jq -rs 'group_by(.key + "|" + .type) | length' "$LEARNINGS_FILE")
echo "Total: ${TOTAL} learning(s)"
echo ""
