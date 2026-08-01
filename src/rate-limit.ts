/**
 * Rate limiting and registration module.
 *
 * WHAT: Enforces per-client daily query limits with public/registered tiers
 * WHY: Protects server resources while incentivizing email registration for higher limits
 *
 * Tiers:
 *   Public:     50 queries/day (anonymous, persistent client ID)
 *   Registered: 500 queries/day (API key via ASTGL_API_KEY env var)
 */

import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { randomUUID, createHash } from "crypto";
import Database from "better-sqlite3";
import { resolveQueryLogDbPath } from "./db-path.js";

const DATA_DIR = join(import.meta.dirname, "..", "data");
const RATE_DB_PATH = resolveQueryLogDbPath();
const CLIENT_ID_FILE = join(homedir(), ".astgl-client-id");

const PUBLIC_LIMIT = 50;
const REGISTERED_LIMIT = 500;

export type Tier = "public" | "registered";

export interface RateLimitResult {
  allowed: boolean;
  tier: Tier;
  clientId: string;
  used: number;
  limit: number;
  remaining: number;
}

export interface RegistrationResult {
  success: boolean;
  apiKey?: string;
  email?: string;
  message: string;
}

let rateLimitDb: InstanceType<typeof Database> | null = null;

// --- Client Identity ---

// WHAT: Get or create a persistent anonymous client ID
// WHY: MCP stdio servers are ephemeral — need a stable ID across sessions for rate limiting
function getOrCreateAnonymousId(): string {
  if (existsSync(CLIENT_ID_FILE)) {
    const id = readFileSync(CLIENT_ID_FILE, "utf-8").trim();
    if (id) return id;
  }

  const id = `anon_${randomUUID()}`;
  try {
    writeFileSync(CLIENT_ID_FILE, id, "utf-8");
  } catch {
    // WHAT: Fall back to hostname-based ID if file write fails
    // WHY: Some environments restrict home directory writes (containers, CI)
    return `anon_${createHash("sha256").update(homedir()).digest("hex").slice(0, 16)}`;
  }
  return id;
}

// WHAT: Resolve the effective client ID and tier
// WHY: API key takes precedence over anonymous ID; determines rate limit tier
export function resolveClient(): { clientId: string; tier: Tier } {
  const apiKey = process.env.ASTGL_API_KEY;

  if (apiKey && apiKey.startsWith("astgl_")) {
    // Validate API key against registrations
    if (rateLimitDb) {
      const reg = rateLimitDb
        .prepare("SELECT email FROM registrations WHERE api_key = ?")
        .get(apiKey) as { email: string } | undefined;

      if (reg) {
        return { clientId: apiKey, tier: "registered" };
      }
    }
    // Invalid key — fall through to anonymous
    console.error(`Warning: ASTGL_API_KEY provided but not found in registrations.`);
  }

  return { clientId: getOrCreateAnonymousId(), tier: "public" };
}

// --- Rate Limiting ---

export function initRateLimitDb(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

  // WHAT: Reuse query-log.db for rate limit tracking
  // WHY: Query counts are already there — just need a registrations table
  rateLimitDb = new Database(RATE_DB_PATH);

  // WHAT: Pin WAL here too — this module can be the one that creates the file.
  // WHY:  initRateLimitDb() and initQueryLog() open the same database and either
  //       can run first against a path where it does not exist yet. Full
  //       rationale in query-log.ts's initQueryLog().
  rateLimitDb.pragma("journal_mode = WAL");

  // Ensure query_log table exists (may not if server hasn't been used yet)
  rateLimitDb.exec(`
    CREATE TABLE IF NOT EXISTS query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      client_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      query_params TEXT NOT NULL,
      content_cited TEXT,
      response_time_ms INTEGER NOT NULL,
      confidence_score REAL
    )
  `);

  rateLimitDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_query_log_ts ON query_log(timestamp)"
  );
  rateLimitDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_query_log_tool ON query_log(tool_name)"
  );
  rateLimitDb.exec(
    "CREATE INDEX IF NOT EXISTS idx_query_log_client ON query_log(client_id)"
  );

  rateLimitDb.exec(`
    CREATE TABLE IF NOT EXISTS registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      api_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )
  `);
}

