import { parseAccountFlag, getAccount, clearOfferReady, recordOfferDecline, requestConsentedHistory } from '../lib/accounts.mjs';
import { declineLine, readOffer, removeOffer, idsToken, plural } from '../lib/history-offer.mjs';
import {
  CHANGED_LINE, scriptCommand, flagValue, tenantIdOfKey, workspaceName, nothingLine, matchesShown, consentedReplay, askOffer,
} from '../lib/history-summary.mjs';
import { offerStateOf } from '../lib/offer-gate.mjs';
import { rememberDeclined, forgetDeclined } from '../lib/offer-declines.mjs';
import { startHistoryWorker, workspacesAt } from '../lib/history-trigger.mjs';
import { readTrackingState } from '../lib/tracking.mjs';
import { pastSessionsFor } from '../lib/anonymization.mjs';
import { isEntryScript } from '../lib/entry-script.mjs';
import { friendlyMessage, UserError } from '../lib/friendly-error.mjs';

// The history offer's commands: `offer` prints the session-start question, `accept` queues the upload, `decline` remembers a no.

const MAX_SESSION_START_OFFERS = 4;
const USAGE = 'Usage: history.mjs offer --account <key> | accept --account <key> --tenant <key> --offer <token> | decline --account <key> --tenant <key> [--audit]';

const sessionIdsOf = (file) => (file != null && Array.isArray(file.sessionIds) ? file.sessionIds : []);

// The offer file the scan's ready token was counted from, else null (missing, empty or rewritten since, M1).
function readyOffer(row, tenantId, tenantKey) {
  const stored = readOffer(row.key, tenantKey);
  const ids = sessionIdsOf(stored);
  return ids.length > 0 && idsToken(ids) === offerStateOf(row, tenantId).ready.token ? stored : null;
}

// The session-start question: a block per workspace whose scan is ready, at most four, built from the file the scan
// counted; a ready workspace without that file loses ready and scans again. Printing records the decline (K6).
async function offer(row) {
  let shown = 0;
  if (row != null) {
    for (const { tenantId, tenantKey } of await workspacesAt(row, readTrackingState(row.key), 'READY')) {
      if (shown === MAX_SESSION_START_OFFERS) break;
      const stored = readyOffer(row, tenantId, tenantKey);
      if (stored == null) {
        await clearOfferReady(row.key, tenantKey);
        continue;
      }
      await askOffer(row, tenantId, stored, `${scriptCommand('history.mjs')} accept --account ${row.key} --tenant ${tenantKey}`);
      shown += 1;
    }
  }
  console.log(`offers=${shown}`);
}

// The session-start yes: owes the workspace the shown offer's sessions and starts the worker.
async function accept(row, tenantKey, token) {
  const tenantId = tenantIdOfKey(tenantKey);
  const stored = row == null ? null : readOffer(row.key, tenantKey);
  if (stored != null && !matchesShown(stored, token)) {
    console.log(CHANGED_LINE);
    return;
  }
  if (stored != null) forgetDeclined(row.key, tenantKey, stored.sessionIds);
  if (stored == null || !(await requestConsentedHistory(row.key, tenantId, new Date().toISOString(), consentedReplay(row, tenantId, stored)))) {
    console.log(nothingLine(row == null ? {} : row, tenantId));
    return;
  }
  await startHistoryWorker(row.key);
  console.log(`✓ Beezi: uploading ${plural(stored.sessionIds.length, 'past session')} to ${workspaceName(row, tenantId)} in the background. You'll see the result when your next session starts.`);
}

// The session-start no: remembers the offer's sessions as declined, then the workspace's decline. The file goes only
// while it still holds the sessions declined; one rewritten in between is another question.
async function decline(row, tenantKey, audit) {
  if (row != null) {
    const changedAt = pastSessionsFor(row, tenantIdOfKey(tenantKey)).changedAt;
    const ids = sessionIdsOf(readOffer(row.key, tenantKey));
    if (ids.length > 0) rememberDeclined(row.key, tenantKey, ids, changedAt);
    await recordOfferDecline(row.key, tenantKey, changedAt);
    if (idsToken(sessionIdsOf(readOffer(row.key, tenantKey))) === idsToken(ids)) removeOffer(row.key, tenantKey);
  }
  console.log(declineLine(audit));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const { account, rest } = await parseAccountFlag(args);
  if (account == null) throw new UserError(USAGE);
  const row = await getAccount(account);
  if (cmd === 'offer') return offer(row);
  const tenantKey = flagValue(rest, '--tenant');
  if (tenantKey == null) throw new UserError(USAGE);
  if (cmd === 'accept') return accept(row, tenantKey, flagValue(rest, '--offer'));
  if (cmd === 'decline') return decline(row, tenantKey, rest.indexOf('--audit') !== -1);
  throw new UserError(USAGE);
}

if (isEntryScript(import.meta.url)) {
  main().catch((error) => {
    console.error(`✗ ${friendlyMessage(error)}`);
    process.exit(1);
  });
}
