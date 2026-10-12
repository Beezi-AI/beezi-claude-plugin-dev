import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_QUESTION } from '../lib/setup-account.mjs';
import { CRASH_QUESTION, FINALIZE_NOTE } from '../lib/setup-finish.mjs';
import { PLAN_SKIPPED } from '../lib/setup-plan.mjs';
import { DONE, PLAN_PROGRESS, SESSIONS_PROGRESS, runSetup } from '../lib/setup-wizard.mjs';
import { commands, fail, fakeCtx, labels, ok } from './setup-fake-ctx.mjs';

const NOT_LINKED = ok('Beezi: this machine is not linked. Run /beezi:login to link an account.\n');
const NO_KEY = ok('{"ok":false,"status":"no_key","message":"Beezi: this machine does not sign in with a Claude setup token — its plan is read from the Claude login instead."}\n');
const login = (lines) => ok(`\nBeezi analytics — link an account\n\nOpening your browser to sign in with your Beezi account…\n\n${lines.join('\n')}\n`);
const W = ['W. Acme account=k2 tenant=t1 role=Owner', 'W. Beta account=k2 tenant=t2 role=Member'];
const JOINED = [
  'dev@example.com: you joined Beta — 2 repos or folders to review account=k2 new=t2',
  'W. Acme account=k2 tenant=t1 new=no role=Owner',
  'W. Beta account=k2 tenant=t2 new=yes role=Member',
  'J1. api (github.com/acme/api), 4 sessions, now: Acme account=k2 kind=repo match=github.com/acme/api now=t1',
  "J1-command=node \"/p/scripts/workspace.mjs\" rule add --repo 'github.com/acme/api' --account k2 <tenants>",
  'J2. notes (~/My notes), 1 session, now: no rule yet account=k2 kind=folder match=/Users/dev/My notes now=pending',
  "J2-command=node \"/p/scripts/workspace.mjs\" rule add --folder '/Users/dev/My notes' --account k2 <tenants>",
  'add-all-command=node "/p/scripts/workspace.mjs" joined add-all --account k2',
  'done-command=node "/p/scripts/workspace.mjs" joined done --account k2',
  'joined=2',
].join('\n');

function routes(n) {
  const lines = [`dev@example.com: ${n} repos or folders have past sessions with no rule (${n} sessions) account=k2`].concat(W);
  for (let i = 1; i <= n; i += 1) {
    lines.push(`P${i}. r${i} (github.com/acme/r${i}), 1 session account=k2 kind=repo match=github.com/acme/r${i}`);
  }
  lines.push('2 other past sessions have no recorded folder and are not sent.', `routes=${n}`);
  return lines.join('\n');
}

