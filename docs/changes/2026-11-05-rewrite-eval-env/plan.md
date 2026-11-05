---
change: 2026-11-05-rewrite-eval-env
status: accepted
track: T1
intent: ./intent.md
linear: ASTGL-69
---
# Plan: `npm run rewrite-eval` reads the settings in `.env`

## Files that change

| File | Change |
|---|---|
| `package.json` | `rewrite-eval` becomes `node --env-file=.env dist/rewrite-eval.js` |
| `test/rewrite-eval-env.test.ts` (new) | Runs the script's real command line from `package.json` against a stub entry point; committed failing first |
| `CLAUDE.md` | Mistake #9 notes the one `.env` script that is not secret-bearing |

## Order of work

1. Failing tests. Each runs `package.json`'s `rewrite-eval` command in a temp directory
   whose `dist/rewrite-eval.js` prints the two settings it sees:
   - values in `.env` reach the eval;
   - a value set in the shell wins over `.env`;
   - a missing `.env` fails the script.
   → verify: the first and third fail on `main`'s script.
2. The `package.json` change and the CLAUDE.md note. → verify: `npm test`.
3. VERIFY and SHIP: `npx tsc --noEmit`, `npm run build`, Codex review posted verbatim
   with my PASS/FAIL label outside it, the forge gate with `--base origin/main` (L79),
   `forge-pr create`. Merge on James's OK.

## Risks

- **`.env` also holds `pass://` references for secrets.** Node loads them as plain
  strings. The eval never reads those variables and never prints its environment, and a
  reference is not a secret. Accepted.
- **`OLLAMA_BASE_URL` set to a non-local host in `.env`.** The rewriter already refuses
  any non-localhost URL before the first request, so the eval fails closed.

## Proof

`npm test` passes with the three new tests. Before the change, the `.env` test sees the
defaults and the missing-`.env` test sees exit 0.

## Options not taken

- **Wrap the script in `pass-cli run --env-file .env`.** That resolves every secret in
  `.env` into a process that needs none of them, and the eval would then need a pass
  unlock to run.
- **`import "dotenv/config"` in `src/rewrite-eval.ts`.** `dotenv` is not used anywhere
  else in `src/`. Loading `.env` in code would also make importing the module change the
  environment, which the test helpers import.
- **`--env-file-if-exists`.** A missing `.env` would silently fall back to the defaults,
  which is the bug this change fixes.
