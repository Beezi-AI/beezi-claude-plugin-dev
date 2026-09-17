import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enqueue, flushQueue, runCheckpoint } from '../lib/checkpoint.mjs';
import { runSessionStart } from '../lib/session-start.mjs';
import { readTrackingState, writeTrackingState } from '../lib/tracking.mjs';
import { queueDir } from '../lib/paths.mjs';
import { runAudit } from '../lib/session-audit.mjs';

const a = { key: 'aaaaaaaa', clientId: 'client-a', token: 'token-a', tenantName: 'Acme' };
const b = { key: 'bbbbbbbb', clientId: 'client-b', token: 'token-b', tenantName: 'Personal' };
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-account-hooks-'));
  process.env.BEEZI_HOME = dir;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a rejected queue darkens only its account; another account renews only its own bearer', async (t) => {
  home(t);
  for (const s of [a, b]) enqueue(s.key, { segmentId: 'segment', sessionId: 's' });
  const calls = [];
  const refreshes = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options.headers);
    const client = options.headers['X-Beezi-Client'];
    if (client === a.clientId) return { status: 403, json: async () => ({ code: 'TRACKING_DISABLED' }) };
    return { status: options.headers.Authorization === 'Bearer fresh-b' ? 200 : 401 };
  };
  const results = await Promise.all([a, b].map((s) => flushQueue(s, {
    fetchImpl,
    getAccessToken: async (_deps, options) => { refreshes.push(options); return 'fresh-b'; },
  })));
  assert.equal(results[0].trackingDisabled, true);
  assert.equal(results[1].flushed, 1);
  assert.equal(readTrackingState(a.key).trackingMode, 'disabled');
  assert.equal(readTrackingState(b.key), null);
  assert.deepEqual(refreshes, [{ account: b.key, forceRefresh: true }]);
  assert.equal(fs.readdirSync(queueDir(a.key)).length, 1);
  assert.equal(fs.readdirSync(queueDir(b.key)).length, 0);
  assert.ok(calls.filter((h) => h['X-Beezi-Client'] === a.clientId).every((h) => h.Authorization === 'Bearer token-a'));
});

