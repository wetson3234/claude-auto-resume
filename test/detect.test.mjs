/**
 * Unit tests for lib/detect.mjs — run with:  node --test test/
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
// Reset-time parsing (DYNAMIC — hour/minute/tz all come from the message)
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
// Target computation — reproduce the real incident
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
