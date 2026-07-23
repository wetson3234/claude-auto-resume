#!/usr/bin/env node
/**
 * Hook SessionStart : démarre le watcher pour la session courante (idempotent).
 * Claude Code passe un JSON sur stdin : { session_id, transcript_path, cwd, ... }.
 * Un lockfile par transcript évite les watchers en double.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let meta = {};
  try { meta = JSON.parse(input); } catch { /* stdin vide en test manuel */ }
  const transcript = meta.transcript_path;
  const cwd = meta.cwd || process.cwd();
  if (!transcript || !fs.existsSync(path.dirname(transcript))) process.exit(0);

  // Idempotence : lockfile avec PID encore vivant -> on ne relance pas.
  const lock = transcript + '.autoresume.pid';
  try {
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (pid && process.kill(pid, 0) === undefined) process.exit(0); // déjà actif
  } catch { /* pas de lock ou process mort */ }

  const child = spawn(process.execPath, [
    path.join(here, '..', 'watcher.mjs'),
    '--transcript', transcript,
    '--cwd', cwd,
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  try { fs.writeFileSync(lock, String(child.pid)); } catch { /* best-effort */ }
  process.exit(0);
});
