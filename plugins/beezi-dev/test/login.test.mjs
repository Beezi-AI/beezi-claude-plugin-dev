import { addAccount, readIndex } from '../lib/accounts.mjs';
const ACCOUNT = 'aabbccdd';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLogin } from '../lib/login.mjs';
import { PROBE_OUTCOMES } from '../lib/whoami.mjs';
import { readCredentials, commitCredentials, CREDENTIAL_STATUS } from '../lib/credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from '../lib/credential-lock.mjs';
import { recordReauthRequired, readReauthMarker } from '../lib/auth-markers.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const OLD = {
  client_id: 'old-client', redirect_uri: 'http://127.0.0.1:12345/callback',
  token_endpoint: 'https://fake.invalid/oauth/token',
  access_token: 'old-at', refresh_token: 'old-rt', expires_at: 0,
};
const META = {
  authorizationEndpoint: 'https://clerk.invalid/oauth/authorize',
  tokenEndpoint: 'https://clerk.invalid/oauth/token',
  registrationEndpoint: 'https://clerk.invalid/oauth/register',
  revocationEndpoint: 'https://clerk.invalid/oauth/revoke',
};

const store = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
const committed = () => readCredentials(store, { account: ACCOUNT });

async function seed(creds) {
  await addAccount({ key: ACCOUNT, email: 'dev@example.com', clientId: creds.client_id });
  const lock = await acquireCredentialLock({ account: ACCOUNT, waitMs: 0 }, store);
  await commitCredentials(creds, { account: ACCOUNT, lock, force: true }, store);
  releaseCredentialLock(lock);
}

// The happy path's collaborators; each test overrides the one it is about.
function deps(overrides = {}) {
  return {
    ...store,
    log: () => {},
    now: () => 1_000,
    openBrowser: () => {},
    syncAccountIfNeeded: async () => {},
    discover: async () => META,
    registerClient: async () => 'new-client',
    startLoopback: async () => ({
      redirectUri: 'http://127.0.0.1:5555/callback', port: 5555, code: Promise.resolve('the-code'),
    }),
    exchangeCode: async () => ({ access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 }),
    probeIdentity: async () => ({ outcome: PROBE_OUTCOMES.AUTHENTICATED, httpStatus: 200, identity: { email: 'dev@example.com', tenantId: 'tenant-one' } }),
    getAuthentication: async () => ({ authState: 'unlinked', reason: 'no_credentials', accessToken: null }),
    unlinkOnServer: async () => ({ unlinked: true }),
    ...overrides,
  };
}

// finding 1, the core of it: login used to whoami the stored access token and delete EVERY
// credential on a 401 or a 403, before discovery had even been attempted.
for (const [name, probeOutcome] of [['401', PROBE_OUTCOMES.UNAUTHORIZED], ['403', PROBE_OUTCOMES.FORBIDDEN]]) {
  test(`login on a ${name} keeps the previous credentials when discovery then fails`, async (t) => {
    tmpHome(t);
    await seed(OLD);
    let refreshes = 0;
    await assert.rejects(runLogin(deps({
      getAuthentication: async (_d, options) => {
        if (options && options.forceRefresh) refreshes += 1;
        return { authState: 'ready', reason: 'ok', accessToken: OLD.access_token };
      },
      probeIdentity: async () => ({ outcome: probeOutcome, httpStatus: name === '401' ? 401 : 403, identity: null }),
      discover: async () => { throw new Error('simulated offline'); },
    })), /simulated offline/);
    const read = await committed();
    assert.equal(read.status, CREDENTIAL_STATUS.READY, 'the session survived a failed login');
    assert.equal(read.credentials.refresh_token, 'old-rt');
    assert.equal(read.credentials.client_id, 'old-client');
    assert.equal(refreshes, 0, 'browser discovery precedes probing existing accounts');
  });
}

test('a cancelled browser flow leaves the previous credentials exactly as they were', async (t) => {
  tmpHome(t);
  await seed(OLD);
  await assert.rejects(runLogin(deps({
    startLoopback: async () => ({
      redirectUri: 'http://127.0.0.1:5555/callback', port: 5555,
      code: Promise.reject(new Error('Login timed out before the browser round-trip completed.')),
    }),
  })), /timed out/);
  assert.equal((await committed()).credentials.access_token, 'old-at');
});

test('a failed registration leaves the previous credentials in place', async (t) => {
  tmpHome(t);
  await seed(OLD);
  await assert.rejects(runLogin(deps({
    getAuthentication: async () => ({ authState: 'reauth_required', reason: 'invalid_grant', accessToken: null }),
    registerClient: async () => { throw new Error('registration refused'); },
  })), /registration refused/);
  assert.equal((await committed()).credentials.access_token, 'old-at');
});

