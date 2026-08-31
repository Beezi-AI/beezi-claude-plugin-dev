import {
  BillingSource,
  detectBillingSource,
  resolveBillingSource,
  normalizePlan,
} from './billing.mjs';
import {
  BILLING_CONFIG_VERSION,
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
  resolveSource as _resolveSource,
  syncBillingSource,
  isStale as _isStale,
} from './billing-config.mjs';
import { resolveClaudeSubscription as _resolveClaudeSubscription } from './claude-auth-status.mjs';
import { oauthTokenAnchor as _oauthTokenAnchor, keyFingerprint } from './oauth-identity.mjs';
import { readClaudeAccountAnchor as _readClaudeAccountAnchor } from './claude-account.mjs';
import { oauthTokenEnv } from './claude-settings-env.mjs';
import { UserError } from './friendly-error.mjs';

// The credential fields are short opaque labels. Anything token-shaped (an
// sk-ant secret, an over-long string, or embedded whitespace) is refused so a
// misdirected value can never be persisted.
const TOKEN_LIKE = /sk-ant|\s/;

function safeField(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 64 || TOKEN_LIKE.test(s)) {
    throw new UserError('Refusing a suspicious value (looks token-like). Nothing written.');
  }
  return s;
}

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--subscription-type') out.subscriptionType = argv[++i];
    else if (flag === '--rate-limit-tier') out.rateLimitTier = argv[++i];
    else if (flag === '--expires-at') out.expiresAt = argv[++i];
    else if (flag === '--via') out.via = argv[++i];
    else if (flag === '--plan') out.plan = argv[++i];
    else if (flag === '--from-claude') out.fromClaude = true;
  }
  // The script's --from-claude branch rebuilds args from ~/.claude.json, which would
  // silently drop a user-supplied --plan; refuse the combination up front instead.
  if (out.fromClaude && out.plan != null) {
    throw new UserError('--plan and --from-claude are mutually exclusive.');
  }
  return out;
}

// Self-reported plans a user can pick in the /beezi:login fallback. `free` is
// absent: Claude Code cannot run on subscription billing with a free plan.
const SELF_REPORTED_PLANS = Object.freeze(['pro', 'max_5x', 'max_20x', 'team', 'enterprise']);

// Not plans — the ways a user declares they are NOT on a subscription. Without them the tier
// question is the only answer available, which pins a machine paying with an API key to a
// subscription plan it does not have and buckets its spend and errors under that plan.
// `gateway` covers the case no local signal can settle: Claude Code pointed at a custom endpoint,
// which may forward this machine's own subscription credential or bill the gateway's instead.
const SELF_REPORTED_API_KEY = 'api_key';
const SELF_REPORTED_GATEWAY = 'gateway';

// The declared source for each non-subscription answer.
function declaredNonSubscriptionSource(plan) {
  if (plan === SELF_REPORTED_API_KEY) return BillingSource.ANTHROPIC_API_KEY;
  if (plan === SELF_REPORTED_GATEWAY) return BillingSource.THIRD_PARTY;
  return null;
}

// WHICH setup token this record describes, or null when the env in force exposes none. Stored
// structurally rather than parsed back out of the anchor: the anchor slot is single-occupancy and
// may legitimately hold an `email`/`account_uuid` identity while the plan came from a key.
//
// Null means "not stated", never "no key" — see sameKeyFingerprint in oauth-identity.mjs. The env
// is the caller's already-resolved one, so this can never disagree with the fingerprint the
// check-in and the session reports send.
function fingerprintOf(env) {
  return keyFingerprint(env == null ? null : env.CLAUDE_CODE_OAUTH_TOKEN);
}

// The stored accountAnchor field: identity value + which source produced it, dated. Null in →
// null out, so a machine exposing no identity keeps the pre-anchor behavior.
function stampAnchor(anchor, now) {
  if (anchor == null || anchor.value == null || anchor.source == null) return null;
  return { value: anchor.value, source: anchor.source, updatedAt: now.toISOString() };
}

