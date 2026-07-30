/**
 * Local-vs-published drift instrument.
 *
 * WHAT: Compares what this machine holds as publishable (data/knowledge.db rows
 *       where public = 1, plus the staged build/knowledge-public.db artifact)
 *       against what the npm registry is ACTUALLY serving — the article and chunk
 *       counts read out of the published tarball — and reports the delta plus
 *       days-since-last-publish.
 * WHY:  ADR-0001 closed with roadmap item "close the publish gap": cut a release,
 *       then instrument the local-vs-published delta so it cannot go unread again.
 *       The release shipped (1.3.0, 2026-07-30); this is the instrument.
 *
 *       The design constraint is the ADR's own finding: *"A drift metric that does
 *       not cross the boundary it is meant to police reports motion, not
 *       divergence."* The retired health tile compared the local file's size to its
 *       own history, so it reported churn every night while the published package
 *       sat 3.5 months and 420 articles behind, and nobody could tell. Every headline
 *       number here therefore has one side on this machine and one side on the
 *       registry.
 *
 * Two rules this module will not bend:
 *
 *   1. The local comparator is `public = 1`, never `COUNT(*)`. The publication gate
 *      withholds 293 of 471 rows on purpose; comparing totals would report a
 *      permanent ~293-article "gap" that is the gate working correctly. A metric
 *      that cries wolf forever gets muted, which is how the original gap went unread.
 *   2. A failed measurement is never a zero. If the registry or the tarball cannot
 *      be read, `content_measured` is false and a reason is carried through to the
 *      alert. "In sync" and "could not tell" must not look alike (the fully-failed-run
 *      rule, PR #15).
 *
 * No CLI entry point by design — this is a library. The check runs as part of
 * `npm run freshness` (and `npm run publish-drift`, which scopes freshness to it),
 * reusing that script's alert cooldown and Discord delivery rather than adding a
 * second alerting mechanism.
 */

import Database from "better-sqlite3";
import { gunzipSync } from "zlib";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getSnapshot, upsertSnapshot } from "./knowledge-db.js";

// --- Identity ---

// WHAT: The package whose registry entry is the far side of the boundary.
// WHY:  Read from package.json rather than hardcoded, so a rename cannot leave the
//       instrument silently polling a package nobody publishes any more.
const PACKAGE_JSON_PATH = join(import.meta.dirname, "..", "package.json");
const ARTIFACT_PATH = join(
  import.meta.dirname,
  "..",
  "build",
  "knowledge-public.db"
);

// WHAT: Path of the database inside the published tarball.
// WHY:  npm prefixes every member with `package/`; this mirrors the
//       `files: ["build/knowledge-public.db"]` entry in package.json.
const TARBALL_DB_MEMBER = "package/build/knowledge-public.db";

export const PUBLISH_GAP_CHECK_TYPE = "publish_gap";

// --- Thresholds ---
// WHAT: When a delta stops being normal lag and becomes a gap worth interrupting for.
// WHY:  A release does not follow every article. Small deltas are the healthy steady
//       state; the failure mode being policed is the one that actually happened —
//       months of accumulation nobody noticed.
const ARTICLE_DELTA_WARNING = 5;
const ARTICLE_DELTA_CRITICAL = 25;
const STALE_PUBLISH_DAYS_WARNING = 30;
const STALE_PUBLISH_DAYS_CRITICAL = 90;

// WHAT: Bucket width for the alert dedup key.
// WHY:  Keying the cooldown on the raw delta would re-fire the moment a single
//       article is added. Keying on the version alone would never re-fire as a small
//       gap grew into a large one. Bucketing escalates without chattering.
const DELTA_ALERT_BUCKET = 10;

// --- Network / decompression limits ---
const REGISTRY_TIMEOUT_MS = 15_000;
const TARBALL_TIMEOUT_MS = 120_000;

// WHAT: Ceiling on the decompressed tarball.
// WHY:  gunzip of attacker-influenced bytes is a zip-bomb surface. The real artifact
//       is ~76 MB; this leaves room to grow while bounding a hostile response.
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

// --- tar format constants ---
// WHAT: Field offsets of the POSIX ustar header (one 512-byte block per member).
// WHY:  Extracting one known member from a gzipped tar is ~60 lines of buffer
//       arithmetic. Shelling out to `tar` would mean spawning a process, which this
//       repo just got burned by on win32 (spawn EINVAL, PR #36), and a tar library
//       would be a new dependency for a single call site.
const TAR_BLOCK = 512;
const TAR_NAME_OFFSET = 0;
const TAR_NAME_LEN = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_SIZE_LEN = 12;
const TAR_TYPEFLAG_OFFSET = 156;
const TAR_PREFIX_OFFSET = 345;
const TAR_PREFIX_LEN = 155;

