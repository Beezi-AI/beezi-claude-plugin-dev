import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('runHook swallows a rejection, records it, and still exits clean', async () => {
  const { runHook } = await import('../lib/hook-runner.mjs?a');
  const { DIAGNOSTIC_CODES, DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?f');
  const recorded = [];
  let exited = null;

  await runHook(DIAGNOSTIC_SOURCES.STOP, async () => { throw new TypeError('boom'); }, {
    recordIssue: (event) => { recorded.push(event); return true; },
    exitClean: (code) => { exited = code; },
  });

  assert.equal(exited, 0, 'exit behaviour is unchanged');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].code, DIAGNOSTIC_CODES.HOOK_CRASH);
  assert.equal(recorded[0].source, DIAGNOSTIC_SOURCES.STOP);
  assert.equal(recorded[0].error.constructor.name, 'TypeError');
});

test('runHook records nothing when the hook succeeds', async () => {
  const { runHook } = await import('../lib/hook-runner.mjs?b');
  const { DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?g');
  const recorded = [];
  let exited = null;
  await runHook(DIAGNOSTIC_SOURCES.PULSE, async () => 'fine', {
    recordIssue: (e) => { recorded.push(e); return true; },
    exitClean: (code) => { exited = code; },
  });
  assert.deepEqual(recorded, []);
  assert.equal(exited, 0);
});

// The bug: fs-store and token.mjs hardcoded `source: 'checkpoint'` for failures reached from
// EVERY hook, and source is part of the dedup key, so failures from different hooks collapsed
// into one mislabeled row. Now the call site omits `source` and recordIssue falls back to
// whatever runHook published as the source currently in flight.
test('a state-write failure inherits the hook source instead of a hardcoded label', {
  skip: process.platform === 'win32' ? 'chmod-based write denial is not meaningful on win32' : false,
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-hookrunner-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = home;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const { grantConsent } = await import('../lib/telemetry-consent.mjs?src');
  grantConsent();
  const { runHook } = await import('../lib/hook-runner.mjs?src');
  const { writeJsonSecure } = await import('../lib/fs-store.mjs?src');
  const { DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?src');

  // A read-only dir: mkdirSync (already exists) succeeds, but writeFileSync of the temp file
  // fails — the path that reaches writeJsonSecure's guarded catch block.
  const blocked = path.join(home, 'blocked');
  fs.mkdirSync(blocked, { recursive: true });
  fs.chmodSync(blocked, 0o500);
  t.after(() => { try { fs.chmodSync(blocked, 0o700); } catch { /* best-effort */ } });

  await runHook(DIAGNOSTIC_SOURCES.STOP, async () => {
    writeJsonSecure(path.join(blocked, 'x.json'), { a: 1 });
  }, { exitClean: async () => {} });

  // fs-store's own report is fire-and-forgotten via a lazy import; give its microtasks a turn.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const telemetryDir = path.join(home, 'telemetry');
  const events = fs.readdirSync(telemetryDir).map((f) => JSON.parse(fs.readFileSync(path.join(telemetryDir, f), 'utf8')));
  const stateWrite = events.find((e) => e.code === 'state_write_failed');
  assert.ok(stateWrite, 'the failure was recorded');
  assert.equal(stateWrite.source, 'stop', 'inherits the hook that was running, not a hardcoded label');
});

test('a hook returning a value still gets its result to the caller', async () => {
  const { runHook } = await import('../lib/hook-runner.mjs?c');
  const { DIAGNOSTIC_SOURCES } = await import('../lib/telemetry-codes.mjs?h');
  const seen = [];
  await runHook(DIAGNOSTIC_SOURCES.SESSION_START, async () => 'msg', {
    recordIssue: () => true,
    exitClean: () => {},
    onResult: (value) => seen.push(value),
  });
  assert.deepEqual(seen, ['msg'], 'session-start needs its systemMessage');
});
