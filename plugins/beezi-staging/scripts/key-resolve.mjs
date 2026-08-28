import { getAccessToken } from '../lib/token.mjs';
import {
  fetchKeyResolution,
  submitKeyPlan,
  submitKeyLink,
  formatLinkOutcome,
} from '../lib/key-resolution.mjs';
import { hasOauthTokenIdentity } from '../lib/oauth-identity.mjs';
import { UserError, friendlyMessage } from '../lib/friendly-error.mjs';

// Thin entrypoint for the interactive key-resolution flow in /beezi:refresh.
//
// `status` prints exactly ONE JSON object on stdout — on every path, including the failures. The
// model parses it and turns selectablePlans / subscriptions into AskUserQuestion options, so a
// human sentence printed to stdout instead would break the parse; the sentence rides inside the
// object's `message` instead. The two write subcommands are for a human to read and print one
// line each.
//
// Nothing here ever prints the setup token. Only its fingerprint (prefix / last4 / length) exists
// on this side of lib/key-resolution.mjs at all.

// Two modes in one invocation is a malformed call, not a preference. The model generates these,
// and last-wins would quietly perform one of the two writes it was asked for.
function setMode(out, mode) {
  if (out.mode != null && out.mode !== mode) {
    throw new UserError('Pick one: status, --plan <plan>, or --target <email-or-account-id> — not several at once.');
  }
  out.mode = mode;
}

export function parseArgs(argv) {
  const out = { mode: null, plan: null, target: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'status') setMode(out, 'status');
    else if (arg === '--plan') { setMode(out, 'plan'); out.plan = argv[++i]; }
    else if (arg === '--target') { setMode(out, 'link'); out.target = argv[++i]; }
    else throw new UserError(`Unknown argument "${arg}". Usage: key-resolve.mjs status | --plan <plan> | --target <email-or-account-id>`);
  }
  if (out.mode == null) {
    throw new UserError('Nothing to do. Usage: key-resolve.mjs status | --plan <plan> | --target <email-or-account-id>');
  }
  if (out.mode === 'plan' && (out.plan == null || out.plan === '')) throw new UserError('--plan needs a plan value.');
  if (out.mode === 'link' && (out.target == null || out.target === '')) {
    throw new UserError('--target needs an email address or an account id.');
  }
  return out;
}

function emit(object) {
  console.log(JSON.stringify(object));
}

async function runStatus(token) {
  if (!token) {
    emit({
      ok: false,
      status: 'not_linked',
      message: 'Beezi: this machine is not linked. Run /beezi:login to link it.',
    });
    return;
  }
  // Answered before any request, and with the SAME predicate the fingerprint uses, so the two
  // cannot drift: "there is no key here" and "the portal did not answer" are opposite actions.
  if (!hasOauthTokenIdentity(process.env)) {
    emit({
      ok: false,
      status: 'no_key',
      message: 'Beezi: no Claude setup token (CLAUDE_CODE_OAUTH_TOKEN) is set on this machine — there is no key to resolve.',
    });
    return;
  }
  const payload = await fetchKeyResolution(token, {});
  if (payload == null) {
    // "Could not ask", never "not resolved": a machine that cannot reach the portal must not be
    // told its key is unresolved, because that is not what it observed.
    emit({
      ok: false,
      status: 'unavailable',
      message: 'Beezi: could not reach the server to read this key’s subscription. Check your connection and try again.',
    });
    return;
  }
  // `key` is dropped from the emitted object: the fingerprint has no consumer in the question the
  // model is about to ask, and there is no reason to put last4 into model context on every call.
  // It stays on the lib's return value for callers that do want it.
  const { key, ...rest } = payload;
  emit({ ok: true, ...rest });
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  const token = await getAccessToken().catch(() => null);

  if (parsed.mode === 'status') {
    await runStatus(token);
    return;
  }

  if (parsed.mode === 'plan') {
    const result = await submitKeyPlan(token, parsed.plan, {});
    // The server's own wording where it gave one — the user is about to act on it.
    if (!result.ok) throw new UserError(result.message);
    console.log(`✓ Beezi: this key’s subscription is now recorded as ${result.subscriptionPlan}.`);
    return;
  }

  const result = await submitKeyLink(token, parsed.target, {});
  if (!result.ok) throw new UserError(result.message);
  console.log(formatLinkOutcome(result));
}

main().catch((error) => {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
});
