import { runAudit as _runAudit, AuditReason } from './session-audit.mjs';
import { BackfillHalt } from './audit-flush.mjs';
import { describeAccount, markOfferAsked, recordOfferSettled, recordOfferRescan } from './accounts.mjs';
import {
  OfferEngine, OfferVia, offerTenantKey, offerLines, readOffer, writeOffer, removeOffer, offerToken, offerFromRun,
  engineRunOptions, replayOptions, coverageUnknown, workspaceWhoami, engineOf, plural, answeredBy,
} from './history-offer.mjs';
import { classifyRun } from './pending-history-run.mjs';
import { RunOutcome } from './pending-history.mjs';
import { readDeclinedIds, rememberDeclined, forgetDeclined } from './offer-declines.mjs';
import { tenantById, newFoldersOf } from './workspace.mjs';
import { anonymizationFor, kindsOf, pastSessionsFor, unionKinds } from './anonymization.mjs';
import { ANON_KINDS } from './anonymize.mjs';
import { pluginRoot } from './paths.mjs';
import { SOLO_KEY, offerStateOf } from './offer-gate.mjs';

// The per-workspace summary, the accept of a printed offer, and their output, shared by backfill.mjs, sync.mjs and history.mjs.

export const CHANGED_LINE = 'Beezi: these past sessions changed after the question was shown, so nothing was uploaded. Run /beezi:sync to see them again.';
const COVERAGE_NOTE = '  Note: Beezi could not confirm what it already has, so this run resumed from local progress only.';
const OFFER_COVERAGE_NOTE = '  Note: Beezi could not confirm what it already has, so it could not count past sessions. Nothing was uploaded; run /beezi:sync to try again.';

export const StopStatus = Object.freeze({ NONE: 'none', DONE: 'done', FAILED: 'failed' });

// Printed commands spell the script path out: tool output does not expand ${CLAUDE_PLUGIN_ROOT}.
export const scriptCommand = (name) => `node "${pluginRoot()}/scripts/${name}"`;

export function printProgress({ processed, total }) {
  console.log(`Beezi: ${processed}/${total} sessions read…`);
}

// The value after `name`, or null when the flag is absent.
export function flagValue(args, name) {
  const at = args.indexOf(name);
  return at === -1 || at + 1 >= args.length ? null : args[at + 1];
}

// The workspace a tenant key stands for; 'solo' (an account with no workspace list or id) stands for none.
export function tenantIdOfKey(tenantKey) {
  return tenantKey === SOLO_KEY ? null : tenantKey;
}

export function workspaceName(row, tenantId) {
  const t = tenantById(row, tenantId);
  if (t != null && t.name) return t.name;
  if (row.tenantName) return row.tenantName;
  return tenantId == null ? 'your workspace' : tenantId;
}

export function nothingLine(row, tenantId) {
  return `Beezi: nothing to upload for ${workspaceName(row, tenantId)}. Run /beezi:sync to check again.`;
}

// An upload answers only the question it was shown with: the token must match the stored offer's sessions and shown kinds.
export function matchesShown(offer, token) {
  return token != null && token === offerToken(offer.sessionIds, shownKindsOf(offer));
}

// The kinds an offer's question hid; a file that does not record them counts as all five hidden.
export function shownKindsOf(file) {
  return Array.isArray(file.shownKinds) ? file.shownKinds : ANON_KINDS.slice();
}

// Writes the offer under the kinds this question hides, prints it with `uploadPrefix --offer <token>` binding both,
// and remembers it as declined until an Upload answers it.
export async function askOffer(row, tenantId, offer, uploadPrefix) {
  const tenantKey = offerTenantKey(row, tenantId);
  const changedAt = pastSessionsFor(row, tenantId).changedAt;
  const asked = { ...offer, shownKinds: kindsOf(anonymizationFor(row, tenantId)) };
  writeOffer(row.key, tenantKey, asked);
  printOfferBlock(row, tenantId, asked, `${uploadPrefix} --offer ${offerToken(asked.sessionIds, asked.shownKinds)}`);
  await markOfferAsked(row.key, tenantKey, changedAt);
  rememberDeclined(row.key, tenantKey, asked.sessionIds, changedAt);
}

