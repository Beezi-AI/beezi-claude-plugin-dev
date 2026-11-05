import { planWorkspaceRuns, createRunCache } from '../lib/session-audit.mjs';
import { parseAccountFlag, getAccount, describeAccount } from '../lib/accounts.mjs';
import { isMultiTenant } from '../lib/workspace.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { readTrackingState } from '../lib/tracking.mjs';
import { startHistoryWorker, offerTenantIds, offerTrackingOff } from '../lib/history-trigger.mjs';
import { OfferGate, offerGate, OfferVia } from '../lib/history-offer.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';
import {
  countWorkspace, presentOffers, acceptOffer, acceptPrefix, foregroundRun, printCounts, flagValue, routeSummary, workspaceName,
} from '../lib/history-summary.mjs';

// The login flow's history step (/beezi:login and the setup wizard). Without --accept it counts each workspace's past
// sessions with a dry run and prints them: an ask-first workspace's question uploads nothing until a yes, and a workspace
// whose owner chose upload without asking prints a notice and uploads now. `--accept <tenant> --offer <token>` uploads
// exactly the sessions that workspace's printed offer counted.

const OPEN_GATES = [OfferGate.SCAN, OfferGate.READY];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// One dry run per workspace whose offer gate is open, then their offers and `offers=<n> notices=<m>`; the exit status is
// 1 when any workspace failed.
export async function backfillSummary(row, deps = {}) {
  const tracking = readTrackingState(row.key);
  let tenantIds = offerTenantIds(row)
    .filter((tenantId) => OPEN_GATES.indexOf(offerGate(row, tenantId, { trackingOff: offerTrackingOff(row, tracking, tenantId) })) !== -1);
  let planRuns;
  const multi = isMultiTenant(row);
  if (multi && tenantIds.length > 0) {
    const plan = (deps.planWorkspaceRuns == null ? planWorkspaceRuns : deps.planWorkspaceRuns)(row);
    if (plan.scanned === 0) {
      console.log('✓ Beezi: no past Claude Code sessions found to upload.');
      tenantIds = [];
    } else {
      const summary = routeSummary(row, plan);
      if (summary != null) console.log(summary);
      tenantIds = plan.tenantIds.filter((id) => tenantIds.indexOf(id) !== -1);
      planRuns = () => plan;
    }
  }
  // One git cache for every workspace's run, so each session's git correlation runs once.
  const ctx = { via: OfferVia.LOGIN, override: false, planRuns, runCache: createRunCache() };
  const counted = [];
  let status = 0;
  for (const tenantId of tenantIds) {
    if (multi) console.log(`\n— ${describeAccount(row)} · ${workspaceName(row, tenantId)} —`);
    // One workspace's exception must not stop the rest.
    try {
      const done = await countWorkspace(row, tenantId, ctx, deps);
      if (done.offer != null) counted.push({ tenantId, ...done });
      if (done.status !== 0) status = 1;
    } catch (error) {
      console.error(`✗ ${friendlyMessage(error)}`);
      status = 1;
    }
  }
  let shown = { offers: 0, notices: 0 };
  try {
    shown = await presentOffers(row, counted, { uploadPrefix: acceptPrefix('backfill.mjs', row), background: false, runOne: foregroundRun(deps) });
    if (shown.status !== 0) status = 1;
  } catch (error) {
    console.error(`✗ ${friendlyMessage(error)}`);
    status = 1;
  }
  printCounts(shown);
  return status;
}

// Uploads the sessions the workspace's offer counted, when `token` names that offer; its exit status.
export function backfillAccept(row, tenantKey, token, deps = {}) {
  return acceptOffer(row, tenantKey, token, foregroundRun(deps));
}

async function main() {
  const { account, rest } = await parseAccountFlag(process.argv.slice(2));
  if (account == null) fail('Beezi: backfill needs --account <key|email|n>. /beezi:login passes it automatically.');
  const row = (await getAccount(account)) || { key: account };
  const tenantKey = flagValue(rest, '--accept');
  if (tenantKey == null) {
    if (await backfillSummary(row) !== 0) process.exit(1);
    return;
  }
  const status = await backfillAccept(row, tenantKey, flagValue(rest, '--offer'));
  await startHistoryWorker(account);
  if (status !== 0) process.exit(1);
}

if (isEntryScript(import.meta.url)) main().catch((error) => fail(friendlyMessage(error)));
