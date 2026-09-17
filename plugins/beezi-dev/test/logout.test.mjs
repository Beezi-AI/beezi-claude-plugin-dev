import { addAccount, readIndex } from '../lib/accounts.mjs';
import { credentialLockDir } from '../lib/paths.mjs';
const ACCOUNT = 'aabbccdd';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLogout } from '../lib/logout.mjs';
import { readCredentials, commitCredentials, deleteCredentials, CREDENTIAL_STATUS } from '../lib/credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from '../lib/credential-lock.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logout-'));
  const prev = process.env.BEEZI_HOME;
  process.env.BEEZI_HOME = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.BEEZI_HOME;
    else process.env.BEEZI_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const CREDS = {
  client_id: 'cid', redirect_uri: 'http://127.0.0.1:1/callback',
  token_endpoint: 'https://clerk.invalid/oauth/token',
  access_token: 'at', refresh_token: 'rt', expires_at: 10_000_000,
};
const META = { revocationEndpoint: 'https://clerk.invalid/oauth/revoke_here' };
const store = { platform: 'unknown', run: () => ({ ok: false, stdout: '' }) };
const committed = () => readCredentials(store, { account: ACCOUNT });
const FOREIGN = 'ff'.repeat(16);

async function seed() {
  await addAccount({ key: ACCOUNT, email: 'dev@example.com', clientId: CREDS.client_id });
  const lock = await acquireCredentialLock({ account: ACCOUNT, waitMs: 0 }, store);
  await commitCredentials(CREDS, { account: ACCOUNT, lock, force: true }, store);
  releaseCredentialLock(lock);
}

const deps = (overrides = {}) => ({
  ...store,
  base: 'https://api.test',
  discover: async () => META,
  rotateInstallationId: () => {},
  getAuthentication: async () => ({ authState: 'ready', reason: 'ok', accessToken: 'at' }),
  ...overrides,
});

test('a confirmed server unlink is described as one', async (t) => {
  tmpHome(t);
  await seed();
  const lines = await runLogout(deps({ fetchImpl: async () => ({ ok: true, status: 204 }) }));
  assert.match(lines.join('\n'), /unlinked from Beezi/);
  assert.equal((await committed()).status, CREDENTIAL_STATUS.NONE);
});

// finding 8: 401/403 on the DELETE means the controller never ran, so nothing was unlinked.
for (const status of [401, 403]) {
  test(`a DELETE refused with ${status} is a failed unlink, and the revocation fallback runs`, async (t) => {
    tmpHome(t);
    await seed();
    const called = [];
    const lines = await runLogout(deps({
      fetchImpl: async (url, init) => {
        called.push(String(url));
        if (init.method === 'DELETE') return { ok: false, status };
        return { ok: true, status: 200 };
      },
    }));
    assert.ok(called.includes(META.revocationEndpoint), 'the discovered revocation endpoint is used');
    assert.doesNotMatch(lines.join('\n'), /unlinked from Beezi/);
    assert.match(lines.join('\n'), /revoked/);
    assert.equal((await committed()).status, CREDENTIAL_STATUS.NONE);
  });
}

test('an unreachable server and a failed revocation are described honestly', async (t) => {
  tmpHome(t);
  await seed();
  const lines = await runLogout(deps({ fetchImpl: async () => { throw new Error('offline'); } }));
  assert.match(lines.join('\n'), /Logged out locally/);
  assert.match(lines.join('\n'), /may still appear linked/);
  assert.equal((await committed()).status, CREDENTIAL_STATUS.NONE);
});

test('a refused DELETE names its status in the message', async (t) => {
  tmpHome(t);
  await seed();
  const lines = await runLogout(deps({
    fetchImpl: async (_url, init) => (init.method === 'DELETE' ? { ok: false, status: 403 } : { ok: false, status: 500 }),
  }));
  assert.match(lines.join('\n'), /HTTP 403/);
});

// The defect at scripts/logout.mjs:73 — the lock timeout was swallowed and "✓ Logged out"
// printed while the credentials were still stored.
test('a lock it cannot take fails loudly instead of claiming a logout', async (t) => {
  const dir = tmpHome(t);
  await seed();
  fs.mkdirSync(credentialLockDir(ACCOUNT));
  fs.writeFileSync(
    path.join(credentialLockDir(ACCOUNT), 'owner.json'),
    JSON.stringify({ pid: process.pid, nonce: FOREIGN, acquiredAt: Date.now() }),
  );
  await assert.rejects(
    runLogout(deps({ lockWaitMs: 30, fetchImpl: async () => ({ ok: true, status: 204 }) })),
    /nothing was removed/,
  );
  assert.equal((await committed()).status, CREDENTIAL_STATUS.READY, 'the credentials are still there');
});