// The replay a yes stands for: the offer under every kind its question hid or the workspace hides now.
export function consentedReplay(row, tenantId, offer) {
  return { ...offer, kinds: unionKinds([shownKindsOf(offer), kindsOf(anonymizationFor(row, tenantId))]) };
}

// Sessions a rule routes, then the rest by New folders; a zero clause is dropped and null means print nothing.
export function routeSummary(row, plan) {
  const ruled = plan.counts.rule;
  const rest = plan.counts['new-folders'] + plan.counts.none + plan.counts.pending;
  const clauses = [];
  if (ruled > 0) clauses.push(`${plural(ruled, 'past session')} ${ruled === 1 ? 'follows' : 'follow'} your rules`);
  if (rest > 0) {
    // The first printed clause names the sessions.
    const lead = clauses.length === 0 ? plural(rest, 'past session') : String(rest);
    const newFolders = newFoldersOf(row);
    if (newFolders.mode === 'send') {
      const names = newFolders.tenantIds.map((id) => workspaceName(row, id)).join(', ');
      clauses.push(`${lead} in new folders ${rest === 1 ? 'goes' : 'go'} to ${names}`);
    } else if (newFolders.mode === 'none') {
      clauses.push(`${lead} in new folders ${rest === 1 ? 'is' : 'are'} not sent`);
    } else {
      clauses.push(`${lead} in repos or folders with no rule ${rest === 1 ? 'is' : 'are'} not sent this time`);
    }
  }
  return clauses.length === 0 ? null : `Beezi (${describeAccount(row)}): ${clauses.join('; ')}.`;
}

// One <offer> block: the K7 lines for the offer's shown kinds and the workspace name, then the question and both commands.
function printOfferBlock(row, tenantId, offer, uploadCommand) {
  const tenantKey = offerTenantKey(row, tenantId);
  const audit = offer.audit === true;
  const { lines, question } = offerLines({
    count: offer.sessionIds.length,
    firstMs: offer.firstMs,
    lastMs: offer.lastMs,
    folders: offer.folders,
    kinds: offer.shownKinds,
    workspace: workspaceName(row, tenantId),
  });
  const decline = `${scriptCommand('history.mjs')} decline --account ${row.key} --tenant ${tenantKey}${audit ? ' --audit' : ''}`;
  [
    `<offer account="${row.key}" tenant="${tenantKey}" audit="${audit ? 'yes' : 'no'}">`,
    ...lines,
    `question=${question}`,
    `upload-command=${uploadCommand}`,
    `decline-command=${decline}`,
    '</offer>',
  ].forEach((line) => console.log(line));
}

function failed(message) {
  console.error(`✗ ${message}`);
  return StopStatus.FAILED;
}

const exitStatus = (stop) => (stop === StopStatus.FAILED ? 1 : 0);