// --- Types ---

export type UnmeasuredReason =
  | "registry_unreachable"
  | "registry_no_latest"
  | "tarball_unreachable"
  | "tarball_member_missing"
  | "tarball_unreadable"
  | "measurement_skipped";

export type VersionState = "in_sync" | "local_ahead" | "local_behind" | "unknown";

export interface RegistryState {
  version: string;
  published_at: string | null;
  tarball_url: string | null;
  shasum: string | null;
  unpacked_bytes: number | null;
  file_count: number | null;
}

export interface LocalPublicState {
  public_articles: number;
  public_chunks: number;
  total_articles: number;
}

export interface ArtifactState {
  articles: number;
  chunks: number;
  bytes: number;
  built_at: string;
}

export interface PublishedContent {
  articles: number;
  chunks: number;
  shasum: string | null;
  measured_at: string;
  from_cache: boolean;
}

export interface PublishDriftInput {
  package_name: string;
  local_version: string;
  local: LocalPublicState;
  artifact: ArtifactState | null;
  registry: RegistryState | null;
  published: PublishedContent | null;
  unmeasured_reason: UnmeasuredReason | null;
  now: Date;
}

export interface PublishDrift {
  package: string;
  local_version: string;
  published_version: string | null;
  published_at: string | null;
  days_since_last_publish: number | null;
  version_state: VersionState;
  local_public_articles: number;
  local_public_chunks: number;
  local_total_articles: number;
  published_articles: number | null;
  published_chunks: number | null;
  articles_delta: number | null;
  chunks_delta: number | null;
  artifact_articles: number | null;
  artifact_built_at: string | null;
  artifact_matches_local: boolean | null;
  content_measured: boolean;
  measurement_from_cache: boolean;
  unmeasured_reason: UnmeasuredReason | null;
}

export interface PublishGapAlert {
  type: "publish_gap";
  severity: "info" | "warning" | "critical";
  title: string;
  details: string;
  data: Record<string, unknown>;
}

// --- Local side ---

// WHAT: Read this repo's declared version.
// WHY:  A version bumped in package.json but never published is itself a publish
//       gap — the release that was prepared and forgotten.
export function readLocalVersion(): { name: string; version: string } {
  const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8")) as {
    name: string;
    version: string;
  };
  return { name: pkg.name, version: pkg.version };
}

// WHAT: Count what the gate WOULD publish from the working database.
// WHY:  `public = 1` is the same predicate build-public-db.ts prunes on, so this is
//       the true near side of the boundary. Chunks are counted through the article
//       join for the same reason — withheld articles' chunks are pruned with them.
export function readLocalPublicState(
  database: InstanceType<typeof Database>
): LocalPublicState {
  const articles = database
    .prepare("SELECT COUNT(*) AS n FROM articles WHERE public = 1")
    .get() as { n: number };
  const chunks = database
    .prepare(
      "SELECT COUNT(*) AS n FROM chunks WHERE article_url IN (SELECT url FROM articles WHERE public = 1)"
    )
    .get() as { n: number };
  const total = database
    .prepare("SELECT COUNT(*) AS n FROM articles")
    .get() as { n: number };

  return {
    public_articles: articles.n,
    public_chunks: chunks.n,
    total_articles: total.n,
  };
}

