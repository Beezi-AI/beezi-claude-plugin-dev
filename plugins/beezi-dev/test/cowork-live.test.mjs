import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCoworkLiveLoop, desktopRunning, maybeSpawnCoworkLive } from '../lib/cowork-live.mjs';

function fixture(overrides = {}) {
  let now = 0; const syncs = [], statuses = [];
  const deps = { now: () => now, sleep: async ms => { now += ms; }, eligible: () => now < 120000,
    desktopRunning: () => true, fingerprint: () => 'one', sync: async () => { syncs.push(now); return { results: [{ ok: true }] }; },
    status: x => statuses.push(x), ...overrides };
  return { deps, syncs, statuses, time: () => now };
}
test('live worker scans initially, skips unchanged caches and exits on logout', async () => {
  const f = fixture(); const result = await runCoworkLiveLoop(f.deps);
  assert.deepEqual(f.syncs, [0]); assert.equal(result.reason, 'not-eligible');
});
test('live worker debounces changes and retries failed unchanged cache with backoff', async () => {
  const f = fixture(); let attempts = 0;
  f.deps.fingerprint = () => String(Math.floor(f.time() / 1000));
  f.deps.sync = async () => { f.syncs.push(f.time()); return ++attempts < 3 ? { unavailable: true } : { results: [{ ok: true }] }; };
  await runCoworkLiveLoop(f.deps);
  assert.deepEqual(f.syncs.slice(0, 3), [0, 15000, 45000]);
  assert.ok(f.syncs.every((x, i) => i === 0 || x - f.syncs[i - 1] >= 15000));
});
test('live worker survives idle Desktop and exits after app-close grace', async () => {
  const f = fixture({ eligible: () => true }); f.deps.desktopRunning = () => f.time() < 180000;
  const result = await runCoworkLiveLoop(f.deps);
  assert.equal(result.reason, 'desktop-closed'); assert.ok(f.time() >= 300000);
});
test('liveness errors have finite grace and Linux exits unsupported', async () => {
  const f = fixture({ eligible: () => true, desktopRunning: () => null });
  assert.equal((await runCoworkLiveLoop(f.deps)).reason, 'liveness-unavailable');
  assert.equal(desktopRunning({ platform: 'linux' }), false);
});

test('alternating absent and failed process checks cannot keep a worker alive indefinitely', async () => {
  const f = fixture(); f.deps.eligible = () => f.time() < 900000;
  f.deps.desktopRunning = () => Math.floor(f.time() / 30000) % 2 ? null : false;
  const result = await runCoworkLiveLoop(f.deps);
  assert.equal(result.reason, 'liveness-unavailable'); assert.equal(f.time(), 300000);
});
test('Windows liveness distinguishes Code cli from Desktop executable', () => {
  assert.equal(desktopRunning({ platform: 'win32', execFileSync: () => JSON.stringify(['C:\\Users\\u\\.local\\bin\\claude.exe']) }), false);
  assert.equal(desktopRunning({ platform: 'win32', execFileSync: () => JSON.stringify(['C:\\Program Files\\WindowsApps\\Claude_1_x64__id\\app\\claude.exe']) }), true);
  assert.equal(desktopRunning({ platform: 'win32', execFileSync: () => { throw Error('timeout'); } }), null);
});
test('startup is throttled and never spawns without linked live accounts', () => {
  let spawned = 0; const deps = { eligible: () => false, readState: () => null, writeState: () => {}, now: () => 100000, spawn: () => { spawned++; return true; } };
  assert.equal(maybeSpawnCoworkLive(deps), false);
  deps.eligible = () => true; assert.equal(maybeSpawnCoworkLive(deps), true);
  deps.readState = () => ({ attemptedAt: 99000 }); assert.equal(maybeSpawnCoworkLive(deps), false);
  assert.equal(spawned, 1);
});

test('failed unchanged cache is retried and account changes trigger a fresh pass', async () => {
  const f = fixture(); let attempts = 0;
  f.deps.eligible = () => f.time() < 90000 ? (f.time() < 60000 ? 'account-a' : 'account-b') : '';
  f.deps.sync = async () => { f.syncs.push(f.time()); return ++attempts === 1 ? { unavailable: true, results: [] } : { results: [{ ok: true }] }; };
  await runCoworkLiveLoop(f.deps);
  assert.deepEqual(f.syncs, [0, 15000, 60000]);
});

test('lease refuses a second worker and old owner cannot release replacement', async t => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { acquireCoworkLease } = await import('../lib/cowork-live-lease.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-live-lease-')), old = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir; t.after(() => { if (old == null) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = old; fs.rmSync(dir, { recursive: true, force: true }); });
  const first = acquireCoworkLease(); assert.ok(first); assert.equal(acquireCoworkLease(), null); assert.equal(first.heartbeat(), true);
  const lock = path.join(dir, 'cowork-live.lock'); const stale = new Date(Date.now() - 11 * 60000); fs.utimesSync(lock, stale, stale);
  const replacement = acquireCoworkLease(); assert.ok(replacement); assert.equal(first.heartbeat(), false); first.release();
  assert.equal(replacement.owns(), true); assert.equal(fs.existsSync(lock), true); replacement.release(); assert.equal(fs.existsSync(lock), false);
});
