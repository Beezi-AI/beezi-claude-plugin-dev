import path from 'path';
import { fileURLToPath } from 'url';
import { weeklyUsageFile } from './paths.mjs';
import { readJson, writeJsonSecure } from './fs-store.mjs';
import { spawnDetached } from './background-spawn.mjs';
import { authHeaders } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';
import { AUTH_STATES } from './auth-state.mjs';
import { listAccounts as _listAccounts, getDefaultKey as _getDefaultKey, getAccount as _getAccount, AccountStatus } from './accounts.mjs';
import { isMultiTenant, readSessionWorkspace, resolveReadTenant } from './workspace.mjs';

const VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
// Refetched at most once a day and only once the line is nearly due (each call runs the portal's health computation);
// shown only while the numbers are under 8 days old, at most once a week.
const REFRESH_MS = DAY_MS;
const DUE_SOON_MS = 6 * DAY_MS;
const FRESH_MS = 8 * DAY_MS;
const SHOW_EVERY_MS = 7 * DAY_MS;
// One deadline for the whole initialize → initialized → tools/call exchange.
const EXCHANGE_TIMEOUT_MS = 20_000;
const TOOL = 'get_my_usage_summary';
const SESSION_HEADER = 'mcp-session-id';
const UNAUTHORIZED = 'unauthorized';
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'weekly-usage.mjs');

function ms(iso) {
  const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(at) ? at : null;
}

function readRaw(key, deps) {
  const read = deps.readJsonImpl == null ? readJson : deps.readJsonImpl;
  const raw = read(weeklyUsageFile(key), null);
  return raw != null && typeof raw === 'object' ? raw : null;
}

// The cached { version, fetchedAt, tenantId, sessions, usageValueUsd, shownAt }, or null when missing or malformed.
export function readWeeklyUsage(key, deps = {}) {
  const raw = readRaw(key, deps);
  if (raw == null || raw.version !== VERSION || ms(raw.fetchedAt) == null || typeof raw.sessions !== 'number') return null;
  return raw;
}

function writeWeeklyUsage(key, record, deps) {
  const write = deps.writeJsonImpl == null ? writeJsonSecure : deps.writeJsonImpl;
  try { write(weeklyUsageFile(key), record); } catch { /* best-effort */ }
}

// The line is due within a day (never shown, or shown 6+ days ago) and the numbers are missing or a day old.
export function needsFetch(cache, nowMs) {
  const shown = cache == null ? null : ms(cache.shownAt);
  if (shown != null && nowMs - shown < DUE_SOON_MS) return false;
  const at = cache == null ? null : ms(cache.fetchedAt);
  return at == null || nowMs - at >= REFRESH_MS;
}

// The cache only when it was fetched for this read workspace (null: one or unknown workspaces).
export function cacheForTenant(cache, tenantId) {
  if (cache == null) return null;
  return (cache.tenantId == null ? null : cache.tenantId) === (tenantId == null ? null : tenantId) ? cache : null;
}

// The one account the weekly line is for: the only linked account, else the default one; null when neither.
export function weeklyAccountKey(rows, defaultKey) {
  const linked = (rows || []).filter((row) => row != null && (row.status == null || row.status === AccountStatus.LINKED));
  if (linked.length === 1) return linked[0].key;
  return linked.some((row) => row.key === defaultKey) ? defaultKey : null;
}

// The workspace a multi-workspace account reads from this session; null for one or unknown workspaces.
export function weeklyTenantId(row, state) {
  return isMultiTenant(row) ? resolveReadTenant(row, state).tenantId : null;
}

// Fresh numbers with at least one session, not shown in the last 7 days.
export function shouldShowWeekly(cache, nowMs) {
  if (cache == null || !(cache.sessions > 0)) return false;
  const fetched = ms(cache.fetchedAt);
  if (fetched == null || nowMs - fetched > FRESH_MS) return false;
  const shown = ms(cache.shownAt);
  return shown == null || nowMs - shown >= SHOW_EVERY_MS;
}

export function markWeeklyShown(key, cache, nowMs, deps = {}) {
  writeWeeklyUsage(key, { ...cache, shownAt: new Date(nowMs).toISOString() }, deps);
}

// The tool result's key numbers, from structuredContent or the JSON text; null for an error, a plan notice or any other shape.
export function parseUsageSummary(result) {
  if (result == null || typeof result !== 'object' || result.isError === true) return null;
  let body = result.structuredContent;
  if (body == null || typeof body !== 'object') {
    const first = Array.isArray(result.content) ? result.content[0] : null;
    try { body = first != null && typeof first.text === 'string' ? JSON.parse(first.text) : null; } catch { body = null; }
  }
  if (body == null || typeof body !== 'object' || body.status === 'unavailable' || body.status === 'failed') return null;
  const numbers = body.keyNumbers;
  if (numbers == null || typeof numbers !== 'object') return null;
  const sessions = numbers.sessions;
  if (typeof sessions !== 'number' || !Number.isFinite(sessions) || sessions < 0) return null;
  const usage = numbers.usageValueUsd;
  return { sessions, usageValueUsd: typeof usage === 'number' && Number.isFinite(usage) ? usage : null };
}