test('checkpoint computes one delta and queues identical reports only to eligible accounts', async (t) => {
  const dir = home(t);
  const transcript = path.join(dir, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T10:00:00Z', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 10, output_tokens: 5 } } }) + '\n');
  const dark = { key: 'cccccccc', clientId: 'client-c', token: 'token-c' };
  writeTrackingState(dark.key, { trackingMode: 'disabled' });
  const result = await runCheckpoint({ session_id: 's', transcript_path: transcript, cwd: dir }, {
    env: {}, gitImpl: () => { throw Error('not a repository'); },
    readClaudeAccount: () => null,
    linkedSessions: async () => [a],
    listAccounts: async () => [a, b, dark].map(({ token, ...row }) => ({ ...row, status: 'linked' })),
  }, { skipFlush: true });
  assert.equal(result.enqueued, 1);
  const read = (s) => fs.readdirSync(queueDir(s.key)).map((name) => JSON.parse(fs.readFileSync(path.join(queueDir(s.key), name))));
  assert.deepEqual(read(a), read(b));
  assert.equal(fs.existsSync(queueDir(dark.key)), false);
});

test('session start keeps forbidden accounts isolated and preserves the update notice', async (t) => {
  home(t);
  const renewals = [];
  const synced = [];
  const message = await runSessionStart({ session_id: 's', cwd: '/nonexistent-beezi-test' }, {
    linkedSessions: async () => [a, b], listAccounts: async () => [], env: {},
    getAuthentication: async (_deps, options) => { renewals.push(options); throw Error('must not renew 403'); },
    takeUpgradeNotice: () => false, recordAuthResult: () => {},
    checkForUpdate: async () => 'Update available',
    gitImpl: () => null,
    reconcileBilling: () => ({ config: {}, source: 'subscription' }), isStale: () => false,
    syncAccount: async (session) => { synced.push(session.key); },
    fetchOauthKeyStatus: async () => null, statuslineCaptureDetached: () => false,
    fetchImpl: async (_url, options) => options.headers['X-Beezi-Client'] === a.clientId
      ? { status: 403 }
      : { status: 200, ok: true, json: async () => ({ trackingMode: 'live', backfillCompleted: true }) },
  });
  assert.deepEqual(renewals, []);
  assert.deepEqual(synced, [b.key]);
  assert.match(message, /Acme/);
  assert.match(message, /Update available$/);
  assert.equal(readTrackingState(a.key), null);
  assert.equal(readTrackingState(b.key).identity, b.clientId);
});

test('audit requires explicit account and retains temporary-auth failure status', async () => {
  assert.equal((await runAudit({}, {})).reason, 'no-account');
  let requested;
  const result = await runAudit({ getAuthentication: async (_deps, options) => {
    requested = options.account;
    return { authState: 'unavailable', reason: 'storage_unavailable' };
  } }, { account: b.key });
  assert.equal(requested, b.key);
  assert.equal(result.reason, 'auth-unavailable');
});


test('only the default account writes its portal plan back to machine billing', async (t) => {
  home(t);
  const plans = [];
  const queried = [];
  await runSessionStart({ session_id: 'plan', cwd: '/nonexistent-beezi-test' }, {
    linkedSessions: async () => [a, b], listAccounts: async () => [], getDefaultKey: async () => b.key,
    env: {}, takeUpgradeNotice: () => false, checkForUpdate: async () => null, gitImpl: () => null,
    reconcileBilling: () => ({ config: {}, source: 'subscription' }), isStale: () => false,
    syncAccount: async () => {}, statuslineCaptureDetached: () => false,
    fetchOauthKeyStatus: async (session) => {
      queried.push(session.key);
      return { known: true, subscriptionPlan: session.key === a.key ? 'pro' : 'max' };
    },
    recordResolvedKeyData: (status) => plans.push(status.subscriptionPlan),
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ trackingMode: 'live', backfillCompleted: true }) }),
  });
  assert.deepEqual(queried.sort(), [a.key, b.key]);
  assert.deepEqual(plans, ['max']);
});


test('account-index migration failure stays unavailable and retains update notice', async () => {
  const message = await runSessionStart({}, {
    listAccounts: async () => { throw Error('migration unavailable'); },
    takeUpgradeNotice: () => false,
    checkForUpdate: async () => 'Update available',
  });
  assert.match(message, /could not read.*saved login/);
  assert.match(message, /retry on its own/);
  assert.match(message, /Update available$/);
  assert.doesNotMatch(message, /not linked|beezi:login/);
});

test('session-start pairs each initial and renewed token with its credential client id', async (t) => {
  home(t);
  const headers = [];
  const diagnostics = [];
  const message = await runSessionStart({}, {
    listAccounts: async () => [{ ...a, token: undefined, clientId: 'stale-index-client' }],
    getAuthentication: async (_deps, options) => ({ authState: 'ready',
      accessToken: options.forceRefresh ? 'renewed-token' : 'initial-token',
      clientId: options.forceRefresh ? 'renewed-client' : 'initial-client',
    }),
    takeUpgradeNotice: () => false, checkForUpdate: async () => null,
    recordAuthResult: (auth, options) => diagnostics.push({ auth, options }),
    fetchImpl: async (_url, options) => {
      headers.push(options.headers);
      return { status: headers.length === 1 ? 401 : 403 };
    },
  });
  assert.equal(headers[0].Authorization, 'Bearer initial-token');
  assert.equal(headers[0]['X-Beezi-Client'], 'initial-client');
  assert.equal(headers[1].Authorization, 'Bearer renewed-token');
  assert.equal(headers[1]['X-Beezi-Client'], 'renewed-client');
  assert.equal(diagnostics[0].options.account, a.key);
  assert.match(message, /does not have access/);
});
