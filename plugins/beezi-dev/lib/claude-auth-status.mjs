import { execFileSync } from 'child_process';
import { readClaudeAccount as _readClaudeAccount, readClaudeAccountAnchor as _readClaudeAccountAnchor } from './claude-account.mjs';
import { oauthTokenAnchor as _oauthTokenAnchor } from './oauth-identity.mjs';

// Subscription info via Claude Code's OWN CLI (`claude auth status --json`), never its credential
// store. The CLI reads its secret store itself — including the macOS Keychain, where it is the
// authorized caller — and prints only non-secret status fields, so no token ever crosses into
// plugin code. The spawn costs ~600ms: callers are the session-start reconcile (trigger-gated)
// and the manual capture commands ONLY — never the per-checkpoint hot path.
const AUTH_STATUS_TIMEOUT_MS = 5000;

// Output values are an open vocabulary — copied through when they look like short labels,
// dropped otherwise. Anything long or whitespace-y is not a status label.
function pickLabel(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > 254 || /\s/.test(s)) return null;
  return s;
}

export function runClaudeAuthStatus(deps = {}) {
  const exec = deps.exec == null ? execFileSync : deps.exec;
  const platform = deps.platform == null ? process.platform : deps.platform;
  const options = {
    timeout: AUTH_STATUS_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf-8',
    // stderr is discarded, not captured: an auth error message must never leak into output.
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  let stdout;
  try {
    // The native install exposes a real executable; PATH resolves it without a shell.
    stdout = exec('claude', ['auth', 'status', '--json'], options);
  } catch {
    if (platform !== 'win32') return null;
    // npm installs on Windows ship a `claude.cmd` shim that only a shell can resolve. One fixed
    // literal command line (no interpolation, no args array) — nothing for a shell to mis-parse.
    try {
      stdout = exec('claude auth status --json', [], { ...options, shell: true });
    } catch {
      // CLI missing, timeout, non-zero exit — all read as "no answer", never as an error.
      return null;
    }
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (parsed == null || typeof parsed !== 'object') return null;
  return {
    loggedIn: parsed.loggedIn === true,
    authMethod: pickLabel(parsed.authMethod),
    apiProvider: pickLabel(parsed.apiProvider),
    subscriptionType: pickLabel(parsed.subscriptionType),
    email: pickLabel(parsed.email),
    orgId: pickLabel(parsed.orgId),
  };
}

// The best available account identity, freshest source first: a CLAUDE_CODE_OAUTH_TOKEN in the
// environment is the account this process is actually authenticating as, then the CLI's email
// (which reflects the LIVE credential store), then oauthAccount — it can survive an account switch
// stale, its accountUuid naming the previous account — and userID, a last-resort opaque hash from
// ~/.claude.json.
//
// Identity only. The plan tuple below still merges the CLI answer with oauthAccount's tier: a
// token machine needs its Max multiplier like any other.
function buildAnchor(status, fileAnchor, tokenAnchor) {
  if (tokenAnchor != null) return tokenAnchor;
  if (status != null && status.email != null) return { value: status.email, source: 'email' };
  return fileAnchor == null ? null : fileAnchor;
}

// Case-insensitive identity comparison. Returns true/false when BOTH sides name an identity,
// and null when the comparison cannot be made — "unknown" is not "different".
function sameIdentity(a, b) {
  if (a == null || b == null) return null;
  const x = String(a).trim().toLowerCase();
  const y = String(b).trim().toLowerCase();
  if (!x || !y) return null;
  return x === y;
}

// Does the profile positively contradict the CLI about the product? Only a stated disagreement
// counts. A profile that cannot derive its own type states nothing, and a tier naming the CLI's
// product family corroborates it even when the coarse type labels differ (a Max seat inside a
// team org derives `team` while the CLI says `max`, yet `default_claude_max_20x` is still this
// account's multiplier).
function contradictsProduct(account, cliType) {
  if (account == null) return true;
  const derived = account.subscriptionType;
  if (derived == null) return false;
  const t = String(cliType).toLowerCase();
  if (String(derived).toLowerCase() === t) return false;
  const tier = String(account.rateLimitTier == null ? '' : account.rateLimitTier).toLowerCase();
  if (tier && tier.indexOf(t) !== -1) return false;
  return true;
}

// Layered subscription resolution, shaped like readClaudeAccount()'s result so every existing
// consumer works unmodified. subscriptionType comes from the CLI when it answers (fresh by
// construction); the Max multiplier lives only in oauthAccount's rateLimitTier.
//
// The profile's fields are kept unless it is shown to describe a DIFFERENT ACCOUNT — which is the
// question the previous product-type equality check was standing in for, and stood in for badly:
// it discarded a present multiplier whenever the profile could not name its own product, which is
// the normal shape for a personal Max subscription. Identity is checked first and decides on its
// own; the weaker product evidence is consulted only when no identity comparison can be made.
export function resolveClaudeSubscription(deps = {}) {
  const readStatus = deps.runClaudeAuthStatus == null ? runClaudeAuthStatus : deps.runClaudeAuthStatus;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  const readFileAnchor = deps.readClaudeAccountAnchor == null ? _readClaudeAccountAnchor : deps.readClaudeAccountAnchor;
  const readTokenAnchor = deps.oauthTokenAnchor == null ? _oauthTokenAnchor : deps.oauthTokenAnchor;
  const env = deps.env == null ? process.env : deps.env;

  let status = null;
  try { status = readStatus(); } catch { status = null; }
  let account = null;
  try { account = readAccount(); } catch { account = null; }
  let fileAnchor = null;
  try { fileAnchor = readFileAnchor(); } catch { fileAnchor = null; }
  let tokenAnchor = null;
  try { tokenAnchor = readTokenAnchor(env); } catch { tokenAnchor = null; }

  const cliType = status != null && status.loggedIn === true ? status.subscriptionType : null;
  if (cliType == null) {
    // No CLI answer: oauthAccount alone, exactly the pre-existing behavior. Accepted gap: a
    // CLI-status email with no oauthAccount is not captured — an identity-only return here would
    // flip the reconcile's 'no-signal' outcome to 'kept' and change /beezi:login routing.
    if (!account) return null;
    return { ...account, detectedVia: 'oauth_account', anchor: buildAnchor(status, fileAnchor, tokenAnchor) };
  }

  // A matching email is the strongest signal available that the profile and the live credential
  // store name the same account; a differing one is proof they do not. Only when neither side
  // offers an email does the product evidence get a say.
  const identity = account == null ? false : sameIdentity(status.email, account.email);
  const trustProfile = identity == null ? !contradictsProduct(account, cliType) : identity === true;
  return {
    accountUuid: account == null ? null : account.accountUuid,
    // Freshest source first, like the anchor: the CLI email reflects the live credential store,
    // while oauthAccount's can survive an account switch stale.
    email: status.email != null ? status.email : (account == null ? null : account.email),
    subscriptionType: cliType,
    rateLimitTier: trustProfile ? account.rateLimitTier : null,
    expiresAt: null,
    billingType: trustProfile ? account.billingType : null,
    seatTier: trustProfile ? account.seatTier : null,
    organizationType: trustProfile ? account.organizationType : null,
    detectedVia: trustProfile ? 'merged' : 'cli_status',
    anchor: buildAnchor(status, fileAnchor, tokenAnchor),
  };
}
