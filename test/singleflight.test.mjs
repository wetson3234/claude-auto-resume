/**
 * Unit tests for lib/singleflight.mjs — run with:  node --test test/
 *
 * Root-cause context: the fallback chain used to schedule several resumes for
 * the SAME sessionId that each fired independently from the poll loop,
 * spawning up to 3 concurrent `claude --resume <sameSessionId>` processes.
 * These tests cover the pure decision logic (lock parsing, liveness gating)
 * that the watcher now uses to serialize resumes per session — no real
 * filesystem or process is touched; `isAlive` is injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  resumeLockPath, parseResumeLock, isResumeInFlight,
} from '../lib/singleflight.mjs';

test('resumeLockPath scopes the lock by sessionId, not by transcript path', () => {
  const a = resumeLockPath('/proj/dir', 'session-aaa');
  const b = resumeLockPath('/proj/dir', 'session-bbb');
  assert.equal(a, path.join('/proj/dir', 'auto-resume.session-aaa.resume.lock'));
  assert.notEqual(a, b, 'different sessions must not share a lock file');
});

test('parseResumeLock: absent/empty content -> null', () => {
  assert.equal(parseResumeLock(undefined), null);
  assert.equal(parseResumeLock(''), null);
  assert.equal(parseResumeLock(null), null);
});
test('parseResumeLock: invalid JSON -> null', () => {
  assert.equal(parseResumeLock('{ not json'), null);
});
test('parseResumeLock: missing/non-numeric pid -> null', () => {
  assert.equal(parseResumeLock(JSON.stringify({})), null);
  assert.equal(parseResumeLock(JSON.stringify({ pid: 'abc' })), null);
});
test('parseResumeLock: valid lock -> {pid, at}', () => {
  assert.deepEqual(parseResumeLock(JSON.stringify({ pid: 4242, at: 1000 })), { pid: 4242, at: 1000 });
});
test('parseResumeLock: missing "at" -> null at', () => {
  assert.deepEqual(parseResumeLock(JSON.stringify({ pid: 4242 })), { pid: 4242, at: null });
});

test('isResumeInFlight: no lock -> false regardless of isAlive', () => {
  assert.equal(isResumeInFlight(undefined, () => true), false);
});
test('isResumeInFlight: lock present, pid alive -> true (the guard that prevents a concurrent spawn)', () => {
  const raw = JSON.stringify({ pid: 123, at: Date.now() });
  assert.equal(isResumeInFlight(raw, (pid) => pid === 123), true);
});
test('isResumeInFlight: lock present, pid dead (stale lock after a crash) -> false', () => {
  const raw = JSON.stringify({ pid: 999, at: Date.now() });
  assert.equal(isResumeInFlight(raw, () => false), false);
});
test('isResumeInFlight: isAlive is called with the exact locked pid', () => {
  const raw = JSON.stringify({ pid: 555 });
  let seen = null;
  isResumeInFlight(raw, (pid) => { seen = pid; return true; });
  assert.equal(seen, 555);
});