import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

function withHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-prompt-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('the consent ask appears once and never again', async (t) => {
  withHome(t);
  const { consentPrompt } = await import('../lib/session-start.mjs?p');
  const first = consentPrompt();
  assert.ok(first && first.includes('/beezi:telemetry'), 'names the command to answer with');
  assert.equal(consentPrompt(), null, 'asked exactly once per machine');
});

test('turning telemetry off deletes anything still pending', async (t) => {
  const home = withHome(t);
  const { grantConsent, denyConsent } = await import('../lib/telemetry-consent.mjs?r');
  grantConsent();
  const dir = path.join(home, 'telemetry');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pending.json'), '{"eventId":"x"}');

  const { setTelemetry } = await import('../scripts/telemetry.mjs?r');
  setTelemetry('off');

  assert.equal(fs.existsSync(path.join(dir, 'pending.json')), false, 'nothing recorded before the change is sent after it');
});
