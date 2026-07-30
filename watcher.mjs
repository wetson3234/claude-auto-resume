#!/usr/bin/env node
/**
 * claude-auto-resume — watcher.mjs
 *
 * Watches a Claude Code session transcript (.jsonl) for usage-limit errors like:
 *   "You've hit your session limit . resets 6:50pm (Europe/Brussels)"
 *   "You've hit your weekly limit . resets 8pm (Europe/Brussels)"
 * Parses the reset time DYNAMICALLY (12h/24h, optional IANA timezone, DST-safe),
 * waits until reset + delay, then resumes the session with `claude --resume` so
 * interrupted background agents pick their work back up.
 *
 * Reliability model (designed after a real overnight failure):
 *   - REAL events only: triggers on assistant records flagged `isApiErrorMessage`,
 *     never on messages that merely quote the limit phrase.
 *   - Sleep/reboot-proof: no long setTimeout. Pending resumes are persisted to a
 *     state file and fired by a short poll loop comparing wall-clock time, so a
 *     PC sleep, a wake, or a watcher restart never loses a scheduled resume.
 *   - Catch-up scan on startup: if the watcher starts AFTER the limit killed the
 *     session (e.g. relaunched by a scheduled task post-reboot), it scans the
 *     transcript tail, sees the session died on a limit, and schedules/resumes.
 *   - Single instance: a PID lockfile prevents duplicate watchers.
 *   - Model fallback (opt-in, OFF by default): the real limit messages never
 *     name a model or say whether the exhausted bar is specific to the
 *     top-tier model vs a generic daily/weekly allowance shared across tiers
 *     — that distinction is NOT observable from the transcript text (see
 *     lib/detect.mjs). So the safe default is to WAIT for the reset; pass
 *     --fallback (or set AUTO_RESUME_FALLBACK=1) to explicitly opt into
 *     stepping down the tier chain (e.g. fable -> opus -> sonnet) instead,
 *     accepting that risk. The reset-time resume always stays scheduled too,
 *     as the safety net that restores the original model once the limit clears.
 *   - Single-flight resumes: at most one `claude --resume <sessionId>` process
 *     in flight per session at a time (lib/singleflight.mjs). A due schedule
 *     that would spawn a second concurrent resume for the same session waits
 *     instead of stacking on top of the one still running — this is what
 *     used to produce up to 3 concurrent resume processes for one session.
 *   - Optional Telegram notifications (opt-in): if ~/.claude/auto-resume/notify.json
 *     exists, key events (limit detected, resume launched, resume finished) are
 *     pushed via the Telegram Bot API — one per REAL event (a new limit
 *     episode, an actual tier escalation, a real spawn), never one per re-scan
 *     of an already-known, still-open outage. Best-effort, deduplicated, never
 *     fatal.
 *
 * Pure Node.js, zero dependencies, no AI involved.
 *
 * Usage:
 *   node watcher.mjs --transcript <path/to/session.jsonl> [--cwd <projectCwd>]
 *                    [--delay-min 5] [--mode headless|window] [--once]
 *   node watcher.mjs --project-dir <~/.claude/projects/XXX>   (tracks newest .jsonl)
 *   node watcher.mjs --project-dir <dir> --scan-only          (print catch-up decision, exit)
 *
 * Flags:
 *   --dry-run            log what would happen, never spawn `claude`
 *   --scan-only          run the startup catch-up scan, print the decision, exit
 *   --fallback           opt IN to model fallback (default: off — wait for reset)
 *   --no-fallback        force fallback off (wins over --fallback / env)
 *   --fallback-chain a,b,c   override the tier chain (default: fable,opus,sonnet)
 *   --claude-bin <path>  explicit claude binary (else CLAUDE_BIN env, else where/which)
 *   --no-lock            skip the single-instance lockfile
 *
 * Env:
 *   CLAUDE_BIN              claude binary path
 *   AUTO_RESUME_PROMPT      override the resume prompt
 *   AUTO_RESUME_EXTRA_ARGS  extra args appended to the claude command
 *   AUTO_RESUME_FALLBACK    "1"/"on"/"true"/"yes" opts IN to model fallback (default: off)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  limitEventOf, recordModel, nextOccurrence, modelTier, nextFallbackTier,
  DEFAULT_FALLBACK_CHAIN, resolveFallbackEnabled, isNewEpisode, shouldNotifyLimitDetected,
} from './lib/detect.mjs';
import {
  loadNotifyConfig, createNotifier,
  formatLimitDetected, formatResumeStarted, formatResumeFinished,
} from './lib/notify.mjs';
import { resumeLockPath, isResumeInFlight } from './lib/singleflight.mjs';

// ---------- args ----------
const argv = process.argv.slice(2);
function arg(name, def = null) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
}
const has = (name) => argv.includes(`--${name}`);

const PROJECT_DIR = arg('project-dir');
let TRANSCRIPT = arg('transcript');
const CWD = arg('cwd', process.cwd());
const DELAY_MIN = Number(arg('delay-min', '5'));
const MODE = arg('mode', 'headless'); // headless: claude -p ; window: new terminal (win32)
const ONCE = has('once');
const DRY_RUN = has('dry-run');
const SCAN_ONLY = has('scan-only');
const NO_LOCK = has('no-lock');
const FALLBACK_ENABLED = resolveFallbackEnabled({
  noFallbackFlag: has('no-fallback'),
  fallbackFlag: has('fallback'),
  envValue: process.env.AUTO_RESUME_FALLBACK,
});
const FALLBACK_CHAIN = (arg('fallback-chain') || process.env.AUTO_RESUME_FALLBACK_CHAIN || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const CHAIN = FALLBACK_CHAIN.length ? FALLBACK_CHAIN : DEFAULT_FALLBACK_CHAIN;
const POLL_MS = 5000;
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const TAIL_SCAN_BYTES = 512 * 1024; // startup catch-up scan window

/**
 * Claude binary resolution: --claude-bin > CLAUDE_BIN env > `where`/`which`.
 * Lesson from a real incident: assuming `claude.cmd` breaks on native installs
 * (claude.exe) and the resume fails silently. Resolve, never guess.
 */