// finding 7: a token set with no refresh token becomes the literal string "undefined" in the
// next refresh grant. It is refused before it can replace a working session.
test('an exchange without a refresh token is refused and never replaces the old generation', async (t) => {
  tmpHome(t);
  await seed(OLD);
  await assert.rejects(runLogin(deps({
    exchangeCode: async () => ({ access_token: 'new-at', expires_in: 3600 }),
  })), /previous Beezi authorization is untouched/);
  const read = await committed();
  assert.equal(read.generation, 1);
  assert.equal(read.credentials.refresh_token, 'old-rt');
});

test('a successful login commits the new generation and clears the rejection marker', async (t) => {
  tmpHome(t);
  await seed(OLD);
  recordReauthRequired(ACCOUNT, 1, 'invalid_grant', 1_000);
  const result = await runLogin(deps({
    getAuthentication: async () => ({ authState: 'reauth_required', reason: 'invalid_grant', accessToken: null }),
  }));
  assert.equal(result.status, 'linked');
  const read = await committed();
  assert.equal(read.generation, 2);
  assert.equal(read.credentials.access_token, 'new-at');
  assert.equal(read.credentials.refresh_token, 'new-rt');
  assert.match(read.credentials.scope, /offline_access/);
  assert.equal(readReauthMarker(ACCOUNT, 2), null, 'the new grant starts clean');
  assert.equal(readReauthMarker(ACCOUNT, 1), null);
});

// The trap that preserving credentials creates: a client the provider has rejected is very
// likely deleted server-side, and reusing it strands the browser step.
test('a rejected generation is re-registered rather than reused', async (t) => {
  tmpHome(t);
  await seed(OLD);
  let registered = false;
  let boundPort = null;
  await runLogin(deps({
    getAuthentication: async () => ({ authState: 'reauth_required', reason: 'invalid_grant', accessToken: null }),
    registerClient: async () => { registered = true; return 'new-client'; },
    startLoopback: async ({ port }) => {
      boundPort = port;
      return { redirectUri: 'http://127.0.0.1:5555/callback', port: 5555, code: Promise.resolve('c') };
    },
  }));
  assert.equal(registered, true);
  assert.equal(boundPort, 0, 'a fresh port, not the rejected client’s');
});

// A legacy client that was registered without offline_access: the replacement is registered
// during the interactive login, and the old credentials survive until it succeeds.
test('a generation with no refresh token registers a replacement client', async (t) => {
  tmpHome(t);
  await seed({ ...OLD, refresh_token: undefined });
  let registered = false;
  await runLogin(deps({
    getAuthentication: async () => ({
      authState: 'reauth_required', reason: 'missing_refresh_token', accessToken: null,
    }),
    registerClient: async () => { registered = true; return 'scoped-client'; },
  }));
  assert.equal(registered, true);
  assert.equal((await committed()).credentials.client_id, 'scoped-client');
});

test('an already-linked machine says so and never touches the store', async (t) => {
  tmpHome(t);
  await seed(OLD);
  const result = await runLogin(deps({
    getAuthentication: async () => ({ authState: 'ready', reason: 'ok', accessToken: 'at' }),
    // Relogin still opens the browser so users can add another account.
  }));
  assert.equal(result.status, 'already_linked');
  assert.equal((await committed()).generation, 1);
});

test('an unavailable existing grant is kept, never replaced by a new browser grant', async t => {
  tmpHome(t); await seed(OLD);
  await assert.rejects(runLogin(deps({
    getAuthentication: async () => ({ authState: 'unavailable', reason: 'refresh_network_error' }),
  })), /saved authorization is untouched/);
  assert.equal((await committed()).credentials.client_id, 'old-client');
});

// consent_required existed in the vocabulary and in the copy, but nothing ever put it on the
// wire — the behaviour was right and the evidence said only "some reauthorization".
test('a legacy client without offline_access records consent_required', async (t) => {
  tmpHome(t);
  await seed({ ...OLD, refresh_token: undefined });
  const recorded = [];
  await runLogin(deps({
    getAuthentication: async () => ({
      authState: 'reauth_required', reason: 'missing_refresh_token', accessToken: null,
    }),
    recordAuthResult: (result, opts) => { recorded.push({ ...result, ...opts }); return true; },
  }));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].authState, 'reauth_required');
  assert.equal(recorded[0].reason, 'consent_required');
  assert.equal(recorded[0].source, 'login');
});

test('an ordinary rejected grant does not claim renewed consent was needed', async (t) => {
  tmpHome(t);
  await seed(OLD);
  const recorded = [];
  await runLogin(deps({
    getAuthentication: async () => ({ authState: 'reauth_required', reason: 'invalid_grant', accessToken: null }),
    recordAuthResult: (result) => { recorded.push(result); return true; },
  }));
  assert.deepEqual(recorded, []);
});


