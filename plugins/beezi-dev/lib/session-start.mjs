import fs from 'fs';
import path from 'path';
import { getAccessToken as _getAccessToken } from './token.mjs';
import { flushQueue } from './checkpoint.mjs';
import { git as _git, resolveOriginRemote } from './git.mjs';
import { resolveRepoRoot } from './repo-timeline.mjs';
import {
  loadRepoMap,
  saveRepoMap,
  upsertRoot,
  pruneRepoMap,
  originFromGitConfig,
} from './repo-map.mjs';
import { stateDir } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { pruneStale } from './prune.mjs';
import { apiBase, ENDPOINTS } from './config.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { whoami } from './whoami.mjs';
import { getMachineClientId } from './machine-identity.mjs';
import {
  recordWhoami,
  readTrackingState,
  isLiveTrackingAllowed,
  shouldBackfill,
  TrackingMode,
} from './tracking.mjs';
import { BillingSource, hasCustomGateway } from './billing.mjs';
import { statuslineCaptureDetached as _statuslineCaptureDetached } from './statusline-install.mjs';
import {
  readBillingConfig as _readBillingConfig,
  writeBillingConfig as _writeBillingConfig,
  resolveSource as _resolveSource,
  isStale as _isStale,
} from './billing-config.mjs';
import { reconcileBillingConfig as _reconcileBillingConfig } from './billing-capture.mjs';
import { syncAccountIfNeeded as _syncAccountIfNeeded } from './account-sync.mjs';
import { fetchOauthKeyStatus as _fetchOauthKeyStatus } from './oauth-key-status.mjs';
import { recordResolvedKeyData as _recordResolvedKeyData } from './plan-writeback.mjs';
import {
  hasKeyBeenNotified as _hasKeyBeenNotified,
  markKeyNotified as _markKeyNotified,
} from './key-notice.mjs';
import { oauthTokenEnvWithOsProbe } from './claude-settings-env.mjs';
import { hasBeenAsked, markAsked } from './telemetry-consent.mjs';
import { checkForUpdate as _checkForUpdate } from './update-check.mjs';

// The composition idiom used throughout this file, extracted for the three return points.
function append(message, line) {
  if (!line) return message;
  return message ? `${message}\n${line}` : line;
}

// A hook cannot prompt interactively, so the ask names the command that answers it. Stamped as
// asked the moment it is shown, so it is shown exactly once per machine whatever the user does.
// Only ever called for a linked machine (see the call site) — an unlinked machine's only
// failures are auth failures, so there is nothing to ask.
export function consentPrompt() {
  if (hasBeenAsked()) return null;
  markAsked();
  return 'Beezi can send anonymous crash reports about the plugin itself — versions, OS, and '
    + 'which plugin file failed. Never your code, prompts, or file paths. It helps us fix bugs '
    + 'we would otherwise never see. Run /beezi:telemetry on to enable it, or /beezi:telemetry off '
    + 'to decline.';
}

// Resume guard: create cursor=0 ONLY if absent; never reset an existing session's cursor.
// Also records where the session lives (cwd + transcript path) so /beezi:track can find
// the transcript after the session cd's away from its launch directory — the mapping is
// refreshed on every start (resume may happen from a different directory).
export function initSessionState(sessionId, { cwd = null, transcriptPath = null } = {}) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = path.join(dir, `${sessionId}.json`);
  const state = readJson(p, { cursor: 0 });
  state.cwd = cwd;
  state.transcriptPath = transcriptPath;
  state.updatedAt = new Date().toISOString();
  writeJsonSecure(p, state);
}