// The vendor account id stored ALONGSIDE the anchor, whichever source won the anchor slot: the
// CLI's email outranks the file uuid as the switch detector, but the server can only merge an
// email-provisional account row into the canonical uuid row (and link sessions, which report the
// uuid) when the check-in presents both identity fields.
function resolveAccountUuid(account, anchor) {
  if (account != null && typeof account.accountUuid === 'string' && account.accountUuid) {
    return account.accountUuid;
  }
  if (anchor != null && anchor.source === 'account_uuid' && anchor.value != null) {
    return anchor.value;
  }
  return null;
}

// The vendor email stored alongside the uuid, for the same merge: a machine anchored on the uuid
// still knows the email and must present both. Copied raw like the anchor value — safeField's
// 64-char cap would throw away a legitimate address (emails run to 254).
function resolveAccountEmail(account, anchor) {
  if (account != null && typeof account.email === 'string' && account.email) {
    return account.email;
  }
  if (anchor != null && anchor.source === 'email' && anchor.value != null) {
    return anchor.value;
  }
  return null;
}

export function buildConfig(args, env = process.env, now = new Date(), account = null, anchor = null) {
  if (args.plan != null) {
    const plan = String(args.plan).trim().toLowerCase();
    const declaredSource = declaredNonSubscriptionSource(plan);
    if (declaredSource != null) {
      const envSource = detectBillingSource(env);
      const capturedVia = safeField(args.via);
      return {
        version: BILLING_CONFIG_VERSION,
        // An env that positively names a provider still wins; otherwise take the user's word.
        source: envSource === BillingSource.UNKNOWN ? declaredSource : envSource,
        subscriptionType: null,
        rateLimitTier: null,
        plan: null,
        credentialsExpiresAt: null,
        capturedAt: now.toISOString(),
        capturedBy: capturedVia == null ? 'manual' : capturedVia,
        selfReported: true,
        detectedVia: null,
        planSource: null,
        accountAnchor: stampAnchor(anchor, now),
        accountUuid: resolveAccountUuid(account, anchor),
        accountEmail: resolveAccountEmail(account, anchor),
        keyFingerprint: fingerprintOf(env),
      };
    }
    if (!SELF_REPORTED_PLANS.includes(plan)) {
      throw new UserError(
        `Unknown plan '${args.plan}'. Valid: ${[...SELF_REPORTED_PLANS, SELF_REPORTED_API_KEY, SELF_REPORTED_GATEWAY].join(', ')}.`,
      );
    }
    // Naming a subscription tier IS the evidence: the user is telling us they bill a subscription,
    // which is exactly the fact no local signal could establish. It resolves UNKNOWN, but it never
    // overrides an env that positively says otherwise — an exported API key outranks the claim.
    const envSource = detectBillingSource(env);
    const source = envSource === BillingSource.UNKNOWN ? BillingSource.SUBSCRIPTION : envSource;
    const isSub = source === BillingSource.SUBSCRIPTION;
    const capturedVia = safeField(args.via);
    return {
      version: BILLING_CONFIG_VERSION,
      source,
      // The plan label is the single source of the derived fields; the tier was
      // never observed, so rateLimitTier stays null rather than a synthesized value.
      subscriptionType: isSub ? (plan.startsWith('max_') ? 'max' : plan) : null,
      rateLimitTier: null,
      plan: isSub ? plan : null,
      credentialsExpiresAt: null,
      capturedAt: now.toISOString(),
      capturedBy: capturedVia == null ? 'manual' : capturedVia,
      selfReported: true,
      detectedVia: null,
      // Provenance of the PLAN: null when the env overruled the declaration, since there is then
      // no plan above for it to describe.
      planSource: isSub ? 'self_reported' : null,
      accountAnchor: stampAnchor(anchor, now),
      accountUuid: resolveAccountUuid(account, anchor),
      accountEmail: resolveAccountEmail(account, anchor),
      keyFingerprint: fingerprintOf(env),
    };
  }
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = safeField(args.via);
  // A readable oauthAccount is positive subscription evidence; without it (and without an env
  // signal) the source stays unknown rather than being assumed.
  const source = resolveBillingSource(env, account);
  const isSub = source === BillingSource.SUBSCRIPTION;
  // The resolver told us the on-disk profile describes a different credential than the one in
  // force (a setup token), so there is no plan tuple to persist. Gate it explicitly: the incoming
  // fields are already null, and normalizePlan(null, null) is 'unknown' — a label that reads as
  // "captured, could not classify" and would be reported as such. `null` says we did not capture.
  const planUnresolved = account != null && account.planSource === 'unresolved';
  const keepPlan = isSub && !planUnresolved;
  // null/undefined/'' must stay null — Number(null) is 0, which would look like an
  // already-expired timestamp and force a permanent "stale" state.
  const expiresAt = args.expiresAt == null || args.expiresAt === '' ? NaN : Number(args.expiresAt);
  return {
    version: BILLING_CONFIG_VERSION,
    source,
    subscriptionType: keepPlan ? subscriptionType : null,
    rateLimitTier: keepPlan ? rateLimitTier : null,
    plan: keepPlan ? normalizePlan(subscriptionType, rateLimitTier) : null,
    credentialsExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    capturedAt: now.toISOString(),
    capturedBy: via == null ? 'manual' : via,
    detectedVia: account == null || account.detectedVia == null ? null : account.detectedVia,
    // Provenance of the PLAN, distinct from detectedVia (provenance of the tuple's fields).
    // 'unresolved' records that the nulls above are a verdict rather than a gap, which is what
    // keeps isStale() and the report gate from treating them as a plan waiting to be re-read.
    planSource: planUnresolved ? 'unresolved' : (keepPlan ? 'claude_login' : null),
    accountAnchor: stampAnchor(anchor, now),
    accountUuid: resolveAccountUuid(account, anchor),
    accountEmail: resolveAccountEmail(account, anchor),
    keyFingerprint: fingerprintOf(env),
  };
}