// The line for a run that stopped before uploading, and what it means; NONE when the run went ahead.
export function printStop(result, { via, workspace, dryRun = false }) {
  if (result.reason === AuditReason.BUSY) {
    console.log('Beezi: another session sync is running. Try again after it finishes.');
    return StopStatus.FAILED;
  }
  if (result.reason === AuditReason.AUTH_UNAVAILABLE) return failed('Beezi: authentication is temporarily unavailable. Try /beezi:sync again.');
  if (result.reason === AuditReason.NO_ACCOUNT) return failed('Beezi: that account is not linked or its link expired. Run /beezi:login and sign in as it.');
  if (result.reason === AuditReason.WORKSPACE_REQUIRED) {
    return failed('Beezi: this account belongs to several workspaces and none was picked for this run. Check where analytics go with /beezi:settings, then run /beezi:sync again.');
  }
  if (result.reason === AuditReason.ALREADY_COMPLETED || result.halt === BackfillHalt.ALREADY_COMPLETED) {
    console.log('✓ Beezi already has the history for this workspace — the one-time import has been used and cannot run again.');
    if (result.upgradeAdvised) {
      console.log('  Your audit snapshot is complete. To keep tracking new sessions and unlock live analytics, upgrade your workspace plan in the Beezi portal.');
    }
    return StopStatus.DONE;
  }
  if (result.reason === AuditReason.AUDIT_ONLY) {
    if (via === OfferVia.SYNC) {
      console.log(`Beezi: analytics are off for ${workspace}, so past sessions cannot be uploaded there. A workspace admin can turn them on in the Beezi portal.`);
    }
    return StopStatus.DONE;
  }
  if (result.halt === BackfillHalt.NOT_ALLOWED) return failed('Beezi: uploads are disabled for this workspace — the audit period has ended.');
  if (result.halt === BackfillHalt.UNSUPPORTED_SERVER) return failed('Beezi: this portal does not support /beezi:sync yet — try again after the next portal update.');
  if (result.halt === BackfillHalt.FORBIDDEN) {
    return failed(
      `Beezi: the server refused the upload (${result.lastError == null ? 'forbidden' : result.lastError}). ` +
        'Check your seat with your workspace admin, then try again.',
    );
  }
  if (result.halt === BackfillHalt.ANONYMIZATION_KEY_MISSING) {
    console.error(`Beezi: ${workspace} hides some names, but this machine has no valid key for it yet, so nothing was uploaded. Start a new Claude Code session to refresh it, then run /beezi:sync.`);
    return StopStatus.FAILED;
  }
  if (dryRun && (result.reason != null || result.halt != null)) {
    console.error(`Beezi: could not count past sessions for ${workspace} (${result.reason == null ? result.halt : result.reason}). Run /beezi:sync to try again.`);
    return StopStatus.FAILED;
  }
  return StopStatus.NONE;
}

// The sessions an upload left out, one line each.
function printLeftOut(result, engine) {
  if (engine === OfferEngine.BACKFILL && result.empty > 0) {
    console.log(`  ${plural(result.empty, 'session')} held no usage data (no assistant tokens recorded) — nothing to upload.`);
  }
  if (result.noRemote > 0) {
    console.log(
      `  ${plural(result.noRemote, 'session')} could not be matched to a repository — not uploaded. ` +
        'Their transcripts record no working directory.',
    );
  }
  if (result.emitFailed > 0) console.log(`  ${plural(result.emitFailed, 'session')} failed while being prepared — not uploaded.`);
  if (result.unreadable > 0) console.log(`  ${plural(result.unreadable, 'session')} could not be read — not uploaded.`);
  if (result.oversize > 0) console.log(`  ${plural(result.oversize, 'session')} were too large to read — not uploaded.`);
}

// The headline of an upload that went ahead, with what the server did with it.
function uploadedLine(result, engine) {
  const parts = [`✓ Beezi: uploaded ${plural(result.sessionsImported, 'session')} (${plural(result.reportsStored, 'report')} stored).`];
  if (result.alreadyImported > 0) parts.push(`${result.alreadyImported} were already uploaded.`);
  if (engine !== OfferEngine.BACKFILL && result.empty > 0) parts.push(`${result.empty} were already up to date.`);
  if (result.costStateSessions > 0) parts.push(`${plural(result.costStateSessions, 'session')} used Claude's own cost record for their totals.`);
  if (result.costStateOnlySessions > 0) {
    parts.push(`${plural(result.costStateOnlySessions, 'session')} had only that record (no repository, billing or timeline detail for those).`);
  }
  // Server-side skips already include the errored items; report the errors, not both numbers.
  if (result.itemErrors > 0) parts.push(`${plural(result.itemErrors, 'report')} skipped — their repository is not connected to Beezi.`);
  if (result.sessionsRejected > 0) parts.push(`${plural(result.sessionsRejected, 'session')} were rejected by the server and will not be retried.`);
  if (result.costStatesUnsupported && result.costStatesFailed > 0) {
    parts.push(`${plural(result.costStatesFailed, 'session')} could not be uploaded — this Beezi server does not accept Claude cost records yet. They are kept for the next run.`);
  } else if (result.costStatesUnsupported) {
    parts.push("This Beezi server does not accept Claude cost records yet, so totals use Beezi's own tally.");
  } else if (result.costStatesFailed > 0) {
    parts.push(`${plural(result.costStatesFailed, 'session')} could not be delivered — run /beezi:sync again to retry them.`);
  }
  if (result.reportsFailed > 0 || result.unattributed > 0 || result.permanentRejections > 0) {
    const reason = result.lastError ? ` (last error: ${result.lastError})` : '';
    parts.push(`${plural(result.reportsFailed, 'report')} could not be delivered${reason} — run /beezi:sync again to retry them.`);
  }
  return parts.join(' ');
}