test('adding another tenant keeps the default and publishes its own credentials', async t => {
  tmpHome(t); await seed(OLD);
  const result = await runLogin(deps({ probeIdentity: async () => ({ outcome: PROBE_OUTCOMES.AUTHENTICATED, identity: { email: 'second@example.com', tenantId: 'second-tenant' } }) }));
  assert.notEqual(result.account, ACCOUNT);
  assert.equal((await readIndex()).default, ACCOUNT);
  assert.equal((await committed()).credentials.client_id, 'old-client');
  assert.equal((await readCredentials(store, { account: result.account })).credentials.client_id, 'new-client');
});

test('another user in the same tenant is refused and the temporary client is unlinked', async t => {
  tmpHome(t); await seed(OLD);
  await addAccount({ key: ACCOUNT, email: 'dev@example.com', tenantId: 'tenant-one', clientId: 'old-client' });
  let unlinked = 0;
  await assert.rejects(runLogin(deps({
    probeIdentity: async () => ({ outcome: PROBE_OUTCOMES.AUTHENTICATED, identity: { email: 'other@example.com', tenantId: 'tenant-one' } }),
    unlinkOnServer: async session => { assert.equal(session.clientId, 'new-client'); unlinked++; return { unlinked: true }; },
  })), /already linked/);
  assert.equal(unlinked, 1);
  assert.equal((await readIndex()).accounts.length, 1);
  assert.equal((await committed()).credentials.client_id, 'old-client');
});

test('concurrent logins in one tenant cannot publish duplicate accounts', async t => {
  tmpHome(t);
  const outcomes = await Promise.allSettled(['one@example.com', 'two@example.com'].map(email => runLogin(deps({
    probeIdentity: async () => ({ outcome: PROBE_OUTCOMES.AUTHENTICATED, identity: { email, tenantId: 'same-tenant' } }),
  }))));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await readIndex()).accounts.length, 1);
});


test('a stored 401 followed by transient refresh failure preserves its generation', async t => {
  tmpHome(t); await seed(OLD);
  await assert.rejects(runLogin(deps({
    getAuthentication: async (_deps, options) => options.forceRefresh
      ? { authState: 'unavailable', reason: 'refresh_network_error' }
      : { authState: 'ready', accessToken: 'old-at', clientId: 'old-client' },
    probeIdentity: async session => session.clientId === 'new-client'
      ? { outcome: PROBE_OUTCOMES.AUTHENTICATED, identity: { email: 'dev@example.com' } }
      : { outcome: PROBE_OUTCOMES.UNAUTHORIZED },
  })), /saved authorization is untouched/);
  assert.equal((await committed()).credentials.client_id, 'old-client');
  assert.equal((await committed()).generation, 1);
});


test('failed publication of a new account removes its stored generation and revokes its grant', async t => {
  tmpHome(t);
  let attemptedKey, revoked = false;
  await assert.rejects(runLogin(deps({
    addAccount: async row => { attemptedKey = row.key; throw new Error('index disk full'); },
    unlinkOnServer: async () => { revoked = true; return { unlinked: true }; },
  })), /saved authorization was removed/);
  assert.equal(revoked, true);
  assert.equal((await readCredentials(store, { account: attemptedKey })).status, CREDENTIAL_STATUS.NONE);
  assert.equal((await readIndex()).accounts.length, 0);
});

test('failed metadata publication for an existing account preserves the previous generation and row', async t => {
  tmpHome(t); await seed(OLD);
  let revoked = false;
  await assert.rejects(runLogin(deps({
    getAuthentication: async () => ({ authState: 'reauth_required', reason: 'invalid_grant' }),
    updateAccount: async () => { throw new Error('index disk full'); },
    unlinkOnServer: async () => { revoked = true; return { unlinked: true }; },
  })), /index disk full/);
  assert.equal(revoked, true);
  assert.equal((await committed()).generation, 1);
  assert.equal((await committed()).credentials.client_id, 'old-client');
  assert.equal((await readIndex()).accounts[0].clientId, 'old-client');
});


test('an existing account metadata update is restored when credential storage fails', async t => {
  tmpHome(t); await seed(OLD);
  await addAccount({ key: ACCOUNT, email: 'dev@example.com', clientId: 'old-client', status: 'revoked' });
  await assert.rejects(runLogin(deps({
    commitCredentials: async () => { throw new Error('credential store failed'); },
  })), /credential store failed/);
  const account = (await readIndex()).accounts[0];
  assert.equal(account.key, ACCOUNT);
  assert.equal(account.clientId, 'old-client');
  assert.equal(account.status, 'revoked');
  assert.equal((await committed()).generation, 1);
});
