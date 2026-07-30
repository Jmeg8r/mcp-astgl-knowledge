/**
 * Tests for the local-vs-published drift instrument.
 *
 * WHAT: Covers the pure delta logic, the alert thresholds, the tar reader, and the
 *       snapshot cache semantics.
 * WHY:  This instrument exists because a previous metric reported motion instead of
 *       divergence and nobody could tell it was wrong (ADR-0001). An instrument
 *       whose own correctness is taken on faith repeats that failure. The cases that
 *       matter most are the ones where a broken run could pass for a clean one:
 *       an unmeasured comparison must NEVER look like a zero delta.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "zlib";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import Database from "better-sqlite3";

import {
  buildPublishGapAlert,
  compareSemver,
  computePublishDrift,
  extractTarMember,
  publishGapAlertKey,
  readLocalPublicState,
  runPublishGapCheck,
  PUBLISH_GAP_CHECK_TYPE,
} from "../src/publish-drift.js";
import type {
  ArtifactState,
  LocalPublicState,
  PublishDrift,
  PublishDriftInput,
  PublishedContent,
  RegistryState,
} from "../src/publish-drift.js";
import { runMigrations, getSnapshot, upsertSnapshot } from "../src/knowledge-db.js";

// --- Fixtures ---

const NOW = new Date("2026-07-30T12:00:00.000Z");

function registry(over: Partial<RegistryState> = {}): RegistryState {
  return {
    version: "1.3.0",
    published_at: "2026-07-30T04:24:36.635Z",
    tarball_url: "https://registry.npmjs.org/x/-/x-1.3.0.tgz",
    shasum: "abc123",
    unpacked_bytes: 75_682_769,
    file_count: 96,
    ...over,
  };
}

function local(over: Partial<LocalPublicState> = {}): LocalPublicState {
  return { public_articles: 178, public_chunks: 1296, total_articles: 471, ...over };
}

function published(over: Partial<PublishedContent> = {}): PublishedContent {
  return {
    articles: 178,
    chunks: 1296,
    shasum: "abc123",
    measured_at: NOW.toISOString(),
    from_cache: false,
    ...over,
  };
}

function drift(over: Partial<PublishDriftInput> = {}): PublishDrift {
  return computePublishDrift({
    package_name: "mcp-astgl-knowledge",
    local_version: "1.3.0",
    local: local(),
    artifact: null,
    registry: registry(),
    published: published(),
    unmeasured_reason: null,
    now: NOW,
    ...over,
  });
}

// --- Minimal tar writer, for exercising the reader ---
// WHY: Building archives byte-by-byte lets the reader be tested against the header
//      variants npm could emit without checking a binary fixture into the repo.
const BLOCK = 512;

function tarHeader(
  name: string,
  size: number,
  typeflag = "0",
  prefix = ""
): Buffer {
  const header = Buffer.alloc(BLOCK);
  header.write(name, 0, 100, "utf8");
  header.write("000644 \0", 100, 8, "utf8");
  header.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "utf8");
  header.write(typeflag, 156, 1, "utf8");
  header.write("ustar\0", 257, 6, "utf8");
  header.write("00", 263, 2, "utf8");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  return header;
}

function tarMember(
  name: string,
  body: Buffer,
  typeflag = "0",
  prefix = ""
): Buffer {
  const padding = Buffer.alloc(
    (BLOCK - (body.length % BLOCK)) % BLOCK
  );
  return Buffer.concat([tarHeader(name, body.length, typeflag, prefix), body, padding]);
}

function tarball(...members: Buffer[]): Buffer {
  return gzipSync(Buffer.concat([...members, Buffer.alloc(BLOCK * 2)]));
}

// --- computePublishDrift ---

describe("computePublishDrift", () => {
  test("reports zero delta when local and published agree", () => {
    const d = drift();
    assert.equal(d.articles_delta, 0);
    assert.equal(d.chunks_delta, 0);
    assert.equal(d.version_state, "in_sync");
    assert.equal(d.content_measured, true);
    assert.equal(d.days_since_last_publish, 0);
  });

  test("compares public-eligible rows, not the whole table", () => {
    // WHY: This is the load-bearing rule. 471 total vs 178 published is the gate
    //      working; only 178-vs-178 is a real comparison. A regression here would
    //      make the instrument alert forever and get muted.
    const d = drift({ local: local({ public_articles: 178, total_articles: 471 }) });
    assert.equal(d.articles_delta, 0);
    assert.equal(d.local_total_articles, 471);
  });

  test("reports a positive delta when local has unpublished content", () => {
    const d = drift({ local: local({ public_articles: 220, public_chunks: 1800 }) });
    assert.equal(d.articles_delta, 42);
    assert.equal(d.chunks_delta, 504);
  });

  test("counts days since the last publish", () => {
    const d = drift({
      registry: registry({ published_at: "2026-04-13T21:14:25.838Z" }),
      now: new Date("2026-07-30T12:00:00.000Z"),
    });
    assert.equal(d.days_since_last_publish, 107);
  });

  test("leaves deltas null when content was not measured", () => {
    // WHY: The single most important case. A null delta is "we could not tell";
    //      a 0 delta is "we checked and it matches". Collapsing the two is the
    //      false-green failure this instrument replaces.
    const d = drift({ published: null, unmeasured_reason: "registry_unreachable" });
    assert.equal(d.content_measured, false);
    assert.equal(d.articles_delta, null);
    assert.equal(d.chunks_delta, null);
    assert.equal(d.published_articles, null);
    assert.equal(d.unmeasured_reason, "registry_unreachable");
  });

  test("reports unknown version state when the registry is unreachable", () => {
    const d = drift({
      registry: null,
      published: null,
      unmeasured_reason: "registry_unreachable",
    });
    assert.equal(d.version_state, "unknown");
    assert.equal(d.published_version, null);
    assert.equal(d.days_since_last_publish, null);
  });

  test("detects a version bump that was never published", () => {
    const d = drift({ local_version: "1.4.0" });
    assert.equal(d.version_state, "local_ahead");
  });

  test("detects a registry ahead of this checkout", () => {
    const d = drift({ local_version: "1.2.0" });
    assert.equal(d.version_state, "local_behind");
  });

  test("flags a staged artifact that no longer matches the working database", () => {
    const artifact: ArtifactState = {
      articles: 170,
      chunks: 1200,
      bytes: 75_042_816,
      built_at: "2026-07-29T00:48:00.000Z",
    };
    const d = drift({ artifact });
    assert.equal(d.artifact_matches_local, false);
    assert.equal(d.artifact_articles, 170);
  });

  test("artifact_matches_local is null when no artifact is staged", () => {
    assert.equal(drift({ artifact: null }).artifact_matches_local, null);
  });
});

// --- buildPublishGapAlert ---

describe("buildPublishGapAlert", () => {
  test("stays silent when local and published agree", () => {
    assert.equal(buildPublishGapAlert(drift()), null);
  });

  test("stays silent for a delta below the threshold", () => {
    const alert = buildPublishGapAlert(drift({ local: local({ public_articles: 181 }) }));
    assert.equal(alert, null);
  });

  test("warns once the article delta crosses the threshold", () => {
    const alert = buildPublishGapAlert(drift({ local: local({ public_articles: 185 }) }));
    assert.ok(alert);
    assert.equal(alert.severity, "warning");
    assert.equal(alert.type, "publish_gap");
    assert.match(alert.title, /7 article\(s\) ready but unpublished/);
  });

  test("escalates to critical on a large delta", () => {
    const alert = buildPublishGapAlert(drift({ local: local({ public_articles: 250 }) }));
    assert.ok(alert);
    assert.equal(alert.severity, "critical");
  });

  test("escalates to critical for a long-stale publish with any drift", () => {
    // The exact failure ADR-0001 documents: months behind, content piled up.
    const alert = buildPublishGapAlert(
      drift({
        local: local({ public_articles: 179 }),
        registry: registry({ published_at: "2026-04-13T21:14:25.838Z" }),
      })
    );
    assert.ok(alert);
    assert.equal(alert.severity, "critical");
    assert.match(alert.details, /107d ago/);
  });

  test("does not fire on age alone when nothing is pending", () => {
    // WHY: A stable package that needs no republish is not a defect. Alerting on
    //      age with a zero delta would train the alert to be ignored.
    const alert = buildPublishGapAlert(
      drift({ registry: registry({ published_at: "2026-01-01T00:00:00.000Z" }) })
    );
    assert.equal(alert, null);
  });

  test("fires on an unpublished version bump even with no content delta", () => {
    const alert = buildPublishGapAlert(drift({ local_version: "1.4.0" }));
    assert.ok(alert);
    assert.match(alert.details, /version bump was prepared and never published/);
  });

  test("does NOT fire when the registry is merely ahead of this checkout", () => {
    // WHY: local_behind is the normal state of any stale branch, fresh clone, or
    //      CI runner — nothing is waiting to be published from here, and unlike an
    //      unreleased bump it does not clear by publishing. Alerting would fire
    //      every run on every non-publishing checkout. Reported, never alerted.
    const d = drift({ local_version: "1.2.0" });
    assert.equal(d.version_state, "local_behind", "the fact is still reported");
    assert.equal(buildPublishGapAlert(d), null);
  });

  test("notes a registry-ahead checkout when some other condition fires", () => {
    const alert = buildPublishGapAlert(
      drift({ local_version: "1.2.0", local: local({ public_articles: 200 }) })
    );
    assert.ok(alert);
    assert.match(alert.details, /is ahead of this checkout/);
    assert.match(alert.details, /measured against a stale package\.json/);
  });

  test("ALWAYS alerts when the comparison could not be made", () => {
    // WHY: Silence on a failed measurement is indistinguishable from silence on a
    //      clean result. The instrument must announce its own blindness.
    const alert = buildPublishGapAlert(
      drift({ published: null, unmeasured_reason: "registry_unreachable" })
    );
    assert.ok(alert);
    assert.equal(alert.severity, "warning");
    assert.match(alert.details, /NOT a clean result/);
    assert.match(alert.details, /could not be reached/);
  });

  test("treats a published tarball with no database as critical", () => {
    // The `npm pack` incident: a tarball shipped with `files` pointing at a
    // missing path, and npm did not complain.
    const alert = buildPublishGapAlert(
      drift({ published: null, unmeasured_reason: "tarball_member_missing" })
    );
    assert.ok(alert);
    assert.equal(alert.severity, "critical");
  });

  test("names the skip reason when measurement was skipped by flag", () => {
    const alert = buildPublishGapAlert(
      drift({ published: null, unmeasured_reason: "measurement_skipped" })
    );
    assert.ok(alert);
    assert.match(alert.details, /--skip-tarball/);
  });
});

// --- publishGapAlertKey ---

describe("publishGapAlertKey", () => {
  test("buckets deltas so a growing gap escalates but does not chatter", () => {
    const at = (n: number) =>
      publishGapAlertKey(drift({ local: local({ public_articles: 178 + n }) }));
    assert.equal(at(6), at(9), "deltas in the same bucket share a key");
    assert.notEqual(at(9), at(12), "crossing a bucket boundary re-fires");
  });

  test("resets when a new version is published", () => {
    const a = publishGapAlertKey(drift());
    const b = publishGapAlertKey(drift({ registry: registry({ version: "1.4.0" }) }));
    assert.notEqual(a, b);
  });

  test("keys unmeasured runs by reason, not by delta", () => {
    const key = publishGapAlertKey(
      drift({ published: null, unmeasured_reason: "tarball_unreachable" })
    );
    assert.equal(key, "publish-gap-unmeasured-tarball_unreachable");
  });
});

// --- compareSemver ---

describe("compareSemver", () => {
  test("orders released versions", () => {
    assert.equal(compareSemver("1.3.0", "1.3.0"), 0);
    assert.equal(compareSemver("1.4.0", "1.3.0"), 1);
    assert.equal(compareSemver("1.3.0", "1.4.0"), -1);
    assert.equal(compareSemver("2.0.0", "1.99.99"), 1);
    assert.equal(compareSemver("1.3.1", "1.3.0"), 1);
  });

  test("sorts a prerelease below its own release", () => {
    assert.equal(compareSemver("1.4.0-beta.1", "1.4.0"), -1);
    assert.equal(compareSemver("1.4.0", "1.4.0-beta.1"), 1);
  });

  test("ignores build metadata", () => {
    assert.equal(compareSemver("1.3.0+build.5", "1.3.0"), 0);
  });
});

// --- extractTarMember ---

describe("extractTarMember", () => {
  const TARGET = "package/build/knowledge-public.db";

  test("extracts a member by exact path", () => {
    const body = Buffer.from("SQLite format 3\0payload");
    const archive = tarball(
      tarMember("package/README.md", Buffer.from("# readme")),
      tarMember(TARGET, body)
    );
    assert.deepEqual(extractTarMember(archive, TARGET), body);
  });

  test("returns null when the member is absent", () => {
    // WHY: null here becomes tarball_member_missing → a CRITICAL alert, because a
    //      package that shipped without its database is a real defect.
    const archive = tarball(tarMember("package/README.md", Buffer.from("# readme")));
    assert.equal(extractTarMember(archive, TARGET), null);
  });

  test("preserves exact bytes across a non-block-aligned body", () => {
    const body = Buffer.from([0x00, 0xff, 0x10, 0x7f, 0x01]);
    const archive = tarball(tarMember(TARGET, body));
    assert.deepEqual(extractTarMember(archive, TARGET), body);
  });

  test("joins the ustar prefix field for long paths", () => {
    const body = Buffer.from("deep");
    const archive = tarball(
      tarMember("knowledge-public.db", body, "0", "package/build")
    );
    assert.deepEqual(extractTarMember(archive, TARGET), body);
  });

  test("honours a PAX path override", () => {
    const body = Buffer.from("pax-body");
    const record = `${`  path=${TARGET}\n`.length} path=${TARGET}\n`;
    const archive = tarball(
      tarMember("PaxHeader/junk", Buffer.from(record), "x"),
      tarMember("junk-short-name", body)
    );
    assert.deepEqual(extractTarMember(archive, TARGET), body);
  });

  test("honours a GNU long name record", () => {
    const body = Buffer.from("gnu-body");
    const archive = tarball(
      tarMember("././@LongLink", Buffer.from(`${TARGET}\0`), "L"),
      tarMember("junk-short-name", body)
    );
    assert.deepEqual(extractTarMember(archive, TARGET), body);
  });

  test("skips directory entries with the target name", () => {
    const body = Buffer.from("real");
    const archive = tarball(
      tarMember(TARGET, Buffer.alloc(0), "5"),
      tarMember(TARGET, body)
    );
    assert.deepEqual(extractTarMember(archive, TARGET), body);
  });

  test("throws on a header with an unparseable size", () => {
    const header = tarHeader(TARGET, 0);
    header.write("NOTOCTAL\0\0\0\0", 124, 12, "utf8");
    const archive = gzipSync(Buffer.concat([header, Buffer.alloc(BLOCK * 2)]));
    assert.throws(() => extractTarMember(archive, TARGET), /unparseable size/);
  });

  test("throws when a member claims to extend past the archive", () => {
    const header = tarHeader(TARGET, 4096);
    const archive = gzipSync(Buffer.concat([header, Buffer.alloc(BLOCK)]));
    assert.throws(() => extractTarMember(archive, TARGET), /past end of archive/);
  });
});

// --- Database-backed behaviour ---

describe("snapshot cache semantics", () => {
  function withDb(fn: (db: InstanceType<typeof Database>) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "astgl-drift-test-"));
    const db = new Database(join(dir, "k.db"));
    try {
      // WHY: Seed only the base tables ingest.ts creates, then apply the REAL
      //      migrations. Re-declaring ecosystem_snapshots here would be a second
      //      copy of the schema — the drift this change removes.
      db.exec(`
        CREATE TABLE articles (
          url TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT
        );
        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          article_url TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);
      runMigrations(db);
      fn(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("migration adds the metrics column", () => {
    withDb((db) => {
      const cols = (
        db.prepare("PRAGMA table_info(ecosystem_snapshots)").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      assert.ok(cols.includes("metrics"));
    });
  });

  test("migrations are idempotent", () => {
    withDb((db) => {
      assert.doesNotThrow(() => runMigrations(db));
      assert.doesNotThrow(() => runMigrations(db));
    });
  });

  test("stores and reads back a measurement", () => {
    withDb((db) => {
      upsertSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "pkg", "1.3.0", '{"articles":178}');
      const snap = getSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "pkg");
      assert.equal(snap?.current_version, "1.3.0");
      assert.equal(snap?.metrics, '{"articles":178}');
    });
  });

  test("preserves metrics when re-checking the same version", () => {
    withDb((db) => {
      upsertSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "pkg", "1.3.0", '{"articles":178}');
      upsertSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "pkg", "1.3.0");
      assert.equal(
        getSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "pkg")?.metrics,
        '{"articles":178}'
      );
    });
  });

  test("CLEARS metrics when the published version changes", () => {
    // WHY: npm versions are immutable, so metrics are only valid for the version
    //      they were measured against. Carrying 1.3.0's counts forward under 1.4.0
    //      would report a stale number wearing a fresh label — the exact class of
    //      false reading this instrument exists to catch.
    withDb((db) => {
      upsertSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "pkg", "1.3.0", '{"articles":178}');
      upsertSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "pkg", "1.4.0");
      const snap = getSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "pkg");
      assert.equal(snap?.metrics, null);
      assert.equal(snap?.previous_version, "1.3.0");
      assert.equal(snap?.current_version, "1.4.0");
    });
  });

  test("does not disturb the ecosystem rows freshness.ts writes", () => {
    withDb((db) => {
      upsertSnapshot(db, "npm_version", "@modelcontextprotocol/sdk", "1.12.1");
      upsertSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "pkg", "1.3.0", '{"articles":1}');
      assert.equal(
        getSnapshot(db, "npm_version", "@modelcontextprotocol/sdk")?.current_version,
        "1.12.1"
      );
    });
  });
});

// --- Failure-reason wiring (regression cover) ---
// WHY: The pure-alert tests above hand-construct a drift object with the reason
//      ALREADY set, so they verify the shape and never the wiring. That gap let a
//      real defect through: the reason was derived by substring-matching the thrown
//      message, and the match never fired, so `tarball_member_missing` was
//      unreachable and a database-less package downgraded from critical to warning.
//      These tests drive runPublishGapCheck through a stubbed registry so the
//      error → reason → severity path is exercised for real.

describe("failure reasons survive the round trip", () => {
  const TARGET = "package/build/knowledge-public.db";

  // WHY: async-aware — a synchronous `finally` would close the database before the
  //      awaited callback resolved, and every assertion would fail on a closed
  //      connection rather than on what it was actually testing.
  async function withFixtureDb<T>(
    fn: (db: InstanceType<typeof Database>) => Promise<T>
  ): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), "astgl-drift-wire-"));
    const db = new Database(join(dir, "k.db"));
    try {
      db.exec(`
        CREATE TABLE articles (url TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          article_url TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);
      runMigrations(db);
      return await fn(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // WHAT: Stand in for the registry, then the tarball CDN.
  // WHY:  runPublishGapCheck makes exactly two calls — packument, then tarball —
  //       so dispatching on the URL covers both legs without a network.
  function stubFetch(handlers: {
    packument?: () => Response;
    tarball?: () => Response;
  }): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(".tgz")) {
        if (!handlers.tarball) throw new Error("unexpected tarball fetch");
        return handlers.tarball();
      }
      if (!handlers.packument) throw new Error("unexpected packument fetch");
      return handlers.packument();
    }) as typeof fetch;
    return () => {
      globalThis.fetch = original;
    };
  }

  function packumentResponse(over: Record<string, unknown> = {}): Response {
    return new Response(
      JSON.stringify({
        "dist-tags": { latest: "1.3.0" },
        time: { "1.3.0": "2026-07-30T04:24:36.635Z" },
        versions: {
          "1.3.0": {
            dist: {
              tarball: "https://registry.npmjs.org/x/-/x-1.3.0.tgz",
              shasum: "abc123",
            },
          },
        },
        ...over,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  test("a tarball with no database is CRITICAL, not a warning", async () => {
    const restore = stubFetch({
      packument: () => packumentResponse(),
      tarball: () =>
        new Response(
          // A tarball carrying only a README — the `npm pack` incident's shape.
          tarball(tarMember("package/README.md", Buffer.from("# readme"))) as unknown as BodyInit,
          { status: 200 }
        ),
    });
    try {
      const { drift: d, alert } = await withFixtureDb((db) =>
        runPublishGapCheck(db)
      );
      assert.equal(d.content_measured, false);
      assert.equal(d.unmeasured_reason, "tarball_member_missing");
      assert.ok(alert);
      assert.equal(alert.severity, "critical");
    } finally {
      restore();
    }
  });

  test("an HTTP error from the registry is registry_unreachable, not no_latest", async () => {
    // WHY: Same channel, wrong diagnosis. A 503 reported as "no latest dist-tag"
    //      sends the reader to look for a publishing mistake that did not happen.
    const restore = stubFetch({
      packument: () => new Response("upstream boom", { status: 503 }),
    });
    try {
      const { drift: d, alert } = await withFixtureDb((db) =>
        runPublishGapCheck(db)
      );
      assert.equal(d.unmeasured_reason, "registry_unreachable");
      assert.ok(alert);
      assert.match(alert.details, /could not be reached/);
    } finally {
      restore();
    }
  });

  test("a 200 with no latest dist-tag really is registry_no_latest", async () => {
    const restore = stubFetch({
      packument: () => packumentResponse({ "dist-tags": {} }),
    });
    try {
      const { drift: d } = await withFixtureDb((db) => runPublishGapCheck(db));
      assert.equal(d.unmeasured_reason, "registry_no_latest");
    } finally {
      restore();
    }
  });

  test("a failed tarball download is tarball_unreachable", async () => {
    const restore = stubFetch({
      packument: () => packumentResponse(),
      tarball: () => new Response("nope", { status: 404 }),
    });
    try {
      const { drift: d, alert } = await withFixtureDb((db) =>
        runPublishGapCheck(db)
      );
      assert.equal(d.unmeasured_reason, "tarball_unreachable");
      assert.ok(alert);
      assert.equal(alert.severity, "warning");
    } finally {
      restore();
    }
  });

  test("a measured run records the version and its metrics", async () => {
    const publishedDb = mkdtempSync(join(tmpdir(), "astgl-drift-pub-"));
    const pubPath = join(publishedDb, "published.db");
    const pub = new Database(pubPath);
    pub.exec(`
      CREATE TABLE articles (url TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        article_url TEXT NOT NULL,
        content TEXT NOT NULL
      );
      INSERT INTO articles (url, title) VALUES ('https://astgl.ai/a', 'A');
      INSERT INTO chunks (article_url, content) VALUES ('https://astgl.ai/a', 'body');
    `);
    pub.close();
    const dbBytes = readFileSync(pubPath);
    rmSync(publishedDb, { recursive: true, force: true });

    const restore = stubFetch({
      packument: () => packumentResponse(),
      tarball: () =>
        new Response(tarball(tarMember(TARGET, dbBytes)) as unknown as BodyInit, {
          status: 200,
        }),
    });
    try {
      await withFixtureDb((db) =>
        runPublishGapCheck(db).then(({ drift: d }) => {
          assert.equal(d.content_measured, true);
          assert.equal(d.published_articles, 1);
          assert.equal(d.published_chunks, 1);
          // Local fixture is empty, so the registry legitimately holds more.
          assert.equal(d.articles_delta, -1);

          const snap = getSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "mcp-astgl-knowledge");
          assert.equal(snap?.current_version, "1.3.0");
          assert.ok(snap?.metrics);
          assert.equal(JSON.parse(snap.metrics).articles, 1);
        })
      );
    } finally {
      restore();
    }
  });

  test("a failed measurement records the version WITHOUT metrics", async () => {
    // WHY: The version must still be recorded so the next run can detect a change,
    //      but attaching no metrics keeps a failed read from inheriting counts.
    const restore = stubFetch({
      packument: () => packumentResponse(),
      tarball: () => new Response("nope", { status: 500 }),
    });
    try {
      await withFixtureDb((db) =>
        runPublishGapCheck(db).then(() => {
          const snap = getSnapshot(db, PUBLISH_GAP_CHECK_TYPE, "mcp-astgl-knowledge");
          assert.equal(snap?.current_version, "1.3.0");
          assert.equal(snap?.metrics, null);
        })
      );
    } finally {
      restore();
    }
  });
});

describe("readLocalPublicState", () => {
  function seed(fn: (db: InstanceType<typeof Database>) => void): void {
    const dir = mkdtempSync(join(tmpdir(), "astgl-drift-local-"));
    const db = new Database(join(dir, "k.db"));
    try {
      db.exec(`
        CREATE TABLE articles (url TEXT PRIMARY KEY, title TEXT NOT NULL);
        CREATE TABLE chunks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          article_url TEXT NOT NULL,
          content TEXT NOT NULL
        );
      `);
      runMigrations(db);
      fn(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("counts only public rows and only their chunks", () => {
    seed((db) => {
      db.prepare("INSERT INTO articles (url, title, public) VALUES (?, ?, 1)").run(
        "https://astgl.ai/a",
        "Public"
      );
      db.prepare("INSERT INTO articles (url, title, public) VALUES (?, ?, 0)").run(
        "https://astgl.ai/draft",
        "Withheld draft"
      );
      const insertChunk = db.prepare(
        "INSERT INTO chunks (article_url, content) VALUES (?, ?)"
      );
      insertChunk.run("https://astgl.ai/a", "public chunk one");
      insertChunk.run("https://astgl.ai/a", "public chunk two");
      insertChunk.run("https://astgl.ai/draft", "withheld chunk");

      const state = readLocalPublicState(db);
      assert.equal(state.public_articles, 1);
      assert.equal(state.public_chunks, 2, "withheld chunks must not be counted");
      assert.equal(state.total_articles, 2);
    });
  });

  test("reports zero public articles on a fully withheld database", () => {
    seed((db) => {
      db.prepare("INSERT INTO articles (url, title, public) VALUES (?, ?, 0)").run(
        "https://astgl.ai/x",
        "Withheld"
      );
      const state = readLocalPublicState(db);
      assert.equal(state.public_articles, 0);
      assert.equal(state.total_articles, 1);
    });
  });
});
