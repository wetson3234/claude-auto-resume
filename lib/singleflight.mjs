/**
 * claude-auto-resume — single-flight resume lock (pure decision logic).
 *
 * Known bug (documented, fixed here): the model-fallback chain could schedule
 * several resumes for the SAME sessionId that each fire independently from the
 * poll loop, spawning up to 3 concurrent `claude --resume <sameSessionId>`
 * processes without ever cancelling or awaiting the one already in flight.
 *
 * This module decides, from a lock file's raw content and an injectable
 * liveness probe, whether a resume is still running for a session — so the
 * watcher can wait for it instead of stacking a new one on top. All I/O (fs,
 * process.kill) stays in watcher.mjs; this file is pure and unit-testable
 * without touching the real filesystem or spawning anything.
 */
import path from 'node:path';

/**
 * Path of the per-session resume lock. Scoped by sessionId (not by the
 * current transcript path) so it keeps working across `--project-dir`
 * switching to a new transcript file for the same logical session.
 */
export function resumeLockPath(dir, sessionId) {
  return path.join(dir, `auto-resume.${sessionId}.resume.lock`);
}

/**
 * Parse a lock file's raw content.
 * @returns {null | {pid: number, at: number|null}} null when absent, empty,
 *   invalid JSON, or missing a numeric pid.
 */
export function parseResumeLock(raw) {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && Number.isFinite(obj.pid)) return { pid: obj.pid, at: Number.isFinite(obj.at) ? obj.at : null };
  } catch { /* absent, empty, or corrupt -> no lock */ }
  return null;
}

/**
 * True when `raw` describes a resume that is still running, per `isAlive`
 * (injectable — real code passes a `process.kill(pid, 0)` probe). A lock
 * referencing a dead pid (stale after a crash) is treated as not in flight.
 * @param {Function} isAlive (pid: number) => boolean
 */
export function isResumeInFlight(raw, isAlive) {
  const lock = parseResumeLock(raw);
  return lock ? Boolean(isAlive(lock.pid)) : false;
}