// WHAT: Counts from the staged build artifact, if one has been built.
// WHY:  Reported as a secondary reading only. The artifact is on THIS side of the
//       boundary: a fresh artifact proves a build ran, never that a publish did.
export function readArtifactState(
  path: string = ARTIFACT_PATH
): ArtifactState | null {
  if (!existsSync(path)) return null;

  let db: InstanceType<typeof Database> | null = null;
  try {
    const stat = statSync(path);
    db = new Database(path, { readonly: true });
    const articles = db
      .prepare("SELECT COUNT(*) AS n FROM articles")
      .get() as { n: number };
    const chunks = db
      .prepare("SELECT COUNT(*) AS n FROM chunks")
      .get() as { n: number };
    return {
      articles: articles.n,
      chunks: chunks.n,
      bytes: stat.size,
      built_at: stat.mtime.toISOString(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  artifact unreadable at ${path}: ${message}`);
    return null;
  } finally {
    db?.close();
  }
}

// --- Published side (crosses the boundary) ---

// WHAT: Ask the registry what `latest` is and where its tarball lives.
// WHY:  The abbreviated packument keeps the response small; `time` for the publish
//       date is only on the full document, so both are needed.
export async function fetchRegistryState(
  packageName: string,
  timeoutMs = REGISTRY_TIMEOUT_MS
): Promise<RegistryState | null> {
  const encoded = packageName.replace("/", "%2f");
  const resp = await fetch(`https://registry.npmjs.org/${encoded}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    console.error(`  npm registry returned ${resp.status} for ${packageName}`);
    return null;
  }

  const doc = (await resp.json()) as {
    "dist-tags"?: Record<string, string>;
    time?: Record<string, string>;
    versions?: Record<
      string,
      {
        dist?: {
          tarball?: string;
          shasum?: string;
          unpackedSize?: number;
          fileCount?: number;
        };
      }
    >;
  };

  const version = doc["dist-tags"]?.latest;
  if (!version) return null;

  const dist = doc.versions?.[version]?.dist;
  return {
    version,
    published_at: doc.time?.[version] ?? null,
    tarball_url: dist?.tarball ?? null,
    shasum: dist?.shasum ?? null,
    unpacked_bytes: dist?.unpackedSize ?? null,
    file_count: dist?.fileCount ?? null,
  };
}

// WHAT: Pull one member out of a gzipped tar archive.
// WHY:  The published database has to be opened by better-sqlite3, which needs a
//       real file, so the bytes must come out of the tarball first. Handles the
//       ustar `prefix` field and PAX/GNU long-name records because npm may emit
//       them for deep paths, even though today's tarball is plain ustar.
export function extractTarMember(
  gzipped: Buffer,
  memberPath: string
): Buffer | null {
  const tar = gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED_BYTES });

  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);

    // Two consecutive zero blocks terminate the archive; one is enough to stop.
    if (header.every((byte) => byte === 0)) break;

    const rawName = readTarString(header, TAR_NAME_OFFSET, TAR_NAME_LEN);
    const prefix = readTarString(header, TAR_PREFIX_OFFSET, TAR_PREFIX_LEN);
    const typeflag = String.fromCharCode(header[TAR_TYPEFLAG_OFFSET]);

    const sizeText = readTarString(header, TAR_SIZE_OFFSET, TAR_SIZE_LEN).trim();
    const size = sizeText ? parseInt(sizeText, 8) : 0;

    // WHY: A malformed or hostile header could otherwise stall the loop forever or
    //      drive a negative-length subarray.
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`Malformed tar header: unparseable size "${sizeText}"`);
    }

    const dataStart = offset + TAR_BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error("Malformed tar: member extends past end of archive");
    }

    const name = pendingLongName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    pendingLongName = null;

    if (typeflag === "L") {
      // GNU long name: this member's body IS the next member's path.
      pendingLongName = tar
        .subarray(dataStart, dataEnd)
        .toString("utf8")
        .replace(/\0.*$/, "");
    } else if (typeflag === "x" || typeflag === "g") {
      // PAX extended header: "<len> path=<value>\n" records.
      const pax = tar.subarray(dataStart, dataEnd).toString("utf8");
      const match = pax.match(/\d+ path=(.*?)\n/);
      if (match) pendingLongName = match[1];
    } else if ((typeflag === "0" || typeflag === "\0") && name === memberPath) {
      return tar.subarray(dataStart, dataEnd);
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }

  return null;
}

function readTarString(header: Buffer, offset: number, length: number): string {
  return header
    .subarray(offset, offset + length)
    .toString("utf8")
    .replace(/\0.*$/, "");
}

