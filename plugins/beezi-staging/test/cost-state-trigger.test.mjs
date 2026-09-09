import { test } from 'node:test';
import assert from 'node:assert';
import { maybeSpawnCostStateSync } from '../lib/cost-state-trigger.mjs';

function makeDeps(overrides) {
  const spawned = [];
  const attempts = [];
  return {
    spawned, attempts,
    deps: {
      readState: () => null,
      markAttemptImpl: (ms) => attempts.push(ms),
      spawnImpl: (script) => { spawned.push(script); return true; },
      existsSyncImpl: () => true,
      now: () => 1_000_000,
      ...overrides,
    },
  };
}

test('spawns when due, and stamps the attempt BEFORE spawning', () => {
  const { spawned, attempts, deps } = makeDeps();
  assert.strictEqual(maybeSpawnCostStateSync(deps), true);
  assert.strictEqual(spawned.length, 1);
  assert.ok(spawned[0].endsWith('cost-state-sync.mjs'));
  assert.deepStrictEqual(attempts, [1_000_000]);
});

test('does not spawn inside the hour', () => {
  const { spawned, deps } = makeDeps({
    readState: () => ({ version: 1, attemptedAt: new Date(1_000_000 - 60_000).toISOString() }),
  });
  assert.strictEqual(maybeSpawnCostStateSync(deps), false);
  assert.strictEqual(spawned.length, 0);
});

test('never throws when spawning fails', () => {
  const { deps } = makeDeps({ spawnImpl: () => { throw new Error('EPERM'); } });
  assert.doesNotThrow(() => maybeSpawnCostStateSync(deps));
});

test('never throws when the state file is unreadable', () => {
  const { deps } = makeDeps({ readState: () => { throw new Error('EACCES'); } });
  assert.doesNotThrow(() => maybeSpawnCostStateSync(deps));
});

test('does not spawn for a machine that was never linked', () => {
  const { spawned, deps } = makeDeps({ existsSyncImpl: () => false });
  assert.strictEqual(maybeSpawnCostStateSync(deps), false);
  assert.strictEqual(spawned.length, 0);
});
