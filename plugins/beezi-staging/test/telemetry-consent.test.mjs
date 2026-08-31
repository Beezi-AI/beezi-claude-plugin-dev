import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-consent-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('consent is off until explicitly granted', async (t) => {
  withHome(t);
  const { isTelemetryGranted, hasBeenAsked } = await import('../lib/telemetry-consent.mjs?1');
  assert.equal(isTelemetryGranted(), false, 'default is off');
  assert.equal(hasBeenAsked(), false);
});

test('granting then denying flips the gate and records the decision', async (t) => {
  withHome(t);
  const m = await import('../lib/telemetry-consent.mjs?2');
  m.grantConsent();
  assert.equal(m.isTelemetryGranted(), true);
  assert.ok(m.readConsent().decidedAt, 'decision is timestamped');
  m.denyConsent();
  assert.equal(m.isTelemetryGranted(), false);
});

test('markAsked records the ask without granting anything', async (t) => {
  withHome(t);
  const m = await import('../lib/telemetry-consent.mjs?3');
  m.markAsked();
  assert.equal(m.hasBeenAsked(), true, 'so the prompt never fires twice');
  assert.equal(m.isTelemetryGranted(), false, 'being asked is not consenting');
});
