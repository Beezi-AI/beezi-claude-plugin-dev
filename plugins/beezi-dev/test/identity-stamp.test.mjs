import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIdentityStamp } from '../lib/identity-stamp.mjs';

// 56 characters, so keyFingerprint's 20-char floor is cleared and the 12+4 window still hides 40.
const TOKEN = `sk-ant-oat01-${'x'.repeat(39)}ab12`;

const ACCOUNT = { accountUuid: 'acc-1', email: 'live@example.com' };

const BILLING = {
  accountUuid: 'acc-billing',
  accountEmail: 'billing@example.com',
  accountAnchor: { value: 'anchor@example.com', source: 'email', updatedAt: '2026-08-01T00:00:00.000Z' },
};

// A key-scoped record: the portal priced a setup token here, so ~/.claude.json names whoever logged
// in interactively last. The record answers for the identity even when the env cannot see the key.
const KEY_SCOPED = {
  ...BILLING,
  keyFingerprint: { prefix: 'sk-ant-oat01', last4: 'ab12', length: 56 },
};

// The session stamps the login it RUNS UNDER. billing.json is machine-wide and rewritten by
// whichever session started last, so after a switch it names the new account while an older
// session is still working under the previous one. ~/.claude.json's oauthAccount, read live (and
// honouring CLAUDE_CONFIG_DIR), is the closer answer whenever it names an account.
test('buildIdentityStamp — the live login outranks billing.json', () => {
  const stamp = buildIdentityStamp(ACCOUNT, BILLING, {});
  assert.equal(stamp.account_uuid, 'acc-1');
  assert.equal(stamp.account_email, 'live@example.com');
  assert.equal(stamp.oauth_key_prefix, undefined);
});

// The surfaces that never write oauthAccount — the VS Code extension, desktop SSO — leave the live
// read empty, and then billing.json is the machine's ONE vendor identity.
test('buildIdentityStamp — billing.json answers when oauthAccount is unreadable', () => {
  const stamp = buildIdentityStamp(null, BILLING, {});
  assert.equal(stamp.account_uuid, 'acc-billing');
  assert.equal(stamp.account_email, 'billing@example.com');
});

// The fallback, and its only trigger: no record on disk at all.
test('buildIdentityStamp — ~/.claude.json answers when there is no billing record', () => {
  const stamp = buildIdentityStamp(ACCOUNT, null, {});
  assert.equal(stamp.account_uuid, 'acc-1');
  assert.equal(stamp.account_email, 'live@example.com');
});

// THE NULL RULE, where it still matters: a record that belongs to a setup key. The env may not see
// the token (exported from a shell profile, invisible to every env tier), and then ~/.claude.json
// names whoever logged in interactively last. A record that states no uuid states no uuid — the
// live file is never consulted to fill it.
test('buildIdentityStamp — a null in a key-scoped billing.json never falls through to ~/.claude.json', () => {
  const stamp = buildIdentityStamp(
    ACCOUNT,
    { ...KEY_SCOPED, accountUuid: null, accountEmail: 'billing@example.com', accountAnchor: null },
    {},
  );
  assert.equal(stamp.account_uuid, undefined);
  assert.equal(stamp.account_email, 'billing@example.com');
});

test('buildIdentityStamp — a key-scoped record naming nobody states nothing', () => {
  assert.deepEqual(
    buildIdentityStamp(ACCOUNT, { ...KEY_SCOPED, accountUuid: null, accountEmail: null, accountAnchor: null }, {}),
    {},
  );
});

// The same protection for a record whose key was captured through the anchor alone, and for one the
// CLI confirmed is running under a setup token (planSource 'unresolved').
test('buildIdentityStamp — an oauth_key anchor or an unresolved plan also keeps billing.json in charge', () => {
  const anchored = buildIdentityStamp(ACCOUNT, {
    accountUuid: null,
    accountEmail: null,
    accountAnchor: { value: 'sk-ant-oat01...ab12:56', source: 'oauth_key' },
  }, {});
  assert.deepEqual(anchored, {});
  const unresolved = buildIdentityStamp(ACCOUNT, { accountUuid: null, accountEmail: null, planSource: 'unresolved' }, {});
  assert.deepEqual(unresolved, {});
});

test('buildIdentityStamp — the email anchor is the last email fallback', () => {
  const stamp = buildIdentityStamp(null, { accountAnchor: BILLING.accountAnchor }, {});
  assert.equal(stamp.account_email, 'anchor@example.com');
  assert.equal(stamp.account_uuid, undefined);
});

// readClaudeAccountAnchor falls back to ~/.claude.json's top-level userID under source 'user_id'.
// That is an opaque local hash: it identifies nothing server-side, so sending it as an account uuid
// would assert an account that cannot exist.
test('buildIdentityStamp — a user_id anchor is never reported as an account uuid', () => {
  const stamp = buildIdentityStamp(
    null,
    { accountAnchor: { value: 'deadbeef-local-hash', source: 'user_id' } },
    {},
  );
  assert.equal(stamp.account_uuid, undefined);
  assert.equal(stamp.account_email, undefined);
});

