import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runClaudeAuthStatus, resolveClaudeSubscription } from '../lib/claude-auth-status.mjs';

// The real shape observed from `claude auth status --json` (CC 2.1.238).
const CLI_JSON = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: null,
  orgId: null,
  orgName: null,
  subscriptionType: 'max',
};

test('runClaudeAuthStatus — parses the CLI JSON and copies only the allowlisted fields', () => {
  const calls = [];
  const r = runClaudeAuthStatus({
    exec: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return JSON.stringify({ ...CLI_JSON, email: 'a@b.co', accessToken: 'sk-ant-oat01-never' });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'claude');
  assert.deepEqual(calls[0].args, ['auth', 'status', '--json']);
  assert.equal(r.loggedIn, true);
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.email, 'a@b.co');
  assert.equal('accessToken' in r, false);
  assert.equal(JSON.stringify(r).includes('sk-ant'), false);
});

test('runClaudeAuthStatus — CLI missing / timing out / exiting non-zero reads as null', () => {
  assert.equal(runClaudeAuthStatus({ exec: () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } }), null);
  assert.equal(runClaudeAuthStatus({ exec: () => { throw new Error('ETIMEDOUT'); } }), null);
});

test('runClaudeAuthStatus — garbage stdout reads as null', () => {
  assert.equal(runClaudeAuthStatus({ exec: () => 'not json' }), null);
  assert.equal(runClaudeAuthStatus({ exec: () => '"just a string"' }), null);
  assert.equal(runClaudeAuthStatus({ exec: () => 'null' }), null);
});

test('runClaudeAuthStatus — token-shaped or over-long values are dropped, not copied', () => {
  const r = runClaudeAuthStatus({
    exec: () => JSON.stringify({ loggedIn: true, subscriptionType: 'x'.repeat(300), authMethod: 'two words' }),
  });
  assert.equal(r.subscriptionType, null);
  assert.equal(r.authMethod, null);
});

// ─── resolveClaudeSubscription merge matrix ──────────────────────────────────

const cliStatus = (over = {}) => () => ({ ...CLI_JSON, ...over });
const noCli = () => null;
const account = (over = {}) => () => ({
  accountUuid: 'acc-1',
  email: null,
  subscriptionType: 'max',
  rateLimitTier: 'default_claude_max_20x',
  expiresAt: null,
  billingType: 'stripe_subscription',
  seatTier: 'max',
  organizationType: null,
  ...over,
});
const noAccount = () => null;
const noAnchor = () => null;

test('resolveClaudeSubscription — CLI-only (VS Code extension shape): plan type without multiplier', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'ext@b.co' }),
    readClaudeAccount: noAccount,
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, null);
  assert.equal(r.accountUuid, null);
  assert.equal(r.email, 'ext@b.co', 'the CLI email must survive with no oauthAccount at all');
  assert.equal(r.detectedVia, 'cli_status');
});

test('resolveClaudeSubscription — oauthAccount-only (CLI missing): pre-existing behavior, tagged', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: noCli,
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
  assert.equal(r.accountUuid, 'acc-1');
  assert.equal(r.detectedVia, 'oauth_account');
});

test('resolveClaudeSubscription — same account: CLI type + oauthAccount multiplier merge', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'cli@b.co' }),
    readClaudeAccount: account({ email: 'CLI@B.co' }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x', 'a same-account profile donates the multiplier');
  assert.equal(r.email, 'cli@b.co', 'the live CLI email outranks the possibly-stale profile email');
  assert.equal(r.detectedVia, 'merged');
});

test('resolveClaudeSubscription — a differing profile email is a different account: no donation', () => {
  // The switch case the old product-type check was standing in for, now tested directly: the
  // types still agree (both max), so only identity can tell these two accounts apart.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'cli@b.co' }),
    readClaudeAccount: account({ email: 'previous@b.co' }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, null, 'a profile naming another account must not donate its tier');
  assert.equal(r.email, 'cli@b.co', 'the live CLI email outranks the possibly-stale profile email');
  assert.equal(r.detectedVia, 'cli_status');
});

test('resolveClaudeSubscription — a null CLI email falls back to the oauthAccount email', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus(), // email: null — the observed CC 2.1.238 shape
    readClaudeAccount: account({ email: 'file@b.co' }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.email, 'file@b.co');
});

test('resolveClaudeSubscription — disagreement: the stale profile must NOT donate its multiplier', () => {
  // Account switch: oauthAccount still describes the previous (max) account, the CLI says pro.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ subscriptionType: 'pro' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'pro');
  assert.equal(r.rateLimitTier, null);
  assert.equal(r.detectedVia, 'cli_status');
});

