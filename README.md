# claude-auto-resume

**Auto-resume your Claude Code sessions when you hit a usage/session limit.**

When Claude Code (or its background agents) dies with an error like:

```
You've hit your session limit · resets 6:50pm (Europe/Brussels)
```

…this tiny watcher (pure Node.js, **zero dependencies, no AI**) detects it in the session
transcript, parses the reset time (12h/24h + IANA timezone, DST-safe), waits until
**reset + 5 minutes** (configurable), then automatically resumes the session with
`claude --resume <sessionId> -p "<resume prompt>"` — so your agents pick their work back up
while you sleep.

## Quick start

```bash
node watcher.mjs --transcript "~/.claude/projects/<PROJECT>/<SESSION_ID>.jsonl" --cwd "<your project dir>"
```

Or let it pick the most recent session of a project automatically:

```bash
node watcher.mjs --project-dir "~/.claude/projects/<PROJECT>" --cwd "<your project dir>"
```

Leave it running in a terminal (or a scheduled task / systemd unit). It logs to
`auto-resume.log` next to the transcript.

## Options

| Flag | Default | Description |
|---|---|---|
| `--transcript <file>` | — | Session `.jsonl` to watch |
| `--project-dir <dir>` | — | Alternative: watch the newest `.jsonl` in this dir |
| `--cwd <dir>` | current dir | Working directory used to relaunch `claude` |
| `--delay-min <n>` | `5` | Minutes to wait **after** the reset time |
| `--mode headless\|window` | `headless` | `headless` = `claude -p` in background · `window` = opens a new terminal (Windows) |
| `--once` | off | Exit after the first successful resume |

Env vars: `AUTO_RESUME_PROMPT` (custom resume prompt), `AUTO_RESUME_EXTRA_ARGS`
(extra args appended to the `claude` command, e.g. `--permission-mode acceptEdits`).

## Claude Code plugin (hook)

This repo also ships as a Claude Code plugin: the `SessionStart` hook starts the watcher
automatically for every session (idempotent — one watcher per transcript).

```
/plugin install  (point it at this repo)
```

Or manually add the hook from `hooks/hooks.json` to your settings.

## How it works

1. Tails the session transcript (`.jsonl`) — only **new** content is scanned.
2. Regex-matches the limit message and captures `6:50pm` + `(Europe/Brussels)`.
3. Computes the next wall-clock occurrence of that time **in that timezone**
   (minute-stepping against `Intl.DateTimeFormat` — no DST math, no deps).
4. Schedules the resume at reset + delay, then spawns
   `claude --resume <sessionId> -p "<prompt>"` detached.
5. Keeps watching — multiple limits per night are handled.

## Caveats

- The resumed run continues the same conversation; your assistant should be instructed
  (via the resume prompt) to restart its interrupted background agents.
- In `headless` mode, tools requiring interactive permission prompts may be limited by
  your permission settings — configure `AUTO_RESUME_EXTRA_ARGS` accordingly.
- If the original interactive terminal is still open, the resumed continuation runs
  alongside it; the terminal simply won't show the new turns.

---

### 🇫🇷 En bref

Petit script Node sans dépendance ni IA : il surveille le transcript de ta session Claude
Code, détecte « You've hit your session limit · resets HH:MM (fuseau) », attend l'heure du
reset + 5 min, puis relance `claude --resume` avec un prompt de reprise pour que tes agents
reprennent le travail tout seuls. Fonctionne aussi comme plugin Claude Code (hook
`SessionStart`).

## License

MIT
