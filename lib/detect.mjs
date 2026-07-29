/**
 * claude-auto-resume — detection & scheduling primitives.
 *
 * Pure functions only (no I/O, no timers) so everything is unit-testable.
 * Zero dependencies.
 */

// ---------------------------------------------------------------------------
// Limit-message detection
// ---------------------------------------------------------------------------
// Real-world messages this must match (English):
//   "You've hit your session limit · resets 6:50pm (Europe/Brussels)"
//   "You've hit your weekly limit · resets 8pm (Europe/Brussels)"
//   "You've hit your 5-hour limit · resets 11am"
//   "You've reached your usage limit"
//   "Claude usage limit reached"
//   "out of usage credits"
// French variants:
//   "Limite de session atteinte", "Limite d'utilisation hebdomadaire atteinte",
//   "Vous avez atteint votre limite"
export const LIMIT_RE = new RegExp(
  [
    // EN: hit/reached + your/the + optional qualifier + "limit"
    "(?:hit|reached)\\s+(?:your|the)\\s+(?:\\d+\\s*[-\\u2010\\u2011]?\\s*hour|five[- ]hour|session|usage|rate|weekly|daily|monthly|overall)?\\s*limit",
    "usage\\s+limit\\s+reached",
    "out\\s+of\\s+usage\\s+credits",
    // FR
    "limite\\s+(?:de\\s+session|d['\\u2019](?:utilisation|usage)|hebdomadaire|journali\\u00e8re|horaire|mensuelle)?\\s*atteinte",
    "vous\\s+avez\\s+atteint\\s+votre\\s+limite",
  ].join("|"),
  "i"
);

// Reset-time formats this must parse (the time is DYNAMIC — never hardcode):
//   "resets 8pm (Europe/Brussels)"     -> 20:00 Europe/Brussels
//   "resets 6:50pm (Europe/Brussels)"  -> 18:50 Europe/Brussels
//   "resets 18:50"                     -> 18:50 local timezone
//   "resets at 3am (America/New_York)" -> 03:00 America/New_York
//   "resets Thu 8pm"                   -> next Thursday 20:00
//   "réinitialisation à 20h05 (Europe/Paris)" -> 20:05 Europe/Paris
export const RESET_RE = new RegExp(
  "(?:resets?|r\\u00e9initialis\\w*)" + // resets / reset / réinitialisé(e)/réinitialisation
    "\\s*(?:at\\s+|\\u00e0\\s+|:\\s*)?" + // optional "at" / "à" / ":"
    "(?:on\\s+)?" +
    "(?:(mon|tue|wed|thu|fri|sat|sun|lun|mar|mer|jeu|ven|sam|dim)[a-z\\u00e9]*\\s+)?" + // optional weekday EN/FR
    "(?:at\\s+|\\u00e0\\s+)?" +
    "(\\d{1,2})(?:[:h]\\s?(\\d{2}))?\\s*(am|pm)?" + // 8pm | 6:50pm | 18:50 | 20h05
    "\\s*(?:\\(([^)]+)\\))?", // optional (IANA timezone)
  "i"
);

const WEEKDAY_MAP = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
  lun: "Mon", mar: "Tue", mer: "Wed", jeu: "Thu", ven: "Fri", sam: "Sat", dim: "Sun",
};

/**
 * Parse the reset time out of a limit message.
 * @returns {null | {h:number, min:number, tz:string, weekday:string|null}}
 */
export function parseResetSpec(text, localTz) {
  const m = RESET_RE.exec(text);
  if (!m) return null;
  const weekday = m[1] ? WEEKDAY_MAP[m[1].toLowerCase()] || null : null;
  let h = Number(m[2]);
  const min = Number(m[3] || 0);
  const ap = (m[4] || "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  const tz = m[5] || localTz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { h, min, tz, weekday };
}

/**
 * True if the text contains a usage-limit phrase (EN or FR, any limit kind).
 */
export function isLimitText(text) {
  return LIMIT_RE.test(text || "");
}

/** Concatenate the text content of a transcript record. */
export function recordText(obj) {
  const c = obj?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => x?.text || "").join(" ");
  return "";
}

