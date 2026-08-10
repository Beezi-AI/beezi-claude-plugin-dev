import { readJson, writeJsonSecure } from './fs-store.mjs';
import { statuslineUsageFile } from './paths.mjs';

// Claude Code hands the status-line command its LIVE rate-limit state on stdin (2.1.80+):
//
//   "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 }, ... }
//
// This is strictly better than the `cachedUsageUtilization` blob in ~/.claude.json, which is a
// cache Claude Code refreshes on its own schedule and was measured two days stale. Nothing is
// fetched here and no token is touched — Claude Code already made the request and is handing us
// the answer, so the capture never leaves the user's machine until the normal reporting path
// posts it.
//
// The status line renders constantly, so this module NEVER does network or spawns anything. It
// records to a small local file; the existing hook path drains it.

// Percentage-point move that is worth another row. Utilization creeps up with every request, so
// recording each render would be thousands of rows a day describing one slow climb.
const MATERIAL_DELTA_PCT = 5;
// Hard ceiling on unposted rows, so a machine that never reaches the drain path cannot grow the
// file without bound. Oldest are dropped: the newest observations are the ones still actionable.
const MAX_PENDING = 40;

function readWindow(node) {
  if (!node || typeof node !== 'object') return null;
  const pct = typeof node.used_percentage === 'number' ? node.used_percentage : null;
  // Unix epoch SECONDS here, unlike the ISO strings the ~/.claude.json cache carries.
  const resetsAt = typeof node.resets_at === 'number' ? node.resets_at : null;
  if (pct === null && resetsAt === null) return null;
  return { pct, resetsAt };
}

// A row earns its place when the window rolled over, when utilization climbed materially, or when
// it hit the ceiling — the exact transitions the plan-fit check reasons about.
function isMaterial(next, last) {
  if (!next) return false;
  if (!last) return true;
  if (next.resetsAt !== last.resetsAt) return true;
  if (next.pct === null) return false;
  if (next.pct >= 100 && (last.pct ?? 0) < 100) return true;
  return Math.abs(next.pct - (last.pct ?? 0)) >= MATERIAL_DELTA_PCT;
}

const epochToIso = (seconds) =>
  typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null;

// Returns { recorded } — recorded is true when this render produced a new pending row.
export function recordStatuslineUsage(payload, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const limits = payload?.rate_limits;
  const fiveHour = readWindow(limits?.five_hour);
  const sevenDay = readWindow(limits?.seven_day);
  if (!fiveHour && !sevenDay) return { recorded: false, reason: 'no-rate-limits' };

  const file = statuslineUsageFile();
  const state = readJson(file) ?? {};
  if (!isMaterial(fiveHour, state.lastFiveHour) && !isMaterial(sevenDay, state.lastSevenDay)) {
    return { recorded: false, reason: 'immaterial' };
  }

  // fetched_at is genuinely "now": unlike the cache, the status line reports what Claude Code
  // holds at render time, so the observation is current by construction.
  const pending = Array.isArray(state.pending) ? state.pending : [];
  pending.push({
    fetched_at: now().toISOString(),
    five_hour_pct: fiveHour?.pct ?? null,
    five_hour_resets_at: epochToIso(fiveHour?.resetsAt ?? null),
    seven_day_pct: sevenDay?.pct ?? null,
    seven_day_resets_at: epochToIso(sevenDay?.resetsAt ?? null),
  });

  writeJsonSecure(file, {
    version: 1,
    lastFiveHour: fiveHour ?? state.lastFiveHour ?? null,
    lastSevenDay: sevenDay ?? state.lastSevenDay ?? null,
    pending: pending.slice(-MAX_PENDING),
  });
  return { recorded: true };
}

export function readPendingStatuslineUsage() {
  const state = readJson(statuslineUsageFile()) ?? {};
  return Array.isArray(state.pending) ? state.pending : [];
}

// Drops the rows that were confirmed stored, leaving anything the status line appended in the
// meantime untouched — the drain and the recorder run in different processes.
export function clearPendingStatuslineUsage(count) {
  const file = statuslineUsageFile();
  const state = readJson(file) ?? {};
  const pending = Array.isArray(state.pending) ? state.pending : [];
  writeJsonSecure(file, { ...state, version: 1, pending: pending.slice(count) });
}