// --- Rate Limit Cache ---
// WHAT: Cache rate limit results for 5 seconds per client
// WHY: At 500 queries/day (~1 every 3 min), a 5s cache has zero practical
//      accuracy impact but eliminates a COUNT(*) query from most requests
const RATE_CACHE_TTL_MS = 5_000;
const rateLimitCache = new Map<
  string,
  { result: RateLimitResult; expiry: number }
>();

// WHAT: Check if a client has queries remaining today
// WHY: Enforces tier-based daily limits without blocking the server
export function checkRateLimit(clientId: string, tier: Tier): RateLimitResult {
  const limit = tier === "registered" ? REGISTERED_LIMIT : PUBLIC_LIMIT;

  if (!rateLimitDb) {
    return { allowed: true, tier, clientId, used: 0, limit, remaining: limit };
  }

  // Check cache first
  const cacheKey = `${clientId}:${tier}`;
  const cached = rateLimitCache.get(cacheKey);
  if (cached && cached.expiry > Date.now()) {
    return cached.result;
  }

  // WHAT: Count queries for this client today (UTC)
  // WHY: Daily reset at midnight UTC keeps limits predictable
  const today = new Date().toISOString().split("T")[0];
  const todayStart = `${today}T00:00:00.000Z`;
  const tomorrowStart = `${today}T23:59:59.999Z`;

  const row = rateLimitDb
    .prepare(
      `SELECT COUNT(*) as count FROM query_log
       WHERE client_id = ? AND timestamp >= ? AND timestamp <= ?`
    )
    .get(clientId, todayStart, tomorrowStart) as { count: number };

  const used = row.count;
  const remaining = Math.max(0, limit - used);

  const result: RateLimitResult = {
    allowed: used < limit,
    tier,
    clientId,
    used,
    limit,
    remaining,
  };

  rateLimitCache.set(cacheKey, {
    result,
    expiry: Date.now() + RATE_CACHE_TTL_MS,
  });

  return result;
}

// WHAT: Format a rate limit exceeded message for the AI client
// WHY: Clear messaging helps the AI explain the situation and suggest registration
export function rateLimitMessage(result: RateLimitResult): string {
  if (result.tier === "public") {
    return [
      `Rate limit exceeded: ${result.used}/${result.limit} queries used today (public tier).`,
      "",
      "To get 500 queries/day, register with your email using the `register` tool.",
      "Then add the API key to your MCP config as ASTGL_API_KEY.",
      "",
      "Rate limits reset at midnight UTC.",
    ].join("\n");
  }

  return [
    `Rate limit exceeded: ${result.used}/${result.limit} queries used today (registered tier).`,
    "",
    "Rate limits reset at midnight UTC.",
  ].join("\n");
}

// --- Registration ---

// WHAT: Register an email and generate an API key
// WHY: Email capture builds an audience; API key enables higher rate limits
export function registerClient(email: string): RegistrationResult {
  if (!rateLimitDb) {
    return { success: false, message: "Registration database not available." };
  }

  // Basic email validation
  if (!email || !email.includes("@") || !email.includes(".")) {
    return { success: false, message: "Please provide a valid email address." };
  }

  const normalized = email.trim().toLowerCase();

  // Check if already registered
  const existing = rateLimitDb
    .prepare("SELECT api_key FROM registrations WHERE email = ?")
    .get(normalized) as { api_key: string } | undefined;

  if (existing) {
    return {
      success: true,
      apiKey: existing.api_key,
      email: normalized,
      message: `Already registered. Your API key: ${existing.api_key}`,
    };
  }

  // Generate API key
  const apiKey = `astgl_${randomUUID().replace(/-/g, "")}`;

  rateLimitDb
    .prepare(
      "INSERT INTO registrations (email, api_key, created_at) VALUES (?, ?, ?)"
    )
    .run(normalized, apiKey, new Date().toISOString());

  return {
    success: true,
    apiKey,
    email: normalized,
    message: [
      `Registered successfully! Your API key: ${apiKey}`,
      "",
      "Add it to your MCP server config to unlock 500 queries/day:",
      "",
      '```json',
      '"env": { "ASTGL_API_KEY": "' + apiKey + '" }',
      '```',
    ].join("\n"),
  };
}

export function closeRateLimitDb(): void {
  if (rateLimitDb) {
    rateLimitDb.close();
    rateLimitDb = null;
  }
}
