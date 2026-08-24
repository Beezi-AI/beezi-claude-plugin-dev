import { execFileSync } from 'child_process';
import { readClaudeAccount as _readClaudeAccount, readClaudeAccountAnchor as _readClaudeAccountAnchor } from './claude-account.mjs';

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

// The best available account identity, freshest source first: the CLI's email reflects the LIVE
// credential store, while oauthAccount can survive an account switch stale (its accountUuid then
// names the previous account) and userID is a last-resort opaque hash from ~/.claude.json.
function buildAnchor(status, fileAnchor) {
  if (status != null && status.email != null) return { value: status.email, source: 'email' };
  return fileAnchor == null ? null : fileAnchor;
}

// Layered subscription resolution, shaped like readClaudeAccount()'s result so every existing
// consumer works unmodified. subscriptionType comes from the CLI when it answers (fresh by
// construction); the Max multiplier lives only in oauthAccount's rateLimitTier and is kept ONLY
// when oauthAccount agrees on the type — a stale profile from the previous account must not
// donate its multiplier to the current one.
export function resolveClaudeSubscription(deps = {}) {
  const readStatus = deps.runClaudeAuthStatus == null ? runClaudeAuthStatus : deps.runClaudeAuthStatus;
  const readAccount = deps.readClaudeAccount == null ? _readClaudeAccount : deps.readClaudeAccount;
  const readFileAnchor = deps.readClaudeAccountAnchor == null ? _readClaudeAccountAnchor : deps.readClaudeAccountAnchor;

  let status = null;
  try { status = readStatus(); } catch { status = null; }
  let account = null;
  try { account = readAccount(); } catch { account = null; }
  let fileAnchor = null;
  try { fileAnchor = readFileAnchor(); } catch { fileAnchor = null; }

  const cliType = status != null && status.loggedIn === true ? status.subscriptionType : null;
  if (cliType == null) {
    // No CLI answer: oauthAccount alone, exactly the pre-existing behavior.
    if (!account) return null;
    return { ...account, detectedVia: 'oauth_account', anchor: buildAnchor(status, fileAnchor) };
  }

  const agree = account != null
    && account.subscriptionType != null
    && String(account.subscriptionType).toLowerCase() === cliType.toLowerCase();
  return {
    accountUuid: account == null ? null : account.accountUuid,
    subscriptionType: cliType,
    rateLimitTier: agree ? account.rateLimitTier : null,
    expiresAt: null,
    billingType: agree ? account.billingType : null,
    seatTier: agree ? account.seatTier : null,
    organizationType: agree ? account.organizationType : null,
    detectedVia: agree ? 'merged' : 'cli_status',
    anchor: buildAnchor(status, fileAnchor),
  };
}