// The one degradation that is never new information: the SAME product with the multiplier gone.
// `max` alongside a stored `max_5x`/`max_20x` means the tier was not readable this time, not that
// the user moved to a different plan — and the loss is unrecoverable, because `max` is not
// `unknown` so no staleness check and no nudge ever asks again.
//
// Deliberately narrow. A fresh `pro` or `team` over a stored `max_20x` IS a real plan change and
// must still record; only same-product detail loss is refused.
export function losesMultiplier(freshPlan, existingPlan) {
  if (freshPlan !== 'max') return false;
  return existingPlan === 'max_5x' || existingPlan === 'max_20x';
}

// A self-reported plan must survive automatic re-capture: when the fresh account
// fields still normalize to 'unknown', overwriting would destroy the only good
// data and restart the refresh-nudge loop the selfReported exemption exists to end.
export function shouldKeepExisting(freshConfig, existingConfig) {
  if (existingConfig == null) return false;
  // Applies to every record, self-reported or not, and to the forced path too: /beezi:refresh
  // exists to correct a stale plan, but a re-resolution that dropped the tier has not learned
  // anything to correct it with.
  if (losesMultiplier(freshConfig.plan, existingConfig.plan)) return true;
  // An `unresolved` capture is the ABSENCE of local evidence, so it must never erase a plan that
  // came from somewhere local evidence cannot reach. The Beezi server's answer for this key's
  // fingerprint (planSource 'key_resolution', written by plan-writeback.mjs) is exactly that: it
  // is the ONLY thing that can price a setup-token machine, and every weekly heartbeat re-runs a
  // capture that will keep reporting 'unresolved' for as long as the token is in force.
  // The literal rather than an import: this must not couple the local capture to the writeback
  // module, and the vocabulary is documented in one place there.
  if (freshConfig.planSource === 'unresolved' && existingConfig.planSource === 'key_resolution') return true;
  // A record that belongs to a KEY must not be overwritten by a capture that could not see one.
  //
  // Without this the reset undoes itself. When the token is exported from a shell profile it is
  // invisible to all three env tiers, so the weekly heartbeat spawns the CLI with no token, gets
  // `authMethod:'claude.ai'` describing the previous interactive login, and builds a fresh
  // `claude_login` capture carrying that account's plan. Nothing above stops it — the fresh record
  // is not 'unresolved', and the existing one is not selfReported — so learnedPlan() would make it
  // win, restoring the wrong plan AND forcing the check-in ('captured') that re-binds the key.
  //
  // A capture whose env held no token is by construction not evidence about a key. Narrow on
  // purpose: it does not touch self-reported records, does not block an 'unresolved' verdict (which
  // is a real observation about this key), and does not reach the account-switch path, which
  // bypasses this function entirely.
  if (existingConfig.keyFingerprint != null
    && freshConfig.keyFingerprint == null
    && freshConfig.planSource === 'claude_login') return true;
  if (existingConfig.selfReported !== true) return false;
  const declaredTier = Boolean(existingConfig.plan) && existingConfig.plan !== 'unknown';
  // A declared api-key or gateway machine carries no plan at all — the source IS the declaration.
  const declaredSource = existingConfig.source === BillingSource.ANTHROPIC_API_KEY
    || existingConfig.source === BillingSource.THIRD_PARTY;
  if (!declaredTier && !declaredSource) return false;
  // An `unresolved` verdict says the on-disk PROFILE is not evidence for the credential in force.
  // It says nothing about the user's own testimony — the token may well belong to the very account
  // they described — so it must not wipe the one answer no automatic capture can reconstruct, or
  // the nudge loop this exemption exists to end starts over. (An account SWITCH still overrides,
  // above in the reconcile: there the record demonstrably describes someone else.)
  if (freshConfig.planSource === 'unresolved') return true;
  // Overwrite only when the fresh capture actually learned something. An `unknown` source means it
  // did not, so the user's answer must survive — otherwise every /beezi:refresh on a machine whose
  // billing cannot be observed wipes the answer and restarts the nudge loop.
  return freshConfig.plan === 'unknown' || freshConfig.source === BillingSource.UNKNOWN;
}

