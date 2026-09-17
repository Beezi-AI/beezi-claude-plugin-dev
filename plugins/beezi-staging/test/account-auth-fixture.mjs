// Explicit single-account fixture for the existing generation-store regression cases.
import fs from 'node:fs';
import * as credentials from '../lib/credentials.mjs';
import * as lock from '../lib/credential-lock.mjs';
import * as markers from '../lib/auth-markers.mjs';
import * as token from '../lib/token.mjs';
import * as worker from '../lib/refresh-worker.mjs';
import { credentialControlFile } from '../lib/paths.mjs';
export * from '../lib/credentials.mjs';
export * from '../lib/credential-lock.mjs';
export * from '../lib/auth-markers.mjs';
export * from '../lib/token.mjs';
export * from '../lib/refresh-worker.mjs';
export const ACCOUNT = 'aabbccdd';
export const acquireCredentialLock = (options = {}, deps) => lock.acquireCredentialLock({ account: ACCOUNT, ...options }, deps);
export const readCredentialLockOwner = () => lock.readCredentialLockOwner(ACCOUNT);
export const commitCredentials = (value, options, deps) => credentials.commitCredentials(value, { account: ACCOUNT, ...options }, deps);
export const deleteCredentialGeneration = (options, deps) => credentials.deleteCredentialGeneration({ account: ACCOUNT, ...options }, deps);
export const readCredentials = async (deps, options = {}) => {
  if (!fs.existsSync(credentialControlFile(ACCOUNT)) && !options.lock) {
    const r = await credentials.migrateSingleAccountStore(ACCOUNT, deps);
    if (r.status !== 'none') return r.status === 'ready' ? { ...r, migrated: true } : r;
  }
  return credentials.readCredentials(deps, { account: ACCOUNT, ...options });
};
export const getCredentials = async (deps) => { const r = await readCredentials(deps); return r.status === 'ready' ? r.credentials : null; };
export const setCredentials = (value, deps) => credentials.setCredentials(ACCOUNT, value, deps);
export const deleteCredentials = (deps) => credentials.deleteCredentials(ACCOUNT, deps);
export const getAuthentication = (deps, options) => token.getAuthentication(deps, { account: ACCOUNT, ...options });
export const getAccessToken = (deps, options) => token.getAccessToken(deps, { account: ACCOUNT, ...options });
export const runRefreshWorker = (options, deps) => worker.runRefreshWorker({ account: ACCOUNT, ...options }, deps);
export const recordInflight = (...args) => markers.recordInflight(ACCOUNT, ...args);
export const readInflight = (...args) => markers.readInflight(ACCOUNT, ...args);
export const recordBackoff = (...args) => markers.recordBackoff(ACCOUNT, ...args);
export const readBackoff = (...args) => markers.readBackoff(ACCOUNT, ...args);
export const readReauthMarker = (...args) => markers.readReauthMarker(ACCOUNT, ...args);
export const recordReauthRequired = (...args) => markers.recordReauthRequired(ACCOUNT, ...args);
export const clearAuthMarkers = (...args) => markers.clearAuthMarkers(ACCOUNT, ...args);
export const clearInflight = (...args) => markers.clearInflight(ACCOUNT, ...args);
export const readAuthState = (...args) => markers.readAuthState(ACCOUNT, ...args);
