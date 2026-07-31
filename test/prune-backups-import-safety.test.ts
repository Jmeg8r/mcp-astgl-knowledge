/**
 * Entry-point guard for the backup pruner.
 *
 * WHAT: Asserts that importing src/prune-backups.ts does not EXECUTE it.
 * WHY:  This lives in its own file, and that is the whole point. The main test file
 *       statically imports the module — so if main() were unguarded it would run and
 *       call process.exit(0) during import, killing the test process before any
 *       assertion inside THAT file could observe anything. Verified by mutation: with
 *       the guard removed, prune-backups.test.ts reports "pass 1" instead of "pass 26",
 *       and no assertion in it ever executes.
 *
 *       Nothing here imports the module at module scope. The check runs in a child
 *       process, so this file survives to fail loudly and name the cause.
 *
 *       The probe is a real FILE, not `--eval`. Under `--eval` the child has no
 *       `process.argv[1]`, so `isEntryPoint` short-circuits on its FIRST condition and
 *       the `import.meta.url === pathToFileURL(argv[1]).href` comparison never runs —
 *       the test would prove only that *a* guard exists, and would pass even if the URL
 *       comparison were wrong. A real script file gives the child a genuine argv[1], so
 *       the comparison is exercised exactly as it is in production.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const REPO_ROOT = join(import.meta.dirname, "..");
const MODULE = join(REPO_ROOT, "src", "prune-backups.ts");
const DATA_DIR = join(REPO_ROOT, "data");

// WHY: a hanging child would block the whole suite with no diagnostic.
const PROBE_TIMEOUT_MS = 60_000;

describe("prune-backups entry-point guard", () => {
  test("importing the module returns control and creates nothing", () => {
    const workDir = mkdtempSync(join(tmpdir(), "astgl-import-probe-"));
    const probePath = join(workDir, "probe.mjs");

    // WHY existsSync in the probe: if data/ is absent a bare readdirSync throws in the
    //      child, spawnSync reports a crash, and the assertion messages below never
    //      report — the failure would surface as an opaque child exit instead of the
    //      diagnostic that names the missing guard.
    writeFileSync(
      probePath,
      [
        'import { existsSync, readdirSync } from "fs";',
        `const dataDir = ${JSON.stringify(DATA_DIR)};`,
        "const count = () =>",
        '  existsSync(dataDir) ? readdirSync(dataDir).filter((n) => n.includes(".bak.")).length : 0;',
        "const before = count();",
        `await import(${JSON.stringify(MODULE)});`,
        'console.log(JSON.stringify({ marker: "RETURNED", created: count() - before }));',
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

      // WHAT: the load-bearing assertion — did main() PRODUCE ANYTHING?
      // WHY:  the two earlier signals were proxies and both have already been
      //       invalidated by unrelated correct changes. "Did control return?" stopped
      //       working when process.exit() was removed (it now returns either way), and
      //       "was a file created?" stopped working when dry runs stopped writing a
      //       checkpoint. Mutation-testing caught the probe passing against an
      //       always-true guard. main()'s banner on stderr and its JSON summary on
      //       stdout are DIRECT evidence it ran, not stand-ins for it.
      assert.ok(
        !err.includes("Backup retention pruner"),
        "main() ran on import — its banner appeared on the child's stderr. " +
          "The isEntryPoint guard in src/prune-backups.ts is not working."
      );
      assert.ok(
        !out.includes('"processed"'),
        "main() ran on import — it emitted a JSON summary on the child's stdout. " +
          "The isEntryPoint guard in src/prune-backups.ts is not working."
      );

      const line = out
        .trim()
        .split("\n")
        .filter((l) => l.includes("RETURNED"))
        .pop();

      assert.ok(
        line,
        "import did not return control — main() ran at module scope and exited the process. " +
          "Restore the isEntryPoint guard in src/prune-backups.ts."
      );
      assert.equal(
        JSON.parse(line).created,
        0,
        "importing the module created a backup file — main() executed on import"
      );
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
