# claude-auto-resume

**Auto-resume your Claude Code sessions when you hit a usage limit.**

When Claude Code (or its background agents) dies with an error like:

```
You've hit your session limit · resets 6:50pm (Europe/Brussels)
You've hit your weekly limit · resets 8pm (Europe/Brussels)
```

…this tiny watcher (pure Node.js, **zero dependencies, no AI**) detects the genuine
limit event in the session transcript, parses the reset time **dynamically**
(12h/24h, optional weekday, optional IANA timezone, DST-safe), waits until
**reset + 5 minutes** (configurable), then automatically resumes the session with
`claude --resume <sessionId> -p "<resume prompt>"` — so your agents pick their work
back up while you sleep.

## Quick start

```bash
node watcher.mjs --project-dir "~/.claude/projects/<PROJECT>" --cwd "<your project dir>"
```

Or watch one specific session:

```bash
node watcher.mjs --transcript "~/.claude/projects/<PROJECT>/<SESSION_ID>.jsonl" --cwd "<your project dir>"
```

It logs to `auto-resume.log` next to the transcript.

### Survive reboots and sleep (recommended)

A plain background process dies with a reboot and can be killed around a sleep cycle.
Register the watcher as a **Windows Scheduled Task** that reruns it every 5 minutes —
the single-instance lock makes reruns no-ops while a watcher is alive, and the startup
**catch-up scan** recovers a limit that struck while nothing was running:

```bash
node scripts/install-task.mjs --project-dir "~/.claude/projects/<PROJECT>" --cwd "<your project dir>"
# verify:   schtasks /query /tn ClaudeAutoResume /v /fo LIST
# remove:   node scripts/install-task.mjs --uninstall
```

On macOS/Linux the installer prints an equivalent cron line instead.

## Reliability model

- **Real events only** — triggers on assistant transcript records flagged
  `isApiErrorMessage: true`, never on messages that merely quote the limit phrase.
- **Broad detection** — session / weekly / daily / monthly / 5-hour / rate limits,
  "usage limit reached", "out of usage credits", French variants; time formats
  `8pm`, `6:50pm`, `18:50`, `20h05`, optional `at`, optional weekday, optional
  `(IANA/Timezone)`. The reset time is never hardcoded.
- **Sleep/reboot-proof scheduling** — pending resumes are persisted to
  `auto-resume.state.json` and fired by a wall-clock check in a short poll loop
  (no long `setTimeout`). After a wake or a watcher restart, overdue resumes fire
  within seconds.
- **Catch-up scan on startup** — if the session already died on a limit before the
  watcher (re)started, the transcript tail scan detects it and schedules the resume.
  If meaningful activity happened after the limit, the event is treated as stale.
- **Model fallback** (on by default) — when the limit hits a high tier, immediately
  resume on the next lower tier (default chain `fable → opus → sonnet`) instead of
  waiting. The reset-time resume stays scheduled as a safety net and restores the
  original model. Each tier is tried at most once per limit episode.
- **Never-silent failures** — a failed resume is logged, toasted, and retried via a
  persisted schedule.

## Notifications (optional, Telegram)

Everything the watcher does is silent by default. To get pushed when something
happens, create `~/.claude/auto-resume/notify.json` (**outside the repo** — this
file holds your bot token and must never be committed):

```json
{
  "telegram": {
    "botToken": "123456789:ABC-your-bot-token",
    "chatId": "123456789"
  }
}
```

