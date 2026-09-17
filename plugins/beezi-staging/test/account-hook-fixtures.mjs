import * as checkpoint from '../lib/checkpoint.mjs';
import * as start from '../lib/session-start.mjs';
import * as audit from '../lib/session-audit.mjs';
import * as failure from '../lib/stop-failure.mjs';
import * as track from '../lib/track-session.mjs';
export const KEY = 'aaaaaaaa';
const row = { key: KEY, clientId: 'client-a', status: 'linked' };
const session = (token) => ({ ...row, token });
function scoped(deps) {
  return { listAccounts: async () => {
    const token = deps.getAccessToken == null ? 'tok' : await deps.getAccessToken().catch(() => null);
    return token ? [row] : [];
  }, linkedSessions: async () => {
    const token = deps.getAccessToken == null ? 'tok' : await deps.getAccessToken();
    return token ? [session(token)] : [];
  }, ...deps };
}
export const runCheckpoint = (input, deps = {}, options) => checkpoint.runCheckpoint(input, scoped(deps), options);
export const flushQueue = (token, deps) => checkpoint.flushQueue(session(token), deps);
export const runSessionStart = (input, deps = {}) => start.runSessionStart(input, { listAccounts: async () => [row], getDefaultKey: async () => KEY, ...deps });
export const reportSessionError = (input, deps = {}) => failure.reportSessionError(input, scoped(deps));
export const trackSession = (input, deps = {}) => track.trackSession(input, scoped({ ...deps, runCheckpoint: async (...args) => ({ flushes: [], ...await deps.runCheckpoint(...args) }) }));
export const runAudit = (deps = {}, options = {}) => audit.runAudit({
  ...deps,
  getAuthentication: deps.getAuthentication || (async () => {
    const token = await deps.getAccessToken();
    return { authState: token ? 'ready' : 'unlinked', accessToken: token };
  }),
  sessionFor: async () => session('tok'),
  loadLedgerImpl: (_key, identity) => deps.loadLedgerImpl(identity),
  saveLedgerImpl: (_key, ledger) => deps.saveLedgerImpl(ledger),
}, { account: KEY, ...options });