// One accepted offer's upload, printed after its stop line if any; the exit status.
function printUploadResult(result, engine, { via, workspace }) {
  const stop = printStop(result, { via, workspace });
  if (stop !== StopStatus.NONE) return exitStatus(stop);
  if (result.coworkWarnings > 0) console.log('Beezi: some Cowork cache data could not be read; run /beezi:sync again to retry.');
  if (result.scanned === 0) {
    console.log('✓ Beezi: no past Claude Code sessions found to upload.');
    return 0;
  }
  // Without a trusted coverage answer the run fell back to local cursors, which a wiped or re-linked ~/.beezi does not have.
  if (engine !== OfferEngine.BACKFILL && coverageUnknown(result)) console.log(COVERAGE_NOTE);
  if (result.candidates === 0) {
    console.log(`✓ Beezi: nothing new to upload${result.alreadyImported > 0 ? ` (${plural(result.alreadyImported, 'session')} already uploaded)` : ''}.`);
    return 0;
  }
  if ((result.reportsFailed > 0 || result.costStatesFailed > 0) && result.sessionsImported === 0) {
    if (result.costStatesUnsupported) {
      return exitStatus(failed(
        'Beezi: upload stopped — this Beezi server does not accept Claude cost records yet. ' +
          'Nothing was uploaded and nothing was lost; run /beezi:sync again after the portal update.',
      ));
    }
    return exitStatus(failed(
      `Beezi: upload stopped — could not reach the server (${result.lastError == null ? 'unknown error' : result.lastError}). ` +
        'Run /beezi:sync again to continue where it left off.',
    ));
  }
  console.log(uploadedLine(result, engine));
  printLeftOut(result, engine);
  if (result.plannedReports > result.reportsStored + result.reportsSkipped) {
    console.log(`  Note: ${plural(result.plannedReports, 'report')} sent, ${result.reportsStored} stored and ${result.reportsSkipped} skipped by the server.`);
  }
  if (result.timelines > 0) console.log(`  ${plural(result.timelines, 'session timeline')} attached.`);
  // timelinesDropped is a subset of the offered-minus-attached gap, so one stanza covers both.
  const notAttached = result.timelinesOffered - result.timelines;
  if (notAttached > 0) {
    console.log(
      `  ${plural(notAttached, 'session timeline')} could not be attached` +
        (result.timelinesDropped > 0 ? ' (the server did not accept them)' : '') +
        ' — the usage itself was uploaded.',
    );
  }
  if (engine === OfferEngine.BACKFILL && !result.followupsAllowed) console.log('  Rate-limit events are not collected in audit mode.');
  console.log('  Plan and billing details reflect your current setup, not the plan you were on at the time.');
  return 0;
}

// /beezi:sync's answer when a workspace has nothing to offer, and how many sessions are still open.
function printNothingNew(active) {
  console.log('✓ Beezi: nothing new to upload.');
  if (active > 0) {
    console.log(`  ${plural(active, 'session')} ${active === 1 ? 'is' : 'are'} still open. Run /beezi:sync again after ${active === 1 ? 'it finishes' : 'they finish'}.`);
  }
}