// JSON-RPC messages of a reply, whether plain JSON or an SSE stream of `data:` events.
function replyMessages(res, text) {
  const type = res.headers != null && typeof res.headers.get === 'function' ? res.headers.get('content-type') : null;
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  const raw = String(type == null ? '' : type).includes('text/event-stream')
    ? text.split(/\r?\n\r?\n/).map((event) => event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')).filter(Boolean).map(parse)
    : [text === '' ? null : parse(text)];
  return raw.flatMap((m) => (Array.isArray(m) ? m : [m])).filter((m) => m != null);
}

// initialize → notifications/initialized → tools/call over the plugin's MCP endpoint; the summary, 'unauthorized' on a 401, else null.
export async function fetchUsageSummary(session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const url = deps.url == null ? (await import('./mcp-bridge.mjs')).mcpUrl() : deps.url;
  const AbortControllerImpl = resolveAbortController();
  const controller = new AbortControllerImpl();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs == null ? EXCHANGE_TIMEOUT_MS : deps.timeoutMs);
  let mcpSession = null;
  const post = (msg) => fetchImpl(url, {
    method: 'POST',
    headers: {
      ...authHeaders(session),
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(mcpSession == null ? {} : { [SESSION_HEADER]: mcpSession }),
    },
    body: JSON.stringify(msg),
    signal: controller.signal,
  });
  try {
    const init = await post({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'beezi-plugin-weekly-usage', version: '1' } },
    });
    if (init.status === 401) return UNAUTHORIZED;
    if (!init.ok) return null;
    const sid = init.headers.get(SESSION_HEADER);
    if (sid) mcpSession = sid;
    await init.text();
    const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    if (!ack.ok) return null;
    await ack.text();
    const call = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: TOOL, arguments: { period: '7d' } } });
    if (!call.ok) return null;
    const reply = replyMessages(call, await call.text()).find((m) => m.id === 2);
    return reply == null ? null : parseUsageSummary(reply.result);
  } catch {
    return null;
  } finally {
    // Best-effort and under the same deadline: the portal's MCP sessions live in memory until closed.
    if (mcpSession != null) {
      await Promise.resolve().then(() => fetchImpl(url, {
        method: 'DELETE',
        headers: { ...authHeaders(session), [SESSION_HEADER]: mcpSession },
        signal: controller.signal,
      })).catch(() => null);
    }
    clearTimeout(timer);
  }
}

// Worker body: fetch this account's 7-day numbers and cache them, keeping shownAt; stores nothing on any failure.
export async function runWeeklyUsage({ account, tenantId = null } = {}, deps = {}) {
  if (account == null || account === '') return null;
  const getAuthentication = deps.getAuthentication == null ? (await import('./token.mjs')).getAuthentication : deps.getAuthentication;
  const getAccount = deps.getAccount == null ? _getAccount : deps.getAccount;
  const now = deps.now == null ? Date.now : deps.now;
  const row = await Promise.resolve().then(() => getAccount(account)).catch(() => null);
  if (row == null) return null;
  const signIn = async (options) => {
    const auth = await Promise.resolve().then(() => getAuthentication({}, { account, ...options })).catch(() => null);
    if (auth == null || auth.authState !== AUTH_STATES.READY) return null;
    return { key: account, token: auth.accessToken, clientId: auth.clientId == null ? row.clientId : auth.clientId, tenantId };
  };
  let session = await signIn({});
  if (session == null) return null;
  let usage = await fetchUsageSummary(session, deps);
  // The portal's 401 is better evidence of expiry than the stored estimate: renew once and retry.
  if (usage === UNAUTHORIZED) {
    session = await signIn({ forceRefresh: true });
    usage = session == null ? null : await fetchUsageSummary(session, deps);
  }
  if (usage == null || usage === UNAUTHORIZED) return null;
  const previous = readWeeklyUsage(account, deps);
  const record = {
    version: VERSION,
    fetchedAt: new Date(now()).toISOString(),
    tenantId: tenantId == null ? null : tenantId,
    sessions: usage.sessions,
    usageValueUsd: usage.usageValueUsd,
    shownAt: previous == null || previous.shownAt == null ? null : previous.shownAt,
  };
  writeWeeklyUsage(account, record, deps);
  return record;
}

// SessionStart: starts the detached fetch for the banner's account (the only linked one, else the default) when its cache is stale. Never throws.
// Argv carries the account key and read workspace id only, never a token.
export async function maybeSpawnWeeklyUsage(input, deps = {}) {
  const listAccounts = deps.listAccounts == null ? _listAccounts : deps.listAccounts;
  const getDefaultKey = deps.getDefaultKey == null ? _getDefaultKey : deps.getDefaultKey;
  const now = deps.now == null ? Date.now : deps.now;
  const spawn = deps.spawnImpl == null ? ((script, args) => spawnDetached(script, {}, args)) : deps.spawnImpl;
  try {
    const rows = await listAccounts(deps);
    const linked = rows.filter((row) => row != null && (row.status == null || row.status === AccountStatus.LINKED));
    if (linked.length === 0) return false;
    const key = weeklyAccountKey(rows, linked.length === 1 ? null : await getDefaultKey(deps));
    const row = linked.find((r) => r.key === key);
    if (row == null) return false;
    const sessionId = input == null ? null : input.session_id;
    const tenantId = weeklyTenantId(row, readSessionWorkspace(sessionId));
    if (!needsFetch(cacheForTenant(readWeeklyUsage(key, deps), tenantId), now())) return false;
    // One attempt a day, stamped before the spawn: a portal without the tool, or offline, is not asked at every session start.
    const raw = readRaw(key, deps);
    const tried = raw == null ? null : ms(raw.attemptedAt);
    if (tried != null && now() - tried < REFRESH_MS) return false;
    writeWeeklyUsage(key, { ...(raw || {}), version: VERSION, attemptedAt: new Date(now()).toISOString() }, deps);
    return spawn(SCRIPT, ['--account', key, ...(tenantId == null ? [] : ['--tenant', tenantId])]) === true;
  } catch {
    return false;
  }
}
