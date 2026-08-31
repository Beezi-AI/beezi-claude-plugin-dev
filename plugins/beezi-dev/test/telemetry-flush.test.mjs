import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

function seed(home, events) {
  const dir = path.join(home, 'telemetry');
  fs.mkdirSync(dir, { recursive: true });
  events.forEach((e, i) => fs.writeFileSync(path.join(dir, `e${i}.json`), JSON.stringify(e)));
  return dir;
}

const EVENT = {
  eventId: '11111111-1111-4111-8111-111111111111',
  code: 'hook_crash', source: 'stop', site: null, errorName: 'TypeError', errorCode: null,
  httpStatus: null, pluginVersion: '0.16.2', claudeCodeVersion: '2.1.251', nodeVersion: 'v22.17.0',
  os: 'darwin', osRelease: '25.4.0', arch: 'arm64', count: 2,
  firstSeenAt: '2026-08-28T10:00:00.000Z', lastSeenAt: '2026-08-28T10:05:00.000Z',
};

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-flush-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('sends pending events as one batch and deletes them on success', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT, { ...EVENT, eventId: '2' }]);
  const { flushTelemetry } = await import('../lib/telemetry-flush.mjs?a');

  const bodies = [];
  const result = await flushTelemetry('tok', {
    postJsonImpl: async (_url, _token, body) => { bodies.push(body); return { status: 200 }; },
  });

  assert.equal(bodies.length, 1, 'one request, not one per event');
  assert.equal(bodies[0].events.length, 2);
  assert.equal(result.sent, 2);
  assert.deepEqual(fs.readdirSync(dir), [], 'files removed once accepted');
});

test('keeps the files when the server fails', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  const { flushTelemetry } = await import('../lib/telemetry-flush.mjs?b');
  const result = await flushTelemetry('tok', { postJsonImpl: async () => ({ status: 503 }) });
  assert.equal(result.failed, 1);
  assert.equal(fs.readdirSync(dir).length, 1, 'retried next time');
});

test('drops a permanently rejected batch rather than retrying forever', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  const { flushTelemetry } = await import('../lib/telemetry-flush.mjs?c');
  await flushTelemetry('tok', { postJsonImpl: async () => ({ status: 400 }) });
  assert.deepEqual(fs.readdirSync(dir), [], '400 means this payload will never be accepted');
});

// The bug: every non-401 4xx was treated as permanent and unlinked, including 403. 403 means
// "not now" (e.g. an audit-mode tenant) rather than "never" — the same distinction checkpoint.mjs
// already makes for the queue.
test('keeps the files on 403, unlike a genuinely permanent 4xx', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  const { flushTelemetry } = await import('../lib/telemetry-flush.mjs?e');
  const result = await flushTelemetry('tok', { postJsonImpl: async () => ({ status: 403 }) });
  assert.equal(result.failed, 1);
  assert.equal(fs.readdirSync(dir).length, 1, '403 is not now, not never — kept for retry');
});

// The bug: only `{ value }.eventId` was checked, so a salvaged prefix missing a field the server
// DTO requires (pluginVersion, count, firstSeenAt, lastSeenAt) still joined the batch, 400'd the
// whole thing, and every file in the batch — including perfectly good ones — was deleted.
test('a malformed event is dropped on its own, and never takes the rest of the batch down with it', async (t) => {
  const home = withHome(t);
  const malformed = { eventId: 'bad', code: 'hook_crash', source: 'stop' }; // no pluginVersion/count/timestamps
  const dir = path.join(home, 'telemetry');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(EVENT));
  fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(malformed));

  const { flushTelemetry } = await import('../lib/telemetry-flush.mjs?f');
  const bodies = [];
  const result = await flushTelemetry('tok', {
    postJsonImpl: async (_url, _token, body) => { bodies.push(body); return { status: 200 }; },
  });

  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].events.length, 1, 'the malformed event never joins the batch');
  assert.equal(bodies[0].events[0].eventId, EVENT.eventId);
  assert.equal(result.sent, 1);
  assert.deepEqual(fs.readdirSync(dir), [], 'the malformed file is removed on its own, and the good one on success');
});

test('does nothing without a token', async (t) => {
  const home = withHome(t);
  seed(home, [EVENT]);
  const { flushTelemetry } = await import('../lib/telemetry-flush.mjs?d');
  let called = false;
  const result = await flushTelemetry(null, { postJsonImpl: async () => { called = true; return { status: 200 }; } });
  assert.equal(called, false);
  assert.equal(result.sent, 0);
});

test('a dark-mode tenant still drains diagnostics', async (t) => {
  const home = withHome(t);
  const dir = seed(home, [EVENT]);
  // Mark the workspace dark, the state runCheckpoint bails out on.
  const { markTrackingDisabled } = await import('../lib/tracking.mjs?dark');
  markTrackingDisabled('audit mode');

  const { runCheckpoint } = await import('../lib/checkpoint.mjs?dark');
  let posted = 0;
  await runCheckpoint(
    { session_id: 's', transcript_path: path.join(home, 'missing.jsonl'), cwd: home },
    { getAccessToken: async () => 'tok', postJsonImpl: async () => { posted += 1; return { status: 200 }; } },
  );

  assert.equal(posted, 1, 'gated for analytics, not for plugin health');
  assert.deepEqual(fs.readdirSync(dir), []);
});