// WHAT: Download the published tarball and count what its database really holds.
// WHY:  This is the only reading that genuinely crosses the boundary. Registry
//       metadata (unpackedSize, fileCount) is a proxy; article counts are the thing
//       the ADR asked to be able to compare.
export async function measurePublishedContent(
  tarballUrl: string,
  timeoutMs = TARBALL_TIMEOUT_MS
): Promise<Omit<PublishedContent, "shasum" | "from_cache">> {
  const resp = await fetch(tarballUrl, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`tarball fetch returned ${resp.status}`);
  }

  const gzipped = Buffer.from(await resp.arrayBuffer());
  const dbBytes = extractTarMember(gzipped, TARBALL_DB_MEMBER);
  if (!dbBytes) {
    // WHY: A published package with no database is a real defect worth surfacing —
    //      exactly the `npm pack` incident CLAUDE.md records, where a 145 kB tarball
    //      shipped with the `files` entry pointing at a missing path.
    throw new Error(`published tarball has no ${TARBALL_DB_MEMBER}`);
  }

  // WHY: better-sqlite3 opens paths, not buffers, so the extracted bytes are staged
  //      in a temp dir and removed in `finally` even on a throw.
  const workDir = mkdtempSync(join(tmpdir(), "astgl-publish-drift-"));
  const dbPath = join(workDir, "published.db");
  let db: InstanceType<typeof Database> | null = null;

  try {
    writeFileSync(dbPath, dbBytes);
    db = new Database(dbPath, { readonly: true });
    const articles = db
      .prepare("SELECT COUNT(*) AS n FROM articles")
      .get() as { n: number };
    const chunks = db
      .prepare("SELECT COUNT(*) AS n FROM chunks")
      .get() as { n: number };
    return {
      articles: articles.n,
      chunks: chunks.n,
      measured_at: new Date().toISOString(),
    };
  } finally {
    db?.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}

// --- Version comparison ---

