import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CRASH_QUESTION, DEFAULT_UNCHANGED, FINALIZE_NOTE, STATUS_LINE_QUESTION, askMachineSettings, crashChoice, offerDefault, uploadHistory,
} from '../lib/setup-finish.mjs';
import { commands, fail, fakeCtx, labels, ok } from './setup-fake-ctx.mjs';

const BACKFILL = 'backfill.mjs --via login --account k1';
const LISTING = ok('1. dev@example.com [default] key=k1\n2. ops@example.com · Beta key=k3\n');
const keys = (crash, statusline) => ({
  'settings.mjs keys': ok(`menu=Account|Crash reports & status line\naccount=k1 default=yes multi=no workspaces=1 status=linked email=dev@example.com\ncrash=${crash} statusline=${statusline}\n`),
});

test('uploadHistory streams the backfill and adds the finalize note only when the pull finalized', async () => {
  const done = fakeCtx({ [BACKFILL]: ok('Beezi: 3/3 sessions read…\n✓ Beezi: uploaded 3 sessions.\n✓ Beezi: your history pull is finalized.\n') }, []);
  await uploadHistory(done, 'k1');
  assert.deepEqual(commands(done), [BACKFILL]);
  assert.equal(done.runs[0].opts.stream, true);
  assert.deepEqual(done.printed, [FINALIZE_NOTE]);
  assert.equal(FINALIZE_NOTE, 'History import is now closed for this account: past sessions on other machines can no longer be imported. New sessions are still tracked everywhere Beezi is installed.');

  const open = fakeCtx({ [BACKFILL]: ok('✓ Beezi: nothing new to upload.\n') }, []);
  await uploadHistory(open, 'k1');
  assert.deepEqual(open.printed, []);

  const failed = fakeCtx({ [BACKFILL]: { code: 1, stdout: 'Beezi: 1/4 sessions read…\n', stderr: '✗ Beezi: the audit period has ended — new history pulls are disabled for this workspace.\n' } }, []);
  await uploadHistory(failed, 'k1');
  assert.deepEqual(failed.printed, []);
});

test('offerDefault asks nothing unless sign-in left another account as the default', async () => {
  const ctx = fakeCtx({}, []);
  await offerDefault(ctx, { key: 'k3', readsElsewhere: false });
  assert.equal(ctx.asked.length, 0);
  assert.equal(ctx.runs.length, 0);
});

test('offerDefault names the account, defaults to No and switches only on yes', async () => {
  const yes = fakeCtx({
    'accounts.mjs list': LISTING,
    'accounts.mjs use k3': ok('✓ /beezi:analytics now reads from ops@example.com · Beta.\n  If the analytics tools look wrong after switching workspaces, start a new Claude Code session.\n'),
  }, [true]);
  await offerDefault(yes, { key: 'k3', readsElsewhere: true });
  assert.deepEqual(yes.asked, [{ kind: 'confirm', question: 'Make ops@example.com · Beta the account /beezi:analytics reads from?', defaultYes: false }]);
  assert.deepEqual(commands(yes), ['accounts.mjs list', 'accounts.mjs use k3']);
  assert.deepEqual(yes.printed, ['✓ /beezi:analytics now reads from ops@example.com · Beta.']);

  const no = fakeCtx({ 'accounts.mjs list': LISTING }, [false]);
  await offerDefault(no, { key: 'k3', readsElsewhere: true });
  assert.deepEqual(commands(no), ['accounts.mjs list']);
  assert.deepEqual(no.printed, [DEFAULT_UNCHANGED]);

  const dismissed = fakeCtx({ 'accounts.mjs list': LISTING }, []);
  await offerDefault(dismissed, { key: 'k3', readsElsewhere: true });
  assert.deepEqual(commands(dismissed), ['accounts.mjs list']);
  assert.deepEqual(dismissed.printed, []);

  const unlisted = fakeCtx({ 'accounts.mjs list': fail('✗ boom\n') }, [false]);
  await offerDefault(unlisted, { key: 'k3', readsElsewhere: true });
  assert.equal(unlisted.asked[0].question, 'Make the account you just linked the account /beezi:analytics reads from?');
});

