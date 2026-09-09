import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { readSyncState, isDue, markAttempt } from './cost-state-sync-state.mjs';
import { spawnDetached } from './background-spawn.mjs';
import { credentialsFile } from './paths.mjs';

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'scripts', 'cost-state-sync.mjs',
);

// Called at the very END of the Stop hook, after its own work is done. Everything here is
// synchronous and cheap — one small JSON read and, at most once an hour, one spawn — because the
// hook's whole budget is 10s and it already spends seconds on network I/O.
//
// The attempt is stamped BEFORE the spawn on purpose: a child that dies on startup then costs one
// hour of silence instead of respawning on every single turn for the rest of the day.
//
// Never throws. A failure to schedule a background backfill must not turn into "Stop hook error".
export function maybeSpawnCostStateSync(deps = {}) {
  const readState = deps.readState == null ? readSyncState : deps.readState;
  const markAttemptImpl = deps.markAttemptImpl == null ? markAttempt : deps.markAttemptImpl;
  const spawnImpl = deps.spawnImpl == null ? spawnDetached : deps.spawnImpl;
  const existsImpl = deps.existsSyncImpl == null ? fs.existsSync : deps.existsSyncImpl;
  const now = deps.now == null ? (() => Date.now()) : deps.now;
  try {
    // Cheapest possible "is this machine even linked" check, before anything else. Without it,
    // every user who never ran /beezi:login gets an hourly process that shells out to
    // PowerShell/DPAPI and writes state into ~/.beezi, only to find no token. The credentials
    // file is one of two token homes (the OS secret store is the other), so this is a heuristic:
    // a false negative on an OS-store-only machine costs a backfill, never correctness.
    if (!existsImpl(credentialsFile())) return false;
    const nowMs = now();
    if (!isDue(readState(), nowMs)) return false;
    markAttemptImpl(nowMs);
    return spawnImpl(SCRIPT) === true;
  } catch {
    return false;
  }
}