test('last account logout rotates the machine diagnostic installation id', async (t) => {
  tmpHome(t);
  await seed();
  let rotated = false;
  await runLogout(deps({
    fetchImpl: async () => ({ ok: true, status: 204 }),
    rotateInstallationId: () => { rotated = true; },
  }));
  assert.equal(rotated, true);
});

test('an unlinked machine has nothing to do', async (t) => {
  tmpHome(t);
  const lines = await runLogout(deps({ fetchImpl: async () => assert.fail('no call') }));
  assert.match(lines.join('\n'), /not linked/);
});

// A generation entry left behind by a lock-lost commit is never read, but a refresh orphan holds
// the freshly ROTATED refresh token — the live one — while the committed generation's is already
// dead. Leaving it is a usable grant in the keychain of a machine the user just signed out of.
test('logout removes every generation entry, orphans included', async (t) => {
  tmpHome(t);
  const entries = new Map();
  const keychain = {
    platform: 'darwin',
    run: (_file, args) => {
      const account = args[args.indexOf('-a') + 1];
      if (args[0] === 'find-generic-password') {
        return { ok: entries.has(account), stdout: entries.get(account) || '' };
      }
      if (args[0] === 'add-generic-password') {
        entries.set(account, args[args.indexOf('-w') + 1]);
        return { ok: true, stdout: '' };
      }
      if (args[0] === 'delete-generic-password') entries.delete(account);
      return { ok: true, stdout: '' };
    },
  };
  await addAccount({ key: ACCOUNT, email: 'dev@example.com', clientId: CREDS.client_id });
  let lock = await acquireCredentialLock({ account: ACCOUNT, waitMs: 0 }, keychain);
  await commitCredentials(CREDS, { account: ACCOUNT, lock, force: true }, keychain);
  // A second, committed generation, then an orphan the control record never named.
  await commitCredentials({ ...CREDS, access_token: 'at2' }, { account: ACCOUNT, lock, expectedGeneration: 1 }, keychain);
  releaseCredentialLock(lock);
  entries.set(`${ACCOUNT}-gen-3`, JSON.stringify({ ...CREDS, refresh_token: 'rotated-and-live' }));
  assert.ok(entries.size >= 2, 'the fixture really holds more than the committed entry');

  await runLogout(deps({ ...keychain, fetchImpl: async () => ({ ok: true, status: 204 }) }));

  assert.deepEqual([...entries.keys()], [], 'no generation entry survives the logout');
  assert.equal((await readCredentials(keychain, { account: ACCOUNT })).status, CREDENTIAL_STATUS.NONE);
});


test('default logout requires a successor and preserves another account credentials', async t => {
  tmpHome(t); await seed();
  const other = '11223344';
  await addAccount({ key: other, email: 'other@example.com', clientId: 'other-client' });
  const lock = await acquireCredentialLock({ account: other }, store);
  await commitCredentials({ ...CREDS, client_id: 'other-client' }, { account: other, lock, force: true }, store);
  releaseCredentialLock(lock);
  const settings = deps({ fetchImpl: async () => ({ ok: true, status: 204 }) });
  await assert.rejects(runLogout(settings, { account: ACCOUNT }), /next-default/);
  assert.equal((await committed()).status, CREDENTIAL_STATUS.READY);
  await runLogout(settings, { account: ACCOUNT, nextDefault: other });
  assert.equal((await readIndex()).default, other);
  assert.equal((await readCredentials(store, { account: other })).credentials.client_id, 'other-client');
});


test('logging out one account preserves the diagnostic identity while another remains', async t => {
  tmpHome(t); await seed();
  await addAccount({ key: '11223344', email: 'other@example.com', clientId: 'other-client' });
  let rotated = false;
  await runLogout(deps({
    fetchImpl: async () => ({ ok: true, status: 204 }),
    rotateInstallationId: () => { rotated = true; },
  }), { account: ACCOUNT, nextDefault: '11223344' });
  assert.equal(rotated, false);
});