function findClaudeBin() {
  const explicit = arg('claude-bin') || process.env.CLAUDE_BIN;
  if (explicit) return explicit;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf8' });
  const line = (r.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return line || (process.platform === 'win32' ? 'claude.cmd' : 'claude');
}
const CLAUDE_BIN = findClaudeBin();

const PROMPT = process.env.AUTO_RESUME_PROMPT
  || 'The usage limit has cleared (or a fallback model is available). Resume IMMEDIATELY '
  + 'where the work stopped: restart or resume every interrupted background agent '
  + '(SendMessage with their id when possible), then continue the current mission '
  + 'without waiting for confirmation.';
const EXTRA_ARGS = (process.env.AUTO_RESUME_EXTRA_ARGS || '').split(' ').filter(Boolean);

// ---------- transcript selection ----------
function newestJsonl(dir) {
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return files.length ? path.join(dir, files[0].f) : null;
}
if (!TRANSCRIPT && PROJECT_DIR) TRANSCRIPT = newestJsonl(PROJECT_DIR);
if (!TRANSCRIPT || !fs.existsSync(TRANSCRIPT)) {
  console.error('transcript not found — pass --transcript <file.jsonl> or --project-dir <dir>');
  process.exit(1);
}
const baseDir = () => PROJECT_DIR || path.dirname(TRANSCRIPT);

function log(msg) {
  const line = `[auto-resume ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(baseDir(), 'auto-resume.log'), line + '\n'); } catch { /* best-effort */ }
}

/** OS notification (Windows balloon tip; notify-send on Linux; osascript on macOS). */
function notify(title, message) {
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms;` +
        `$n=New-Object System.Windows.Forms.NotifyIcon;` +
        `$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
        `$n.ShowBalloonTip(15000,'${title.replace(/'/g, "''")}','${message.replace(/'/g, "''")}','Info');` +
        `Start-Sleep 16;$n.Dispose()`;
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps],
        { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `display notification "${message}" with title "${title}"`],
        { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('notify-send', [title, message], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* a notification must never break the watcher */ }
}

/**
 * Optional Telegram notifications — opt-in via ~/.claude/auto-resume/notify.json
 * (outside the repo). File absent => no-op, behavior unchanged. Sends are
 * best-effort and deduplicated (same event within 60 s -> one message).
 */
const telegram = createNotifier(loadNotifyConfig(), { log });

// ---------- single-instance lock ----------
const LOCK_FILE = PROJECT_DIR
  ? path.join(PROJECT_DIR, 'auto-resume.watcher.lock')
  : TRANSCRIPT + '.autoresume.pid';
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
if (!NO_LOCK && !SCAN_ONLY) {
  try {
    const prev = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (prev && prev !== process.pid && pidAlive(prev)) {
      console.log(`[auto-resume] another watcher is already running (pid ${prev}) — exiting`);
      process.exit(0);
    }
  } catch { /* no lock or dead process */ }
  try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch { /* best-effort */ }
  const clean = () => { try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ } };
  process.on('exit', clean);
  process.on('SIGINT', () => { clean(); process.exit(0); });
  process.on('SIGTERM', () => { clean(); process.exit(0); });
}

// ---------- persisted state (survives sleep, reboot, watcher restarts) ----------
const STATE_FILE = PROJECT_DIR
  ? path.join(PROJECT_DIR, 'auto-resume.state.json')
  : TRANSCRIPT + '.autoresume.state.json';
/**
 * state = {
 *   pending:  [{ at: epochMs, model: string|null, reason: string }],
 *   episode:  { detectedAt, resetAt, triedTiers: [] } | null,
 * }
 */
let state = { pending: [], episode: null };
try {
  const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  if (loaded && Array.isArray(loaded.pending)) state = loaded;
} catch { /* fresh state */ }
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Single-flight resume lock (fixes the documented bug: several fallback tiers
// could each spawn their own `claude --resume <sameSessionId>` process without
// cancelling/awaiting the one already in flight — up to 3 concurrent
// processes observed for one session). Scoped by sessionId so it survives
// --project-dir switching to a new transcript for the same logical session.
// ---------------------------------------------------------------------------
function resumeInFlight(sessionId) {
  const lockPath = resumeLockPath(baseDir(), sessionId);
  let raw;
  try { raw = fs.readFileSync(lockPath, 'utf8'); } catch { return false; }
  if (isResumeInFlight(raw, pidAlive)) return true;
  try { fs.unlinkSync(lockPath); } catch { /* stale lock, already gone */ }
  return false;
}
function markResumeInFlight(sessionId, pid) {
  try { fs.writeFileSync(resumeLockPath(baseDir(), sessionId), JSON.stringify({ pid, at: Date.now() })); } catch { /* best-effort */ }
}
function clearResumeInFlight(sessionId) {
  try { fs.unlinkSync(resumeLockPath(baseDir(), sessionId)); } catch { /* already gone */ }
}

function schedule(at, model, reason) {
  // Earliest-wins dedup: an equal-or-later schedule for the same model is a no-op.
  const dup = state.pending.find((p) => (p.model || null) === (model || null) && p.at <= at + 60000);
  if (dup) { log(`schedule(${reason}) skipped — equal/earlier resume already pending`); return; }
  state.pending = state.pending.filter((p) => (p.model || null) !== (model || null));
  state.pending.push({ at, model: model || null, reason });
  state.pending.sort((a, b) => a.at - b.at);
  saveState();
  const when = new Date(at).toLocaleString(undefined, { hour12: false });
  log(`scheduled resume [${reason}] at ${when}${model ? ` (model: ${model})` : ''} (~${Math.max(0, Math.round((at - Date.now()) / 60000))} min)`);
}

// ---------- resume ----------
function resumeSession(model = null) {
  const sessionId = path.basename(TRANSCRIPT, '.jsonl');
  if (resumeInFlight(sessionId)) {
    log(`resume SKIPPED — a resume for session ${sessionId} is already in flight (single-flight guard)`);
    return;
  }
  const modelArgs = model ? ['--model', model] : [];
  if (DRY_RUN) {
    log(`DRY-RUN: would resume session ${sessionId} (cwd=${CWD}, mode=${MODE}${model ? `, model=${model}` : ''})`);
    return;
  }
  log(`RESUME session ${sessionId} (cwd=${CWD}, mode=${MODE}${model ? `, model=${model}` : ''})`);
  telegram.notify(formatResumeStarted(sessionId, model));
  if (MODE === 'window' && process.platform === 'win32') {
    // New interactive terminal window resuming the session with the prompt.
    // NOTE: we cannot track the new terminal's lifetime, so the single-flight
    // lock only guards the headless (automatic, unattended) path below — the
    // one that actually produced the concurrent-process bug.
    const argList = ['--resume', sessionId, ...modelArgs, PROMPT];
    const psList = argList.map((a) => `'${a.replace(/'/g, "''")}'`).join(',');
    const psArgs = ['-NoProfile', '-Command',
      `Start-Process -FilePath claude -WorkingDirectory '${CWD.replace(/'/g, "''")}' -ArgumentList @(${psList})`];
    spawn('powershell.exe', psArgs, { detached: true, stdio: 'ignore' }).unref();
  } else {
    // Headless: the session resumes in the background and restarts its agents.
    const args = ['--resume', sessionId, ...modelArgs, '-p', PROMPT, ...EXTRA_ARGS];
    const out = fs.openSync(path.join(baseDir(), 'auto-resume-run.log'), 'a');
    const child = spawn(CLAUDE_BIN, args, { cwd: CWD, detached: true, stdio: ['ignore', out, out] });
    markResumeInFlight(sessionId, child.pid);
    // A resume failure must NEVER be silent: log + toast + persisted retry.
    child.on('exit', (code) => {
      clearResumeInFlight(sessionId);
      telegram.notify(formatResumeFinished(code));
      if (code === 0) { log('resume finished successfully (exit 0)'); return; }
      log(`resume FAILED (exit ${code}) — see auto-resume-run.log`);
      notify('Claude auto-resume', `Automatic resume FAILED (exit ${code}). Retrying in 5 min.`);
      schedule(Date.now() + 5 * 60000, model, 'retry-after-failure');
    });
    child.on('error', (e) => {
      clearResumeInFlight(sessionId);
      log(`resume spawn FAILED: ${e.message} (bin=${CLAUDE_BIN})`);
      notify('Claude auto-resume', `Could not launch claude (${e.message}).`);
      telegram.notify('Resume failed (could not launch claude)');
    });
  }
}