// Pre-warm the persisted repo-map at session start so the checkpoint hot path resolves most dirs
// without shelling git. Resolves the launch cwd's root+origin; when the launch cwd is itself a
// non-repo parent (e.g. a multi-repo workspace folder), shallow-scans its immediate children (one
// level) for a .git and maps each child repo. Best-effort; never throws. Returns the (possibly
// mutated) map plus a dirty flag.
export function discoverRepos(cwd, gitImpl, map, deps = {}) {
  const fsImpl = deps.fs == null ? fs : deps.fs;
  let dirty = false;
  if (!cwd) return { map, dirty };
  const cache = new Map();
  const recordRoot = (root) => {
    if (!root) return;
    let origin = resolveOriginRemote(gitImpl, root);
    if (origin == null) origin = originFromGitConfig(root);
    upsertRoot(map, root, origin);
    dirty = true;
  };

  const launchRoot = resolveRepoRoot(gitImpl, cwd, cache, map);
  if (launchRoot) {
    recordRoot(launchRoot);
  } else {
    let entries;
    try { entries = fsImpl.readdirSync(cwd, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(cwd, entry.name);
      try {
        if (!fsImpl.existsSync(path.join(child, '.git'))) continue;
      } catch { continue; }
      const childRoot = resolveRepoRoot(gitImpl, child, cache, map);
      recordRoot(childRoot == null ? child : childRoot);
    }
  }
  return { map, dirty };
}

async function announceRepo(cwd, token, fetchImpl, gitImpl) {
  const remote = resolveOriginRemote(gitImpl, cwd);
  if (!remote) return null; // not a git repo — silent
  try {
    const res = await fetchImpl(`${apiBase()}${ENDPOINTS.reposStatus}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ remote }),
    });
    if (!res.ok) return null;
    const { connected, projectName } = await res.json();
    return connected
      ? `Beezi: repo connected${projectName ? ` to "${projectName}"` : ''}. Task-branch sessions will be tracked.`
      : 'Beezi: this repo is not connected to Beezi. No analytics tracked here.';
  } catch { return null; } // offline — silent
}

// whoami reports invalid for any 401/403, which covers an expired token and a permissions
// or wrong-environment refusal as well as a genuine revocation — too coarse to delete on.
// So this only decides what to *tell* the user; discarding credentials is left to the token
// endpoint naming the grant revoked, or to the user re-running /beezi:login.
// Offline/unknown (null) still reads as fine, so a check we couldn't run stays silent.
// The body is returned alongside the verdict — it carries the tenant's tracking policy.
async function probeToken(token, fetchImpl) {
  const who = await whoami(token, { fetchImpl });
  return { rejected: who != null && who.valid === false, who };
}

// Returns an optional systemMessage string (or null). Never throws for expected failures.
export async function runSessionStart(input, deps = {}) {
  const getAccessToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const gitImpl = deps.gitImpl == null ? _git : deps.gitImpl;
  const resolveSource = deps.resolveSource == null ? _resolveSource : deps.resolveSource;
  const readBillingConfig = deps.readBillingConfig == null ? _readBillingConfig : deps.readBillingConfig;
  const writeBillingConfig = deps.writeBillingConfig == null ? _writeBillingConfig : deps.writeBillingConfig;
  const isStale = deps.isStale == null ? _isStale : deps.isStale;
  const recordWhoamiImpl = deps.recordWhoamiImpl == null ? recordWhoami : deps.recordWhoamiImpl;
  const statuslineCaptureDetached =
    deps.statuslineCaptureDetached == null ? _statuslineCaptureDetached : deps.statuslineCaptureDetached;

  // The plugin's own version check. Started BEFORE the credential store is touched (getAccessToken
  // may spawn `security` / `secret-tool` / PowerShell) and awaited only at the return points, so its
  // bounded fetch overlaps work that was going to happen anyway and adds no serial latency.
  //
  // Deliberately NOT behind the token check or the liveAllowed gate: a stale plugin is stale whether
  // or not this machine is linked or its tenant tracks anything, and an unlinked machine is exactly
  // the one that may be unlinked because of a bug a newer build already fixes.
  //
  // It is NOT handed this call's fetchImpl: that one is a Beezi-API client with a Beezi bearer, and
  // the manifest lives on raw.githubusercontent.com. update-check resolves its own, unauthenticated.
  //
  // .catch() at creation, not at the await: a promise created here and awaited three branches later
  // must never be able to surface as an unhandledRejection in between.
  const checkUpdate = deps.checkForUpdate == null ? _checkForUpdate : deps.checkForUpdate;
  const updatePromise = Promise.resolve().then(() => checkUpdate()).catch(() => null);

  let token = null;
  try { token = await getAccessToken(); } catch { token = null; }
  if (!token) {
    return append(
      '⚠ Beezi: this machine is not linked — analytics are NOT being tracked. Run /beezi:login to link it.',
      await updatePromise,
    );
  }

  let probe = await probeToken(token, fetchImpl);
  if (probe.rejected) {
    // The 401 is the server's verdict on the token; expires_at was only ours, and a server that
    // omits expires_in leaves it a guess. Take the server's word and refresh once before
    // declaring the link bad — otherwise a token that died earlier than we estimated is never
    // renewed, and every session reports a rejection that a single refresh would have fixed.
    const refreshed = await getAccessToken({}, { forceRefresh: true }).catch(() => null);
    probe = refreshed ? await probeToken(refreshed, fetchImpl) : { rejected: true, who: null };
    if (!refreshed || probe.rejected) {
      return append(
        '⚠ Beezi: this machine’s link was rejected — analytics are NOT being tracked. Run /beezi:login to re-link.',
        await updatePromise,
      );
    }
    token = refreshed;
  }

  // ONE env for the whole hook. Claude Code 2.1.251 deletes CLAUDE_CODE_OAUTH_TOKEN from every
  // child environment it builds, so this hook never inherits a setup token however the user set
  // it: the answer has to be recovered, from the user settings file and then from the OS-level
  // persistent environment. That recovery can spawn, so it is done exactly once here and handed to
  // every consumer below (billing reconcile, account check-in, key status) rather than letting each
  // one re-resolve it off its own default parameter — which would also let them disagree.
  //
  // Deliberately below the token guards, not at the very top: a machine that is not linked, or
  // whose link was rejected, has already returned by here and never pays for the probe.
  // Only the probe seam is forwarded, never the whole deps bag — os-env-token disables its own
  // per-process cache the moment it sees an injected env/platform/run.
  const oauthEnv = deps.env == null
    ? oauthTokenEnvWithOsProbe(process.env, { osEnvOauthToken: deps.osEnvOauthToken })
    : deps.env;

  // Persist the tenant's tracking policy BEFORE the flush below, so a freshly-disabled tenant
  // never gets one last ungated drain. Bound to this login's client id — a workspace switch
  // must not inherit the previous tenant's flags.
  try {
    let clientId = getMachineClientId();
    if (clientId == null) clientId = probe.who == null ? undefined : probe.who.email;
    recordWhoamiImpl(probe.who, clientId == null ? null : clientId);
  } catch { /* best-effort */ }
  const tracking = readTrackingState();
  const liveAllowed = isLiveTrackingAllowed(tracking);

  initSessionState(input.session_id, { cwd: input.cwd == null ? null : input.cwd, transcriptPath: input.transcript_path == null ? null : input.transcript_path });
  // Independent network I/O on the per-session hot path — flush queued checkpoints
  // and probe repo status concurrently rather than serially. A dark workspace skips the repo
  // probe's promise entirely: "Task-branch sessions will be tracked" would be a lie there.
  const [, systemMessage] = await Promise.all([
    flushQueue(token, { fetchImpl }),
    liveAllowed ? announceRepo(input.cwd, token, fetchImpl, gitImpl) : Promise.resolve(null),
  ]);
  try { pruneStale(); } catch { /* best-effort */ }

  // Pre-warm + self-heal the repo-map: discover this session's repo(s) and drop dead roots.
  try {
    const map = loadRepoMap();
    const { dirty } = discoverRepos(input.cwd, gitImpl, map);
    const removed = pruneRepoMap(map);
    if (dirty || removed > 0) saveRepoMap(map);
  } catch { /* best-effort */ }

  // Reconcile billing.json against reality: realign the source to the env (the user may have
  // switched auth method since the last session), and re-capture the plan when the record is
  // missing, stuck on `unknown`, stale, or belongs to a different Claude account. All the logic
  // lives in reconcileBillingConfig; best-effort — a failure must not break session start.
  const reconcileBilling = deps.reconcileBilling == null
    ? (() => _reconcileBillingConfig({
      readBillingConfig,
      writeBillingConfig,
      resolveSource,
      isStale,
      env: oauthEnv,
      resolveClaudeSubscription: deps.resolveClaudeSubscription,
      readClaudeAccountAnchor: deps.readClaudeAccountAnchor,
    }))
    : deps.reconcileBilling;
  let billingConfig = null;
  let billingSource = BillingSource.UNKNOWN;
  let billingOutcome = 'none';
  try {
    const reconciled = reconcileBilling();
    billingConfig = reconciled.config;
    billingSource = reconciled.source;
    billingOutcome = reconciled.outcome == null ? 'none' : reconciled.outcome;
  } catch { /* best-effort */ }

  // Tell the portal which Claude account and credentials this machine is on. Fire-and-forget: the
  // hook must not wait on it, and it never throws. The steady state (unchanged payload, synced
  // within the week) reads one file and sends nothing, so this costs nothing on a normal start.
  // A reconcile that switched accounts or captured fresh identity forces the send — that is the
  // only moment the portal can learn about an account switch.
  const syncAccount = deps.syncAccount == null ? _syncAccountIfNeeded : deps.syncAccount;
  // The config the reconcile above just settled is handed over directly — re-reading billing.json
  // here would be a second file read for an answer already in hand.
  const reconciledConfig = billingConfig;
  const syncDeps = { fetchImpl, env: oauthEnv, readBillingConfig: () => reconciledConfig };
  // HELD, not discarded. Still fire-and-forget for every path that does not need it — the catch is
  // attached here at creation, so awaiting it later can only yield a value, never throw. The one
  // path that does await it is the unknown-key branch below: that check-in is what registers this
  // key with the portal, so asking again before it lands would just re-read "unknown".
  let syncPromise = null;
  try {
    const forced = billingOutcome === 'switched' || billingOutcome === 'captured';
    syncPromise = Promise.resolve(
      syncAccount(token, { force: forced, via: 'session-start' }, syncDeps),
    ).catch(() => null);
  } catch { /* best-effort */ }

  let message = systemMessage;
  // Billing nudges are noise for a workspace that reports nothing live.
  if (liveAllowed) {
    if (billingSource === BillingSource.SUBSCRIPTION && isStale(billingConfig)) {
      const nudge = 'Beezi: subscription plan info is missing or stale — run /beezi:refresh to update it.';
      message = message ? `${message}\n${nudge}` : nudge;
    } else if (billingSource === BillingSource.UNKNOWN) {
      // Reported honestly as `unknown` rather than guessed. Only the user can resolve it, and
      // without this they would never learn their usage is landing unattributed. A custom gateway
      // gets its own wording: there the machine is not missing a signal, it has one it cannot
      // interpret — the route may forward this machine's subscription credential or bill the
      // gateway's own — so the nudge names the question the user is being asked to settle.
      const nudge = hasCustomGateway()
        ? 'Beezi: this machine sends Claude Code through a custom API endpoint (gateway), so its billing cannot be read locally — usage is reported as "unknown". Run /beezi:login to say whether your Claude subscription or the gateway pays.'
        : 'Beezi: cannot determine how this machine bills Claude — usage is reported as "unknown". Run /beezi:login to set it.';
      message = message ? `${message}\n${nudge}` : nudge;
    }

    // A setup-token machine is the one case the UNKNOWN nudge above structurally cannot reach:
    // billing.mjs forces SUBSCRIPTION for CLAUDE_CODE_OAUTH_TOKEN, so that branch never fires. The
    // stale branch CAN fire — isStale() returns true for a config carrying no plan, or one whose
    // plan was deliberately cleared — but it says the wrong thing there: it points at a local
    // re-capture, and a setup-token machine has nothing local to re-capture. Claude Code writes no
    // account metadata under that auth mode, so only the portal knows whether that key has been
    // given an account and a plan.
    //
    // Answered from a cached verdict, so the steady state is one file read. A null answer means the
    // question could not be asked, which is not the same as "unresolved" and says nothing.
    const fetchKeyStatus = deps.fetchOauthKeyStatus == null
      ? _fetchOauthKeyStatus
      : deps.fetchOauthKeyStatus;
    let keyStatus = null;
    try {
      keyStatus = await fetchKeyStatus(token, { fetchImpl, env: oauthEnv });
    } catch { /* best-effort */ }

    // A key the portal has never seen reports its usage unpriced and, worse, says nothing about it:
    // the server withholds needsAttention for an unknown key on purpose, because the check-in that
    // registers it rides this very hook and a first run would otherwise always nudge. So register
    // it, then ask again.
    //
    // Gated on a REAL answer of `known: false`. A null is "could not ask" — offline, an older
    // server, or no token on this machine at all — and nulls are never cached, so treating null as
    // unknown would make every token-less and every offline machine pay a serial check-in plus a
    // second probe on every single session, forever, for a question that has no answer.
    if (keyStatus != null && keyStatus.known === false) {
      try {
        // Await whatever is already in flight, then force one. syncAccountIfNeeded's hash gate
        // skips the POST when the payload is unchanged and the weekly resync is not due — which is
        // exactly the state of a machine whose key is unknown to the portal for any reason other
        // than a changed payload (a tenant switch after re-login, a server-side restore). Without
        // the force the key stays unregistered for up to a week and no nudge ever fires, because
        // needsAttention requires `known`.
        if (syncPromise != null) await syncPromise;
        await Promise.resolve(
          syncAccount(token, { force: true, via: 'session-start' }, syncDeps),
        ).catch(() => null);
        const reprobed = await fetchKeyStatus(token, { fetchImpl, env: oauthEnv, refresh: true });
        if (reprobed != null) keyStatus = reprobed;
      } catch { /* best-effort */ }
    }

    const recordKeyData = deps.recordResolvedKeyData == null
      ? _recordResolvedKeyData
      : deps.recordResolvedKeyData;
    if (keyStatus != null && keyStatus.needsAttention) {
      // Points at /beezi:refresh, not at the portal: that command IS this flow — it reads the same
      // resolution, offers the same plans and subscriptions, and writes the answer back here.
      // Sending the user to a web page to do what the prompt they are standing at can do is one
      // context switch for nothing.
      const nudge = 'Beezi: this machine signs in with a Claude setup token, and Beezi does not know which subscription it bills — its usage is reported without a plan. Run /beezi:refresh to set the plan or link this key to an existing subscription.';
      message = message ? `${message}
${nudge}` : nudge;
    } else if (keyStatus != null && keyStatus.known && keyStatus.subscriptionPlan != null) {
      // The portal already knows what this key bills. Adopt the WHOLE answer into billing.json —
      // plan, subscription type, tier, account email, and the fingerprint it is all scoped to — so
      // the reports carry it from this session on, instead of waiting for the user to run
      // /beezi:refresh and instead of shipping whatever a previous interactive login left behind.
      // Best-effort and silent by contract: nothing changed for the user to read about.
      try { recordKeyData(keyStatus); } catch { /* best-effort */ }

      // One exception to the silence. The portal priced this key against an account that carries an
      // identity of its own — an email or a vendor uuid — and the plan was never confirmed for the
      // key itself, only reported by some machine. That is what a key inheriting a subscription an
      // interactive sign-in established looks like, and it may not be the subscription the token
      // belongs to. The user cannot fix it from here (a /link refuses an account with its own
      // identity), so this is a notice, not a nudge — said once per key, and re-armed by rotation.
      if (keyStatus.accountAnchored === true && keyStatus.planSource === 'reported') {
        const notified = deps.hasKeyBeenNotified == null
          ? _hasKeyBeenNotified
          : deps.hasKeyBeenNotified;
        const markNotified = deps.markKeyNotified == null ? _markKeyNotified : deps.markKeyNotified;
        try {
          if (!notified(keyStatus.fingerprint)) {
            const named = keyStatus.accountEmail == null ? '' : ` (${keyStatus.accountEmail})`;
            const notice = `Beezi: this machine's Claude setup token bills a subscription${named} that an earlier sign-in established, not one confirmed for the key itself. If that is the wrong subscription, ask your Beezi admin to re-point it.`;
            message = message ? `${message}\n${notice}` : notice;
            markNotified(keyStatus.fingerprint);
          }
        } catch { /* best-effort */ }
      }
    }

    // The status-line wrapper is the only source of LIVE plan-usage readings, and it is a
    // settings.json entry anything can overwrite. Silence here would read as "still tracking".
    let detached = false;
    try { detached = statuslineCaptureDetached(); } catch { /* best-effort */ }
    if (detached) {
      const nudge = 'Beezi: your status line no longer runs Beezi’s wrapper, so live plan-usage capture is off. Run /beezi:login to wrap it again.';
      message = message ? `${message}\n${nudge}` : nudge;
    }
  }

  // Tracking-policy messages: tell a dark workspace it is dark, and point at the login flow
  // wherever the one-time history pull has not completed yet (paid tenants included) — the
  // backfill runs as the last step of /beezi:login.
  const mode = tracking == null || tracking.trackingMode == null ? null : tracking.trackingMode;
  let policy = null;
  if (mode === TrackingMode.BACKFILL_ONLY) {
    policy = shouldBackfill(tracking)
      ? 'Beezi: audit mode — new sessions are not tracked. Run /beezi:login to upload your session history, or upgrade your workspace plan to track new sessions.'
      : 'Beezi: audit mode — new sessions are not tracked. Upgrade your workspace plan to start tracking them.';
  } else if (mode === TrackingMode.DISABLED) {
    policy = 'Beezi: analytics are off for this workspace.';
  } else if (shouldBackfill(tracking)) {
    policy = 'Beezi: run /beezi:login once to include your past sessions.';
  }
  if (policy) message = message ? `${message}\n${policy}` : policy;

  const consentAsk = consentPrompt();
  if (consentAsk) message = message ? `${message}\n${consentAsk}` : consentAsk;

  // Appended last, after the consent ask, so every existing assertion on the earlier lines is
  // untouched by a nudge that only ever adds a trailing line.
  return append(message, await updatePromise);
}
