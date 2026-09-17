import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setCredentials, readCredentials, deleteCredentials, commitCredentials } from '../lib/credentials.mjs';
import { acquireCredentialLock, releaseCredentialLock } from '../lib/credential-lock.mjs';
import { readIndex, addAccount, getAccount } from '../lib/accounts.mjs';
import { getAuthentication } from '../lib/token.mjs';
import { runRefreshWorker } from '../lib/refresh-worker.mjs';
import { linkedSessions } from '../lib/sessions.mjs';
import { readReauthMarker } from '../lib/auth-markers.mjs';
const A = 'aabbccdd';
const B = '11223344';
const deps = { platform: 'test' };
const credentials = (id, expired = false) => ({ client_id: id, access_token: `token-${id}`, refresh_token: `refresh-${id}`, token_endpoint: 'https://test.invalid/token', expires_at: expired ? 1 : Date.now() + 3600000 });
async function isolated(fn) {
  const previous = process.env.BEEZI_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-account-auth-'));
  process.env.BEEZI_HOME = home;
  try { await fn(home); } finally { if (previous == null) delete process.env.BEEZI_HOME; else process.env.BEEZI_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); }
}
test('accounts have independent generations, locks, sessions and logout', () => isolated(async () => {
  await addAccount({ key: A, clientId: 'a' }, deps);
  await addAccount({ key: B, clientId: 'b' }, deps);
  await setCredentials(A, credentials('a'), deps);
  await setCredentials(B, credentials('b'), deps);
  const lock = await acquireCredentialLock({ account: A });
  const other = await acquireCredentialLock({ account: B, waitMs: 0 });
  assert.ok(other);
  await assert.rejects(commitCredentials(credentials('oops'), { account: B, lock, force: true }, deps), /different account/);
  releaseCredentialLock(lock); releaseCredentialLock(other);
  assert.equal((await getAuthentication(deps)).accessToken, 'token-a');
  assert.deepEqual((await linkedSessions(deps)).map((s) => s.token), ['token-a', 'token-b']);
  await deleteCredentials(A, deps);
  assert.equal((await readCredentials(deps, { account: B })).credentials.client_id, 'b');
}));
test('definitive rejection revokes only its account and retains generation diagnostics', () => isolated(async () => {
  for (const key of [A, B]) { await addAccount({ key }, deps); await setCredentials(key, credentials(key, true), deps); }
  const result = await runRefreshWorker({ account: A }, { ...deps, refreshTokens: async () => ({ invalidGrant: true, error: 'invalid_grant' }) });
  assert.equal(result.outcome, 'reauth_required');
  assert.equal((await getAccount(A)).status, 'revoked');
  assert.equal((await getAccount(B)).status, 'linked');
  assert.equal(readReauthMarker(A, 1).reason, 'invalid_grant');
  assert.equal(readReauthMarker(B, 1), null);
  assert.equal((await readCredentials(deps, { account: A })).status, 'ready');
}));
test('migration transfers committed generation and markers once, tombstones legacy source', () => isolated(async (home) => {
  const dir = path.join(home, 'credentials'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ generation: 4, highestGeneration: 4, backend: 'file' }));
  fs.writeFileSync(path.join(dir, 'gen-4.json'), JSON.stringify({ token: JSON.stringify(credentials('legacy')) }));
  fs.writeFileSync(path.join(dir, 'auth-state.json'), JSON.stringify({ reauth: { generation: 4, reason: 'invalid_grant' } }));
  const index = await readIndex(deps);
  assert.equal(index.accounts.length, 1);
  assert.equal(index.accounts[0].clientId, 'legacy');
  const key = index.default;
  assert.equal((await readCredentials(deps, { account: key })).generation, 4);
  assert.equal(readReauthMarker(key, 4).reason, 'invalid_grant');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'control.json'))).generation, null);
  assert.deepEqual(await readIndex(deps), index);
}));
test('transient refresh failure preserves both index and credentials', () => isolated(async () => {
  await addAccount({ key: A }, deps); await setCredentials(A, credentials('a', true), deps);
  await runRefreshWorker({ account: A }, { ...deps, refreshTokens: async () => ({ failure: 'network' }) });
  assert.equal((await getAccount(A)).status, 'linked');
  assert.equal((await readCredentials(deps, { account: A })).credentials.access_token, 'token-a');
}));
test('migration resumes its journaled destination after publication was interrupted', () => isolated(async (home) => {
  const dir = path.join(home, 'credentials'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(home, 'accounts.migration.json'), JSON.stringify({ key: A }));
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ generation: null, highestGeneration: 1, backend: null, migratedAccount: A }));
  await setCredentials(A, credentials('resumed'), deps);
  const index = await readIndex(deps);
  assert.equal(index.default, A);
  assert.equal(index.accounts[0].clientId, 'resumed');
  assert.equal(index.accounts.length, 1);
}));
test('an empty account index reports unlinked without writing account markers', () => isolated(async () => {
  const auth = await getAuthentication(deps);
  assert.equal(auth.authState, 'unlinked');
  assert.equal(auth.accessToken, null);
}));
test('corrupt index is read tolerantly but cannot be overwritten by account mutations', () => isolated(async (home) => {
  const indexFile = path.join(home, 'accounts.json'); fs.writeFileSync(indexFile, '{broken');
  assert.deepEqual((await readIndex(deps)).accounts, []);
  await assert.rejects(addAccount({ key: A }, deps), /index is unreadable/);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), '{broken');
}));
test('migration retry follows a legacy generation advanced after an interrupted copy', () => isolated(async (home) => {
  fs.writeFileSync(path.join(home, 'accounts.migration.json'), JSON.stringify({ key: A }));
  await setCredentials(A, credentials('stale-copy'), deps);
  const dir = path.join(home, 'credentials'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ generation: 2, highestGeneration: 2, backend: 'file' }));
  fs.writeFileSync(path.join(dir, 'gen-2.json'), JSON.stringify({ token: JSON.stringify(credentials('rotated-source')) }));
  const index = await readIndex(deps);
  assert.equal(index.accounts[0].clientId, 'rotated-source');
  assert.equal((await readCredentials(deps, { account: A })).generation, 2);
}));
test('unreadable legacy committed credentials report unavailable, never unlinked', () => isolated(async (home) => {
  const dir = path.join(home, 'credentials'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ generation: 2, highestGeneration: 2, backend: 'file' }));
  const auth = await getAuthentication(deps);
  assert.equal(auth.authState, 'unavailable');
  assert.equal(auth.accessToken, null);
  assert.equal(fs.existsSync(path.join(home, 'accounts.json')), false);
}));
test('session bearer and machine identity come from one credential generation', () => isolated(async () => {
  await addAccount({ key: A, clientId: 'stale-index' }, deps);
  await setCredentials(A, credentials('new-client'), deps);
  const [session] = await linkedSessions(deps);
  assert.equal(session.clientId, 'new-client');
  assert.equal(session.token, 'token-new-client');
}));
