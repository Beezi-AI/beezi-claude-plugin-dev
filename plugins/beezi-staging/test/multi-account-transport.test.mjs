import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authHeaders, postJson } from '../lib/http.mjs';
import { probeIdentity } from '../lib/whoami.mjs';
import { syncAccountIfNeeded } from '../lib/account-sync.mjs';
import { writeTrackingState, readTrackingState } from '../lib/tracking.mjs';
import { runCostStateScan } from '../lib/cost-state-scan.mjs';
import { readSyncState, markSuccess } from '../lib/cost-state-sync-state.mjs';
import { drainStatuslineSnapshots } from '../lib/usage-snapshot-report.mjs';

const a = { key: 'a1b2c3d4', token: 'token-a', clientId: 'client-a' };
const b = { key: 'b1c2d3e4', token: 'token-b', clientId: 'client-b' };

function home(t) {
  const previous = process.env.BEEZI_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-accounts-transport-'));
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (previous == null) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('concurrent requests keep each bearer paired with its own machine client', async () => {
  const seen = [];
  const fetchImpl = async (url, request) => {
    await new Promise((resolve) => setTimeout(resolve, request.headers.Authorization.endsWith('a') ? 5 : 0));
    seen.push([request.headers.Authorization, request.headers['X-Beezi-Client']]);
    return { status: 200 };
  };
  await Promise.all([a, b].map((session) => postJson('https://example.test', session, {}, { fetchImpl })));
  assert.deepEqual(seen.sort(), [['Bearer token-a', 'client-a'], ['Bearer token-b', 'client-b']]);
  assert.throws(() => authHeaders('token'), /session/);
});

test('identity probe carries the tenant and the explicit session identity', async () => {
  const result = await probeIdentity(b, { fetchImpl: async (url, request) => {
    assert.equal(request.headers['X-Beezi-Client'], 'client-b');
    assert.equal(request.headers.Authorization, 'Bearer token-b');
    return { status: 200, ok: true, json: async () => ({ tenantId: 'tenant-b', tenantName: 'Workspace B' }) };
  } });
  assert.equal(result.identity.tenantId, 'tenant-b');
  assert.equal(result.identity.tenantName, 'Workspace B');
});

test('check-in dedupe and tracking opt-out are isolated per account', async (t) => {
  home(t);
  const sent = [];
  const deps = {
    env: {}, readBillingConfig: () => ({ accountUuid: 'vendor-id' }),
    fetchImpl: async (url, request) => { sent.push(request.headers.Authorization); return { status: 200 }; },
  };
  assert.equal((await syncAccountIfNeeded(a, {}, deps)).synced, true);
  assert.equal((await syncAccountIfNeeded(b, {}, deps)).synced, true);
  assert.equal((await syncAccountIfNeeded(a, {}, deps)).reason, 'unchanged');
  assert.deepEqual(sent, ['Bearer token-a', 'Bearer token-b']);
  writeTrackingState(a.key, { trackingMode: 'disabled' });
  assert.equal(readTrackingState(a.key).trackingMode, 'disabled');
  assert.equal(readTrackingState(b.key), null);
});

test('cost scan fans out and failed account cannot advance another account progress', async (t) => {
  home(t);
  const posted = [];
  const now = 10_000_000;
  const result = await runCostStateScan({
    linkedSessions: async () => [a, b],
    now: () => now,
    listTranscripts: () => [{ sessionId: 's', transcriptPath: '/fixture', mtimeMs: now - 3_600_000 }],
    readBlock: () => ({ totalCostUSD: 1, modelUsage: { model: { costUSD: 1, inputTokens: 2 } } }),
    postJsonImpl: async (url, session) => {
      posted.push(session.key);
      return { status: session.key === a.key ? 500 : 200,
        text: async () => JSON.stringify({ stored: 1, skipped: 0, errors: [] }) };
    },
  });
  assert.deepEqual(posted, [a.key, b.key]);
  assert.equal(result.results[0].clean, false);
  assert.equal(result.results[1].clean, true);
  assert.equal(readSyncState({ account: a.key }).lastScanAt, undefined);
  assert.ok(readSyncState({ account: b.key }).lastScanAt);
  assert.equal(readSyncState(), null);
  markSuccess(now, { account: a.key });
  assert.notEqual(readSyncState({ account: a.key }).lastScanAt, readSyncState({ account: b.key }).lastScanAt);
});

test('pending status-line observations survive while a linked recipient cannot load its token', async () => {
  let cleared = 0;
  const sent = [];
  const deps = {
    env: {},
    readPendingStatuslineUsage: () => [{ fetched_at: '2026-09-17T00:00:00Z', five_hour_pct: 25 }],
    clearPendingStatuslineUsage: (count) => { cleared += count; },
    readClaudeAccount: () => null,
    readBillingConfig: () => null,
    fetchImpl: async (url, request) => { sent.push(request.headers.Authorization); return { status: 200 }; },
  };
  assert.equal((await drainStatuslineSnapshots([a, { ...b, token: null }], deps)).posted, 0);
  assert.equal(cleared, 0);
  assert.deepEqual(sent, ['Bearer token-a']);
  assert.equal((await drainStatuslineSnapshots([a, b], deps)).posted, 1);
  assert.equal(cleared, 1);
});