// ---------- limit-event handling (detection -> schedule and/or fallback) ----------
function currentModelTier() {
  // Scan the transcript tail backwards for the last assistant record with a real model id.
  try {
    const st = fs.statSync(TRANSCRIPT);
    const len = Math.min(TAIL_SCAN_BYTES, st.size);
    const fd = fs.openSync(TRANSCRIPT, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const model = recordModel(lines[i]);
      if (model) return { model, tier: modelTier(model, CHAIN) };
    }
  } catch { /* ignore */ }
  return { model: null, tier: null };
}

function handleLimitEvent(ev, origin) {
  const now = Date.now();
  // Reset-time schedule (the guaranteed path — this is now the DEFAULT and
  // only behavior unless --fallback / AUTO_RESUME_FALLBACK opts in below).
  let resetAt;
  if (ev.reset) {
    resetAt = nextOccurrence(ev.reset.h, ev.reset.min, ev.reset.tz, ev.reset.weekday) + DELAY_MIN * 60000;
    log(`LIMIT detected (${origin}) — reset ${String(ev.reset.h).padStart(2, '0')}:${String(ev.reset.min).padStart(2, '0')} (${ev.reset.tz}${ev.reset.weekday ? `, ${ev.reset.weekday}` : ''})`);
  } else {
    resetAt = now + 60 * 60000; // no parsable time: conservative hourly retry
    log(`LIMIT detected (${origin}) — no parsable reset time, retrying hourly`);
  }

  // Episode bookkeeping (one episode per limit outage). A re-detection of the
  // SAME still-open episode (watcher restart, catch-up scan, or a fresh
  // transcript after a resume that didn't clear the limit) must not re-notify
  // or reset triedTiers — only a genuinely new episode does.
  const isNewEp = isNewEpisode(state.episode, now);
  if (isNewEp) {
    state.episode = { detectedAt: now, resetAt, triedTiers: [] };
  } else {
    state.episode.resetAt = Math.min(state.episode.resetAt, resetAt);
  }

  schedule(resetAt, null, 'reset');
  if (isNewEp) {
    notify('Claude auto-resume', `Limit hit — resume scheduled at ${new Date(resetAt).toLocaleTimeString(undefined, { hour12: false })}.`);
  } else {
    log(`LIMIT re-detected (${origin}) for the same still-open episode — notification suppressed (anti-spam)`);
  }

  // Model fallback: OPT-IN ONLY (see lib/detect.mjs — the limit text never
  // names a model, so we cannot reliably tell "this model's own bar is
  // exhausted" apart from "a generic daily/weekly bar is exhausted"). Default
  // behavior is to wait for the reset; this block is a no-op unless the human
  // explicitly passed --fallback / AUTO_RESUME_FALLBACK=1.
  let fallbackTier = null;
  if (FALLBACK_ENABLED) {
    const { model, tier } = currentModelTier();
    const lastTried = state.episode.triedTiers[state.episode.triedTiers.length - 1] || null;
    const fromTier = lastTried || tier; // after a failed fallback, keep stepping down
    const next = nextFallbackTier(fromTier, CHAIN, state.episode.triedTiers);
    if (next) {
      fallbackTier = next;
      state.episode.triedTiers.push(next);
      saveState();
      log(`model fallback (opt-in): ${model || 'unknown model'} (tier ${fromTier || 'unknown'}) -> ${next} — resuming in 2 min instead of waiting`);
      notify('Claude auto-resume', `Falling back to ${next} — resuming in 2 min instead of waiting for the reset.`);
      schedule(now + 2 * 60000, next, `fallback-${next}`);
    } else if (isNewEp) {
      log('model fallback: chain exhausted — waiting for the reset');
    }
  }
  // One Telegram notification per REAL event: a brand new episode, or an
  // actual tier escalation — never a plain re-scan of an already-known outage.
  if (shouldNotifyLimitDetected(isNewEp, fallbackTier)) {
    telegram.notify(formatLimitDetected({
      resetAt, tz: ev.reset?.tz || LOCAL_TZ, fallbackModel: fallbackTier,
    }));
  }
  saveState();
}

