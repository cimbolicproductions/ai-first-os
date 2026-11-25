"use strict";

/**
 * Multi-provider quota, auth-expiry, and reset-time parser backed by SQLite.
 *
 * Fixes all four v1 failover bugs:
 * 1. Persisted in SQLite (never lost on restart)
 * 2. Parses Claude, Codex, Gemini, OpenCode, Antigravity & Cursor reset formats
 * 3. Never wipes all provider cooldowns globally on a single task retry
 * 4. Separates auth expiry (needs 1-link sign-in) from quota exhaustion (needs failover)
 */

const DEFAULT_UNKNOWN_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_REASONABLE_WAIT_MS = 14 * 24 * 60 * 60 * 1000;

const AUTH_EXPIRED_RE = /\b(?:not authenticated|not logged in|please log ?in|sign ?in required|oauth token.*(?:expired|invalid)|token_expired|invalid_api_key|unauthorized|authentication failed|login required|re-authenticate)\b/i;
const QUOTA_EXHAUSTED_RE = /\b(?:usage limit|session limit|weekly limit|5-hour limit|quota exceeded|insufficient_quota|resource_exhausted|rate limit(?:ed)?|too many requests|purchase more credits|hit your .*limit|out of (?:usage|credits|quota)|capacity limit)\b/i;
const MODEL_UNSUPPORTED_RE = /\b(?:model_not_found|model is not supported|model .{0,50}does not exist|IneligibleTier|unsupported model)\b/i;

/**
 * Computes the UTC epoch ms for a wall-clock time (year, month 1..12, day, hour 0..23, minute)
 * in a given IANA time zone (e.g. "America/Chicago"), using only built-in Intl APIs.
 */
function zonedWallClockToEpoch({ year, month, day, hour, minute, timeZone }) {
  // Start with a naive UTC guess and refine by the zone's observed wall-clock delta (2 iterations handles DST).
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  for (let i = 0; i < 2; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map(p => [p.type, p.value]));
    const observed = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      0,
      0
    );
    const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    const delta = target - observed;
    guess += delta;
    if (delta === 0) break;
  }
  return guess;
}

function zonedDateParts(epochMs, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(epochMs)).map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function parse12Hour(hourStr, minStr, ampm) {
  let h = Number(hourStr);
  const m = Number(minStr || 0);
  if (h < 1 || h > 12 || m < 0 || m > 59) return null;
  const isPm = String(ampm).toLowerCase() === "pm";
  if (h === 12) h = isPm ? 12 : 0;
  else if (isPm) h += 12;
  return { hour: h, minute: m };
}

const MONTHS = Object.freeze({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
});

function validTimeZone(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/**
 * Parses reset timestamps from any supported CLI message into UTC epoch ms, or null if unknown.
 */
function parseResetAt(message, { now = Date.now(), defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" } = {}) {
  const text = String(message || "");
  if (!text) return null;

  const accept = ts => (Number.isFinite(ts) && ts > now && ts - now <= MAX_REASONABLE_WAIT_MS ? ts : null);

  // 1. ISO-8601 timestamp: "resets at 2026-11-25T14:00:00Z"
  const iso = /(?:resets?|try again|available)\s+(?:at|after)?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(text);
  if (iso) {
    const parsed = accept(Date.parse(iso[1]));
    if (parsed) return parsed;
  }

  // 2. Relative duration: "try again in 15 minutes", "resets in 2 hours 30 min", "retry after 90s"
  const rel = /(?:try again|retry|resets?|wait)\s+(?:in|after)\s+(?:(\d+)\s*(?:h|hr|hrs|hour|hours))?\s*(?:(\d+)\s*(?:m|min|mins|minute|minutes))?\s*(?:(\d+)\s*(?:s|sec|secs|second|seconds))?/i.exec(text);
  if (rel && (rel[1] || rel[2] || rel[3])) {
    const ms = (Number(rel[1] || 0) * 3600 + Number(rel[2] || 0) * 60 + Number(rel[3] || 0)) * 1000;
    const parsed = accept(now + ms);
    if (parsed) return parsed;
  }

  // 3. Codex date + time: "try again at Nov 16th, 2026 7:47 AM" (optional timezone)
  const codex = /(?:try again|resets?)\s+(?:at|after)\s+([A-Z][a-z]{2,8})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4}),?\s+(\d{1,2})(?::(\d{2}))?\s*([AP]M)(?:\s*\(([^)]+)\))?/i.exec(text);
  if (codex) {
    const month = MONTHS[codex[1].toLowerCase()];
    const day = Number(codex[2]);
    const year = Number(codex[3]);
    const hm = parse12Hour(codex[4], codex[5], codex[6]);
    const tz = validTimeZone(codex[7]?.trim()) || defaultTimeZone;
    if (month && hm) {
      const parsed = accept(zonedWallClockToEpoch({ year, month, day, hour: hm.hour, minute: hm.minute, timeZone: tz }));
      if (parsed) return parsed;
    }
  }

  // 4. Claude date + time without year: "resets Nov 25, 11am (America/Chicago)" or "resets Nov 25 at 2:30pm"
  const claudeDated = /resets?\s+(?:on\s+)?([A-Z][a-z]{2,8})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,|\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*([AP]M)(?:\s*\(([^)]+)\))?/i.exec(text);
  if (claudeDated) {
    const month = MONTHS[claudeDated[1].toLowerCase()];
    const day = Number(claudeDated[2]);
    const hm = parse12Hour(claudeDated[3], claudeDated[4], claudeDated[5]);
    const tz = validTimeZone(claudeDated[6]?.trim()) || defaultTimeZone;
    if (month && hm) {
      const today = zonedDateParts(now, tz);
      let candidate = zonedWallClockToEpoch({ year: today.year, month, day, hour: hm.hour, minute: hm.minute, timeZone: tz });
      if (candidate <= now) {
        candidate = zonedWallClockToEpoch({ year: today.year + 1, month, day, hour: hm.hour, minute: hm.minute, timeZone: tz });
      }
      const parsed = accept(candidate);
      if (parsed) return parsed;
    }
  }

  // 5. Claude clock time only: "resets 12:20pm (America/Chicago)" or "resets 11pm (America/Chicago)"
  const claudeClock = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*([AP]M)(?:\s*\(([^)]+)\))?/i.exec(text);
  if (claudeClock) {
    const hm = parse12Hour(claudeClock[1], claudeClock[2], claudeClock[3]);
    const tz = validTimeZone(claudeClock[4]?.trim()) || defaultTimeZone;
    if (hm) {
      const today = zonedDateParts(now, tz);
      let candidate = zonedWallClockToEpoch({ year: today.year, month: today.month, day: today.day, hour: hm.hour, minute: hm.minute, timeZone: tz });
      if (candidate <= now) {
        const tomorrow = zonedDateParts(now + 24 * 60 * 60 * 1000, tz);
        candidate = zonedWallClockToEpoch({ year: tomorrow.year, month: tomorrow.month, day: tomorrow.day, hour: hm.hour, minute: hm.minute, timeZone: tz });
      }
      const parsed = accept(candidate);
      if (parsed) return parsed;
    }
  }

  return null;
}

