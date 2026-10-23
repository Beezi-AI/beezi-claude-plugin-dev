import { runAudit as _runAudit, planWorkspaceRuns as _planWorkspaceRuns, createRunCache as _createRunCache, AuditReason } from './session-audit.mjs';
import { BackfillHalt } from './audit-flush.mjs';
import { readSessionShell as _readSessionShell } from './transcript-shell.mjs';
import { pendingHistoryOf, waitingOnRecent, RunOutcome } from './pending-history.mjs';
import {
  OfferEngine, coverageUnknown, replayOptions, offerTenantKey, answeredBy, readOffer as _readOffer, removeOffer as _removeOffer,
} from './history-offer.mjs';

const REFUSED_REASONS = [AuditReason.NO_ACCOUNT, AuditReason.WORKSPACE_REQUIRED, AuditReason.AUDIT_ONLY, AuditReason.ALREADY_COMPLETED];
const REFUSED_HALTS = [BackfillHalt.ALREADY_COMPLETED, BackfillHalt.NOT_ALLOWED, BackfillHalt.FORBIDDEN, BackfillHalt.UNSUPPORTED_SERVER];

// One run's meaning for the marker; `waiting` = a recent session predates the request. Only sync runs ask coverage.
export function classifyRun(result, waiting, engine = OfferEngine.SYNC) {
  if (result == null) return RunOutcome.FAILED;
  if (result.reason === AuditReason.BUSY) return RunOutcome.BUSY;
  if (REFUSED_REASONS.indexOf(result.reason) !== -1 || REFUSED_HALTS.indexOf(result.halt) !== -1) return RunOutcome.REFUSED;
  if (result.ok !== true || result.reason != null || result.halt != null) return RunOutcome.FAILED;
  if (result.reportsFailed > 0) return RunOutcome.FAILED;
  if (engine !== OfferEngine.BACKFILL && coverageUnknown(result)) return RunOutcome.FAILED;
  return waiting ? RunOutcome.WAITING : RunOutcome.CLEAN;
}

function startedAtMs(recent, readShell) {
  try {
    const shell = readShell(recent.path);
    const ms = shell == null ? NaN : Date.parse(shell.startedAt);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

// Each consented workspace with the offer accepted for it and its replay options; options are null without one.
function plannedRuns(row, entries, planWorkspaceRuns) {
  let plan = null;
  const planOnce = (r) => {
    if (plan == null) plan = planWorkspaceRuns(r);
    return plan;
  };
  return entries.map((entry) => {
    const offer = entry.accepted != null && Array.isArray(entry.accepted.sessionIds) ? entry.accepted : null;
    const options = offer == null ? null : replayOptions(row, entry.tenantId, offer, { planWorkspaceRuns: planOnce });
    return { entry, tenantKey: offerTenantKey(row, entry.tenantId), offer, options };
  });
}

async function linkedRow(accounts, key) {
  return (await accounts.listAccounts()).find((a) => a.key === key && a.status === accounts.AccountStatus.LINKED);
}

async function loadAccounts(deps) {
  return deps.accounts == null ? import('./accounts.mjs') : deps.accounts;
}

// Runs every consented workspace of one account once and settles each entry; the workspace's current choice is not consulted (K6).
export async function runPendingHistory(key, deps = {}) {
  const accounts = await loadAccounts(deps);
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  const readShell = deps.readSessionShell == null ? _readSessionShell : deps.readSessionShell;
  const readOffer = deps.readOffer == null ? _readOffer : deps.readOffer;
  const removeOffer = deps.removeOffer == null ? _removeOffer : deps.removeOffer;
  const now = deps.now == null ? () => Date.now() : deps.now;
  // Stamped before the row is read: a request written after the read is newer than the plan, so it stays.
  const plannedAtMs = now();
  const row = await linkedRow(accounts, key);
  if (row == null) return [];
  const entries = pendingHistoryOf(row);
  if (entries.length === 0) return [];
  await accounts.notePendingAttempt(key, entries.map((e) => e.tenantId), new Date(plannedAtMs).toISOString());
  // One git cache for every workspace's run, so each session's git correlation runs once.
  const runCache = (deps.createRunCache == null ? _createRunCache : deps.createRunCache)();
  const runs = plannedRuns(row, entries, deps.planWorkspaceRuns == null ? _planWorkspaceRuns : deps.planWorkspaceRuns);
  const done = [];
  let busy = false;
  for (const { entry, tenantKey, offer, options } of runs) {
    let run = { outcome: busy ? RunOutcome.BUSY : RunOutcome.REFUSED, sent: 0, skipped: 0 };
    if (!busy && options != null) {
      // A throwing run settles as failed (classifyRun's null) rather than leaving the entry unsettled.
      const result = await runAudit({ runCache }, options).catch(() => null);
      const recent = result != null && Array.isArray(result.recent) ? result.recent.map((r) => startedAtMs(r, readShell)) : [];
      run = { outcome: classifyRun(result, waitingOnRecent(recent, entry.requestedAt), offer.engine), sent: result == null ? 0 : result.sessionsImported || 0, skipped: 0 };
      busy = run.outcome === RunOutcome.BUSY;
    }
    // Only a run that answered the offer file now on disk settles it; a newer question stays (final M3).
    if (run.outcome === RunOutcome.CLEAN && answeredBy(readOffer(key, tenantKey), offer.sessionIds)) {
      // Nothing settles while a session the offer covers is still open (final M6).
      if (offer.active === 0) await accounts.recordOfferSettled(key, tenantKey, { changedAt: offer.changedAt == null ? null : offer.changedAt });
      else await accounts.recordOfferRescan(key, tenantKey);
      removeOffer(key, tenantKey);
    }
    const state = await accounts.settlePendingHistory(key, entry.tenantId, run, { plannedAtMs, nowMs: now() });
    done.push({ tenantId: entry.tenantId, outcome: run.outcome, state });
  }
  return done;
}

// Repeats the pass while a request written during it is still pending (a later Upload), up to
// maxPasses. A pass that met a busy lock stops: its entries are due again at the next retry.
export async function runPendingHistoryPasses(key, deps = {}, maxPasses = 3) {
  const accounts = await loadAccounts(deps);
  const now = deps.now == null ? () => Date.now() : deps.now;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const startedMs = now();
    const done = await runPendingHistory(key, deps);
    if (done.length === 0 || done.some((d) => d.outcome === RunOutcome.BUSY)) return;
    const row = await linkedRow(accounts, key);
    if (row == null || !pendingHistoryOf(row).some((e) => Date.parse(e.requestedAt) > startedMs)) return;
  }
}