// ---------- startup catch-up scan ----------
/**
 * If the session already died on a limit BEFORE this watcher started (typical
 * after a reboot: the scheduled task relaunches the watcher, but the limit line
 * is already in the transcript), the tail scan finds it. The event only counts
 * if NOTHING meaningful happened after it (otherwise the session was already
 * resumed and the event is stale).
 */
function catchUpScan() {
  let lines;
  try {
    const st = fs.statSync(TRANSCRIPT);
    const len = Math.min(TAIL_SCAN_BYTES, st.size);
    const fd = fs.openSync(TRANSCRIPT, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    lines = buf.toString('utf8').split('\n');
    if (len < st.size) lines.shift(); // first line may be truncated
  } catch { return null; }

  let lastLimit = null;
  let activityAfter = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    const ev = limitEventOf(line, LOCAL_TZ);
    if (ev) { lastLimit = ev; activityAfter = false; continue; }
    if (!lastLimit) continue;
    // Any real assistant turn or user prompt after the limit = session resumed.
    try {
      const obj = JSON.parse(line);
      if (obj.type === 'assistant' && obj.isApiErrorMessage !== true) activityAfter = true;
      if (obj.type === 'user' && !obj.isMeta) activityAfter = true;
    } catch { /* ignore non-JSON */ }
  }
  if (!lastLimit) return { verdict: 'no-limit-event' };
  if (activityAfter) return { verdict: 'stale-limit-already-resumed' };
  return { verdict: 'dead-on-limit', event: lastLimit };
}