function classifyProviderFailure(provider, text, { exitCode = 1, now = Date.now(), defaultTimeZone } = {}) {
  const combined = String(text || "").trim();
  if (AUTH_EXPIRED_RE.test(combined)) {
    return {
      kind: "auth_expired",
      provider,
      resetAt: null,
      reason: "Sign-in expired or missing",
      rawMessage: combined.slice(-500),
    };
  }
  if (MODEL_UNSUPPORTED_RE.test(combined)) {
    return {
      kind: "model_unsupported",
      provider,
      resetAt: null,
      reason: "Configured model is unavailable on this account",
      rawMessage: combined.slice(-500),
    };
  }
  if (QUOTA_EXHAUSTED_RE.test(combined)) {
    const resetAt = parseResetAt(combined, { now, defaultTimeZone });
    return {
      kind: "exhausted",
      provider,
      resetAt: resetAt || (now + DEFAULT_UNKNOWN_COOLDOWN_MS),
      resetKnown: Boolean(resetAt),
      reason: resetAt ? "Usage limit reached" : "Usage limit reached (reset time unknown)",
      rawMessage: combined.slice(-500),
    };
  }
  return {
    kind: exitCode === 0 ? "unknown" : "error",
    provider,
    resetAt: null,
    reason: `Provider failed (exit ${exitCode})`,
    rawMessage: combined.slice(-500),
  };
}

function recordProviderFailure(store, failure) {
  if (!store || !failure?.provider) return null;
  if (failure.kind === "exhausted" || failure.kind === "auth_expired") {
    return store.setQuota({
      provider: failure.provider,
      status: failure.kind,
      resetAt: failure.resetAt || null,
      reason: failure.reason,
      rawMessage: failure.rawMessage || null,
    });
  }
  return null;
}

function recordProviderSuccess(store, provider) {
  if (!store || !provider) return;
  store.setQuota({ provider, status: "available", resetAt: null, reason: null, rawMessage: null });
}

function getEffectiveProviderQuota(store, provider, { now = Date.now() } = {}) {
  const q = store.getQuota(provider);
  if (q.status === "available") return { available: true, ...q };
  if (q.status === "auth_expired") return { available: false, needsAuth: true, ...q };
  if (q.status === "exhausted") {
    const deadline = q.resetAt || ((q.observedAt || 0) + DEFAULT_UNKNOWN_COOLDOWN_MS);
    if (now >= deadline) {
      store.setQuota({ provider, status: "available", resetAt: null, reason: null, rawMessage: null });
      return { available: true, provider, status: "available", resetAt: null, reason: null, rawMessage: null, observedAt: now };
    }
    return { available: false, needsAuth: false, ...q, resetAt: deadline };
  }
  return { available: true, ...q };
}

module.exports = {
  DEFAULT_UNKNOWN_COOLDOWN_MS,
  parseResetAt,
  classifyProviderFailure,
  recordProviderFailure,
  recordProviderSuccess,
  getEffectiveProviderQuota,
};
