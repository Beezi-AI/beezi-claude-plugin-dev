import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAnalyticsSessions } from '../lib/analytics-sessions.mjs';
import { runCoworkSync } from '../lib/cowork-sync.mjs';

const snapshot = (cost = 1) => ({ source: 'claude-cowork', sessionId: 'runtime-id', mtimeMs: 1,
  costState: { totalCostUSD: cost }, shell: { startedAt: '2026-01-01T00:00:00Z' } });

test('discovery merges Cowork and Code and uses a single record for matching runtime UUID', () => {
  const rows = listAnalyticsSessions({ listTranscripts: () => [{ sessionId: 'code' }, { sessionId: 'runtime-id' }],
    scanCoworkCache: () => ({ sessions: [snapshot()], warnings: [] }) });
  assert.equal(rows.length, 2);
  assert.equal(rows.find(x => x.sessionId === 'runtime-id').source, 'claude-cowork');
});

test('unavailable Cowork cache preserves Code discovery', () => {
  assert.deepEqual(listAnalyticsSessions({ listTranscripts: () => [{ sessionId: 'code' }],
    scanCoworkCache: () => { throw Error('locked'); } }), [{ sessionId: 'code' }]);
});

test('unreadable Cowork cache remains visible and prevents sealing an incomplete import', async () => {
  const { shouldFinalize } = await import('../lib/session-audit.mjs');
  const rows = listAnalyticsSessions({ listTranscripts: () => [], scanCoworkCache: () => ({ sessions: [], warnings: ['unsupported'] }) });
  assert.equal(rows.coworkWarnings, 1);
  assert.equal(shouldFinalize({ ok: true, coworkWarnings: rows.coworkWarnings }, {}), false);
});

test('automatic Cowork sync scans once and uses existing sync shell path per eligible account', async () => {
  let scans = 0; const calls = [];
  const results = await runCoworkSync({
    linkedSessions: async () => [{ key: 'a' }, { key: 'b' }, { key: 'off' }],
    readTrackingState: key => key === 'off' ? { trackingMode: 'disabled' } : null,
    scanCoworkCache: () => { scans++; return { sessions: [snapshot()], warnings: [] }; },
    runAudit: async (deps, options) => { calls.push({ rows: deps.listTranscripts(), options }); return { ok: true }; },
  });
  assert.equal(scans, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.options), [{ mode: 'sync', account: 'a' }, { mode: 'sync', account: 'b' }]);
  assert.equal(calls[0].rows[0].source, 'claude-cowork');
  assert.equal(results.results.length, 2);
});

test('automatic Cowork sync never scans for unlinked or tracking-disabled accounts', async () => {
  for (const sessions of [[], [{ key: 'off' }]]) {
    await runCoworkSync({ linkedSessions: async () => sessions, readTrackingState: () => ({ trackingMode: 'disabled' }),
      scanCoworkCache: () => { throw Error('must not scan'); }, runAudit: () => { throw Error('must not upload'); } });
  }
});

test('automatic Cowork sync retries snapshots and forwards changed cumulative values without summing', async () => {
  const sent = []; let cost = 1;
  const deps = { linkedSessions: async () => [{ key: 'a' }], readTrackingState: () => null,
    scanCoworkCache: () => ({ sessions: [snapshot(cost)], warnings: [] }),
    runAudit: async d => { sent.push(d.listTranscripts()[0].costState.totalCostUSD); return { ok: false }; } };
  await runCoworkSync(deps); await runCoworkSync(deps); cost = 2; await runCoworkSync(deps);
  assert.deepEqual(sent, [1, 1, 2]);
});

test('audit lock contention reports busy and never reads credentials or cache', async () => {
  const { runAudit } = await import('../lib/session-audit.mjs');
  let releases = 0;
  const result = await runAudit({ acquireAuditLock: () => false, releaseAuditLock: () => releases++,
    getAuthentication: () => { throw Error('must not authenticate'); } }, { account: 'a' });
  assert.equal(result.reason, 'busy');
  assert.equal(releases, 0);
});

test('accepted cumulative snapshots cannot lose models or counters', async () => {
  const { nonRegressingSnapshot } = await import('../lib/cowork-snapshot.mjs');
  const previous = { total_cost_usd: 2, models: [{ model: 'opus', token_input: 4, cost_usd: 1 }, { model: 'haiku', token_input: 2, cost_usd: 1 }] };
  assert.equal(nonRegressingSnapshot({ total_cost_usd: 3, models: [{ model: 'opus', token_input: 10, cost_usd: 3 }] }, previous), previous);
  const next = { total_cost_usd: 3, models: [{ model: 'opus', token_input: 8, cost_usd: 2 }, { model: 'haiku', token_input: 2, cost_usd: 1 }] };
  assert.equal(nonRegressingSnapshot(next, previous), next);
});

test('live sync retries temporarily unavailable linked accounts and guards each request after opt-out', async () => {
  const missing = await runCoworkSync({ linkedSessions: async () => [], expectedAccountKeys: () => ['a'] }, { live: true });
  assert.equal(missing.unavailable, true);
  let allowed = true, fetched = 0;
  await runCoworkSync({ linkedSessions: async () => [{ key: 'a' }], expectedAccountKeys: () => ['a'], readTrackingState: () => null,
    scanCoworkCache: () => ({ sessions: [snapshot()], warnings: [] }), isEligible: () => allowed,
    fetchImpl: async () => { fetched++; }, runAudit: async (deps, options) => {
      assert.equal(options.coworkLive, true); await deps.fetchImpl('mock'); allowed = false;
      assert.throws(() => deps.fetchImpl('mock'), /tracking stopped/); assert.equal(deps.shouldContinue(), false); return { ok: true };
    } }, { live: true });
  assert.equal(fetched, 1);
});