// ---------- startup ----------
log(`started — watching ${TRANSCRIPT} (delay +${DELAY_MIN} min, mode ${MODE}, fallback ${FALLBACK_ENABLED ? CHAIN.join('>') : 'off (default — wait for reset)'}, telegram ${telegram.enabled ? 'on' : 'off'}, claude=${CLAUDE_BIN}${DRY_RUN ? ', DRY-RUN' : ''})`);

const scan = catchUpScan();
if (SCAN_ONLY) {
  console.log(`[scan-only] verdict: ${scan?.verdict || 'unreadable'}`
    + (scan?.event?.reset ? ` | reset ${scan.event.reset.h}:${String(scan.event.reset.min).padStart(2, '0')} (${scan.event.reset.tz})` : ''));
  process.exit(0);
}
if (scan?.verdict === 'dead-on-limit') {
  log('catch-up scan: session died on a limit with no activity since — scheduling resume');
  handleLimitEvent(scan.event, 'catch-up');
} else if (scan) {
  log(`catch-up scan: ${scan.verdict}`);
}
// Drop pending schedules that are absurdly stale (>26 h past): a resume that old
// would land in an unknown context; the catch-up scan above re-derives fresh ones.
const staleBefore = Date.now() - 26 * 3600 * 1000;
const beforeCount = state.pending.length;
state.pending = state.pending.filter((p) => p.at > staleBefore);
if (state.pending.length !== beforeCount) { log('dropped stale pending schedule(s) from a previous run'); saveState(); }
if (state.pending.length) {
  log(`restored ${state.pending.length} pending schedule(s) from state file`);
}
notify('Claude auto-resume', `Watcher active — session ${path.basename(TRANSCRIPT, '.jsonl').slice(0, 8)}... (resume at reset +${DELAY_MIN} min)`);

