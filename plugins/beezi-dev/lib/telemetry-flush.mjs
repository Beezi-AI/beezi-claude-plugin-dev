import fs from 'fs';
import path from 'path';
import { apiBase, ENDPOINTS } from './config.mjs';
import { postJson } from './http.mjs';
import { readJsonSalvaged } from './fs-store.mjs';
import { telemetryDir } from './paths.mjs';

const MAX_PER_BATCH = 50;

// Everything the server DTO requires. A salvaged prefix can lack any of these — admitting it to
// the batch anyway would 400 the whole batch and cost every other event in it its file.
function isPostableEvent(value) {
  return value != null
    && typeof value.eventId === 'string' && value.eventId.length > 0
    && typeof value.code === 'string' && value.code.length > 0
    && typeof value.source === 'string' && value.source.length > 0
    && typeof value.pluginVersion === 'string' && value.pluginVersion.length > 0
    && Number.isInteger(value.count) && value.count >= 1
    && typeof value.firstSeenAt === 'string' && value.firstSeenAt.length > 0
    && typeof value.lastSeenAt === 'string' && value.lastSeenAt.length > 0;
}

// Drains pending diagnostics as one batch. Deliberately records nothing about its own failures:
// telemetry about telemetry is a loop that feeds itself.
export async function flushTelemetry(token, deps = {}) {
  const postJsonImpl = deps.postJsonImpl == null ? postJson : deps.postJsonImpl;
  const result = { sent: 0, deleted: 0, failed: 0 };
  if (!token) return result;

  const dir = telemetryDir();
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).slice(0, MAX_PER_BATCH); }
  catch { return result; }
  if (files.length === 0) return result;

  const batch = [];
  const paths = [];
  for (const file of files) {
    const filePath = path.join(dir, file);
    const { value } = readJsonSalvaged(filePath);
    if (!isPostableEvent(value)) {
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      continue;
    }
    batch.push(value);
    paths.push(filePath);
  }
  if (batch.length === 0) return result;

  try {
    const res = await postJsonImpl(`${apiBase()}${ENDPOINTS.pluginDiagnostics}`, token, { events: batch }, { timeoutMs: deps.timeoutMs });
    if (res.status >= 200 && res.status < 300) {
      result.sent = batch.length;
      for (const filePath of paths) {
        try { fs.unlinkSync(filePath); result.deleted += 1; } catch { /* best-effort */ }
      }
    } else if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403) {
      // Validation refused it; the same bytes will be refused forever. 401 (auth) and 403
      // (not now — an audit-mode tenant can convert) are not permanent, so they fall through
      // to `failed` and the files are kept for retry.
      for (const filePath of paths) {
        try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      }
    } else {
      result.failed = batch.length;
    }
  } catch {
    result.failed = batch.length;
  }
  return result;
}
