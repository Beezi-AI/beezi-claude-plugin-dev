import {
  BILLING_CONFIG_VERSION,
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
} from './billing-config.mjs';

// The one bridge between the two plan stores.
//
// Until this module existed there were two answers to "what does this machine bill" that never
// spoke to each other: billing.json, which feeds subscription_plan / subscription_type /
// rate_limit_tier on every /sessions/report, the account check-in and the usage snapshot; and the
// server's key resolution (lib/key-resolution.mjs, lib/oauth-key-status.mjs), which knows what a
// CLAUDE_CODE_OAUTH_TOKEN's fingerprint has been attached to in the portal. A user could resolve
// their key through /beezi:refresh and every session report afterwards would still ship the stale
// plan a previous interactive login left on disk, or none at all. This writes the server's answer
// into the file the reports actually read.
//
// Deliberately the ONLY thing here. billing-capture.mjs owns the local capture and its
// reconcile; adding a second writer there would have put two unrelated decisions in one place.
// This module reads and writes through billing-config.mjs's exports and touches nothing else.

// provenance stamped on a plan this module wrote. The vocabulary is shared with the local capture
// path: 'unresolved' (a setup token whose plan is not knowable locally), 'claude_login'
// (claude auth status / oauthAccount), 'self_reported' (what the user told /beezi:login), and this
// one — the Beezi server's answer for this key's fingerprint.
export const KEY_RESOLUTION_PLAN_SOURCE = 'key_resolution';

// Same discipline as billing-capture.mjs's safeField: the plan is a short opaque label, so anything
// token-shaped (an sk-ant secret, embedded whitespace) or over-long is refused rather than written.
// A server that answered with something surprising must never get a credential-looking string into
// billing.json, which is read back and reported on every session.
//
// Unlike safeField this RETURNS null instead of throwing: every caller here is best-effort, and a
// throw on the /beezi:refresh success path would turn a resolved key into a visible error.
const TOKEN_LIKE = /sk-ant|\s/;
const MAX_PLAN_LENGTH = 64;

export function safePlan(plan) {
  if (plan == null) return null;
  const s = String(plan).trim();
  if (!s) return null;
  if (s.length > MAX_PLAN_LENGTH || TOKEN_LIKE.test(s)) return null;
  return s;
}

// The plan named by a fetchKeyResolution payload, or null. Only 'resolved' counts: 'unlinked' and
// 'unknown_key' are the server saying it has no answer, and a null status is the normalization of a
// status this client does not recognize — none of the three is an authoritative plan.
export function resolvedPlanFrom(payload) {
  if (payload == null || payload.status !== 'resolved') return null;
  return safePlan(payload.subscriptionPlan);
}

// The plan named by a submitKeyPlan / submitKeyLink result, or null. A refusal names nothing, and a
// link that succeeded without the server naming a plan names nothing either — attaching a key to a
// subscription does not tell this side which plan that subscription is on, and guessing one would
// put a fabricated tier into every report.
export function submittedPlanFrom(result) {
  if (result == null || result.ok !== true) return null;
  return safePlan(result.subscriptionPlan);
}

// Record a plan the Beezi server resolved for this machine's setup token. Returns true when
// billing.json was written, false when there was nothing trustworthy to write or the write failed.
//
// Never throws, by contract: the callers are a SessionStart hook and the success path of
// /beezi:refresh, and neither may turn a failed write into a broken session or a red line under a
// resolution that actually landed.
//
// capturedAt is stamped alongside planResolvedAt on purpose. isStale() reads capturedAt, and
// leaving a previous login's date there would make the very next session start print "subscription
// plan info is missing or stale — run /beezi:refresh" one line after /beezi:refresh resolved it.
// A capture genuinely did just happen; planResolvedAt is the provenance-specific stamp on top.
//
// subscriptionType and rateLimitTier are deliberately NOT synthesized from the plan. The server
// named a plan, not a tier, and buildConfig already sets the precedent: an unobserved tier stays
// null rather than becoming a value nothing measured.
export function recordResolvedKeyPlan(plan, deps = {}) {
  const readConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  const writeConfig = deps.writeBillingConfig == null ? _writeBillingConfig : deps.writeBillingConfig;
  const now = deps.now == null ? new Date() : deps.now;
  const safe = safePlan(plan);
  if (safe == null) return false;
  try {
    let existing = null;
    try { existing = readConfig(); } catch { existing = null; }
    const base = existing == null || typeof existing !== 'object' ? {} : existing;
    const stamped = now.toISOString();
    writeConfig({
      version: BILLING_CONFIG_VERSION,
      ...base,
      plan: safe,
      planSource: KEY_RESOLUTION_PLAN_SOURCE,
      planResolvedAt: stamped,
      capturedAt: stamped,
    });
    return true;
  } catch {
    // Best-effort: an unwritable ~/.beezi must not break the caller. The next session start asks
    // the portal again and gets another chance to record it.
    return false;
  }
}
