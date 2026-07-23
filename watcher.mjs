#!/usr/bin/env node
/**
 * claude-auto-resume — watcher.mjs
 *
 * Watches a Claude Code session transcript (.jsonl) for session-limit errors like:
 *   "You've hit your session limit · resets 6:50pm (Europe/Brussels)"
 * Parses the reset time (+ optional IANA timezone), waits until reset + delay,
 * then resumes the session automatically with `claude --resume <sessionId>`.
 *
 * Pure Node.js, zero dependencies, no AI involved.
 *
 * Usage:
 *   node watcher.mjs --transcript <path/to/session.jsonl> [--cwd <projectCwd>]
 *                    [--delay-min 5] [--mode headless|window] [--once]
 *   node watcher.mjs --project-dir <~/.claude/projects/XXX>   (auto-picks newest .jsonl)
 *
 * Env:
 *   AUTO_RESUME_PROMPT      override the resume prompt
 *   AUTO_RESUME_EXTRA_ARGS  extra args appended to the claude command (space-separated)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
const POLL_MS = 5000;

const PROMPT = process.env.AUTO_RESUME_PROMPT
  || 'La limite de session est réinitialisée — reprends IMMÉDIATEMENT ton travail là où il s\'était arrêté : relance/reprends tous les agents interrompus (SendMessage avec leur id), puis continue la mission en cours sans attendre de confirmation.';
const EXTRA_ARGS = (process.env.AUTO_RESUME_EXTRA_ARGS || '').split(' ').filter(Boolean);

// Matches: "You've hit your session limit · resets 6:50pm (Europe/Brussels)"
//          "You've hit your usage limit ... resets 18:50"
const LIMIT_RE = /(?:hit your (?:session|usage|rate) limit|limite de session atteinte)[^\n]*?resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;

function log(msg) {
  const line = `[auto-resume ${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(path.dirname(TRANSCRIPT || '.'), 'auto-resume.log'), line + '\n'); } catch { /* best-effort */ }
}

/** Notification système (toast Windows via balloon tip ; notify-send sur Linux ; osascript sur macOS). */
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
  } catch { /* la notif ne doit jamais casser le watcher */ }
}

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
  console.error('transcript introuvable — passe --transcript <fichier.jsonl> ou --project-dir <dossier>');
  process.exit(1);
}

// ---------- time helpers (DST-proof: iterate minutes, compare formatted time in tz) ----------
function timeInTz(date, tz) {
  try {
    const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' })
      .formatToParts(date);
    const g = (t) => p.find((x) => x.type === t)?.value;
    return { h: Number(g('hour')) % 24, m: Number(g('minute')) };
  } catch {
    return { h: date.getHours(), m: date.getMinutes() }; // tz invalide -> heure locale
  }
}

/**
 * Epoch-ms cible pour h:m dans `tz`. Cherche d'abord dans le PASSÉ RÉCENT
 * (≤ 20 min : le reset vient d'avoir lieu → reprise quasi immédiate), sinon
 * la prochaine occurrence (≤ 25 h, pas d'une minute, DST-proof).
 */
function nextOccurrence(h, m, tz) {
  const start = new Date(Math.ceil(Date.now() / 60000) * 60000); // prochaine minute pleine
  for (let i = -20; i <= 25 * 60; i++) {
    const cand = new Date(start.getTime() + i * 60000);
    const t = timeInTz(cand, tz);
    if (t.h === h && t.m === m) {
      // Occurrence déjà passée (reset récent) -> reprise dans 2 min.
      return i <= 0 ? Date.now() + 2 * 60000 : cand.getTime();
    }
  }
  return start.getTime() + 60 * 60000; // improbable : repli +1 h
}

function parseLimit(text) {
  const m = LIMIT_RE.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  const tz = m[4] || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { h, min, tz };
}

