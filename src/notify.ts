/**
 * Review notifications for the rewrite queue: Telegram and Slack.
 *
 * WHAT: Sends one plain-text notice to each channel and returns a result per
 *       channel. Never throws.
 * WHY:  The job never pushes, so the forge cannot tell James a rewrite is waiting;
 *       these notices are the only signal (intent Q6). The committed branch is the
 *       outcome and the notices only report it, so one dead channel must not stop
 *       the other, and the caller turns any failure into a nonzero exit (spec R10).
 */

const TELEGRAM_API = "https://api.telegram.org";
const SEND_TIMEOUT_MS = 30 * 1000;
const ERROR_SNIPPET_CHARS = 300;

export interface NotifyEnv {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TELEGRAM_THREAD_ID?: string;
  SLACK_WEBHOOK_URL?: string;
}

export type Channel = "telegram" | "slack";

export type ChannelResult =
  | { channel: Channel; ok: true }
  | { channel: Channel; ok: false; error: string };

// WHAT: Mask every credential value in a piece of error text.
// WHY:  The bot token sits in the Telegram URL and the Slack webhook URL is itself
//       the credential; either can surface in a fetch error or a response body.
function redact(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.slice(0, ERROR_SNIPPET_CHARS);
}

async function post(url: string, body: unknown): Promise<void> {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
}

async function send(
  channel: Channel,
  secrets: Array<string | undefined>,
  run: () => Promise<void>
): Promise<ChannelResult> {
  try {
    await run();
    return { channel, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { channel, ok: false, error: redact(message, secrets) };
  }
}

export async function notifyAll(text: string, env: NotifyEnv): Promise<ChannelResult[]> {
  const secrets = [env.TELEGRAM_BOT_TOKEN, env.SLACK_WEBHOOK_URL];

  const telegram: ChannelResult =
    env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
      ? await send("telegram", secrets, () =>
          post(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: env.TELEGRAM_CHAT_ID,
            ...(env.TELEGRAM_THREAD_ID
              ? { message_thread_id: parseInt(env.TELEGRAM_THREAD_ID, 10) }
              : {}),
            text,
            disable_web_page_preview: true,
          })
        )
      : { channel: "telegram", ok: false, error: "not configured" };

  const slack: ChannelResult = env.SLACK_WEBHOOK_URL
    ? await send("slack", secrets, () => post(env.SLACK_WEBHOOK_URL as string, { text }))
    : { channel: "slack", ok: false, error: "not configured" };

  return [telegram, slack];
}
