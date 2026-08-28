import { getAccessToken as _getAccessToken } from './token.mjs';
import { machineHeaders } from './machine-identity.mjs';
import { apiBase } from './config.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { resolveAbortController } from './abort-compat.mjs';

// Stdio ⇄ Streamable-HTTP bridge for the Beezi MCP server. Claude Code runs the
// bridge as a local stdio MCP server, so it never sees the portal's OAuth
// challenge — every forwarded request is authenticated with the same stored
// /beezi:login credentials the commands and hooks use (refresh included).
// Server→client push (the standing GET stream) is not bridged: the drafting
// tools are strictly request/response.

// Bounds a hung request, not normal tool latency (board writes take seconds). Measured from the
// last byte received rather than from the start, so a slow tool keeps its time as long as the
// stream is making progress.
const DEFAULT_TIMEOUT_MS = 120_000;
// The handshake gets a tighter budget than a tool call: an MCP client abandons a server that
// has not answered `initialize` within ~30s, so a reply that lands after that is worth nothing —
// the client is already gone and the server shows as forever "connecting".
const HANDSHAKE_TIMEOUT_MS = 20_000;
const SESSION_HEADER = 'mcp-session-id';
const NOT_LINKED_MESSAGE =
  'This machine is not linked to Beezi. Run /beezi:login in Claude Code, then retry.';
const REJECTED_MESSAGE =
  "Beezi rejected this machine's credentials. Run /beezi:login to relink.";
// While unlinked, poll for the credentials /beezi:login is about to store. A failed initialize
// would mark this server "failed" for the whole session — stdio servers are never retried — so
// the handshake must succeed even with no token, and this poll turns the eventual login into
// live tools with no /mcp reconnect.
const WATCH_INTERVAL_MS = 15_000;

export function mcpUrl() {
  return process.env.BEEZI_MCP_URL == null ? `${apiBase()}/mcp` : process.env.BEEZI_MCP_URL;
}

// Yields the data payload of each SSE event (multi-line `data:` fields joined
// per the SSE spec). The server closes the stream once every response for the
// POST has been sent, which ends the iteration.
async function* sseEvents(body, onProgress) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    if (onProgress) onProgress();
    buf += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = buf.match(/\r?\n\r?\n/))) {
      const raw = buf.slice(0, match.index);
      buf = buf.slice(match.index + match[0].length);
      const data = raw
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  }
}