test('fresh single-workspace link: sign in, plan, upload, crash reports and status line', async () => {
  const capture = '✓ Beezi billing captured: source=subscription plan=max_20x via=claude-auth-status.';
  const ctx = fakeCtx({
    'accounts.mjs list': NOT_LINKED,
    'login.mjs': login(['✓ Beezi analytics linked as dev@example.com · Acme. Credentials stored in the macOS Keychain.', 'account=k1']),
    'workspace.mjs new-folders --account k1': ok('new-folders=n/a multi=no account=k1\n'),
    'billing-capture.mjs --from-claude --via login --account k1': ok(`${capture}\n`),
    'key-resolve.mjs status --account k1': NO_KEY,
    'workspace.mjs joined --account k1': ok('joined=0\n'),
    'workspace.mjs routes --account k1': ok('routes=0\n'),
    'backfill.mjs --via login --account k1': ok('Beezi: 2/2 sessions read…\n✓ Beezi: uploaded 2 sessions.\n✓ Beezi: your history pull is finalized.\n'),
    'settings.mjs keys': ok('crash=off statusline=off\n'),
    'telemetry.mjs correlate': ok('Beezi diagnostics are ON with account correlation.\n'),
    'statusline-install.mjs': ok('✓ Beezi: status line installed — live usage capture is on (folder · model · plan usage).\n'),
  }, [0, true]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(commands(ctx), [
    'accounts.mjs list',
    'login.mjs',
    'workspace.mjs new-folders --account k1',
    'billing-capture.mjs --from-claude --via login --account k1',
    'key-resolve.mjs status --account k1',
    'workspace.mjs joined --account k1',
    'workspace.mjs routes --account k1',
    'backfill.mjs --via login --account k1',
    'settings.mjs keys',
    'telemetry.mjs correlate',
    'statusline-install.mjs',
  ]);
  assert.equal(ctx.runs[1].opts.stream, true);
  assert.equal(ctx.runs[7].opts.stream, true);
  assert.deepEqual(ctx.asked.map((a) => a.kind), ['choose', 'confirm']);
  assert.deepEqual(ctx.printed, [
    PLAN_PROGRESS,
    capture,
    SESSIONS_PROGRESS,
    FINALIZE_NOTE,
    'Beezi diagnostics are ON with account correlation.',
    '✓ Beezi: status line installed — live usage capture is on (folder · model · plan usage).',
    DONE,
  ]);
  assert.equal(PLAN_PROGRESS, 'Checking your plan…');
  assert.equal(SESSIONS_PROGRESS, 'Looking at your past sessions…');
  assert.equal(DONE, 'Beezi is set up. Open Claude Code and keep working — restart it first if it was already open.');
});

test('already-linked multi-workspace account: continue, new folders, joined workspaces and send-all routes', async () => {
  const capture = '✓ Beezi billing captured: source=subscription plan=pro.';
  const ctx = fakeCtx({
    'accounts.mjs list': ok('1. dev@example.com · Acme [default] key=k2\n2. old@example.com [revoked] key=k9\n'),
    'workspace.mjs new-folders --account k2': ok(`New folders: Ask me\n${W.join('\n')}\nnew-folders=ask set=no multi=yes account=k2\n`),
    'workspace.mjs new-folders ask --account k2': ok('✓ New folders: Ask me — Beezi asks once per repo or folder.\nnew-folders=ask\n'),
    'billing-capture.mjs --from-claude --via login --account k2': ok(`${capture}\n`),
    'key-resolve.mjs status --account k2': NO_KEY,
    'workspace.mjs joined --account k2': ok(JOINED),
    'workspace.mjs routes --account k2': ok(routes(5)),
    'backfill.mjs --via login --account k2': ok('✓ Beezi: nothing new to upload.\n'),
    'settings.mjs keys': ok('crash=correlate statusline=on\n'),
    'telemetry.mjs correlate': ok('Beezi diagnostics are ON with account correlation.\n'),
  }, [0, 0, [1], [0, 1], 0, [0], 0]);
  assert.equal(await runSetup(ctx), 0);
  assert.equal(ctx.asked[0].question, ACCOUNT_QUESTION);
  assert.deepEqual(labels(ctx.asked[0]), ['Continue with dev@example.com · Acme', 'Link another account']);
  assert.deepEqual(commands(ctx), [
    'accounts.mjs list',
    'workspace.mjs new-folders --account k2',
    'workspace.mjs new-folders ask --account k2',
    'billing-capture.mjs --from-claude --via login --account k2',
    'key-resolve.mjs status --account k2',
    'workspace.mjs joined --account k2',
    'workspace.mjs rule add --repo github.com/acme/api --account k2 t2',
    'workspace.mjs rule add --folder /Users/dev/My notes --account k2 t1,t2',
    'workspace.mjs joined done --account k2',
    'workspace.mjs routes --account k2',
    'workspace.mjs rule add-all --account k2 t1',
    'backfill.mjs --via login --account k2',
    'settings.mjs keys',
    'telemetry.mjs correlate',
  ]);
  assert.deepEqual(ctx.printed, [
    '✓ New folders: Ask me — Beezi asks once per repo or folder.',
    PLAN_PROGRESS,
    capture,
    SESSIONS_PROGRESS,
    '2 other past sessions have no recorded folder and are not sent.',
    'Beezi diagnostics are ON with account correlation.',
    DONE,
  ]);
});

// Answers every question as pressing Enter does: its default, or null (skipped) when it has none.
function pressEnter(ctx) {
  ctx.ask.choose = (question, options, opts) => {
    ctx.asked.push({ kind: 'choose', question, options });
    return Promise.resolve(opts && typeof opts.defaultIndex === 'number' ? opts.defaultIndex : null);
  };
  ctx.ask.confirm = (question, defaultYes) => {
    ctx.asked.push({ kind: 'confirm', question, defaultYes });
    return Promise.resolve(defaultYes);
  };
  return ctx;
}

test('re-running setup on a configured machine and pressing Enter everywhere signs nothing in and changes nothing', async () => {
  const ctx = pressEnter(fakeCtx({
    'accounts.mjs list': ok('1. dev@example.com · Acme [default] key=k2\n'),
    'workspace.mjs new-folders --account k2': ok(`${W.join('\n')}\nnew-folders=ask set=yes multi=yes account=k2\n`),
    'billing-capture.mjs --from-claude --via login --account k2': ok('✓ Beezi billing captured: source=subscription plan=pro.\n'),
    'key-resolve.mjs status --account k2': NO_KEY,
    'workspace.mjs joined --account k2': ok('joined=0\n'),
    'workspace.mjs routes --account k2': ok('routes=0\n'),
    'backfill.mjs --via login --account k2': ok('✓ Beezi: nothing new to upload.\n'),
    'settings.mjs keys': ok('crash=anonymous statusline=on\n'),
  }, []));
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(commands(ctx), [
    'accounts.mjs list',
    'workspace.mjs new-folders --account k2',
    'billing-capture.mjs --from-claude --via login --account k2',
    'key-resolve.mjs status --account k2',
    'workspace.mjs joined --account k2',
    'workspace.mjs routes --account k2',
    'backfill.mjs --via login --account k2',
    'settings.mjs keys',
    'telemetry.mjs anonymous',
  ]);
  assert.deepEqual(ctx.asked.map((a) => a.kind), ['choose', 'choose']);
  assert.equal(ctx.asked[0].question, ACCOUNT_QUESTION);
});

test('re-running setup with a kept self-reported plan and pressing Enter everywhere skips the tier question and still asks about crash reports', async () => {
  const kept = 'Beezi: Claude account info still does not name a plan — keeping the self-reported plan.';
  const ctx = pressEnter(fakeCtx({
    'accounts.mjs list': ok('1. dev@example.com · Acme [default] key=k2\n'),
    'workspace.mjs new-folders --account k2': ok(`${W.join('\n')}\nnew-folders=ask set=yes multi=yes account=k2\n`),
    'billing-capture.mjs --from-claude --via login --account k2': ok(`${kept}\n`),
    'key-resolve.mjs status --account k2': NO_KEY,
    'workspace.mjs joined --account k2': ok('joined=0\n'),
    'workspace.mjs routes --account k2': ok('routes=0\n'),
    'backfill.mjs --via login --account k2': ok('✓ Beezi: nothing new to upload.\n'),
    'settings.mjs keys': ok('crash=anonymous statusline=on\n'),
  }, []));
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(ctx.asked.map((a) => a.question), [ACCOUNT_QUESTION, 'How does this machine pay for Claude?', CRASH_QUESTION]);
  assert.equal(commands(ctx).filter((c) => c.startsWith('billing-capture.mjs --plan')).length, 0);
  assert.ok(ctx.printed.indexOf(kept) !== -1);
  assert.ok(ctx.printed.indexOf(PLAN_SKIPPED) > ctx.printed.indexOf(kept));
  assert.equal(commands(ctx)[commands(ctx).length - 1], 'telemetry.mjs anonymous');
});

test('linking another account offers to make it the default, and a failing settings read does not stop setup', async () => {
  const ctx = fakeCtx({
    'accounts.mjs list': [
      ok('1. dev@example.com [default] key=k1\n'),
      ok('1. dev@example.com [default] key=k1\n2. ops@example.com · Beta key=k3\n'),
    ],
    'login.mjs': login([
      '  dev@example.com',
      '✓ Beezi analytics linked as ops@example.com · Beta. Credentials stored in the macOS Keychain.',
      '  /beezi:analytics still reads from dev@example.com.',
      'account=k3',
    ]),
    'accounts.mjs use k3': ok('✓ /beezi:analytics now reads from ops@example.com · Beta.\n'),
    'settings.mjs keys': fail("\n✗ Could not access Beezi's local data (EACCES). Check file permissions and try again.\n"),
  }, [1, true]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(commands(ctx), [
    'accounts.mjs list',
    'login.mjs',
    'workspace.mjs new-folders --account k3',
    'billing-capture.mjs --from-claude --via login --account k3',
    'key-resolve.mjs status --account k3',
    'workspace.mjs joined --account k3',
    'workspace.mjs routes --account k3',
    'backfill.mjs --via login --account k3',
    'accounts.mjs list',
    'accounts.mjs use k3',
    'settings.mjs keys',
  ]);
  assert.deepEqual(ctx.asked[1], { kind: 'confirm', question: 'Make ops@example.com · Beta the account /beezi:analytics reads from?', defaultYes: false });
  assert.deepEqual(ctx.printed, [
    PLAN_PROGRESS,
    SESSIONS_PROGRESS,
    '✓ /beezi:analytics now reads from ops@example.com · Beta.',
    "✗ Could not access Beezi's local data (EACCES). Check file permissions and try again.",
    DONE,
  ]);
});

test('a failing plan capture or upload is shown and setup still finishes', async () => {
  const ctx = fakeCtx({
    'accounts.mjs list': ok('1. dev@example.com [default] key=k1\n'),
    'billing-capture.mjs --from-claude --via login --account k1': fail('✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.\n'),
    'key-resolve.mjs status --account k1': NO_KEY,
    'backfill.mjs --via login --account k1': { code: 1, stdout: '', stderr: '✗ Beezi: the server does not support the history pull yet — try again after the portal update.\n' },
    'settings.mjs keys': ok('crash=on statusline=on\n'),
  }, [0, 1]);
  assert.equal(await runSetup(ctx), 0);
  assert.deepEqual(commands(ctx), [
    'accounts.mjs list',
    'workspace.mjs new-folders --account k1',
    'billing-capture.mjs --from-claude --via login --account k1',
    'key-resolve.mjs status --account k1',
    'workspace.mjs joined --account k1',
    'workspace.mjs routes --account k1',
    'backfill.mjs --via login --account k1',
    'settings.mjs keys',
    'telemetry.mjs on',
  ]);
  assert.deepEqual(ctx.printed, [
    PLAN_PROGRESS,
    '✗ Something went wrong. Re-run with BEEZI_DEBUG=1 to see details.',
    SESSIONS_PROGRESS,
    DONE,
  ]);
});

test('a failed, keyless or offline sign-in stops setup with exit 1 before any other step', async () => {
  const outcomes = [
    { code: 1, stdout: 'Opening your browser to sign in with your Beezi account…\n', stderr: '\n✗ Could not reach the Beezi server. Check your internet connection and try again.\n' },
    ok('Opening your browser to sign in with your Beezi account…\n'),
    { code: 1, stdout: '', stderr: '\n✗ The login server took too long to respond. Check BEEZI_API_URL, then try again.\n' },
  ];
  for (const outcome of outcomes) {
    const ctx = fakeCtx({ 'accounts.mjs list': NOT_LINKED, 'login.mjs': outcome }, []);
    assert.equal(await runSetup(ctx), 1);
    assert.deepEqual(commands(ctx), ['accounts.mjs list', 'login.mjs']);
    assert.deepEqual(ctx.printed, []);
  }
});

test('dismissing the account question stops setup with exit 1', async () => {
  const ctx = fakeCtx({ 'accounts.mjs list': ok('1. dev@example.com [default] key=k1\n') }, []);
  assert.equal(await runSetup(ctx), 1);
  assert.deepEqual(commands(ctx), ['accounts.mjs list']);
  assert.deepEqual(ctx.printed, []);
});
