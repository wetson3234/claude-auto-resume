/**
 * Unit tests for lib/notify.mjs — run with:  node --test test/notify.test.mjs
 *
 * No network is ever touched: fetch and the clock are injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadNotifyConfig, createNotifier, defaultConfigPath,
  formatLimitDetected, formatResumeStarted, formatResumeFinished, formatClock,
  DEDUP_WINDOW_MS,
} from '../lib/notify.mjs';

const TOKEN = '000000:TEST-FAKE-TOKEN';
const CONFIG = { telegram: { botToken: TOKEN, chatId: '42' } };

/** fetch mock capturing calls; answers HTTP 200 unless told otherwise. */
function fetchMock({ ok = true, status = 200, fail = false } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    if (fail) throw new Error(`fetch failed for ${url}`);
    return { ok, status };
  };
  return { calls, impl };
}

// ---------------------------------------------------------------------------
// Config loading — absent/invalid config MUST disable everything (no-op)
// ---------------------------------------------------------------------------
function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-test-'));
  const file = path.join(dir, 'notify.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

test('absent config file -> null (notifications disabled)', () => {
  assert.equal(loadNotifyConfig(tmpFile(undefined)), null);
});
test('invalid JSON -> null', () => {
  assert.equal(loadNotifyConfig(tmpFile('{ not json')), null);
});
test('missing telegram section -> null', () => {
  assert.equal(loadNotifyConfig(tmpFile('{"slack": {"webhook": "x"}}')), null);
});
test('missing botToken or chatId -> null', () => {
  assert.equal(loadNotifyConfig(tmpFile('{"telegram": {"botToken": "x"}}')), null);
  assert.equal(loadNotifyConfig(tmpFile('{"telegram": {"chatId": "1"}}')), null);
  assert.equal(loadNotifyConfig(tmpFile('{"telegram": {"botToken": "", "chatId": "1"}}')), null);
});
test('valid config -> normalized strings', () => {
  const got = loadNotifyConfig(tmpFile(JSON.stringify({ telegram: { botToken: ' x ', chatId: 42 } })));
  assert.deepEqual(got, { telegram: { botToken: 'x', chatId: '42' } });
});
test('default config path lives under ~/.claude/auto-resume', () => {
  assert.equal(defaultConfigPath(), path.join(os.homedir(), '.claude', 'auto-resume', 'notify.json'));
});

test('null config -> disabled notifier that never calls fetch', async () => {
  const { calls, impl } = fetchMock();
  const n = createNotifier(null, { fetchImpl: impl });
  assert.equal(n.enabled, false);
  assert.equal(await n.notify('anything'), false);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Message formatting
// ---------------------------------------------------------------------------
test('formatClock renders HH:MM in the given timezone', () => {
  // 2026-07-28T18:05:00Z == 20:05 in Brussels (CEST, UTC+2)
  assert.equal(formatClock(Date.parse('2026-07-28T18:05:00Z'), 'Europe/Brussels'), '20:05');
});
test('limit-detected message, no fallback', () => {
  const msg = formatLimitDetected({ resetAt: Date.parse('2026-07-28T18:05:00Z'), tz: 'Europe/Brussels' });
  assert.equal(msg, '⛔ Claude limit hit — resume scheduled at 20:05 (Europe/Brussels)');
});
test('limit-detected message, with model fallback', () => {
  const msg = formatLimitDetected({
    resetAt: Date.parse('2026-07-28T18:05:00Z'), tz: 'Europe/Brussels', fallbackModel: 'opus',
  });
  assert.equal(msg, '⛔ Claude limit hit — resume scheduled at 20:05 (Europe/Brussels) [model fallback: opus]');
});
test('resume-started message shortens the session id', () => {
  assert.equal(formatResumeStarted('c22f02b1-119f-4f57-84f7-9e054075ef9e', 'opus'),
    '▶️ Resuming session c22f02b1 (opus)');
  assert.equal(formatResumeStarted('c22f02b1-119f-4f57-84f7-9e054075ef9e', null),
    '▶️ Resuming session c22f02b1 (original model)');
});
test('resume-finished messages', () => {
  assert.equal(formatResumeFinished(0), '✅ Resume finished');
  assert.equal(formatResumeFinished(3), '❌ Resume failed (exit 3)');
});

// ---------------------------------------------------------------------------
// Sending — Telegram API call shape
// ---------------------------------------------------------------------------
test('notify posts to the Bot API with chat_id and text', async () => {
  const { calls, impl } = fetchMock();
  const n = createNotifier(CONFIG, { fetchImpl: impl });
  assert.equal(n.enabled, true);
  assert.equal(await n.notify('hello'), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.telegram.org/bot${TOKEN}/sendMessage`);
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { chat_id: '42', text: 'hello' });
});

// ---------------------------------------------------------------------------
// Anti-spam dedup — same event within 60 s -> one send
// ---------------------------------------------------------------------------
test('same message within the dedup window is sent once', async () => {
  let t = 1_000_000;
  const { calls, impl } = fetchMock();
  const n = createNotifier(CONFIG, { fetchImpl: impl, now: () => t });
  assert.equal(await n.notify('⛔ limit'), true);
  t += 30_000; // 30 s later: duplicate
  assert.equal(await n.notify('⛔ limit'), false);
  assert.equal(calls.length, 1);
  t += DEDUP_WINDOW_MS; // past the window: sends again
  assert.equal(await n.notify('⛔ limit'), true);
  assert.equal(calls.length, 2);
});
test('different messages inside the window are all sent', async () => {
  let t = 1_000_000;
  const { calls, impl } = fetchMock();
  const n = createNotifier(CONFIG, { fetchImpl: impl, now: () => t });
  await n.notify('⛔ limit');
  t += 1000;
  await n.notify('▶️ resuming');
  assert.equal(calls.length, 2);
});

// ---------------------------------------------------------------------------
// Best-effort — failures never throw, and never leak the token
// ---------------------------------------------------------------------------
test('network failure -> resolves false, never throws, logs without the token', async () => {
  const logs = [];
  const { impl } = fetchMock({ fail: true });
  const n = createNotifier(CONFIG, { fetchImpl: impl, log: (m) => logs.push(m) });
  assert.equal(await n.notify('hello'), false); // no throw
  assert.equal(logs.length, 1);
  assert.match(logs[0], /telegram notify failed/);
  assert.ok(!logs[0].includes(TOKEN), 'bot token must never appear in logs');
});
test('HTTP error -> resolves false and logs the status', async () => {
  const logs = [];
  const { impl } = fetchMock({ ok: false, status: 403 });
  const n = createNotifier(CONFIG, { fetchImpl: impl, log: (m) => logs.push(m) });
  assert.equal(await n.notify('hello'), false);
  assert.match(logs[0], /HTTP 403/);
});