// One workspace's dry run under its engine, with ctx = { via, script, override, planRuns, runCache }. Writes and prints
// the offer, settles a workspace with nothing left to offer, or prints why it could not count; { offered: 0|1, status }.
export async function summarizeWorkspace(row, tenantId, ctx, deps = {}) {
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  const tenantKey = offerTenantKey(row, tenantId);
  const workspace = workspaceName(row, tenantId);
  const who = await workspaceWhoami(row, tenantId, deps);
  const engine = engineOf(who);
  const options = engineRunOptions(row, tenantId, ctx.via, engine, { planWorkspaceRuns: ctx.planRuns });
  if (ctx.override) delete options.sessionRoutes;
  const runDeps = { runCache: ctx.runCache, onProgress: printProgress, whoamiImpl: async () => who };
  const result = await runAudit(runDeps, { ...options, dryRun: true });
  if (result.reason != null || result.halt != null) {
    return { offered: 0, status: exitStatus(printStop(result, { via: ctx.via, workspace, dryRun: true })) };
  }
  if (engine === OfferEngine.SYNC && coverageUnknown(result)) {
    console.log(OFFER_COVERAGE_NOTE);
    return { offered: 0, status: 0 };
  }
  const changedAt = pastSessionsFor(row, tenantId).changedAt;
  // /beezi:sync is the way back to a declined session, so only it lists them.
  const declined = ctx.via === OfferVia.SYNC ? new Set() : readDeclinedIds(row.key, tenantKey, changedAt);
  const planned = result.plannedSessions.filter((s) => !declined.has(s.sessionId));
  // An offer file still on disk may be a question waiting for its answer, so a run that offers nothing leaves it.
  if (planned.length === 0) {
    if (ctx.via === OfferVia.SYNC) printNothingNew(result.active);
    if (result.active === 0) await recordOfferSettled(row.key, tenantKey, { changedAt, handled: offerStateOf(row, tenantId).reopen });
    return { offered: 0, status: 0 };
  }
  const offer = offerFromRun({ ...result, plannedSessions: planned }, {
    via: ctx.via, engine, tenantId, historyCutoffMs: options.historyCutoffMs, override: ctx.override === true, changedAt,
    nowIso: new Date().toISOString(), active: result.active,
  });
  await askOffer(row, tenantId, offer, `${scriptCommand(ctx.script)} --account ${row.key} --accept ${tenantKey}`);
  return { offered: 1, status: 0 };
}

// Uploads the stored offer the printed `token` names through `runOne(options)` → result, and prints it; the exit status.
// A clean run that answered the file now on disk settles the workspace, or scans it again when the offer left active sessions.
export async function acceptOffer(row, tenantKey, token, runOne) {
  const tenantId = tenantIdOfKey(tenantKey);
  const offer = readOffer(row.key, tenantKey);
  if (offer == null) {
    console.log(nothingLine(row, tenantId));
    return 0;
  }
  if (!matchesShown(offer, token)) {
    console.log(CHANGED_LINE);
    return 0;
  }
  const engine = offer.engine === OfferEngine.BACKFILL ? OfferEngine.BACKFILL : OfferEngine.SYNC;
  forgetDeclined(row.key, tenantKey, offer.sessionIds);
  const result = await runOne(replayOptions(row, tenantId, consentedReplay(row, tenantId, offer)));
  const status = printUploadResult(result, engine, { via: OfferVia.SYNC, workspace: workspaceName(row, tenantId) });
  if (classifyRun(result, false, engine) === RunOutcome.CLEAN && answeredBy(readOffer(row.key, tenantKey), offer.sessionIds)) {
    if (offer.active === 0) await recordOfferSettled(row.key, tenantKey, { changedAt: offer.changedAt == null ? null : offer.changedAt });
    else await recordOfferRescan(row.key, tenantKey);
    removeOffer(row.key, tenantKey);
  }
  return status;
}
