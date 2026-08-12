/**
 * Entry-point guard for the citation-test tracker.
 *
 * WHAT: Asserts that importing src/citation-test.ts does not EXECUTE it.
 * WHY:  This lives in its own file, and that is the whole point.
 *       citation-report-errors.test.ts statically imports the module for
 *       buildReport() — so if main() were unguarded it would run at import with no
 *       argv[2], print its usage banner, and call process.exit(1), killing the test
 *       process before a single assertion in THAT file could observe anything. The
 *       suite would go green having proved nothing. Same failure, same remedy, as
 *       prune-backups-import-safety.test.ts.
 *
 *       Nothing here imports the module at module scope. The check runs in a child
 *       process, so this file survives to fail loudly and name the cause.
 *
 *       The probe is a real FILE, not `--eval`. Under `--eval` the child has no
 *       `process.argv[1]`, so `isEntryPoint` short-circuits on its FIRST condition
 *       and the `import.meta.url === pathToFileURL(argv[1]).href` comparison never
 *       runs — the test would prove only that *a* guard exists, and would pass even
 *       if the URL comparison were wrong.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dirname, "..");
const MODULE = join(REPO_ROOT, "src", "citation-test.ts");

// WHY: a hanging child would block the whole suite with no diagnostic.
const PROBE_TIMEOUT_MS = 60_000;

// WHAT: main()'s own output when invoked with no subcommand.
// WHY: DIRECT evidence that main() ran, not a proxy for it. "Did control return?"
//      is not usable here — main() exits the process, so a regression would show up
//      as a dead child rather than a failed assertion.
const USAGE_BANNER = "Usage: npm run citation-test --";

describe("citation-test entry-point guard", () => {
  test("importing the module does not run main()", () => {
    const workDir = mkdtempSync(join(tmpdir(), "astgl-citation-import-probe-"));
    const probePath = join(workDir, "probe.mjs");

    writeFileSync(
      probePath,
      [
        `await import(${JSON.stringify(MODULE)});`,
        'console.log(JSON.stringify({ marker: "RETURNED" }));',
      ].join("\n")
    );

    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", probePath], {
        encoding: "utf8",
        cwd: REPO_ROOT,
        timeout: PROBE_TIMEOUT_MS,
      });
      const out = result.stdout ?? "";
      const err = result.stderr ?? "";

      // WHY: check HOW the child died before interpreting what it printed, so a tsx
      //      loader failure cannot masquerade as a guard regression.
      assert.equal(
        result.error,
        undefined,
        `probe child could not be run (${result.error?.message}) — this is a harness ` +
          "failure, not a guard regression"
      );

      assert.ok(
        !err.includes(USAGE_BANNER),
        "main() ran on import — its usage banner appeared on the child's stderr. " +
          "The isEntryPoint guard in src/citation-test.ts is not working."
      );

      assert.equal(
        result.status,
        0,
        `probe child exited ${result.status} (signal ${result.signal}). stderr:\n${err}`
      );

      assert.ok(
        out.includes("RETURNED"),
        `the probe never reached its marker. stdout:\n${out}\nstderr:\n${err}`
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // WHY this case exists: the test above pins only one half of the guard. A guard
  //      reduced to `const isEntryPoint = false` passes it while silently killing
  //      the CLI for every subcommand — the module would load and do nothing. Both
  //      directions have to be nailed down, or "the guard works" means "the guard
  //      is off". Caught in review of PR #61; the mutation sweep for that PR had
  //      tested `if (true)` and never `if (false)`.
  test("running the module directly still runs main()", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", MODULE], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      timeout: PROBE_TIMEOUT_MS,
    });

    assert.equal(
      result.error,
      undefined,
      `child could not be run (${result.error?.message}) — this is a harness failure`
    );
    assert.ok(
      (result.stderr ?? "").includes(USAGE_BANNER),
      "main() did not run on direct invocation — isEntryPoint is never true, so " +
        "the CLI is dead for every subcommand. stderr:\n" + (result.stderr ?? "")
    );
    // WHY status 1: main() rejects a missing subcommand. Asserting the exit code as
    //      well as the banner distinguishes "main() ran and refused" from "something
    //      else printed something that happened to contain the banner text".
    assert.equal(result.status, 1);
  });
});
