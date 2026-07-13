# npm run stdout is polluted — verify stdout contracts against `node dist/` directly

**Date:** 2026-07-07
**Context:** CodeRabbit flagged the `/astgl-new-job` smoke test (`… | jq .`) as too weak
and suggested counting `npm run` stdout lines instead.

## The problem

Scripts in this repo have a hard contract: exactly ONE JSON line on stdout (schedulers
and MAESTER parse it). The suggested check — count lines from `npm run <name>` — looked
right but would false-fail on this machine.

## What testing revealed

Measured empirically before encoding the fix (`npm run build` prints nothing itself, so
any stdout lines are wrapper noise):

- `npm run build` → **6 stray stdout lines** (npm's `> script` banner)
- `npm run -s build` → **still 2 lines** — the safe-chain npm shim's warning goes to
  stdout and survives `-s`

So no `npm run`-based line count is reliable here.

## The fix

Verify against the production invocation, which bypasses npm entirely:

```bash
npm run build
out=$(node dist/<name>.js --dry-run 2>/dev/null)
[ "$(printf '%s\n' "$out" | wc -l)" -eq 1 ] && printf '%s' "$out" | jq -e . >/dev/null
```

Bonus: this is literally what launchd runs, so the check also catches stale-dist drift.

## Reusable rules

1. **Never assert on `npm run` stdout** — the banner and local shell shims (safe-chain
   here) pollute it, and `-s` doesn't fully clean it. Assert on the direct
   `node`/`tsx` invocation.
2. **Verify with the production invocation**, not a dev-convenience wrapper — it tests
   the contract AND the deployed artifact at once.
3. **Before encoding a reviewer's suggested check into docs/skills, run it once** — the
   suggestion was directionally right but concretely wrong for this environment; a
   30-second empirical test changed the fix.