// ---------- tail loop ----------
let lastSize = fs.statSync(TRANSCRIPT).size; // history handled by catchUpScan; tail only new lines
let carry = '';
let loggedInFlightWait = false; // avoid re-logging every tick while waiting on an in-flight resume

setInterval(() => {
  // --project-dir mode: ALWAYS follow the newest session (headless resumes
  // create new .jsonl files — the watcher must switch to them).
  if (PROJECT_DIR) {
    try {
      const newest = newestJsonl(PROJECT_DIR);
      if (newest && newest !== TRANSCRIPT) {
        TRANSCRIPT = newest;
        const st = fs.statSync(TRANSCRIPT);
        lastSize = st.size;
        carry = '';
        log(`switched to newest session: ${path.basename(TRANSCRIPT)}`);
        // Scan the tail of the new file once to catch a run that just died on a limit.
        const s = catchUpScan();
        if (s?.verdict === 'dead-on-limit') handleLimitEvent(s.event, 'switch-scan');
      }
    } catch { /* best-effort */ }
  }

  // Fire due schedules (wall-clock check: survives sleep — after wake the next
  // tick compares Date.now() against the persisted target and fires if overdue).
  if (state.pending.length && Date.now() >= state.pending[0].at) {
    const sessionId = path.basename(TRANSCRIPT, '.jsonl');
    if (resumeInFlight(sessionId)) {
      // A resume for this session is still running: wait for it instead of
      // stacking a second concurrent `claude --resume` on top (the documented
      // "up to 3 concurrent processes" bug). Log once per wait, not per tick.
      if (!loggedInFlightWait) {
        log(`resume already in flight for session ${sessionId} — waiting before firing the next schedule`);
        loggedInFlightWait = true;
      }
    } else {
      loggedInFlightWait = false;
      const due = state.pending.shift();
      saveState();
      log(`firing scheduled resume [${due.reason}]${due.model ? ` (model ${due.model})` : ''}`);
      resumeSession(due.model);
      if (Date.now() > (state.episode?.resetAt || 0)) { state.episode = null; saveState(); }
      if (ONCE) { log('--once mode: exiting.'); process.exit(0); }
    }
  }

  // Tail new transcript content.
  let size;
  try { size = fs.statSync(TRANSCRIPT).size; } catch { return; }
  if (size < lastSize) { lastSize = 0; carry = ''; } // truncated/rotated file
  if (size === lastSize) return;

  const fd = fs.openSync(TRANSCRIPT, 'r');
  const len = size - lastSize;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, lastSize);
  fs.closeSync(fd);
  lastSize = size;

  const parts = (carry + buf.toString('utf8')).split('\n');
  carry = parts.pop() || '';
  for (const line of parts) {
    if (!line.trim()) continue;
    const ev = limitEventOf(line, LOCAL_TZ);
    if (ev) handleLimitEvent(ev, 'live');
  }
}, POLL_MS);