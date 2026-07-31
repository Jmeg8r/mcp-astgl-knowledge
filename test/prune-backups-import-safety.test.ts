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
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { join } from "path";

const REPO_ROOT = join(import.meta.dirname, "..");
const MODULE = join(REPO_ROOT, "src", "prune-backups.ts");
const DATA_DIR = join(REPO_ROOT, "data");

describe("prune-backups entry-point guard", () => {
  test("importing the module returns control and creates nothing", () => {
    const script = `
      import { readdirSync } from "fs";
      const dataDir = ${JSON.stringify(DATA_DIR)};
      const count = () => readdirSync(dataDir).filter((n) => n.includes(".bak.")).length;
      const before = count();
      await import(${JSON.stringify(MODULE)});
      console.log(JSON.stringify({ marker: "RETURNED", created: count() - before }));
    `;

    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      { encoding: "utf8", cwd: REPO_ROOT }
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
  });
});
