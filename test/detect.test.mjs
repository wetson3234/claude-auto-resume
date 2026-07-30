/**
 * Unit tests for lib/detect.mjs â€” run with:  node --test test/
 *
 * The first case is the EXACT message from a real incident (2026-07-28) where
 * the previous regex ("session|usage|rate limit" only) failed to match
 * "weekly limit" and no auto-resume happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isLimitText, parseResetSpec, limitEventOf, recordModel,
  nextOccurrence, modelTier, nextFallbackTier, DEFAULT_FALLBACK_CHAIN,
  resolveFallbackEnabled, isNewEpisode, shouldNotifyLimitDetected,
} from '../lib/detect.mjs';

const TZ = 'Europe/Brussels';

// ---------------------------------------------------------------------------
// Limit-phrase detection
// ---------------------------------------------------------------------------
const MUST_MATCH = [
  "You've hit your weekly limit · resets 8pm (Europe/Brussels)", // real incident, 2026-07-28
  "You've hit your session limit · resets 6:50pm (Europe/Brussels)",
  "You've hit your session limit · resets 18:50",
  "You've hit your usage limit · resets 12:10pm (Europe/Brussels)",
  "You've hit your rate limit",
  "You've hit your 5-hour limit · resets 11:30am",
  "You've hit your five-hour limit · resets 3am",
  "You've hit your daily limit · resets at 8pm (America/New_York)",
  "You've hit your monthly limit",
  'You have reached your usage limit',
  'Claude usage limit reached',
  'You are out of usage credits',
  'Limite de session atteinte',
  "Limite d'utilisation atteinte · réinitialisation à 20h05 (Europe/Paris)",
  'Limite hebdomadaire atteinte',
  'Vous avez atteint votre limite',
];
const MUST_NOT_MATCH = [
  'The speed limit on this road is 120 km/h',
  'We should limit the number of retries',
  'rate limiting middleware added to the API',
  'the limit of a sequence in calculus',
];

for (const msg of MUST_MATCH) {
  test(`detects limit: "${msg.slice(0, 60)}"`, () => {
    assert.equal(isLimitText(msg), true);
  });
}
for (const msg of MUST_NOT_MATCH) {
  test(`ignores non-limit: "${msg.slice(0, 60)}"`, () => {
    assert.equal(isLimitText(msg), false);
  });
}

// ---------------------------------------------------------------------------
// Reset-time parsing (DYNAMIC â€” hour/minute/tz all come from the message)
// ---------------------------------------------------------------------------
const RESET_CASES = [
  ["You've hit your weekly limit · resets 8pm (Europe/Brussels)", { h: 20, min: 0, tz: TZ }],
  ["You've hit your session limit · resets 6:50pm (Europe/Brussels)", { h: 18, min: 50, tz: TZ }],
  ["resets 18:50", { h: 18, min: 50, tz: 'LOCAL' }],
  ["resets at 3am (America/New_York)", { h: 3, min: 0, tz: 'America/New_York' }],
  ["resets 12:50am (Europe/Brussels)", { h: 0, min: 50, tz: TZ }],
  ["resets 12:10pm (Europe/Brussels)", { h: 12, min: 10, tz: TZ }],
  ["réinitialisation à 20h05 (Europe/Paris)", { h: 20, min: 5, tz: 'Europe/Paris' }],
  ["resets 11:30am", { h: 11, min: 30, tz: 'LOCAL' }],
];
for (const [msg, want] of RESET_CASES) {
  test(`parses reset time: "${msg.slice(0, 60)}"`, () => {
    const got = parseResetSpec(msg, 'LOCAL');
    assert.ok(got, 'expected a parsed reset spec');
    assert.equal(got.h, want.h);
    assert.equal(got.min, want.min);
    assert.equal(got.tz, want.tz);
  });
}

test('parses weekday-qualified reset', () => {
  const got = parseResetSpec('resets Thu 8pm (Europe/Brussels)', 'LOCAL');
  assert.ok(got);
  assert.deepEqual([got.h, got.min, got.weekday], [20, 0, 'Thu']);
});

test('limit without parsable time yields null spec (caller retries hourly)', () => {
  assert.equal(parseResetSpec("You've hit your rate limit", 'LOCAL'), null);
});

// ---------------------------------------------------------------------------
// Real-event gating: only assistant records with isApiErrorMessage trigger
// ---------------------------------------------------------------------------
const LIMIT_MSG = "You've hit your weekly limit · resets 8pm (Europe/Brussels)";
test('assistant error record IS a limit event', () => {
  const line = JSON.stringify({
    type: 'assistant', isApiErrorMessage: true,
    message: { model: '<synthetic>', content: [{ type: 'text', text: LIMIT_MSG }] },
  });
  const ev = limitEventOf(line, TZ);
  assert.ok(ev, 'expected an event');
  assert.deepEqual([ev.reset.h, ev.reset.min, ev.reset.tz], [20, 0, TZ]);
});
test('user record QUOTING the phrase is NOT an event', () => {
  const line = JSON.stringify({ type: 'user', message: { content: `the error was: ${LIMIT_MSG}` } });
  assert.equal(limitEventOf(line, TZ), null);
});
test('normal assistant record mentioning the phrase is NOT an event', () => {
  const line = JSON.stringify({
    type: 'assistant', message: { model: 'claude-fable-5', content: [{ type: 'text', text: `I saw "${LIMIT_MSG}" in the log` }] },
  });
  assert.equal(limitEventOf(line, TZ), null);
});

// ---------------------------------------------------------------------------
// Target computation â€” reproduce the real incident
// ---------------------------------------------------------------------------
test('incident replay: limit at 05:03:58Z, resets 8pm Brussels -> 18:00 UTC same day', () => {
  // 2026-07-28 is CEST (UTC+2): 20:00 Europe/Brussels == 18:00 UTC.
  const now = Date.parse('2026-07-28T05:03:58Z');
  const target = nextOccurrence(20, 0, TZ, null, now);
  assert.equal(new Date(target).toISOString(), '2026-07-28T18:00:00.000Z');
});
test('reset just passed (<=20 min ago) -> resume ~2 min from now', () => {
  const now = Date.parse('2026-07-28T18:05:00Z'); // 20:05 Brussels, reset was 20:00
  const target = nextOccurrence(20, 0, TZ, null, now);
  assert.equal(target, now + 2 * 60000);
});
test('24h-format reset in local tz resolves within 25h', () => {
  const now = Date.parse('2026-07-28T05:00:00Z');
  const target = nextOccurrence(18, 50, TZ, null, now);
  assert.equal(new Date(target).toISOString(), '2026-07-28T16:50:00.000Z'); // 18:50 CEST
});
test('weekday-qualified target lands on the right weekday', () => {
  const now = Date.parse('2026-07-28T05:00:00Z'); // a Tuesday
  const target = nextOccurrence(20, 0, TZ, 'Thu', now);
  assert.equal(new Date(target).toISOString(), '2026-07-30T18:00:00.000Z'); // Thursday 20:00 CEST
});

// ---------------------------------------------------------------------------
// Model fallback chain
// ---------------------------------------------------------------------------
test('model id -> tier', () => {
  assert.equal(modelTier('claude-fable-5'), 'fable');
  assert.equal(modelTier('claude-opus-4-8'), 'opus');
  assert.equal(modelTier('claude-sonnet-4-5'), 'sonnet');
  assert.equal(modelTier('<synthetic>'), null);
});
test('fallback: fable -> opus -> sonnet -> exhausted', () => {
  assert.equal(nextFallbackTier('fable', DEFAULT_FALLBACK_CHAIN, []), 'opus');
  assert.equal(nextFallbackTier('opus', DEFAULT_FALLBACK_CHAIN, []), 'sonnet');
  assert.equal(nextFallbackTier('sonnet', DEFAULT_FALLBACK_CHAIN, []), null);
  assert.equal(nextFallbackTier('fable', DEFAULT_FALLBACK_CHAIN, ['opus']), 'sonnet');
  assert.equal(nextFallbackTier('fable', DEFAULT_FALLBACK_CHAIN, ['opus', 'sonnet']), null);
});
test('unknown current tier starts fallback at the top of the chain', () => {
  assert.equal(nextFallbackTier(null, DEFAULT_FALLBACK_CHAIN, []), 'opus');
});
test('transcript model extraction', () => {
  assert.equal(recordModel(JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5' } })), 'claude-fable-5');
  assert.equal(recordModel(JSON.stringify({ type: 'assistant', isApiErrorMessage: true, message: { model: '<synthetic>' } })), null);
  assert.equal(recordModel(JSON.stringify({ type: 'user', message: {} })), null);
});

// ---------------------------------------------------------------------------
// Investigation finding (2026-07-30): top-tier-specific vs generic limits are
// NOT distinguishable from the message text — no real message names a model.
// This is a receipts test: if a future incident ever adds a model name to the
// corpus above, this test forces a conscious re-evaluation of that finding.
// ---------------------------------------------------------------------------
test('real limit messages never name a model tier (proves the text cannot distinguish top-tier-specific vs generic limits)', () => {
  const modelWords = /\b(fable|opus|sonnet|haiku)\b/i;
  for (const msg of MUST_MATCH) {
    assert.equal(modelWords.test(msg), false, `unexpected model mention in: "${msg}"`);
  }
});

// ---------------------------------------------------------------------------
// Fallback opt-in resolution — default OFF (wait for reset), never a silent
// automatic switch. See resolveFallbackEnabled doc comment for the rationale.
// ---------------------------------------------------------------------------
test('fallback resolution: no flags, no env -> off by default', () => {
  assert.equal(resolveFallbackEnabled({}), false);
  assert.equal(resolveFallbackEnabled({ noFallbackFlag: false, fallbackFlag: false, envValue: '' }), false);
});
test('fallback resolution: --fallback opts in', () => {
  assert.equal(resolveFallbackEnabled({ fallbackFlag: true }), true);
});
test('fallback resolution: AUTO_RESUME_FALLBACK opts in (case-insensitive, several spellings)', () => {
  for (const v of ['1', 'on', 'ON', 'true', 'True', 'yes']) {
    assert.equal(resolveFallbackEnabled({ envValue: v }), true, `expected "${v}" to opt in`);
  }
});
test('fallback resolution: unrecognized/empty env value stays off', () => {
  for (const v of ['', '0', 'off', 'false', 'nope', undefined]) {
    assert.equal(resolveFallbackEnabled({ envValue: v }), false, `expected "${v}" to stay off`);
  }
});
test('fallback resolution: --no-fallback always wins, even over --fallback', () => {
  assert.equal(resolveFallbackEnabled({ noFallbackFlag: true, fallbackFlag: true }), false);
});
test('fallback resolution: --no-fallback always wins, even over an enabling env var', () => {
  assert.equal(resolveFallbackEnabled({ noFallbackFlag: true, envValue: '1' }), false);
});

// ---------------------------------------------------------------------------
// Episode continuation vs new episode — gates re-notification and tier reset
// ---------------------------------------------------------------------------
test('isNewEpisode: no prior episode -> new', () => {
  assert.equal(isNewEpisode(null, Date.now()), true);
});
test('isNewEpisode: prior episode still open (now before resetAt) -> not new', () => {
  const now = 1_000_000;
  assert.equal(isNewEpisode({ resetAt: now + 1 }, now), false);
});
test('isNewEpisode: prior episode resetAt exactly now -> not new (strict >)', () => {
  const now = 1_000_000;
  assert.equal(isNewEpisode({ resetAt: now }, now), false);
});
test('isNewEpisode: prior episode resetAt already passed -> new', () => {
  const now = 1_000_000;
  assert.equal(isNewEpisode({ resetAt: now - 1 }, now), true);
});

// ---------------------------------------------------------------------------
// Notification gating — one per real event, not one per re-scan
// ---------------------------------------------------------------------------
test('shouldNotifyLimitDetected: new episode, no fallback -> notify', () => {
  assert.equal(shouldNotifyLimitDetected(true, null), true);
});
test('shouldNotifyLimitDetected: re-detected episode, no fallback escalation -> silent', () => {
  assert.equal(shouldNotifyLimitDetected(false, null), false);
});
test('shouldNotifyLimitDetected: re-detected episode WITH a fallback escalation -> notify', () => {
  assert.equal(shouldNotifyLimitDetected(false, 'opus'), true);
});
test('shouldNotifyLimitDetected: new episode with fallback -> notify', () => {
  assert.equal(shouldNotifyLimitDetected(true, 'opus'), true);
});