/**
 * Detect a REAL limit event in one transcript JSONL line.
 * A real event is an assistant record flagged `isApiErrorMessage: true` whose
 * text matches a limit phrase. Records merely QUOTING the phrase (user
 * messages, task notifications, assistant explanations) never trigger.
 *
 * @returns {null | {reset: null|{h,min,tz,weekday}}}
 */
export function limitEventOf(line, localTz) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj.type !== "assistant" || obj.isApiErrorMessage !== true) return null;
  const text = recordText(obj);
  if (!isLimitText(text)) return null;
  return { reset: parseResetSpec(text, localTz) };
}

/** Model id of a transcript record, or null ("<synthetic>" is not a model). */
export function recordModel(line) {
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (obj.type !== "assistant") return null;
  const model = obj?.message?.model;
  if (!model || model === "<synthetic>") return null;
  return model;
}

// ---------------------------------------------------------------------------
// Target-time computation (DST-safe, dependency-free)
// ---------------------------------------------------------------------------

/** Wall-clock {h, m, wd} of `date` in IANA timezone `tz`. */
export function timeInTz(date, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short",
    }).formatToParts(date);
    const g = (t) => p.find((x) => x.type === t)?.value;
    return { h: Number(g("hour")) % 24, m: Number(g("minute")), wd: g("weekday") };
  } catch {
    return { h: date.getHours(), m: date.getMinutes(), wd: null }; // invalid tz -> local
  }
}

/**
 * Epoch-ms of the target reset instant for h:m (+optional weekday) in `tz`.
 * Searches the RECENT PAST first (<= 20 min: the reset just happened -> resume
 * almost immediately), then forward minute-by-minute (DST-proof: compares
 * formatted wall-clock time instead of doing offset math).
 *
 * @param {number|null} nowMs injectable clock for tests (default Date.now())
 */
export function nextOccurrence(h, m, tz, weekday = null, nowMs = null) {
  const now = nowMs ?? Date.now();
  const start = new Date(Math.ceil(now / 60000) * 60000); // next full minute
  const horizon = weekday ? 8 * 24 * 60 : 25 * 60; // 8 days if weekday given, else 25 h
  for (let i = -20; i <= horizon; i++) {
    const cand = new Date(start.getTime() + i * 60000);
    const t = timeInTz(cand, tz);
    if (t.h === h && t.m === m && (!weekday || t.wd === weekday)) {
      // Occurrence just passed (recent reset) -> resume in 2 minutes.
      return i <= 0 ? now + 2 * 60000 : cand.getTime();
    }
  }
  return start.getTime() + 60 * 60000; // unreachable in practice: retry in 1 h
}

// ---------------------------------------------------------------------------
// Model fallback (skip the wait: step down to the next lower model tier)
// ---------------------------------------------------------------------------

/** Ordered high -> low. Values are substrings matched against the model id. */
export const DEFAULT_FALLBACK_CHAIN = ["fable", "opus", "sonnet"];

/** Tier of a model id within a chain, or null if not in the chain. */
export function modelTier(modelId, chain = DEFAULT_FALLBACK_CHAIN) {
  const id = String(modelId || "").toLowerCase();
  return chain.find((t) => id.includes(t)) || null;
}

/**
 * Next lower tier to try, skipping already-tried tiers.
 * @param {string|null} currentTier tier the session was running on (null -> chain[0])
 * @param {string[]} tried tiers already attempted during this limit episode
 * @returns {string|null} the tier to fall back to, or null if the chain is exhausted
 */
export function nextFallbackTier(currentTier, chain = DEFAULT_FALLBACK_CHAIN, tried = []) {
  const from = chain.indexOf(currentTier);
  for (let i = (from < 0 ? 0 : from) + 1; i < chain.length; i++) {
    if (!tried.includes(chain[i])) return chain[i];
  }
  return null;
}
