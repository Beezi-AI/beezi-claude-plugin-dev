import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { oauthKeyStatusFile } from './paths.mjs';
import { keyFingerprint } from './oauth-identity.mjs';

const STATE_VERSION = 1;

// How long an answer is trusted. Long enough that the steady state is one file read, short enough
// that a user who fixes their plan in the portal stops being nagged the same working day.
const FRESH_MS = 6 * 60 * 60 * 1000;

// Tighter than postJson's 3s default: this runs inline on SessionStart, whose whole budget is 10s
// and which may already have spent ~600ms spawning the Claude CLI. A slow answer is worth less than
// a fast start — the nudge simply waits for the next session.
const PROBE_TIMEOUT_MS = 1500;

export function readOauthKeyStatus(deps = {}) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(oauthKeyStatusFile(), null);
  if (!raw || raw.version !== STATE_VERSION) return null;
  return raw;
}

function writeOauthKeyStatus(state, deps = {}) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  try {
    write(oauthKeyStatusFile(), { version: STATE_VERSION, ...state });
  } catch { /* best-effort */ }
}

// Is a cached answer about THIS key, and recent enough to reuse? A rotation changes the
// fingerprint, so the previous key's verdict is discarded rather than aged out — the new key has
// its own account, or none.
function isUsable(cached, fingerprint, nowMs) {
  if (cached == null || cached.fingerprint == null) return false;
  if (
    cached.fingerprint.prefix !== fingerprint.prefix
    || cached.fingerprint.last4 !== fingerprint.last4
    || cached.fingerprint.length !== fingerprint.length
  ) {
    return false;
  }
  const at = Date.parse(cached.checkedAt == null ? '' : cached.checkedAt);
  if (Number.isNaN(at)) return false;
  // A stamp from the future is a clock change, not a fresh answer.
  return nowMs - at <= FRESH_MS && at <= nowMs;
}

// Does the portal know what this machine's setup token bills?
//
// Returns { needsAttention, known, subscriptionPlan } or null when the question could not be
// answered — offline, an older server with no such route, no token, a token too short to
// fingerprint. Null means SAY NOTHING: a machine that cannot reach the portal must not be told its
// billing is unresolved, because that is not what it observed.
//
// Best-effort by contract, like every other hook path: it never throws.
export async function fetchOauthKeyStatus(token, deps = {}) {
  const env = deps.env == null ? process.env : deps.env;
  const fingerprint = keyFingerprint(env.CLAUDE_CODE_OAUTH_TOKEN);
  if (!token || fingerprint == null) return null;

  const now = deps.now == null ? new Date() : deps.now;
  const cached = readOauthKeyStatus(deps);
  if (isUsable(cached, fingerprint, now.getTime())) {
    return {
      known: cached.known === true,
      needsAttention: cached.needsAttention === true,
      subscriptionPlan: cached.subscriptionPlan == null ? null : cached.subscriptionPlan,
    };
  }

  try {
    const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
    const res = await postJson(
      `${apiBase()}${ENDPOINTS.credentialStatus}`,
      token,
      { prefix: fingerprint.prefix, last4: fingerprint.last4, length: fingerprint.length },
      { fetchImpl, timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (res == null || res.status < 200 || res.status >= 300) return null;
    const body = await res.json();
    if (body == null || typeof body !== 'object') return null;

    const status = {
      known: body.known === true,
      needsAttention: body.needsAttention === true,
      subscriptionPlan: typeof body.subscriptionPlan === 'string' ? body.subscriptionPlan : null,
    };
    writeOauthKeyStatus(
      { fingerprint, checkedAt: now.toISOString(), ...status },
      deps,
    );
    return status;
  } catch {
    // Offline, timed out, or an old server. Not an observation about the key.
    return null;
  }
}