test('resolveClaudeSubscription — partial oauthAccount (setup-token shape, no subscriptionType)', () => {
  // Reversed deliberately. A profile that cannot derive its own product states nothing, and
  // silence is not disagreement: dropping the tier here reported every personal Max user — whose
  // seatTier is null by construction — as plain `max`. Identity is the gate; when neither side
  // offers an email, an underivable type is no reason to discard a tier that is present.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus(),
    readClaudeAccount: account({ subscriptionType: null }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x', 'silence is not a contradiction');
  assert.equal(r.detectedVia, 'merged');
});

test('resolveClaudeSubscription — personal Max: organizationType claude_max, seatTier null', () => {
  // The exact live shape from an affected Max 20x machine (macOS, stripe billing). Every field
  // here is real: personal Max is written as an "organization" of type claude_max with a null
  // seatTier and the multiplier parked in organizationRateLimitTier.
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'b@icloud.com' }),
    readClaudeAccount: () => ({
      accountUuid: '164073bf-3bef-4127-93d5-b0bb5d8ec7e5',
      email: 'b@icloud.com',
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      expiresAt: null,
      billingType: 'stripe_subscription',
      seatTier: null,
      organizationType: 'claude_max',
    }),
    readClaudeAccountAnchor: noAnchor,
  });
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
  assert.equal(r.detectedVia, 'merged');
});

test('resolveClaudeSubscription — loggedIn false yields no CLI evidence', () => {
  assert.equal(
    resolveClaudeSubscription({
      runClaudeAuthStatus: cliStatus({ loggedIn: false }),
      readClaudeAccount: noAccount,
      readClaudeAccountAnchor: noAnchor,
    }),
    null,
  );
});

test('resolveClaudeSubscription — nothing anywhere yields null', () => {
  assert.equal(
    resolveClaudeSubscription({ runClaudeAuthStatus: noCli, readClaudeAccount: noAccount, readClaudeAccountAnchor: noAnchor }),
    null,
  );
});

// An explicit env everywhere the anchor is asserted: a developer machine with a real
// CLAUDE_CODE_OAUTH_TOKEN exported would otherwise outrank the fixtures under test.
test('resolveClaudeSubscription — anchor prefers the CLI email over the file anchor', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'a@b.co' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: () => ({ value: 'acc-1', source: 'account_uuid' }),
    env: {},
  });
  assert.deepEqual(r.anchor, { value: 'a@b.co', source: 'email' });
});

test('resolveClaudeSubscription — falls back to the file anchor when the CLI has no email', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus(),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: () => ({ value: 'uid-9', source: 'user_id' }),
    env: {},
  });
  assert.deepEqual(r.anchor, { value: 'uid-9', source: 'user_id' });
});

test('resolveClaudeSubscription — a CLAUDE_CODE_OAUTH_TOKEN outranks BOTH the CLI email and the file anchor', () => {
  const token = `sk-ant-oat01-${'y'.repeat(40)}`;
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'stale@b.co' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: () => ({ value: 'acc-1', source: 'account_uuid' }),
    env: { CLAUDE_CODE_OAUTH_TOKEN: token },
  });
  assert.deepEqual(r.anchor, {
    value: `sk-ant-oat01...${token.slice(-4)}:${token.length}`,
    source: 'oauth_key',
  });
  assert.equal(r.anchor.value.includes(token.slice(12, -4)), false, 'the middle never leaves the process');
  // Identity only — the plan tuple still comes from the CLI + oauthAccount merge.
  assert.equal(r.subscriptionType, 'max');
  assert.equal(r.rateLimitTier, 'default_claude_max_20x');
});

test('resolveClaudeSubscription — a token too short to fingerprint yields no anchor of its own', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: cliStatus({ email: 'a@b.co' }),
    readClaudeAccount: account(),
    readClaudeAccountAnchor: noAnchor,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01' },
  });
  assert.deepEqual(r.anchor, { value: 'a@b.co', source: 'email' });
});

test('resolveClaudeSubscription — a throwing reader degrades to the other layers, never throws', () => {
  const r = resolveClaudeSubscription({
    runClaudeAuthStatus: () => { throw new Error('boom'); },
    readClaudeAccount: account(),
    readClaudeAccountAnchor: () => { throw new Error('boom'); },
  });
  assert.equal(r.detectedVia, 'oauth_account');
  assert.equal(r.subscriptionType, 'max');
});