// How long an account-anchor verdict is trusted before the reconcile re-checks it (one CLI spawn).
const ANCHOR_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

// A positive identity mismatch ONLY: both anchors present, produced by the same source, naming
// different values. Cross-source differences (a CLI email vs a file userID) and any null side are
// inconclusive — they must not wipe a self-reported plan.
function anchorChanged(stored, current) {
  if (stored == null || current == null) return false;
  if (stored.source !== current.source) return false;
  if (stored.value == null || current.value == null) return false;
  return stored.value !== current.value;
}

function sameAnchor(stored, current) {
  if (stored == null && current == null) return true;
  if (stored == null || current == null) return false;
  return stored.source === current.source && stored.value === current.value;
}

// How long before a machine that could not confirm an auth-mode switch is allowed to ask again.
// Shorter than ANCHOR_RECHECK_MS because the question is answerable as soon as the CLI works;
// long enough that a machine which can NEVER answer it does not spawn `claude auth status` on
// every single session.
const AUTH_MODE_RECHECK_MS = 6 * 60 * 60 * 1000;

// Has this machine moved from an interactive login onto a setup token?
//
// The case anchorChanged structurally cannot see. Its rule — a mismatch counts only between anchors
// of the SAME source — is right and must stay: a CLI email versus a file userID is two different
// questions, not a changed answer, and treating it as a switch would wipe self-reported plans. But
// the login → token transition is exactly a cross-source pair (`email`/`account_uuid`/`user_id` on
// the record, `oauth_key` in force), so it read as inconclusive and nothing fired. The plan captured
// from the previous login kept shipping under a key that may belong to someone else entirely.
//
// selfReported records are excluded on purpose, matching the invariant documented in
// shouldKeepExisting: an `unresolved` verdict says nothing about the user's own testimony, and the
// token may well belong to the very account they described. Their record is left to the heartbeat.
//
// This is only HALF the decision — it says the question is worth asking, not what the answer is.
// The caller must additionally require that the CLI positively confirmed a setup token before
// treating it as a switch; see the reconcile.
function authModeSwitched(existing, tokenAnchor) {
  if (tokenAnchor == null) return false;
  if (existing == null || existing.accountAnchor == null) return false;
  if (existing.accountAnchor.source === 'oauth_key') return false;
  return existing.selfReported !== true;
}