// An oauth_key anchor holds the MASKED fingerprint ('sk-ant-oat01...ab12:56'), not an identity.
test('buildIdentityStamp — an oauth_key anchor is neither a uuid nor an email', () => {
  const stamp = buildIdentityStamp(
    null,
    { accountAnchor: { value: 'sk-ant-oat01...ab12:56', source: 'oauth_key' } },
    {},
  );
  assert.equal(stamp.account_uuid, undefined);
  assert.equal(stamp.account_email, undefined);
});

// The core suppression. On a setup-token machine oauthAccount describes whoever logged in last,
// and the server matches a uuid BEFORE a fingerprint — so a stale identity next to a live
// fingerprint does not add a second opinion, it wins.
test('buildIdentityStamp — a fingerprintable token replaces the uuid and the email', () => {
  const stamp = buildIdentityStamp(ACCOUNT, BILLING, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  assert.equal(stamp.account_uuid, undefined);
  assert.equal(stamp.account_email, undefined);
  assert.equal(stamp.oauth_key_prefix, 'sk-ant-oat01');
  assert.equal(stamp.oauth_key_last4, 'ab12');
  assert.equal(stamp.oauth_key_length, TOKEN.length);
});

// Truthiness is not enough: a short value identifies nothing, the server drops the key entry, and
// suppressing on it would trade a usable identity for none at all.
test('buildIdentityStamp — a token too short to fingerprint suppresses nothing', () => {
  const stamp = buildIdentityStamp(ACCOUNT, BILLING, { CLAUDE_CODE_OAUTH_TOKEN: 'x' });
  assert.equal(stamp.account_uuid, 'acc-1');
  assert.equal(stamp.account_email, 'live@example.com');
  assert.equal(stamp.oauth_key_prefix, undefined);
});

// billing.json is the source of truth for the uuid, the email and the plan — but NOT for which key
// is in force. Its keyFingerprint is stamped by the reconcile from the same probed env every
// suppression site resolves, so it names no token the env cannot see; it can only disagree, and
// every disagreement is a stale record. Honouring it would strand a self-reported key-scoped
// machine that moved back to an interactive login: shouldKeepExisting's key guard blocks the
// automatic rewrite, so the suppression would hold until the user ran /beezi:refresh, which is the
// one path that stands the guard down. See oauth-identity.mjs.
test('buildIdentityStamp — a stored fingerprint is not a substitute for a live token', () => {
  const stamp = buildIdentityStamp(ACCOUNT, {
    ...BILLING,
    keyFingerprint: { prefix: 'sk-ant-oat01', last4: 'ab12', length: 56 },
  }, {});
  assert.equal(stamp.oauth_key_prefix, undefined);
  assert.equal(stamp.account_uuid, 'acc-billing', 'billing.json still answers for the identity');
  assert.equal(stamp.account_email, 'billing@example.com');
});

// A machine that has never run /beezi:login and cannot read oauthAccount states nothing rather
// than guessing. The server stores the reading with a NULL link.
test('buildIdentityStamp — nothing known is an empty stamp, not nulls', () => {
  assert.deepEqual(buildIdentityStamp(null, null, {}), {});
});

// Absence is how this stamp says "not stated"; an explicit null would be a claim.
test('buildIdentityStamp — unknown fields are omitted, never nulled', () => {
  const stamp = buildIdentityStamp({ accountUuid: 'acc-1', email: null }, null, {});
  assert.deepEqual(Object.keys(stamp), ['account_uuid']);
});

// The whole reason this lives in its own module: the middle of the token is never read, so it can
// never reach the wire.
test('buildIdentityStamp — the middle of the token never leaves the machine', () => {
  const stamp = buildIdentityStamp(null, null, { CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
  assert.ok(!JSON.stringify(stamp).includes(TOKEN.slice(12, -4)));
});

// ---------------------------------------------------------------------------
// One source, not one field at a time.
// ---------------------------------------------------------------------------

// The uuid and the email are read from ONE record, never mixed across sources. billing.json keeps
// the pair consistent — the reconcile writes both together and its switch detection compares both —
// so a mixed pair, which the server would resolve by the uuid alone, is unrepresentable here.
test('buildIdentityStamp — the pair comes from one record, never mixed', () => {
  const stamp = buildIdentityStamp(
    { accountUuid: null, email: 'b@example.com' },
    { accountUuid: 'uuid-A', accountEmail: 'a@example.com' },
    {},
  );
  assert.equal(stamp.account_uuid, 'uuid-A');
  assert.equal(stamp.account_email, 'a@example.com');
});

// The switch the live-first rule exists for: billing.json was rewritten by a newer session under
// account A, this session still runs under B. B's uuid wins, and A's email must NOT ride along —
// a mixed pair the server would resolve by the uuid alone.
test('buildIdentityStamp — a live uuid displaces billing.json\'s, and never borrows its email', () => {
  const stamp = buildIdentityStamp(
    { accountUuid: 'uuid-B', email: null },
    { accountUuid: 'uuid-A', accountEmail: 'a@example.com' },
    {},
  );
  assert.equal(stamp.account_uuid, 'uuid-B');
  assert.equal('account_email' in stamp, false);
});

// Same account on both sides: billing.json's email is the CLI's, which reflects the live credential
// store, while oauthAccount's can survive a switch stale — so the record's email still answers.
test('buildIdentityStamp — the same uuid keeps billing.json\'s fresher email', () => {
  const stamp = buildIdentityStamp(
    { accountUuid: 'uuid-A', email: 'old@example.com' },
    { accountUuid: 'uuid-A', accountEmail: 'a@example.com' },
    {},
  );
  assert.equal(stamp.account_uuid, 'uuid-A');
  assert.equal(stamp.account_email, 'a@example.com');
});

// A record that names an email but no uuid cannot contradict the live uuid, so its email fills the
// gap when the live login states none.
test('buildIdentityStamp — a uuid-less record lends its email to a live uuid', () => {
  const stamp = buildIdentityStamp(
    { accountUuid: 'uuid-A', email: null },
    { accountUuid: null, accountAnchor: { value: 'cli@example.com', source: 'email' } },
    {},
  );
  assert.equal(stamp.account_uuid, 'uuid-A');
  assert.equal(stamp.account_email, 'cli@example.com');
});

// An oauthAccount carrying only subscription metadata states no identity at all, so billing.json
// is still the machine's one answer — the object being non-null must not blank the stamp.
test('buildIdentityStamp — an oauthAccount that names nobody still yields to billing.json', () => {
  const stamp = buildIdentityStamp({ accountUuid: null, email: null, subscriptionType: 'pro' }, BILLING, {});
  assert.equal(stamp.account_uuid, 'acc-billing');
  assert.equal(stamp.account_email, 'billing@example.com');
});

// ---------------------------------------------------------------------------
// The organization: one login, several subscriptions.
// ---------------------------------------------------------------------------

// A personal plan and a company org under ONE Claude login share the accountUuid and the email;
// only oauthAccount's organizationUuid tells the server which subscription a session ran under.
test('buildIdentityStamp — the live organization rides alongside the live uuid', () => {
  const stamp = buildIdentityStamp(
    { ...ACCOUNT, organizationUuid: 'org-1', organizationName: 'Acme Corp' },
    BILLING,
    {},
  );
  assert.equal(stamp.account_uuid, 'acc-1');
  assert.equal(stamp.account_org_uuid, 'org-1');
  assert.equal(stamp.account_org_name, 'Acme Corp');
});

// Two sessions on the same login, different orgs: each stamps its own, whatever billing.json says.
test('buildIdentityStamp — the organization comes from the live login, not billing.json', () => {
  const stamp = buildIdentityStamp(
    { ...ACCOUNT, organizationUuid: 'org-personal', organizationName: null },
    { ...BILLING, accountUuid: 'acc-1', organizationUuid: 'org-company', organizationName: 'Acme' },
    {},
  );
  assert.equal(stamp.account_org_uuid, 'org-personal');
  assert.equal('account_org_name' in stamp, false, 'a null name is omitted, not borrowed or nulled');
});

test('buildIdentityStamp — an unknown organization is omitted, never nulled', () => {
  const stamp = buildIdentityStamp({ ...ACCOUNT, organizationUuid: null, organizationName: null }, null, {});
  assert.equal('account_org_uuid' in stamp, false);
  assert.equal('account_org_name' in stamp, false);
});

// When billing.json supplies the uuid, the live org would describe a different record — so it
// stays off the wire rather than forming a mixed pair.
test('buildIdentityStamp — no live organization next to a uuid billing.json supplied', () => {
  const stamp = buildIdentityStamp(
    { accountUuid: null, email: null, organizationUuid: 'org-1', organizationName: 'Acme' },
    BILLING,
    {},
  );
  assert.equal(stamp.account_uuid, 'acc-billing');
  assert.equal('account_org_uuid' in stamp, false);
  assert.equal('account_org_name' in stamp, false);
});

// Under a setup token the stamp is the fingerprint alone — the org, like the uuid, describes
// whoever logged in interactively last.
test('buildIdentityStamp — a fingerprintable token suppresses the organization too', () => {
  const stamp = buildIdentityStamp(
    { ...ACCOUNT, organizationUuid: 'org-1', organizationName: 'Acme' },
    null,
    { CLAUDE_CODE_OAUTH_TOKEN: TOKEN },
  );
  assert.equal('account_org_uuid' in stamp, false);
  assert.equal('account_org_name' in stamp, false);
});

test('buildIdentityStamp — a key-scoped record suppresses the live organization', () => {
  const stamp = buildIdentityStamp(
    { ...ACCOUNT, organizationUuid: 'org-1', organizationName: 'Acme' },
    KEY_SCOPED,
    {},
  );
  assert.equal(stamp.account_uuid, 'acc-billing');
  assert.equal('account_org_uuid' in stamp, false);
});