export function createBridge(deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  const getToken = deps.getAccessToken == null ? _getAccessToken : deps.getAccessToken;
  const url = deps.url == null ? mcpUrl() : deps.url;
  const write = deps.write;
  const logError = deps.logError == null ? ((msg) => process.stderr.write(`[beezi-mcp] ${msg}\n`)) : deps.logError;
  const timeoutMs = deps.timeoutMs == null ? DEFAULT_TIMEOUT_MS : deps.timeoutMs;
  const handshakeMs = Math.min(timeoutMs, HANDSHAKE_TIMEOUT_MS);

  let sessionId = null;
  let initializeMsg = null;
  let reinit = null; // in-flight transparent re-initialize, shared by concurrent 404s
  let realInitDone = false; // the portal has actually seen initialize for this bridge
  let watcher = null;
  const setIntervalImpl = deps.setIntervalImpl == null ? setInterval : deps.setIntervalImpl;
  const clearIntervalImpl = deps.clearIntervalImpl == null ? clearInterval : deps.clearIntervalImpl;
  const watchIntervalMs = deps.watchIntervalMs == null ? WATCH_INTERVAL_MS : deps.watchIntervalMs;

  const isInitialize = (msg) => !Array.isArray(msg) && msg.method === 'initialize';

  // Ids of the requests in the message (single or legacy batch); responses and
  // notifications carry none and get no synthesized error.
  function requestIds(msg) {
    return (Array.isArray(msg) ? msg : [msg])
      .filter((m) => m && m.id !== undefined && m.method !== undefined)
      .map((m) => m.id);
  }

  function writeMessage(obj) {
    write(JSON.stringify(obj));
  }

  function errorResponse(id, message) {
    writeMessage({ jsonrpc: '2.0', id, error: { code: -32000, message } });
  }

  // One deadline per exchange, covering the response body as well as the headers. Clearing it
  // once the headers land — which is where the timeout used to end — leaves the stream read
  // unguarded, and a socket the OS left half-open across a laptop sleep delivers headers and
  // then nothing at all: no data, no close. That read never returns, so the request it belongs
  // to never answers and, because `reinit` memoizes the promise, neither does anything queued
  // behind it. `touch()` restarts the clock on every chunk, so progress buys more time.
  function createDeadline(ms) {
    const AbortControllerImpl = resolveAbortController();
    const controller = new AbortControllerImpl();
    let timer = null;
    const arm = () => { timer = setTimeout(() => controller.abort(), ms); };
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    arm();
    return { signal: controller.signal, touch: () => { stop(); arm(); }, stop };
  }

  async function post(msg, token, deadline) {
    return fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(sessionId ? { [SESSION_HEADER]: sessionId } : {}),
        ...machineHeaders(),
      },
      body: JSON.stringify(msg),
      signal: deadline.signal,
    });
  }

  // Streams every JSON-RPC message of a response to stdout, re-serialized so
  // each lands as one line. `silent` drains instead — used for the transparent
  // re-initialize, whose response the client must not see twice.
  async function emit(res, { silent = false, deadline } = {}) {
    const newSession = res.headers.get(SESSION_HEADER);
    if (newSession) sessionId = newSession;
    if (res.status === 202 || res.status === 204) return;
    const contentType = res.headers.get('content-type');
    if ((contentType == null ? '' : contentType).includes('text/event-stream')) {
      for await (const data of sseEvents(res.body, deadline == null ? undefined : deadline.touch)) {
        if (!silent) writeMessage(JSON.parse(data));
      }
      return;
    }
    const text = await res.text();
    if (text && !silent) writeMessage(JSON.parse(text));
  }

  // The portal's MCP sessions are in-memory; an API restart between turns loses
  // them (HTTP 404). Rebuild one transparently — replay initialize (response
  // hidden) and the initialized notification — so the client never notices.
  function reinitialize(token) {
    if (reinit == null) {
      reinit = (async () => {
        const deadline = createDeadline(handshakeMs);
        try {
          sessionId = null;
          const res = await post(initializeMsg, token, deadline);
          if (!res.ok) throw new Error(`re-initialize failed (HTTP ${res.status})`);
          await emit(res, { silent: true, deadline });
          const ack = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token, deadline);
          await emit(ack, { deadline });
          realInitDone = true;
          stopWatcher();
        } finally {
          deadline.stop();
        }
      })().finally(() => {
        reinit = null;
      });
    }
    return reinit;
  }

  function stopWatcher() {
    if (watcher) {
      clearIntervalImpl(watcher);
      watcher = null;
    }
  }

  function startWatcher() {
    if (watcher) return;
    watcher = setIntervalImpl(async () => {
      const token = await getToken().catch(() => null);
      if (!token) return;
      try {
        await reinitialize(token);
        // The client accepted an empty tool list during the synthetic handshake; this makes
        // it re-fetch, so the Beezi tools appear the moment the login lands.
        writeMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      } catch { /* portal unreachable — keep watching */ }
    }, watchIntervalMs);
    if (watcher != null && typeof watcher.unref === 'function') watcher.unref();
  }

  // An unlinked machine still gets a healthy server: the handshake succeeds locally, the tool
  // list is empty, and only actual calls explain what to do. Erroring initialize instead
  // strands the very login flow that fixes the link.
  // Answers the handshake locally, with an empty tool list, and leaves the watcher to replay the
  // real one. Shared by the unlinked machine and by a handshake the portal could not serve.
  function synthesizeHandshake(msg, instructions) {
    writeMessage({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion:
          msg.params != null && msg.params.protocolVersion != null
            ? msg.params.protocolVersion
            : '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'beezi', version: '0.0.0' },
        instructions,
      },
    });
    startWatcher();
  }

  function handleUnlinked(msg, ids) {
    if (isInitialize(msg)) {
      synthesizeHandshake(msg, 'Beezi tools activate after /beezi:login links this machine.');
      return;
    }
    if (!Array.isArray(msg) && msg.method === 'tools/list' && msg.id !== undefined) {
      writeMessage({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
      return;
    }
    ids.forEach((id) => errorResponse(id, NOT_LINKED_MESSAGE));
  }

  async function serverErrorMessage(res) {
    try {
      const body = await res.json();
      // JSON-RPC errors nest under `error`; the portal's HTTP errors put the sentence at the
      // top level with `error` holding only the status name ("Forbidden"). Read both, so a
      // plan or permission refusal reaches the user in the server's own words.
      const err = body == null ? undefined : body.error;
      const errMessage = err == null ? undefined : err.message;
      const message = errMessage == null
        ? (body != null && typeof body.message === 'string' ? body.message : null)
        : errMessage;
      if (message) return `Beezi MCP error: ${message}`;
    } catch {
      /* non-JSON body */
    }
    return `Beezi MCP request failed (HTTP ${res.status}).`;
  }

  async function handleMessage(msg) {
    const ids = requestIds(msg);
    if (isInitialize(msg)) {
      initializeMsg = msg;
      sessionId = null;
    }
    let token = await getToken().catch(() => null);
    if (!token) {
      handleUnlinked(msg, ids);
      return;
    }
    // Linked after a synthetic handshake: the portal has never seen initialize, so replay it
    // before forwarding anything else — the same rebuild the 404 path uses.
    if (!realInitDone && !isInitialize(msg) && initializeMsg) {
      try {
        await reinitialize(token);
      } catch {
        ids.forEach((id) => errorResponse(id, 'Beezi MCP request failed: the Beezi server is unreachable.'));
        return;
      }
    }
    const deadline = createDeadline(isInitialize(msg) ? handshakeMs : timeoutMs);
    try {
      let res = await post(msg, token, deadline);
      if (res.status === 404 && initializeMsg && !isInitialize(msg)) {
        await reinitialize(token);
        res = await post(msg, token, deadline);
      }
      // A 401 is the server telling us the token is dead — better evidence than the expires_at
      // we estimated locally, which is a pure guess when the token response omits expires_in.
      // Renew once on its word and retry, so a short-lived token doesn't strand the whole
      // MCP server until the user re-links by hand.
      if (res.status === 401) {
        const refreshed = await getToken({}, { forceRefresh: true }).catch(() => null);
        if (refreshed && refreshed !== token) {
          token = refreshed;
          res = await post(msg, token, deadline);
        }
      }
      if (res.ok) {
        if (isInitialize(msg)) {
          realInitDone = true;
          stopWatcher();
        }
        await emit(res, { deadline });
        return;
      }
      if (res.status === 401) {
        ids.forEach((id) => errorResponse(id, REJECTED_MESSAGE));
        return;
      }
      // 403 is authenticated-but-not-permitted: the account lacks access to this feature, and
      // no token can change that. Sending the user to /beezi:login (as a shared 401/403 branch
      // did) is advice that cannot work, so report what the server actually said.
      if (res.status === 403) {
        const forbidden = await serverErrorMessage(res);
        ids.forEach((id) => errorResponse(id, forbidden));
        return;
      }
      const message = await serverErrorMessage(res);
      ids.forEach((id) => errorResponse(id, message));
    } catch (error) {
      // Only a thrown error lands here — a timeout or a dead socket, never the portal's own
      // answer (an HTTP status leaves the try block on its own path). Failing the handshake on
      // one of those strands the server for the rest of the session: the client marks it failed
      // and stdio servers are never retried. Answer it locally instead and let the watcher
      // replay the real handshake once the portal is reachable again.
      if (isInitialize(msg)) {
        synthesizeHandshake(msg, 'Beezi tools activate once the Beezi server is reachable.');
        return;
      }
      ids.forEach((id) =>
        errorResponse(id, `Beezi MCP request failed: ${error == null || error.message == null ? String(error) : error.message}`),
      );
    } finally {
      deadline.stop();
    }
  }

  async function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      logError(`dropped non-JSON input: ${trimmed.slice(0, 120)}`);
      return;
    }
    await handleMessage(msg);
  }

  return { handleLine, handleMessage };
}
