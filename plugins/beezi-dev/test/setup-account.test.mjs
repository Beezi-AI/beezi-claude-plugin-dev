import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_QUESTION, STILL_READS, chooseAccount, signInResult, usableAccounts } from '../lib/setup-account.mjs';
import { commands, fail, fakeCtx, ok } from './setup-fake-ctx.mjs';

const NOT_LINKED = ok('Beezi: this machine is not linked. Run /beezi:login to link an account.\n');
const LISTING = ok([
  '1. Jane Doe <jane@example.com> · Acme key=aa11bb22',
  '2. ops@example.com · Beta [default] key=cc33dd44',
  '3. old@example.com [revoked] key=ee55ff66',
  '4. gone@example.com [default, revoked] key=0a0b0c0d',
  '',
].join('\n'));
const LOGIN = ok([
  '',
  'Beezi analytics — link an account',
  '',
  'Opening your browser to sign in with your Beezi account…',
  '',
  '✓ Beezi analytics linked as dev@example.com. Credentials stored in the macOS Keychain.',
  'account=k1',
  '',
].join('\n'));

test('usableAccounts reads descriptions, keys and the default flag, and drops revoked rows', () => {
  assert.deepEqual(usableAccounts(LISTING.stdout), [
    { description: 'Jane Doe <jane@example.com> · Acme', key: 'aa11bb22', isDefault: false },
    { description: 'ops@example.com · Beta', key: 'cc33dd44', isDefault: true },
  ]);
  assert.deepEqual(usableAccounts(NOT_LINKED.stdout), []);
  assert.deepEqual(usableAccounts('No default account is set — /beezi:analytics has nothing to read from.\n'), []);
});

test('signInResult takes the account= line and notes when another account stays the default', () => {
  assert.deepEqual(signInResult(LOGIN), { key: 'k1', readsElsewhere: false });
  const elsewhere = ok(`✓ Beezi analytics linked as ops@example.com. Credentials stored in a file.\n  ${STILL_READS} dev@example.com.\naccount=k3\n`);
  assert.deepEqual(signInResult(elsewhere), { key: 'k3', readsElsewhere: true });
  const already = ok('\n✓ This machine is already linked as dev@example.com.\naccount=k1\n');
  assert.deepEqual(signInResult(already), { key: 'k1', readsElsewhere: false });
});

test('signInResult is null for a failed exit, a missing key or a network error', () => {
  assert.equal(signInResult({ code: 1, stdout: 'Opening your browser…\n', stderr: '\n✗ Login cancelled.\n' }), null);
  assert.equal(signInResult(ok('Opening your browser…\n')), null);
  assert.equal(signInResult({ code: 0, stdout: 'account=k1\n', stderr: '✗ Could not reach the Beezi server. Check your internet connection and try again.\n' }), null);
  assert.equal(signInResult(ok('The login server took too long to respond. Check BEEZI_API_URL, then try again.\naccount=k1\n')), null);
});

test('chooseAccount signs in, streamed with the account line hidden, when nothing is linked', async () => {
  const ctx = fakeCtx({ 'accounts.mjs list': NOT_LINKED, 'login.mjs': LOGIN }, []);
  assert.deepEqual(await chooseAccount(ctx), { key: 'k1', readsElsewhere: false });
  assert.deepEqual(commands(ctx), ['accounts.mjs list', 'login.mjs']);
  const login = ctx.runs[1].opts;
  assert.equal(login.stream, true);
  assert.equal(login.hide.test('account=k1'), true);
  assert.equal(login.hide.test('✓ Beezi analytics linked as dev@example.com.'), false);
  assert.equal(ctx.asked.length, 0);
});

test('chooseAccount offers the default account first and preselected, then the others, then Link another account', async () => {
  const ctx = fakeCtx({ 'accounts.mjs list': LISTING }, [0]);
  assert.deepEqual(await chooseAccount(ctx), { key: 'cc33dd44', readsElsewhere: false });
  assert.equal(ctx.asked[0].question, ACCOUNT_QUESTION);
  assert.equal(ACCOUNT_QUESTION, 'This machine is already linked to Beezi. Which account should setup use?');
  assert.deepEqual(ctx.asked[0].options, [
    { label: 'Continue with ops@example.com · Beta', description: 'Keep this account; no browser sign-in' },
    { label: 'Continue with Jane Doe <jane@example.com> · Acme', description: 'Keep this account; no browser sign-in' },
    { label: 'Link another account', description: 'Sign in through your browser' },
  ]);
  assert.equal(ctx.asked[0].defaultIndex, 0);
  assert.deepEqual(commands(ctx), ['accounts.mjs list']);
  const other = fakeCtx({ 'accounts.mjs list': LISTING }, [1]);
  assert.deepEqual(await chooseAccount(other), { key: 'aa11bb22', readsElsewhere: false });
});

test('chooseAccount preselects the first account when none is the default', async () => {
  const ctx = fakeCtx({ 'accounts.mjs list': ok('1. dev@example.com key=k1\n') }, [0]);
  assert.deepEqual(await chooseAccount(ctx), { key: 'k1', readsElsewhere: false });
  assert.equal(ctx.asked[0].defaultIndex, 0);
});

test('chooseAccount signs in when the user links another account', async () => {
  const ctx = fakeCtx({ 'accounts.mjs list': LISTING, 'login.mjs': LOGIN }, [2]);
  assert.deepEqual(await chooseAccount(ctx), { key: 'k1', readsElsewhere: false });
  assert.deepEqual(commands(ctx), ['accounts.mjs list', 'login.mjs']);
});

test('chooseAccount stops on a dismissal, and signs in straight away when every account is revoked', async () => {
  const dismissed = fakeCtx({ 'accounts.mjs list': LISTING }, []);
  assert.equal(await chooseAccount(dismissed), null);
  assert.deepEqual(commands(dismissed), ['accounts.mjs list']);
  const revoked = fakeCtx({ 'accounts.mjs list': ok('1. old@example.com [default, revoked] key=k9\n'), 'login.mjs': LOGIN }, []);
  assert.deepEqual(await chooseAccount(revoked), { key: 'k1', readsElsewhere: false });
  assert.equal(revoked.asked.length, 0);
});

test('chooseAccount reports a failing account list, then signs in; a failed sign-in is null', async () => {
  const ctx = fakeCtx({
    'accounts.mjs list': fail("\n✗ Could not access Beezi's local data (EACCES). Check file permissions and try again.\n"),
    'login.mjs': { code: 1, stdout: '', stderr: '\n✗ Could not reach the Beezi server. Check your internet connection and try again.\n' },
  }, []);
  assert.equal(await chooseAccount(ctx), null);
  assert.deepEqual(ctx.printed, ["✗ Could not access Beezi's local data (EACCES). Check file permissions and try again."]);
  assert.deepEqual(commands(ctx), ['accounts.mjs list', 'login.mjs']);
});
