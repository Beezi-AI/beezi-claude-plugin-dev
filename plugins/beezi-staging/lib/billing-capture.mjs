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
import { readClaudeAccountAnchor as _readClaudeAccountAnchor } from './claude-account.mjs';
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

// The stored accountAnchor field: identity value + which source produced it, dated. Null in →
// null out, so a machine exposing no identity keeps the pre-anchor behavior.
function stampAnchor(anchor, now) {
  if (anchor == null || anchor.value == null || anchor.source == null) return null;
  return { value: anchor.value, source: anchor.source, updatedAt: now.toISOString() };
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
        accountAnchor: stampAnchor(anchor, now),
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
      accountAnchor: stampAnchor(anchor, now),
    };
  }
  const subscriptionType = safeField(args.subscriptionType);
  const rateLimitTier = safeField(args.rateLimitTier);
  const via = safeField(args.via);
  // A readable oauthAccount is positive subscription evidence; without it (and without an env
  // signal) the source stays unknown rather than being assumed.
  const source = resolveBillingSource(env, account);
  const isSub = source === BillingSource.SUBSCRIPTION;
  // null/undefined/'' must stay null — Number(null) is 0, which would look like an
  // already-expired timestamp and force a permanent "stale" state.
  const expiresAt = args.expiresAt == null || args.expiresAt === '' ? NaN : Number(args.expiresAt);
  return {
    version: BILLING_CONFIG_VERSION,
    source,
    subscriptionType: isSub ? subscriptionType : null,
    rateLimitTier: isSub ? rateLimitTier : null,
    plan: isSub ? normalizePlan(subscriptionType, rateLimitTier) : null,
    credentialsExpiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    capturedAt: now.toISOString(),
    capturedBy: via == null ? 'manual' : via,
    detectedVia: account == null || account.detectedVia == null ? null : account.detectedVia,
    accountAnchor: stampAnchor(anchor, now),
  };
}

// A self-reported plan must survive automatic re-capture: when the fresh account
// fields still normalize to 'unknown', overwriting would destroy the only good
// data and restart the refresh-nudge loop the selfReported exemption exists to end.
export function shouldKeepExisting(freshConfig, existingConfig) {
  if (existingConfig == null || existingConfig.selfReported !== true) return false;
  const declaredTier = Boolean(existingConfig.plan) && existingConfig.plan !== 'unknown';
  // A declared api-key or gateway machine carries no plan at all — the source IS the declaration.
  const declaredSource = existingConfig.source === BillingSource.ANTHROPIC_API_KEY
    || existingConfig.source === BillingSource.THIRD_PARTY;
  if (!declaredTier && !declaredSource) return false;
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
// Returns { config, source, outcome } — outcome is 'switched' | 'captured' | 'kept' | 'no-signal'
// | 'none' (no trigger fired), for the manual commands' one-line reports.
// Best-effort by contract: any failure returns whatever is known and must never throw.
export function reconcileBillingConfig(deps = {}, options = {}) {
  const readConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  const writeConfig = deps.writeBillingConfig == null ? _writeBillingConfig : deps.writeBillingConfig;
  const resolveSourceImpl = deps.resolveSource == null ? _resolveSource : deps.resolveSource;
  const isStaleImpl = deps.isStale == null ? _isStale : deps.isStale;
  const resolveSubscription = deps.resolveClaudeSubscription == null ? _resolveClaudeSubscription : deps.resolveClaudeSubscription;
  const readFileAnchor = deps.readClaudeAccountAnchor == null ? _readClaudeAccountAnchor : deps.readClaudeAccountAnchor;
  const env = deps.env == null ? process.env : deps.env;
  const now = deps.now == null ? new Date() : deps.now;
  const force = options.force === true;
  const via = options.via == null ? 'session-start' : options.via;

  let chosen = null;
  let outcome = 'none';
  try {
    const existing = readConfig();
    chosen = existing;
    const storedAnchor = existing == null ? null : existing.accountAnchor;
    // Cheap file-only precheck; the CLI's own (fresher) anchor re-checks after the spawn. A
    // cross-source pair here is inconclusive by design — the weekly heartbeat covers it.
    let fileAnchor = null;
    try { fileAnchor = readFileAnchor(); } catch { fileAnchor = null; }

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
      || heartbeatDue;

    if (trigger) {
      let sub = null;
      try { sub = resolveSubscription(); } catch { sub = null; }
      const currentAnchor = sub != null && sub.anchor != null ? sub.anchor : fileAnchor;
      const switched = anchorChanged(storedAnchor, currentAnchor);
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
      const overwrite = sub != null && !shouldKeepExisting(fresh, existing)
        && (force || learnedPlan(fresh));
      if (switched) {
        // The account changed: the old record — self-reported or not — describes someone else.
        // A degraded fresh capture still wins; the unknown-nudge then asks the right account.
        chosen = { ...fresh, anchorCheckedAt: stampedNow };
        writeConfig(chosen);
        outcome = 'switched';
      } else if (overwrite) {
        chosen = { ...fresh, anchorCheckedAt: stampedNow };
        writeConfig(chosen);
        outcome = 'captured';
      } else if (existing != null) {
        // Kept: adopt the anchor (v1 grandfathering included) so the NEXT switch is detectable,
        // and stamp the heartbeat. Identity-only write — plan fields and capturedAt untouched.
        const next = currentAnchor == null ? storedAnchor : currentAnchor;
        const keptAnchor = next == null
          ? (existing.accountAnchor == null ? null : existing.accountAnchor)
          : (sameAnchor(existing.accountAnchor, next) ? existing.accountAnchor : stampAnchor(next, now));
        chosen = { ...existing, version: BILLING_CONFIG_VERSION, accountAnchor: keptAnchor, anchorCheckedAt: stampedNow };
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
