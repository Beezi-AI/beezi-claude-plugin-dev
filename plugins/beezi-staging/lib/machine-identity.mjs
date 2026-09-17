import os from 'os';

// Identifying headers for the portal's linked-machines view (display/bookkeeping
// only — auth stays the bearer token). X-Beezi-Agent picks the tool axis for the
// backfill scope and analytics source — the server defaults an absent header to
// claude-code, but explicit beats implicit.
export function machineHeaders(clientId) {
  const headers = {
    'X-Beezi-Agent': 'claude-code',
    'X-Beezi-Host': String(os.hostname()).slice(0, 255),
  };
  if (clientId) headers['X-Beezi-Client'] = clientId;
  return headers;
}
