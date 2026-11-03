/**
 * Tests for the Telegram and Slack review notifications.
 *
 * WHAT: Stubs fetch and checks each channel's request, independent failure, the
 *       not-configured case, and redaction of credentials in error text.
 * WHY:  The branch is the outcome and the notices only report it (spec R9, R10): one
 *       dead channel must not stop the other, and a failure must be recorded, never
 *       swallowed. The bot token and the webhook URL are themselves credentials, so
 *       neither may appear in an error that reaches a log.
 *
 * Run with: npm test   (node:test via tsx — no test framework dependency)
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { notifyAll, type NotifyEnv } from "../src/notify.js";

const ENV: NotifyEnv = {
  TELEGRAM_BOT_TOKEN: "123456:SECRET-TELEGRAM-TOKEN",
  TELEGRAM_CHAT_ID: "-100200300",
  TELEGRAM_THREAD_ID: "42",
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/T000/B000/SECRETPART",
};

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

const realFetch = globalThis.fetch;
let seen: Seen[] = [];
let failHost: string | null = null;
let throwHost: string | null = null;

beforeEach(() => {
  seen = [];
  failHost = null;
  throwHost = null;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const host = new URL(url).hostname;
    if (host === throwHost) throw new Error(`connect ECONNREFUSED while calling ${url}`);
    seen.push({ url, body: JSON.parse(String(init?.body)) });
    if (host === failHost) return new Response(`bad request for ${url}`, { status: 400 });
    return new Response(host === "hooks.slack.com" ? "ok" : '{"ok":true}', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("notifyAll", () => {
  test("sends the same text to Telegram and Slack", async () => {
    const results = await notifyAll("Rewrite ready", ENV);
    assert.deepEqual(results, [
      { channel: "telegram", ok: true },
      { channel: "slack", ok: true },
    ]);
    assert.equal(seen[0].url, "https://api.telegram.org/bot123456:SECRET-TELEGRAM-TOKEN/sendMessage");
    assert.deepEqual(seen[0].body, {
      chat_id: "-100200300",
      message_thread_id: 42,
      text: "Rewrite ready",
      disable_web_page_preview: true,
    });
    assert.equal(seen[1].url, ENV.SLACK_WEBHOOK_URL);
    assert.deepEqual(seen[1].body, { text: "Rewrite ready" });
  });

  test("a failing channel does not stop the other and is recorded", async () => {
    failHost = "api.telegram.org";
    const results = await notifyAll("Rewrite ready", ENV);
    assert.equal(results[0].ok, false);
    assert.deepEqual(results[1], { channel: "slack", ok: true });
    assert.equal(seen.length, 2);
  });

  test("an unconfigured channel fails without a request", async () => {
    const { SLACK_WEBHOOK_URL: _unused, ...withoutSlack } = ENV;
    const results = await notifyAll("Rewrite ready", withoutSlack);
    assert.deepEqual(results[1], { channel: "slack", ok: false, error: "not configured" });
    assert.equal(seen.length, 1);
  });

  test("credentials never appear in recorded errors", async () => {
    failHost = "api.telegram.org";
    throwHost = "hooks.slack.com";
    const results = await notifyAll("Rewrite ready", ENV);
    const errors = results.map((r) => (r.ok ? "" : r.error)).join("\n");
    assert.ok(errors.length > 0);
    assert.ok(!errors.includes("SECRET-TELEGRAM-TOKEN"), errors);
    assert.ok(!errors.includes("SECRETPART"), errors);
    assert.ok(errors.includes("[redacted]"), errors);
  });
});