// WHAT: Compare two semver strings; -1 / 0 / 1.
// WHY:  Only needed to answer "is the repo ahead of the registry?". A dependency for
//       that would be disproportionate, and the repo hand-rolls its own arg parsing
//       for the same reason. Build metadata is ignored; a prerelease sorts below its
//       own release, which is all the precision this comparison needs.
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre = ""] = v.replace(/\+.*$/, "").split("-", 2);
    const nums = core.split(".").map((n) => parseInt(n, 10) || 0);
    return { nums, pre };
  };

  const left = parse(a);
  const right = parse(b);

  for (let i = 0; i < 3; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

// --- The delta (pure) ---

// WHAT: Turn the gathered readings into the drift report.
// WHY:  Pure and side-effect free so every branch — in sync, behind, unmeasured,
//       registry ahead — is unit-testable without a network or a database. The
//       instrument's own correctness is the thing that must not be taken on faith.
export function computePublishDrift(input: PublishDriftInput): PublishDrift {
  const { registry, published, local, artifact } = input;

  const daysSince =
    registry?.published_at != null
      ? Math.floor(
          (input.now.getTime() - new Date(registry.published_at).getTime()) /
            (1000 * 60 * 60 * 24)
        )
      : null;

  let versionState: VersionState = "unknown";
  if (registry) {
    const cmp = compareSemver(input.local_version, registry.version);
    versionState = cmp === 0 ? "in_sync" : cmp > 0 ? "local_ahead" : "local_behind";
  }

  return {
    package: input.package_name,
    local_version: input.local_version,
    published_version: registry?.version ?? null,
    published_at: registry?.published_at ?? null,
    days_since_last_publish: daysSince,
    version_state: versionState,
    local_public_articles: local.public_articles,
    local_public_chunks: local.public_chunks,
    local_total_articles: local.total_articles,
    published_articles: published?.articles ?? null,
    published_chunks: published?.chunks ?? null,
    articles_delta: published ? local.public_articles - published.articles : null,
    chunks_delta: published ? local.public_chunks - published.chunks : null,
    artifact_articles: artifact?.articles ?? null,
    artifact_built_at: artifact?.built_at ?? null,
    // WHAT: Does the staged artifact still reflect the working database?
    // WHY:  A mismatch means the next publish would ship yesterday's build. Local
    //       vs local, so it is a supporting reading and never the headline.
    artifact_matches_local: artifact
      ? artifact.articles === local.public_articles
      : null,
    content_measured: published != null,
    measurement_from_cache: published?.from_cache ?? false,
    unmeasured_reason: input.unmeasured_reason,
  };
}

// --- Alerting (pure) ---

const UNMEASURED_EXPLANATION: Record<UnmeasuredReason, string> = {
  registry_unreachable: "the npm registry could not be reached",
  registry_no_latest: "the registry returned no `latest` dist-tag",
  tarball_unreachable: "the published tarball could not be downloaded",
  tarball_member_missing:
    "the published tarball contains no build/knowledge-public.db — the package may have shipped without its database",
  tarball_unreadable: "the published database could not be opened",
  measurement_skipped: "measurement was skipped (--skip-tarball) and no cached reading exists for this version",
};

// WHAT: Decide whether this drift deserves a human's attention, and how loudly.
// WHY:  Separated from computePublishDrift so thresholds can be tested against
//       fabricated drift objects rather than against a live registry.
export function buildPublishGapAlert(drift: PublishDrift): PublishGapAlert | null {
  // WHY: A blind instrument must announce itself. Silence here would be
  //      indistinguishable from "no drift" — the false green this repo has been
  //      bitten by repeatedly.
  if (!drift.content_measured) {
    const reason = drift.unmeasured_reason ?? "registry_unreachable";
    return {
      type: "publish_gap",
      severity:
        reason === "tarball_member_missing" ? "critical" : "warning",
      title: `Publish-gap check could not measure ${drift.package}`,
      details: [
        `The local-vs-published comparison did not run: ${UNMEASURED_EXPLANATION[reason]}.`,
        "",
        `**Local version:** ${drift.local_version}`,
        `**Published version:** ${drift.published_version ?? "unknown"}`,
        drift.days_since_last_publish != null
          ? `**Days since last publish:** ${drift.days_since_last_publish}`
          : "**Days since last publish:** unknown",
        `**Local public-eligible articles:** ${drift.local_public_articles}`,
        "",
        "This is NOT a clean result — the gap is unknown, not zero.",
        "Action: re-run `npm run publish-drift` once connectivity is restored.",
      ].join("\n"),
      data: { ...drift, unmeasured_reason: reason },
    };
  }

  const articlesDelta = drift.articles_delta ?? 0;
  const daysSince = drift.days_since_last_publish;

  // WHAT: Only a POSITIVE delta — local ahead of the registry — is a publish gap.
  // WHY:  A negative delta means the published package holds more than this
  //       checkout does, which is the normal state of any fresh clone or CI
  //       runner: data/knowledge.db is tracked in git at a much older revision
  //       than the live file on James's machine. Alerting on it would fire on
  //       every clone and teach the alert to be ignored. The number is still
  //       reported in the JSON summary, where a real local content loss would
  //       show up as a large negative on the machine that actually publishes.
  const contentGap = articlesDelta >= ARTICLE_DELTA_WARNING;
  const unreleasedBump = drift.version_state === "local_ahead";
  const registryAhead = drift.version_state === "local_behind";
  const staleWithDrift =
    daysSince != null && daysSince >= STALE_PUBLISH_DAYS_WARNING && articlesDelta > 0;

  if (!contentGap && !unreleasedBump && !registryAhead && !staleWithDrift) {
    return null;
  }

  const critical =
    articlesDelta >= ARTICLE_DELTA_CRITICAL ||
    (daysSince != null && daysSince >= STALE_PUBLISH_DAYS_CRITICAL && articlesDelta > 0);

  const headline = registryAhead
    ? `${drift.package}: registry is AHEAD of this checkout (${drift.published_version} published, ${drift.local_version} local)`
    : `${drift.package}: ${articlesDelta} article(s) ready but unpublished` +
      (daysSince != null ? `, ${daysSince}d since last release` : "");

  return {
    type: "publish_gap",
    severity: critical ? "critical" : "warning",
    title: headline,
    details: [
      `**Published:** ${drift.published_version} on ${drift.published_at ?? "unknown date"}` +
        (daysSince != null ? ` (${daysSince}d ago)` : ""),
      `**Local package.json:** ${drift.local_version} (${drift.version_state.replace("_", " ")})`,
      "",
      `**Articles:** ${drift.local_public_articles} publishable locally vs ${drift.published_articles} published → **${formatDelta(articlesDelta)}**`,
      `**Chunks:** ${drift.local_public_chunks} vs ${drift.published_chunks} → **${formatDelta(drift.chunks_delta ?? 0)}**`,
      drift.artifact_articles != null
        ? `**Staged artifact:** ${drift.artifact_articles} articles, built ${drift.artifact_built_at}` +
          (drift.artifact_matches_local === false
            ? " — STALE vs the working database, rebuild before publishing"
            : "")
        : "**Staged artifact:** not built",
      "",
      unreleasedBump
        ? `Note: package.json is at ${drift.local_version} but the registry serves ${drift.published_version} — a version bump was prepared and never published.`
        : "",
      registryAhead
        ? "Note: the registry is ahead of this checkout. Someone published from elsewhere, or this branch is behind main."
        : "",
      "",
      "Action: run `npm publish` (prepack re-runs build → reclassify → prune), or",
      "record why the gap is intentional.",
    ]
      .filter(Boolean)
      .join("\n"),
    data: { ...drift },
  };
}

function formatDelta(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

// WHAT: Dedup key for the alert cooldown.
// WHY:  Includes the published version so a fresh release resets the clock, and a
//       bucketed delta so a growing gap escalates instead of staying suppressed
//       under the key that already fired.
export function publishGapAlertKey(drift: PublishDrift): string {
  if (!drift.content_measured) {
    return `publish-gap-unmeasured-${drift.unmeasured_reason ?? "unknown"}`;
  }
  const bucket =
    Math.floor((drift.articles_delta ?? 0) / DELTA_ALERT_BUCKET) * DELTA_ALERT_BUCKET;
  return `publish-gap-${drift.published_version}-${bucket}`;
}

// --- Orchestration ---

interface CachedMetrics {
  articles: number;
  chunks: number;
  shasum: string | null;
  measured_at: string;
}

// WHAT: Reuse a previous measurement when it provably describes the same bytes.
// WHY:  npm versions are immutable — a published version can never be replaced with
//       different content — so a measurement keyed by version stays true forever.
//       The shasum is compared as well so an unexpected mismatch forces a re-read
//       rather than trusting the cache on the version string alone.
function readCachedMeasurement(
  database: InstanceType<typeof Database>,
  packageName: string,
  registry: RegistryState
): PublishedContent | null {
  const snapshot = getSnapshot(database, PUBLISH_GAP_CHECK_TYPE, packageName);
  if (!snapshot || snapshot.current_version !== registry.version || !snapshot.metrics) {
    return null;
  }

  try {
    const cached = JSON.parse(snapshot.metrics) as CachedMetrics;
    if (typeof cached.articles !== "number" || typeof cached.chunks !== "number") {
      return null;
    }
    if (registry.shasum && cached.shasum && cached.shasum !== registry.shasum) {
      console.error("  cached measurement shasum differs from registry — re-measuring");
      return null;
    }
    return {
      articles: cached.articles,
      chunks: cached.chunks,
      shasum: cached.shasum,
      measured_at: cached.measured_at,
      from_cache: true,
    };
  } catch {
    return null;
  }
}

export interface PublishGapResult {
  drift: PublishDrift;
  alert: PublishGapAlert | null;
}

// WHAT: Run the whole check against a live registry and the working database.
// WHY:  Every failure mode degrades to a REPORTED unknown rather than a thrown
//       exception or a fabricated zero, so the caller always gets a drift object it
//       can print and alert on.
export async function runPublishGapCheck(
  database: InstanceType<typeof Database>,
  options: { skipTarball?: boolean } = {}
): Promise<PublishGapResult> {
  const { name, version } = readLocalVersion();
  const local = readLocalPublicState(database);
  const artifact = readArtifactState();

  let registry: RegistryState | null = null;
  let published: PublishedContent | null = null;
  let reason: UnmeasuredReason | null = null;

  try {
    registry = await fetchRegistryState(name);
    if (!registry) reason = "registry_no_latest";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  registry poll failed for ${name}: ${message}`);
    reason = "registry_unreachable";
  }

  if (registry) {
    published = readCachedMeasurement(database, name, registry);

    if (!published && options.skipTarball) {
      reason = "measurement_skipped";
    } else if (!published) {
      if (!registry.tarball_url) {
        reason = "tarball_unreachable";
      } else {
        try {
          const measured = await measurePublishedContent(registry.tarball_url);
          published = { ...measured, shasum: registry.shasum, from_cache: false };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`  published measurement failed: ${message}`);
          reason = message.includes("no build/knowledge-public.db")
            ? "tarball_member_missing"
            : message.includes("fetch returned")
              ? "tarball_unreachable"
              : "tarball_unreadable";
        }
      }
    }

    // WHY: Record the version even when measurement failed, so the next run can
    //      still detect a version change. upsertSnapshot clears metrics on a version
    //      change, so a failed measurement never inherits the previous release's
    //      counts.
    const metrics: CachedMetrics | null = published
      ? {
          articles: published.articles,
          chunks: published.chunks,
          shasum: published.shasum,
          measured_at: published.measured_at,
        }
      : null;
    upsertSnapshot(
      database,
      PUBLISH_GAP_CHECK_TYPE,
      name,
      registry.version,
      metrics ? JSON.stringify(metrics) : null
    );
  }

  const drift = computePublishDrift({
    package_name: name,
    local_version: version,
    local,
    artifact,
    registry,
    published,
    unmeasured_reason: published ? null : reason,
    now: new Date(),
  });

  return { drift, alert: buildPublishGapAlert(drift) };
}
