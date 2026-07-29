/**
 * claude-auto-resume — optional Telegram notifications.
 *
 * Strictly OPT-IN: the watcher reads `~/.claude/auto-resume/notify.json`
 * (outside the repo). If the file is absent or invalid, notifications are a
 * complete no-op and the watcher behaves exactly as before.
 *
 * Config format (placeholders — never commit real values):
 *   {
 *     "telegram": { "botToken": "123456:ABC-your-bot-token", "chatId": "123456789" }
 *   }
 *
 * Design rules:
 *   - Best-effort: a network failure (or any error) must NEVER break the
 *     watcher — every send is wrapped, failures are logged and swallowed.
 *   - Anti-spam: identical events within a 60 s window are sent once.
 *   - No secrets in logs: the bot token is scrubbed from error messages.
 *
 * Pure logic (formatting, dedup) is separated from I/O so it is unit-testable
 * with an injected fetch/clock.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEDUP_WINDOW_MS = 60_000;

/** Default config location: ~/.claude/auto-resume/notify.json */
export function defaultConfigPath() {
  return path.join(os.homedir(), '.claude', 'auto-resume', 'notify.json');
}

/**
 * Load the opt-in notification config.
 * @returns {null | {telegram: {botToken: string, chatId: string}}}
 *   null when the file is absent, unreadable, invalid JSON, or incomplete —
 *   the caller treats null as "notifications disabled".
 */
export function loadNotifyConfig(configPath = defaultConfigPath()) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const t = cfg?.telegram;
    const token = typeof t?.botToken === 'string' ? t.botToken.trim() : '';
    const chatId = t?.chatId === 0 || t?.chatId ? String(t.chatId).trim() : '';
    if (token && chatId) return { telegram: { botToken: token, chatId } };
  } catch { /* absent or invalid -> disabled */ }
  return null;
}

// ---------------------------------------------------------------------------
// Message formatting (pure)
// ---------------------------------------------------------------------------

/** "HH:MM" wall-clock of epoch-ms `at` in IANA timezone `tz` (local if invalid). */
export function formatClock(at, tz) {
  const opts = { hour12: false, hour: '2-digit', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }).format(new Date(at));
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).format(new Date(at));
  }
}

/**
 * (a) Limit detected.
 * @param {{resetAt: number, tz: string, fallbackModel?: string|null}} info
 */
export function formatLimitDetected({ resetAt, tz, fallbackModel = null }) {
  const base = `⛔ Claude limit hit — resume scheduled at ${formatClock(resetAt, tz)} (${tz})`;
  return fallbackModel ? `${base} [model fallback: ${fallbackModel}]` : base;
}

/** (b) Resume launched. */
export function formatResumeStarted(sessionId, model = null) {
  const shortId = String(sessionId || '').slice(0, 8);
  return `▶️ Resuming session ${shortId} (${model || 'original model'})`;
}

/** (c) Resume finished OK/KO. */
export function formatResumeFinished(exitCode) {
  return exitCode === 0
    ? '✅ Resume finished'
    : `❌ Resume failed (exit ${exitCode})`;
}

// ---------------------------------------------------------------------------
// Notifier
// ---------------------------------------------------------------------------

/**
 * Build a notifier from a loaded config.
 *
 * @param {null | {telegram: {botToken: string, chatId: string}}} config
 * @param {object} [deps] injectable for tests
 * @param {Function} [deps.fetchImpl] fetch-compatible function
 * @param {Function} [deps.now] clock returning epoch ms
 * @param {Function} [deps.log] logger for best-effort failures
 * @param {number}   [deps.dedupWindowMs]
 * @returns {{enabled: boolean, notify: (text: string) => Promise<boolean>}}
 *   `notify` resolves true only when the message was actually sent and the
 *   Telegram API answered ok. It NEVER throws.
 */
export function createNotifier(config, {
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = () => {},
  dedupWindowMs = DEDUP_WINDOW_MS,
} = {}) {
  const tg = config?.telegram;
  if (!tg?.botToken || !tg?.chatId) {
    return { enabled: false, notify: async () => false };
  }

  const lastSent = new Map(); // message text -> epoch ms of last send
  const scrub = (s) => String(s).split(tg.botToken).join('<token>');

  async function notify(text) {
    try {
      const t = now();
      const prev = lastSent.get(text);
      if (prev !== undefined && t - prev < dedupWindowMs) return false; // dedup
      lastSent.set(text, t);
      // Drop stale entries so the map cannot grow unbounded.
      for (const [k, ts] of lastSent) if (t - ts >= dedupWindowMs && k !== text) lastSent.delete(k);

      const res = await fetchImpl(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: tg.chatId, text }),
      });
      if (!res.ok) {
        log(`telegram notify failed: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (e) {
      // Best-effort by contract: a notification failure never breaks the watcher.
      log(`telegram notify failed: ${scrub(e?.message || e)}`);
      return false;
    }
  }

  return { enabled: true, notify };
}