// Bounds how often the above is allowed to cost a process spawn. anchorCheckedAt is stamped on
// every reconcile attempt, including the kept and no-signal paths, so a machine that keeps failing
// to confirm re-asks at most four times a day instead of once per session.
function authModeCheckDue(existing, now) {
  if (existing == null) return true;
  const checkedAt = Date.parse(existing.anchorCheckedAt == null ? '' : existing.anchorCheckedAt);
  if (Number.isNaN(checkedAt)) return true;
  // A stamp from the future is a clock change, not a fresh check.
  return now.getTime() - checkedAt > AUTH_MODE_RECHECK_MS || checkedAt > now.getTime();
}

// A capture that resolved a real subscription plan. Anything weaker must not overwrite an
// existing record outside an account switch — a broken CLI or a wiped oauthAccount would
// otherwise degrade a good capture to nulls on the next stale check.
function learnedPlan(config) {
  return config.source === BillingSource.SUBSCRIPTION && config.plan != null && config.plan !== 'unknown';
}

// The self-healing capture, shared by the SessionStart hook and the manual commands so the two
// can never disagree about switch detection or what a self-reported plan survives.
//
// Session-start mode (default): re-capture only when the record is missing, stuck on `unknown`,
// stale, or belongs to a different account — all decided from local reads. The one process spawn
// (claude auth status, ~600ms) happens only after a trigger fires; the steady state (fresh config,
// same account) reads two small files and writes nothing.
//
// Forced mode (`options.force`, /beezi:login and /beezi:refresh): the user asked for a re-read, so
// the capture always runs and a resolved account overwrites anything but a still-protected
// self-reported plan — including re-writing `plan=unknown`, which is what routes the login flow to
// its tier question. `options.via` names the writer (capturedBy).
//
// Returns { config, source, outcome } — outcome is 'switched' | 'captured' | 'cleared' | 'kept' |
// 'no-signal' | 'none' (no trigger fired), for the manual commands' one-line reports. 'cleared' is
// a write like 'captured', but of a record with NO plan: the CLI said the credential in force is a
// setup token, so the tuple that was there described a different account.
// Best-effort by contract: any failure returns whatever is known and must never throw.
export function reconcileBillingConfig(deps = {}, options = {}) {
  const readConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  const writeConfig = deps.writeBillingConfig == null ? _writeBillingConfig : deps.writeBillingConfig;
  const resolveSourceImpl = deps.resolveSource == null ? _resolveSource : deps.resolveSource;
  const isStaleImpl = deps.isStale == null ? _isStale : deps.isStale;
  const resolveSubscription = deps.resolveClaudeSubscription == null ? _resolveClaudeSubscription : deps.resolveClaudeSubscription;
  const readFileAnchor = deps.readClaudeAccountAnchor == null ? _readClaudeAccountAnchor : deps.readClaudeAccountAnchor;
  const tokenAnchorOf = deps.oauthTokenAnchor == null ? _oauthTokenAnchor : deps.oauthTokenAnchor;
  // Same rule as every other token read: a settings-file token counts when nothing exported
  // one, and an injected deps.env is trusted verbatim.
  const env = deps.env == null ? oauthTokenEnv(process.env) : deps.env;
  const now = deps.now == null ? new Date() : deps.now;
  const force = options.force === true;
  const via = options.via == null ? 'session-start' : options.via;

  let chosen = null;
  let outcome = 'none';
  try {
    const existing = readConfig();
    chosen = existing;
    const storedAnchor = existing == null ? null : existing.accountAnchor;
    // Cheap precheck, no spawn; the CLI's own (fresher) anchor re-checks after one. A
    // cross-source pair here is inconclusive by design — the weekly heartbeat covers it.
    let fileAnchor = null;
    try { fileAnchor = readFileAnchor(); } catch { fileAnchor = null; }

    // The setup token's OWN anchor, read from the already-resolved env — free, no process spawn.
    // Without it a key ROTATION is invisible here: ~/.claude.json's file anchor does not move when
    // the token changes, so on a token machine the precheck compared two things that never differ,
    // nothing triggered, and a plan the server resolved for the PREVIOUS fingerprint kept shipping
    // under the new one. A key_resolution plan is an answer scoped to one fingerprint, so serving it
    // under a different one is a category error — worse than a stale plan, and one the pre-token
    // code could not make, because plans were not key-scoped then.
    let tokenAnchor = null;
    try { tokenAnchor = tokenAnchorOf(env); } catch { tokenAnchor = null; }

    // The heartbeat bounds how long an account switch can stay invisible: an email anchor only
    // exists in the CLI's answer, and a self-reported plan never goes stale, so without a periodic
    // re-check neither would ever be re-verified. anchorCheckedAt is stamped on every attempt.
    const checkedAt = Date.parse(existing == null || existing.anchorCheckedAt == null ? '' : existing.anchorCheckedAt);
    const heartbeatDue = existing != null
      && (Number.isNaN(checkedAt) || now.getTime() - checkedAt > ANCHOR_RECHECK_MS || checkedAt > now.getTime());

    const trigger = force
      || existing == null
      || (existing.source === BillingSource.UNKNOWN && existing.selfReported !== true)
      || isStaleImpl(existing, now.getTime())
      || anchorChanged(storedAnchor, fileAnchor)
      || anchorChanged(storedAnchor, tokenAnchor)
      // The login → setup-token transition, which no anchorChanged pair can express. Rate-limited
      // because a machine whose CLI cannot answer would otherwise re-ask on every session forever:
      // the predicate stays true until a confirming capture rewrites the anchor to oauth_key.
      || (authModeSwitched(existing, tokenAnchor) && authModeCheckDue(existing, now))
      || heartbeatDue;

    if (trigger) {
      let sub = null;
      // `env` is passed EXPLICITLY, and that is the whole point of this line. resolveClaudeSubscription
      // otherwise defaults to oauthTokenEnv(process.env) — the NON-probing variant — and rebuilds a
      // second, un-probed env of its own. On a setup-token machine that env has no token (Claude Code
      // scrubs CLAUDE_CODE_OAUTH_TOKEN from every child it spawns), so the CLI is asked without the
      // token, answers authMethod:"claude.ai", and the previous login's plan is captured as fact —
      // exactly the bug the oauth_token branch below exists to prevent. The reconcile's env has been
      // through all three tiers; the resolver must judge by the same one.
      try { sub = resolveSubscription({ env }); } catch { sub = null; }
      const currentAnchor = sub != null && sub.anchor != null ? sub.anchor : fileAnchor;
      // The transition counts as a switch ONLY once the CLI has confirmed it. `planSource
      // 'unresolved'` is set by exactly one branch of resolveClaudeSubscription: the one that saw
      // authMethod 'oauth_token', i.e. positive evidence that the credential in force is the setup
      // token rather than the login on disk.
      //
      // Without this guard the 'switched' arm below — which writes wholesale and consults nothing —
      // would stamp whatever resolveClaudeSubscription happened to return under a fresh oauth_key
      // anchor and fingerprint. Two shapes make that actively destructive: a machine whose `claude`
      // CLI is missing or slow still yields the stale oauthAccount profile (the previous login's
      // plan, permanently key-scoped, and shipped as this key's tier in the check-in that binds it);
      // and `sub == null` yields plan 'unknown', wiping a good key_resolution answer with junk.
      // Both now fall through to the ordinary overwrite/kept logic, which is today's behaviour.
      const authSwitch = authModeSwitched(existing, tokenAnchor)
        && sub != null && sub.planSource === 'unresolved';
      const switched = anchorChanged(storedAnchor, currentAnchor) || authSwitch;
      const fresh = buildConfig(
        {
          subscriptionType: sub == null ? null : sub.subscriptionType,
          rateLimitTier: sub == null ? null : sub.rateLimitTier,
          expiresAt: sub == null ? null : sub.expiresAt,
          via,
        },
        env, now, sub, currentAnchor,
      );
      const stampedNow = now.toISOString();
      // Forced (user-invoked) captures keep the historical /beezi:refresh contract: a resolved
      // account overwrites anything shouldKeepExisting does not protect, `plan=unknown` included.
      // The automatic path additionally demands a real plan, so a transiently unreadable machine
      // can never degrade a good record on its own.
      // Losing a plan we now know we cannot resolve IS new information, so it has to be able to
      // win the write. Without this a machine that once captured `team` from a previous
      // interactive login would keep reporting it forever under a setup token: learnedPlan(fresh)
      // is false for a cleared capture, so the automatic path would take the `kept` branch and
      // leave the stale tuple in place on every heartbeat.
      const clearsPlan = fresh.planSource === 'unresolved';
      const overwrite = sub != null && !shouldKeepExisting(fresh, existing)
        && (force || learnedPlan(fresh) || clearsPlan);
      if (switched) {
        // The account changed: the old record — self-reported or not — describes someone else.
        // A degraded fresh capture still wins; the unknown-nudge then asks the right account.
        chosen = { ...fresh, anchorCheckedAt: stampedNow };
        writeConfig(chosen);
        outcome = 'switched';
      } else if (overwrite) {
        chosen = { ...fresh, anchorCheckedAt: stampedNow };
        writeConfig(chosen);
        outcome = clearsPlan ? 'cleared' : 'captured';
      } else if (existing != null) {
        // Kept: adopt the anchor (v1 grandfathering included) so the NEXT switch is detectable,
        // and stamp the heartbeat. Identity-only write — plan fields and capturedAt untouched.
        // A newly visible accountUuid or accountEmail is identity too and is adopted the same
        // way, so a machine whose plan record is protected forever still gains the identity
        // fields the check-in needs.
        const next = currentAnchor == null ? storedAnchor : currentAnchor;
        const keptAnchor = next == null
          ? (existing.accountAnchor == null ? null : existing.accountAnchor)
          : (sameAnchor(existing.accountAnchor, next) ? existing.accountAnchor : stampAnchor(next, now));
        const keptUuid = resolveAccountUuid(sub, currentAnchor);
        const keptEmail = resolveAccountEmail(sub, currentAnchor);
        // A newly visible fingerprint is adopted on the same terms as the identity fields: it says
        // which key this machine runs, and a record that knows it can no longer be overwritten by a
        // capture that saw no key (see shouldKeepExisting). Never cleared here — an env that stopped
        // exposing the token is not evidence the record stopped belonging to it.
        const keptFingerprint = fingerprintOf(env);
        chosen = {
          ...existing,
          version: BILLING_CONFIG_VERSION,
          accountAnchor: keptAnchor,
          anchorCheckedAt: stampedNow,
          keyFingerprint: keptFingerprint == null
            ? (existing.keyFingerprint == null ? null : existing.keyFingerprint)
            : keptFingerprint,
          accountUuid: keptUuid == null
            ? (existing.accountUuid == null ? null : existing.accountUuid)
            : keptUuid,
          accountEmail: keptEmail == null
            ? (existing.accountEmail == null ? null : existing.accountEmail)
            : keptEmail,
        };
        writeConfig(chosen);
        outcome = sub == null ? 'no-signal' : 'kept';
      } else {
        outcome = 'no-signal';
      }
    }
  } catch { /* best-effort */ }

  let source = BillingSource.UNKNOWN;
  try {
    source = resolveSourceImpl(chosen, env);
    const synced = syncBillingSource(chosen, source, now);
    if (synced) {
      writeConfig(synced);
      chosen = synced;
    }
  } catch { /* best-effort */ }

  return { config: chosen, source, outcome };
}
