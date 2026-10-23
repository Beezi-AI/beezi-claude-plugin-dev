import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { resolveFetch } from './fetch-compat.mjs';
import { anonymizationFor, hasKind } from './anonymization.mjs';
import { AnonKind, scrubSessionError } from './anonymize.mjs';
import { parseRateLimitReset } from './rate-limit-reset.mjs';

const RATE_LIMIT_ERROR = 'rate_limit';
const MAX_ERROR_TEXT = 1000;
const ERROR_TEXT_FIELDS = ['errorDetails', 'lastAssistantMessage'];

// The reset time read from the error text, before any scrub can drop that text.
function withResetsAt(payload) {
  if (payload.resetsAt != null || payload.error !== RATE_LIMIT_ERROR) return payload;
  const resetsAt = parseRateLimitReset(payload.lastAssistantMessage, payload.occurredAt);
  return resetsAt == null ? payload : { ...payload, resetsAt };
}

// Each error text field cut to MAX_ERROR_TEXT characters; absent and null fields stay as they are.
function withClampedText(payload) {
  const out = { ...payload };
  for (const field of ERROR_TEXT_FIELDS) {
    if (typeof out[field] === 'string') out[field] = out[field].slice(0, MAX_ERROR_TEXT);
  }
  return out;
}

// POST one session-error record to Beezi. Fire-and-forget by convention; callers
// swallow the result. Returns { reported, status? , reason? }.
export async function postSessionError(payload, session, deps = {}) {
  const fetchImpl = deps.fetchImpl == null ? resolveFetch() : deps.fetchImpl;
  if (payload == null || !payload.sessionId || !payload.error) return { reported: false, reason: 'missing-fields' };
  if (!session || !session.token) return { reported: false, reason: 'no-token' };
  const full = withClampedText(withResetsAt(payload));
  const body = hasKind(anonymizationFor(session, session.tenantId), AnonKind.SESSIONS) ? scrubSessionError(full) : full;
  try {
    // timeoutMs is undefined for every hook caller, so postJson keeps its 3s default; the bulk
    // import raises it, having no 10s hook budget to protect.
    const res = await postJson(`${apiBase()}${ENDPOINTS.sessionErrors}`, session, body, { fetchImpl, timeoutMs: deps.timeoutMs });
    return { reported: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    return { reported: false, reason: 'network' };
  }
}