- Get a bot token from [@BotFather](https://t.me/BotFather); your `chatId` is what
  [@userinfobot](https://t.me/userinfobot) replies to you (send the bot a first
  message so it is allowed to answer).
- **File absent → strict no-op**: no notification, watcher behavior unchanged.
- Events pushed: `⛔ Claude limit hit — resume scheduled at HH:MM (tz)
  [model fallback: X]`, `▶️ Resuming session <id> (model)`,
  `✅ Resume finished` / `❌ Resume failed (exit N)`.
- **Best-effort**: a network or API failure is logged and swallowed — it never
  breaks the watcher. Duplicate events within 60 s are sent once (anti-spam).

Verify your setup with a real send:

```bash
node scripts/test-notify.mjs   # -> "🔔 Auto-resume notifications enabled" in Telegram
```

## Options

| Flag | Default | Description |
|---|---|---|
| `--transcript <file>` | — | Session `.jsonl` to watch |
| `--project-dir <dir>` | — | Alternative: track the newest `.jsonl` in this dir |
| `--cwd <dir>` | current dir | Working directory used to relaunch `claude` |
| `--delay-min <n>` | `5` | Minutes to wait **after** the reset time |
| `--mode headless\|window` | `headless` | `headless` = `claude -p` in background · `window` = opens a new terminal (Windows) |
| `--once` | off | Exit after the first resume |
| `--no-fallback` | fallback on | Disable model fallback (wait for the reset instead) |
| `--fallback-chain a,b,c` | `fable,opus,sonnet` | Model tiers, high → low (substring-matched against model ids) |
| `--claude-bin <path>` | auto | Explicit claude binary (else `CLAUDE_BIN`, else `where`/`which`) |
| `--dry-run` | off | Log every decision, never spawn `claude` |
| `--scan-only` | off | Print the startup catch-up verdict and exit |
| `--no-lock` | off | Skip the single-instance lockfile |

Env vars: `CLAUDE_BIN`, `AUTO_RESUME_PROMPT` (custom resume prompt),
`AUTO_RESUME_EXTRA_ARGS` (extra args appended to the `claude` command, e.g.
`--permission-mode acceptEdits`), `AUTO_RESUME_FALLBACK` (`0`/`off` disables),
`AUTO_RESUME_FALLBACK_CHAIN`.

## Claude Code plugin (hook)

This repo also ships as a Claude Code plugin: the `SessionStart` hook starts the watcher
automatically for every session (idempotent — one watcher per transcript).

```
/plugin install  (point it at this repo)
```

Or manually add the hook from `hooks/hooks.json` to your settings. Note: the hook only
covers sessions you start by hand — for unattended overnight runs, prefer the scheduled
task above, which also survives reboots.

## How it works

1. Tails the session transcript (`.jsonl`) — history is handled once by the catch-up
   scan, then only **new** lines are parsed.
2. A JSONL record is a limit event only if it is `type:"assistant"` with
   `isApiErrorMessage: true` and matches the limit regex; the reset spec
   (`8pm`, `6:50pm (Europe/Brussels)`, `18:50`, `Thu 8pm`, `20h05`) is captured
   dynamically.
3. Computes the next wall-clock occurrence of that time **in that timezone**
   (minute-stepping against `Intl.DateTimeFormat` — no DST math, no deps).
4. Persists the schedule, optionally schedules an immediate lower-tier fallback
   resume, and fires due schedules from the poll loop:
   `claude --resume <sessionId> [--model <tier>] -p "<prompt>"`, detached.
5. Keeps watching — resumes create new transcripts; `--project-dir` mode follows them
   and rescans each new tail. Multiple limits per night are handled.

## Tests

```bash
node --test test/detect.test.mjs test/notify.test.mjs
```

Covers the exact message from the 2026-07-28 incident (`weekly limit · resets 8pm`),
EN/FR phrase variants, dynamic reset-time parsing (am/pm, 24h, `20h05`, weekday,
timezone), real-event gating vs quotes, target-time computation across timezones,
and the fallback chain. The notification tests (injected fetch/clock, no network)
cover the absent-config no-op, message formatting, the Bot API call shape, the
60 s dedup window, and best-effort failure handling (no throw, token never logged).

## Caveats

- The resumed run continues the same conversation; your assistant should be instructed
  (via the resume prompt) to restart its interrupted background agents.
- A weekly "all models" limit may also block fallback tiers; in that case the fallback
  run dies on a fresh limit event, the watcher steps further down the chain, and once
  exhausted it simply waits for the reset — the scheduled resume is always there.
- In `headless` mode, tools requiring interactive permission prompts may be limited by
  your permission settings — configure `AUTO_RESUME_EXTRA_ARGS` accordingly.
- If the original interactive terminal is still open, the resumed continuation runs
  alongside it; the terminal simply won't show the new turns.

---

### 🇫🇷 En bref

Petit script Node sans dépendance ni IA : il surveille le transcript de ta session Claude
Code, détecte le vrai événement de limite (« You've hit your weekly/session limit · resets
8pm (fuseau) », variantes FR incluses), lit l'heure du reset dynamiquement, attend
reset + 5 min, puis relance `claude --resume` pour que tes agents reprennent le travail
tout seuls. Planification persistée (survit veille/reboot via tâche planifiée), repli
automatique vers un modèle inférieur en attendant le reset, notifications Telegram
optionnelles (opt-in via `~/.claude/auto-resume/notify.json`, hors repo), et outils
`--dry-run` / `--scan-only` pour tester sans rien lancer.

## License

MIT
