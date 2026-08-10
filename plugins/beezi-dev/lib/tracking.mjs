import fs from 'node:fs';
import { trackingStateFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';

const STATE_VERSION = 1;

// Mirror of the server's TrackingMode enum — the whoami contract, never string-matched inline.
export const TrackingMode = Object.freeze({
  LIVE: 'live',
  BACKFILL_ONLY: 'backfill_only',
  DISABLED: 'disabled',
});

// Cached tenant tracking state, refreshed from whoami on SessionStart and from any 403
// TRACKING_DISABLED. Lives at the beeziHome() ROOT (beside billing.json) — pruneStale() sweeps
// state/ and queue/ only, and an expiring gate would silently re-enable dark-mode tenants.
//
// The gate is deliberately FAIL-OPEN: a missing/corrupt file or an old server (no trackingMode
// in whoami) means "allow" — the server's TrackingEnabledGuard is the actual boundary, and
// failing closed would dark-mode every fresh install until its first whoami.
export function readTrackingState(deps = {}) {
  const read = deps.readJsonImpl ?? readJson;
  const raw = read(trackingStateFile(), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

export function writeTrackingState(state, deps = {}) {
  const write = deps.writeJsonImpl ?? writeJsonSecure;
  // 0600 like every other beeziHome() root file; best-effort — a disk failure must never
  // break a hook.
  try {
    write(trackingStateFile(), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

export function isLiveTrackingAllowed(state = readTrackingState()) {
  const mode = state?.trackingMode ?? null;
  if (mode === TrackingMode.BACKFILL_ONLY || mode === TrackingMode.DISABLED) return false;
  return true;
}

// Mirrors the server's derivation: every mode except `disabled` is offered the one-time pull
// until it completes — paid tenants included, not just audit ones. A null mode means a
// pre-audit server: it has no backfill routes, so no hint.
export function shouldBackfill(state = readTrackingState()) {
  if (!state) return false;
  if (state.trackingMode == null) return false;
  if (state.backfillCompleted === true) return false;
  return state.trackingMode !== TrackingMode.DISABLED;
}

// The state is machine-global but the server's pull record is per (tenant, user, tool): a
// logout→login into another workspace must not inherit the previous one's flags. The OAuth
// client id changes on every login (dynamic registration), so it is the natural binding key;
// email is the fallback for states recorded before the id was known.
export function matchesIdentity(state, identity) {
  if (!state?.identity || !identity) return true;
  return state.identity === identity;
}

// Persist the whoami verdict. `identity` is the current login's binding key (client id or email).
export function recordWhoami(who, identity, deps = {}) {
  if (!who || who.valid !== true) return;
  writeTrackingState(
    {
      trackingMode: who.trackingMode ?? null,
      tenantTier: who.tenantTier ?? null,
      backfillCompleted: who.backfillCompleted === true,
      identity: identity ?? null,
      fetchedAt: new Date().toISOString(),
      reason: null,
    },
    deps,
  );
}

// A live endpoint answered 403 TRACKING_DISABLED: the server has spoken — go dark until the
// next whoami says otherwise.
export function markTrackingDisabled(reason, deps = {}) {
  const state = readTrackingState(deps) ?? {};
  writeTrackingState(
    {
      ...state,
      trackingMode: TrackingMode.DISABLED,
      fetchedAt: new Date().toISOString(),
      reason: reason ?? null,
    },
    deps,
  );
}

// The pull sealed (locally observed or server-confirmed) — the audit fast path keys off this.
export function markBackfillCompleted(deps = {}) {
  const state = readTrackingState(deps) ?? {};
  writeTrackingState(
    { ...state, backfillCompleted: true, fetchedAt: new Date().toISOString() },
    deps,
  );
}

export function clearTrackingState(deps = {}) {
  const fsImpl = deps.fsImpl ?? fs;
  try {
    fsImpl.rmSync(trackingStateFile(), { force: true });
  } catch { /* best-effort */ }
}