test("crashChoice offers settings.md's four options and marks the current mode as the default", () => {
  const off = crashChoice('off');
  assert.deepEqual(labels(off), ['Correlate (recommended)', 'On', 'Off', 'Anonymous']);
  assert.deepEqual(off.options.map((o) => o.mode), ['correlate', 'on', 'off', 'anonymous']);
  assert.deepEqual(off.options.map((o) => o.description), [
    'Crash reports with an installation ID, so support can find yours',
    'Crash reports without an installation ID',
    'No crash reports; pending ones are deleted, current setting',
    'Stay on, and delete the installation ID and the reports that carry it',
  ]);
  assert.equal(off.defaultIndex, 2);
  assert.equal(crashChoice('correlate').defaultIndex, 0);
  assert.equal(crashChoice('on').defaultIndex, 1);
  const anonymous = crashChoice('anonymous');
  assert.equal(anonymous.defaultIndex, 3);
  assert.equal(anonymous.options[3].description, 'Stay on, and delete the installation ID and the reports that carry it, current setting');
  assert.equal(anonymous.options[1].description, 'Crash reports without an installation ID');
  const unknown = crashChoice(null);
  assert.equal(unknown.defaultIndex, -1);
  assert.equal(unknown.options.some((o) => o.description.endsWith(', current setting')), false);
});

test('askMachineSettings runs telemetry.mjs for the kept mode too, and skips the status line when it is on', async () => {
  const ctx = fakeCtx(Object.assign(keys('off', 'on'), {
    'telemetry.mjs off': ok('Beezi diagnostics are OFF. Pending reports and the installation ID were deleted.\n'),
  }), [2]);
  await askMachineSettings(ctx);
  assert.equal(ctx.asked[0].question, CRASH_QUESTION);
  assert.equal(CRASH_QUESTION, 'How should Beezi crash reports work?');
  assert.equal(ctx.asked[0].defaultIndex, 2);
  assert.equal(ctx.asked.length, 1);
  assert.deepEqual(commands(ctx), ['settings.mjs keys', 'telemetry.mjs off']);
  assert.deepEqual(ctx.printed, ['Beezi diagnostics are OFF. Pending reports and the installation ID were deleted.']);
});

test('askMachineSettings runs telemetry.mjs for a changed mode and installs the status line on yes', async () => {
  const outputs = Object.assign(keys('off', 'off'), {
    'telemetry.mjs correlate': ok('Beezi diagnostics are ON with account correlation. An installation ID is attached, so a report can be matched to the last Beezi account linked here.\n'),
    'statusline-install.mjs': ok('✓ Beezi: status line installed — live usage capture is on (folder · model · plan usage).\n'),
  });
  const ctx = fakeCtx(outputs, [0, true]);
  await askMachineSettings(ctx);
  assert.deepEqual(commands(ctx), ['settings.mjs keys', 'telemetry.mjs correlate', 'statusline-install.mjs']);
  assert.deepEqual(ctx.asked[1], { kind: 'confirm', question: STATUS_LINE_QUESTION, defaultYes: true });
  assert.equal(STATUS_LINE_QUESTION, "Show Beezi in Claude Code's status line?");
  assert.deepEqual(ctx.printed, [
    'Beezi diagnostics are ON with account correlation. An installation ID is attached, so a report can be matched to the last Beezi account linked here.',
    '✓ Beezi: status line installed — live usage capture is on (folder · model · plan usage).',
  ]);
});

test('askMachineSettings maps each option to its own mode, and leaves the status line off on no', async () => {
  const on = fakeCtx(keys('correlate', 'off'), [1, false]);
  await askMachineSettings(on);
  assert.deepEqual(commands(on), ['settings.mjs keys', 'telemetry.mjs on']);
  const anonymous = fakeCtx(keys('correlate', 'off'), [3, false]);
  await askMachineSettings(anonymous);
  assert.deepEqual(commands(anonymous), ['settings.mjs keys', 'telemetry.mjs anonymous']);
});

test('askMachineSettings runs nothing on dismissals and reports a failing settings read', async () => {
  const dismissed = fakeCtx(keys('anonymous', 'off'), []);
  await askMachineSettings(dismissed);
  assert.deepEqual(commands(dismissed), ['settings.mjs keys']);
  assert.equal(dismissed.asked.length, 2);

  const failed = fakeCtx({ 'settings.mjs keys': fail("\n✗ Could not access Beezi's local data (EACCES). Check file permissions and try again.\n") }, []);
  await askMachineSettings(failed);
  assert.deepEqual(failed.printed, ["✗ Could not access Beezi's local data (EACCES). Check file permissions and try again."]);
  assert.equal(failed.asked.length, 0);

  const silent = fakeCtx({ 'settings.mjs keys': ok('menu=Account\n') }, []);
  await askMachineSettings(silent);
  assert.deepEqual(silent.printed, []);
  assert.equal(silent.asked.length, 0);
});
