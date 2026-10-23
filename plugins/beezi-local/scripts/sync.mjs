import { parseArgs, runAudit as _runAudit, planWorkspaceRuns, createRunCache } from '../lib/session-audit.mjs';
import { parseAccountFlag, listAccounts, getAccount, describeAccount, AccountStatus } from '../lib/accounts.mjs';
import { parseTenantFlags, isMultiTenant } from '../lib/workspace.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';
import { maybeSpawnCoworkLive } from '../lib/cowork-live.mjs';
import { startHistoryWorker, offerTenantIds } from '../lib/history-trigger.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';
import { joined as printJoined, routes as printRoutes } from './workspace.mjs';
import { OfferVia } from '../lib/history-offer.mjs';
import {
  summarizeWorkspace, acceptOffer, flagValue, printProgress, routeSummary, workspaceName,
} from '../lib/history-summary.mjs';

// /beezi:sync — offers every past session this machine still has on disk that Beezi does not hold yet. Without --accept
// it counts each workspace's sessions with a dry run and prints one <offer> block per
// workspace that has some, whatever the workspace's past-sessions choice; nothing is sent. `--accept <tenant> --offer <token>`
// uploads exactly the sessions that workspace's printed offer counted, resuming each from what the server already holds. No --force
// (nothing to force past) and no --since: it filters on transcript mtime, which says when a session last ran, not what
// is missing from Beezi. Coverage already scopes the work to what is genuinely absent.

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const REVIEW_FLAGS = ['--review', '--review-routes'];

// One listing as a block; a failed one prints its ✗ line there and asks nothing, so the summary still runs.
async function listing(tag, print) {
  console.log(`<${tag}>`);
  let total = 0;
  try {
    total = await print();
  } catch (error) {
    console.log(`✗ ${friendlyMessage(error)}`);
  }
  console.log(`</${tag}>`);
  return total;
}

// /beezi:sync Step 1 in the same call: --review lists new workspaces, then repos and folders with no rule
// (--review-routes starts at the second), each as a <joined>/<routes> block; true when neither asks anything.
async function review(flag, account) {
  const argv = account == null ? [] : ['--account', account];
  const flags = { deferScan: true };
  if (flag === '--review' && await listing('joined', () => printJoined(argv, flags)) > 0) return false;
  return await listing('routes', () => printRoutes(argv, flags)) === 0;
}

// One <offer> block per account × workspace with sessions to offer, under any past-sessions choice, then `offers=<n>`.
// --tenant is an override: those workspaces are offered every past session, unrouted.
export async function syncSummary(rows, tenantArgs, deps = {}) {
  let offers = 0;
  const summarize = async (row, tenantId, ctx) => {
    try {
      offers += (await summarizeWorkspace(row, tenantId, { via: OfferVia.SYNC, script: 'sync.mjs', ...ctx }, deps)).offered;
    } catch (error) {
      console.error(`✗ ${friendlyMessage(error)}`);
    }
  };
  for (const row of rows) {
    // One git cache for every workspace's run of this account.
    const runCache = createRunCache();
    if (!isMultiTenant(row)) {
      if (rows.length > 1) console.log(`\n— ${describeAccount(row)} —`);
      await summarize(row, offerTenantIds(row)[0], { override: false, runCache });
      continue;
    }
    const override = parseTenantFlags(tenantArgs, row).tenantIds;
    if (override.length > 0) {
      for (const tenantId of override) {
        console.log(`\n— ${describeAccount(row)} · ${workspaceName(row, tenantId)} —`);
        await summarize(row, tenantId, { override: true, runCache });
      }
      continue;
    }
    const plan = planWorkspaceRuns(row);
    if (plan.scanned === 0) {
      console.log(`\n✓ Beezi (${describeAccount(row)}): no Claude Code sessions found on this machine.`);
      continue;
    }
    const summary = routeSummary(row, plan);
    if (summary != null) console.log(`\n${summary}`);
    for (const tenantId of plan.tenantIds) {
      console.log(`\n— ${describeAccount(row)} · ${workspaceName(row, tenantId)} —`);
      await summarize(row, tenantId, { override: false, planRuns: () => plan, runCache });
    }
  }
  console.log(`offers=${offers}`);
}

// Uploads the sessions the workspace's offer counted.
export async function syncAccept(row, tenantKey, token, deps = {}) {
  const runAudit = deps.runAudit == null ? _runAudit : deps.runAudit;
  await acceptOffer(row, tenantKey, token, (options) => runAudit({ onProgress: printProgress }, options));
}

// False when --review stopped for a question before the summary.
async function main() {
  const args = process.argv.slice(2);
  const reviewFlags = args.filter((arg) => REVIEW_FLAGS.indexOf(arg) !== -1);
  if (reviewFlags.length > 1) fail('Beezi: pass --review or --review-routes, not both.');
  const reviewFlag = reviewFlags[0];
  const { account, rest } = await parseAccountFlag(args.filter((arg) => REVIEW_FLAGS.indexOf(arg) === -1));
  const tenantKey = flagValue(rest, '--accept');
  if (tenantKey != null) {
    if (account == null) fail('Beezi: --accept needs --account <key>.');
    await syncAccept((await getAccount(account)) || { key: account }, tenantKey, flagValue(rest, '--offer'));
    await startHistoryWorker(account);
    return true;
  }
  if (reviewFlag != null && !(await review(reviewFlag, account))) return false;
  const rows = account != null
    ? [(await getAccount(account)) || { key: account }]
    : (await listAccounts()).filter((a) => a.status === AccountStatus.LINKED);
  if (rows.length === 0) fail('Beezi: this machine is not linked. Run /beezi:login first.');
  if (rows.length > 1 && rest.indexOf('--tenant') !== -1) {
    fail('Beezi: --tenant needs --account <key> when several accounts are linked.');
  }
  const options = parseArgs(rest.filter((arg, i) => arg !== '--tenant' && rest[i - 1] !== '--tenant'));
  if (options.sinceMs != null) {
    fail('Beezi: /beezi:sync does not take --since — it uploads exactly what Beezi is missing. Run it with no flags.');
  }
  if (options.force) {
    fail('Beezi: /beezi:sync does not take --force — there is no one-time seal to force past.');
  }
  await syncSummary(rows, rest);
  return true;
}

if (isEntryScript(import.meta.url)) {
  main().then((ran) => {
    if (ran) maybeSpawnCoworkLive();
  }).catch((error) => fail(friendlyMessage(error)));
}