// ---------- resume ----------
function resumeSession() {
  const sessionId = path.basename(TRANSCRIPT, '.jsonl');
  log(`RESUME de la session ${sessionId} (cwd=${CWD}, mode=${MODE})`);
  if (MODE === 'window' && process.platform === 'win32') {
    // Nouvelle fenêtre de terminal interactive qui reprend la session avec le prompt.
    const psArgs = ['-NoProfile', '-Command',
      `Start-Process -FilePath claude -WorkingDirectory '${CWD.replace(/'/g, "''")}' -ArgumentList @('--resume','${sessionId}','${PROMPT.replace(/'/g, "''")}')`];
    spawn('powershell.exe', psArgs, { detached: true, stdio: 'ignore' }).unref();
  } else {
    // Headless : la session reprend en arrière-plan et relance ses agents.
    const args = ['--resume', sessionId, '-p', PROMPT, ...EXTRA_ARGS];
    const out = fs.openSync(path.join(path.dirname(TRANSCRIPT), 'auto-resume-run.log'), 'a');
    spawn(process.platform === 'win32' ? 'claude.cmd' : 'claude', args,
      { cwd: CWD, detached: true, stdio: ['ignore', out, out], shell: process.platform === 'win32' }).unref();
  }
}

// ---------- tail loop ----------
let lastSize = fs.statSync(TRANSCRIPT).size; // on ignore l'historique : seules les NOUVELLES limites comptent
let carry = '';           // chevauchement entre lectures (motif à cheval sur 2 chunks)
let pendingAt = null;     // epoch-ms du resume programmé
let pendingTimer = null;  // handle du setTimeout (reprogrammable au plus tôt)

log(`démarré — surveille ${TRANSCRIPT} (delay +${DELAY_MIN} min, mode ${MODE})`);
notify('Claude auto-resume ✅', `Watcher actif — surveille la session ${path.basename(TRANSCRIPT, '.jsonl').slice(0, 8)}… (reprise auto à reset+${DELAY_MIN} min)`);

setInterval(() => {
  let size;
  try { size = fs.statSync(TRANSCRIPT).size; } catch { return; }
  if (size < lastSize) { lastSize = 0; carry = ''; } // fichier tronqué/rotaté
  if (size === lastSize) return;

  const fd = fs.openSync(TRANSCRIPT, 'r');
  const len = size - lastSize;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, lastSize);
  fs.closeSync(fd);
  lastSize = size;

  const text = carry + buf.toString('utf8');
  carry = text.slice(-400);

  const hit = parseLimit(text);
  if (!hit) return;

  const target = nextOccurrence(hit.h, hit.min, hit.tz) + DELAY_MIN * 60000;
  // Reprogrammation au PLUS TÔT : une nouvelle limite avec un reset plus proche
  // remplace celle en attente (une détection parasite tardive ne bloque jamais
  // la vraie ; une reprise "pour rien" est inoffensive et auto-corrigée).
  if (pendingAt) {
    if (target >= pendingAt - 60000) { log('limite détectée — resume déjà programmé plus tôt/égal, ignoré'); return; }
    clearTimeout(pendingTimer);
    log('limite détectée avec un reset PLUS TÔT — reprogrammation');
  }
  pendingAt = target;
  const inMin = Math.round((target - Date.now()) / 60000);
  const localHHMM = new Date(target).toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' });
  log(`LIMITE détectée — reset ${String(hit.h).padStart(2, '0')}:${String(hit.min).padStart(2, '0')} (${hit.tz}) → resume à ${localHHMM} (~${inMin} min)`);
  notify('Claude auto-resume ⏳', `Limite atteinte — reprise automatique à ${localHHMM} (dans ~${inMin} min).`);

  pendingTimer = setTimeout(() => {
    pendingAt = null;
    resumeSession();
    if (ONCE) { log('mode --once : arrêt.'); process.exit(0); }
  }, Math.max(1000, target - Date.now()));
}, POLL_MS);
