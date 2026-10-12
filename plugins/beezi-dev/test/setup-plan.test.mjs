import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEFT_UNRESOLVED, NO_INFO, PLAN_SKIPPED, UNKNOWN_KEY, UNREADABLE, capturePlan, parseKeyStatus, paymentQuestion, resolvedLine,
} from '../lib/setup-plan.mjs';
import { commands, fail, fakeCtx, labels, ok } from './setup-fake-ctx.mjs';

const CAPTURE = 'billing-capture.mjs --from-claude --via login --account k1';
const STATUS = 'key-resolve.mjs status --account k1';
const KNOWN = '✓ Beezi billing captured: source=subscription plan=max_20x via=claude-auth-status.';
const UNKNOWN_PLAN = '✓ Beezi billing captured: source=subscription plan=unknown via=claude-auth-status.';
const NO_INFO_LINE = `Beezi: ${NO_INFO} on this machine — nothing captured.`;
const GATEWAY_LINE = '✓ Beezi billing captured: source=unknown plan=n/a gateway=custom.';
const json = (object) => ok(`${JSON.stringify(object)}\n`);
const NO_KEY = json({ ok: false, status: 'no_key', message: 'Beezi: this machine does not sign in with a Claude setup token — its plan is read from the Claude login instead.' });
const planRun = (value) => `billing-capture.mjs --plan ${value} --via login-user --account k1`;
const planDone = (value) => ok(`✓ Beezi billing captured: source=subscription plan=${value}.\n`);
const UNLINKED = {
  ok: true,
  status: 'unlinked',
  selectablePlans: [{ plan: 'max_5x', label: 'Max 5x', monthlyUsd: 100 }, { plan: 'team', label: 'Team', monthlyUsd: 30 }],
  subscriptions: [{ target: 'acct_1', label: 'Acme (Max 20x)', plan: 'max_20x' }, { target: 'acct_2', label: 'Beta (Team)', plan: 'team' }],
};

function plan(captureLine, statusResult, answers, extra) {
  return fakeCtx(Object.assign({ [CAPTURE]: ok(`${captureLine}\n`), [STATUS]: statusResult }, extra || {}), answers);
}

test('paymentQuestion: settled sources and known plans ask nothing, the gateway goes first, unknown plans ask the tier', () => {
  assert.equal(paymentQuestion(KNOWN), 'none');
  assert.equal(paymentQuestion('✓ Beezi billing captured: source=subscription plan=max_20x gateway=custom.'), 'gateway');
  assert.equal(paymentQuestion(GATEWAY_LINE), 'gateway');
  assert.equal(paymentQuestion(`${NO_INFO_LINE} gateway=custom`), 'gateway');
  assert.equal(paymentQuestion(NO_INFO_LINE), 'tier');
  assert.equal(paymentQuestion(UNKNOWN_PLAN), 'tier');
  assert.equal(paymentQuestion('Beezi: Claude account info still does not name a plan — keeping the self-reported plan.'), 'tier');
  assert.equal(paymentQuestion('Beezi: Claude account info still does not name a plan — keeping the plan Beezi resolved for this machine’s setup token.'), 'none');
  assert.equal(paymentQuestion('✓ Beezi billing captured: source=third_party plan=n/a gateway=custom.'), 'none');
  assert.equal(paymentQuestion('✓ Beezi billing captured: source=anthropic_api_key plan=n/a.'), 'none');
  assert.equal(paymentQuestion(''), 'none');
});

test('parseKeyStatus reads the last JSON line and rejects anything else', () => {
  assert.deepEqual(parseKeyStatus('noise\n{"ok":true,"status":"resolved"}\n'), { ok: true, status: 'resolved' });
  assert.equal(parseKeyStatus('{broken\n'), null);
  assert.equal(parseKeyStatus('✗ nothing\n'), null);
});

test('resolvedLine names the plan only when the JSON has one', () => {
  assert.equal(resolvedLine('max_20x'), "✓ Beezi knows the subscription for this machine's Claude setup token: max_20x. It is now what Beezi reports for this machine.");
  assert.equal(resolvedLine(null), "✓ Beezi knows the subscription for this machine's Claude setup token. It is now what Beezi reports for this machine.");
});

test('a known plan with no setup token asks nothing', async () => {
  const ctx = plan(KNOWN, NO_KEY, []);
  await capturePlan(ctx, 'k1');
  assert.deepEqual(commands(ctx), [CAPTURE, STATUS]);
  assert.deepEqual(ctx.printed, [KNOWN]);
  assert.equal(ctx.asked.length, 0);
});

test('the tier question maps every answer through the value table', async () => {
  const cases = [
    [[0], 'pro'], [[1, 0], 'max_5x'], [[1, 1], 'max_20x'], [[2, 0], 'team'], [[2, 1], 'enterprise'], [[3], 'api_key'],
  ];
  for (const [answers, value] of cases) {
    const ctx = plan(NO_INFO_LINE, NO_KEY, answers, { [planRun(value)]: planDone(value) });
    await capturePlan(ctx, 'k1');
    assert.deepEqual(commands(ctx), [CAPTURE, STATUS, planRun(value)]);
    assert.deepEqual(ctx.printed, [NO_INFO_LINE, `✓ Beezi billing captured: source=subscription plan=${value}.`]);
  }
});

test('the tier question offers four options and the Max and Team follow-ups', async () => {
  const max = plan(UNKNOWN_PLAN, NO_KEY, [1, 1]);
  await capturePlan(max, 'k1');
  assert.equal(max.asked[0].question, 'How does this machine pay for Claude?');
  assert.deepEqual(labels(max.asked[0]), ['Pro', 'Max', 'Team or Enterprise', 'API key (no subscription)']);
  assert.equal(max.asked[1].question, 'Which Max plan?');
  assert.deepEqual(labels(max.asked[1]), ['Max 5x', 'Max 20x']);
  const team = plan(UNKNOWN_PLAN, NO_KEY, [2, 0]);
  await capturePlan(team, 'k1');
  assert.equal(team.asked[1].question, 'Team or Enterprise?');
  assert.deepEqual(labels(team.asked[1]), ['Team', 'Enterprise']);
});

test('a custom gateway asks what pays first, then the tier without the API-key option', async () => {
  const sub = plan(GATEWAY_LINE, NO_KEY, [0, 2, 1]);
  await capturePlan(sub, 'k1');
  assert.equal(sub.asked[0].question, 'This machine sends Claude Code through a custom API endpoint. What pays for that usage?');
  assert.deepEqual(labels(sub.asked[0]), [
    'My Claude subscription (the endpoint just forwards it)', "The gateway or provider's own billing", 'An Anthropic API key',
  ]);
  assert.equal(sub.asked[1].question, 'How does this machine pay for Claude?');
  assert.deepEqual(labels(sub.asked[1]), ['Pro', 'Max', 'Team or Enterprise']);
  assert.equal(commands(sub)[2], planRun('enterprise'));

  const own = plan(GATEWAY_LINE, NO_KEY, [1]);
  await capturePlan(own, 'k1');
  assert.equal(own.asked.length, 1);
  assert.deepEqual(commands(own), [CAPTURE, STATUS, planRun('gateway')]);

  const key = plan(GATEWAY_LINE, NO_KEY, [2]);
  await capturePlan(key, 'k1');
  assert.deepEqual(commands(key), [CAPTURE, STATUS, planRun('api_key')]);
});

test('a dismissed plan question saves nothing and says the link succeeded', async () => {
  const ctx = plan(NO_INFO_LINE, NO_KEY, [1]);
  await capturePlan(ctx, 'k1');
  assert.deepEqual(commands(ctx), [CAPTURE, STATUS]);
  assert.deepEqual(ctx.printed, [NO_INFO_LINE, PLAN_SKIPPED]);
});

test('a third-party source settles the plan even behind a custom gateway', async () => {
  const ctx = plan('✓ Beezi billing captured: source=third_party plan=n/a gateway=custom.', NO_KEY, []);
  await capturePlan(ctx, 'k1');
  assert.equal(ctx.asked.length, 0);
  assert.deepEqual(commands(ctx), [CAPTURE, STATUS]);
});

test('not_linked prints its message, then asks the tier as normal', async () => {
  const message = 'Beezi: this machine is not linked. Run /beezi:login to link it.';
  const ctx = plan(UNKNOWN_PLAN, json({ ok: false, status: 'not_linked', message }), [0], { [planRun('pro')]: planDone('pro') });
  await capturePlan(ctx, 'k1');
  assert.deepEqual(ctx.printed, [UNKNOWN_PLAN, message, '✓ Beezi billing captured: source=subscription plan=pro.']);
  assert.deepEqual(commands(ctx), [CAPTURE, STATUS, planRun('pro')]);
});

test('setup-token statuses print their line and never ask the tier', async () => {
  const unavailable = 'Beezi: could not reach the server to read this key’s subscription. Check your connection and try again.';
  const authUnavailable = 'Beezi: this machine is linked, but its saved login could not be read just now. Nothing was removed — try /beezi:settings refresh again in a moment.';
  const cases = [
    [{ ok: true, status: 'resolved', subscriptionPlan: 'team', planSource: 'reported', selectablePlans: [], subscriptions: [] }, resolvedLine('team')],
    [{ ok: true, status: 'resolved', subscriptionPlan: null, selectablePlans: [], subscriptions: [] }, resolvedLine(null)],
    [{ ok: true, status: 'unknown_key', selectablePlans: [], subscriptions: [] }, UNKNOWN_KEY],
    [{ ok: false, status: 'unavailable', message: unavailable }, unavailable],
    [{ ok: false, status: 'auth_unavailable', authState: 'busy', message: authUnavailable }, authUnavailable],
    [{ ok: true, status: null, selectablePlans: [], subscriptions: [] }, UNREADABLE],
  ];
  for (const [object, line] of cases) {
    const ctx = plan(UNKNOWN_PLAN, json(object), []);
    await capturePlan(ctx, 'k1');
    assert.deepEqual(ctx.printed, [UNKNOWN_PLAN, line]);
    assert.equal(ctx.asked.length, 0);
    assert.deepEqual(commands(ctx), [CAPTURE, STATUS]);
  }
});

test('unlinked: use one of my subscriptions runs --target once and prints its lines', async () => {
  const run = 'key-resolve.mjs --target acct_2 --account k1';
  const ctx = plan(KNOWN, json(UNLINKED), [0, 1], { [run]: ok('✓ Beezi: this key now bills Beta (Team).\n') });
  await capturePlan(ctx, 'k1');
  assert.equal(ctx.asked[0].question, "Beezi does not know which subscription this machine's Claude setup token bills. How do you want to resolve it?");
  assert.deepEqual(labels(ctx.asked[0]), ['Use one of my subscriptions', 'Name the plan', 'Enter an email or account id']);
  assert.equal(ctx.asked[1].question, 'Which subscription does this machine bill?');
  assert.deepEqual(labels(ctx.asked[1]), ['Acme (Max 20x)', 'Beta (Team)']);
  assert.deepEqual(commands(ctx), [CAPTURE, STATUS, run]);
  assert.deepEqual(ctx.printed, [KNOWN, '✓ Beezi: this key now bills Beta (Team).']);
});

test('unlinked without subscriptions: name the plan runs --plan with the plan value, not the label', async () => {
  const run = 'key-resolve.mjs --plan max_5x --account k1';
  const object = Object.assign({}, UNLINKED, { subscriptions: [] });
  const ctx = plan(KNOWN, json(object), [0, 0], { [run]: ok('✓ Beezi: this key’s subscription is now recorded as max_5x.\n') });
  await capturePlan(ctx, 'k1');
  assert.deepEqual(labels(ctx.asked[0]), ['Name the plan', 'Enter an email or account id']);
  assert.equal(ctx.asked[1].question, 'Which plan is this subscription on?');
  assert.deepEqual(labels(ctx.asked[1]), ['Max 5x', 'Team']);
  assert.deepEqual(commands(ctx), [CAPTURE, STATUS, run]);
  assert.deepEqual(ctx.printed, [KNOWN, '✓ Beezi: this key’s subscription is now recorded as max_5x.']);
});

test('unlinked: enter an email or account id takes the typed text', async () => {
  const ctx = plan(KNOWN, json(UNLINKED), [2, 'ops@acme.com']);
  await capturePlan(ctx, 'k1');
  assert.deepEqual(ctx.asked[1], { kind: 'text', question: 'Email or account id:' });
  assert.deepEqual(commands(ctx), [CAPTURE, STATUS, 'key-resolve.mjs --target ops@acme.com --account k1']);
});

test('unlinked: a dismissal or an empty follow-up list leaves the key unresolved', async () => {
  const cases = [
    [UNLINKED, [], 1],
    [UNLINKED, [2], 2],
    [UNLINKED, [0], 2],
    [Object.assign({}, UNLINKED, { subscriptions: [], selectablePlans: [] }), [0], 1],
  ];
  for (const [object, answers, asked] of cases) {
    const ctx = plan(KNOWN, json(object), answers);
    await capturePlan(ctx, 'k1');
    assert.deepEqual(commands(ctx), [CAPTURE, STATUS]);
    assert.deepEqual(ctx.printed, [KNOWN, LEFT_UNRESOLVED]);
    assert.equal(ctx.asked.length, asked);
  }
});

test('a failing resolve prints its error lines', async () => {
  const run = 'key-resolve.mjs --plan team --account k1';
  const ctx = plan(KNOWN, json(UNLINKED), [1, 1], { [run]: fail('✗ The Beezi server rejected the request (HTTP 500).\n') });
  await capturePlan(ctx, 'k1');
  assert.deepEqual(commands(ctx), [CAPTURE, STATUS, run]);
  assert.deepEqual(ctx.printed, [KNOWN, '✗ The Beezi server rejected the request (HTTP 500).']);
});

test('a failing status check is reported and skips the plan questions', async () => {
  const ctx = plan(UNKNOWN_PLAN, fail('✗ Pass one --tenant here: this reads from a single workspace.\n'), []);
  await capturePlan(ctx, 'k1');
  assert.deepEqual(ctx.printed, [UNKNOWN_PLAN, '✗ Pass one --tenant here: this reads from a single workspace.']);
  assert.equal(ctx.asked.length, 0);
});

test('a failing capture is reported and the status check still runs', async () => {
  const ctx = fakeCtx({ [CAPTURE]: fail("✗ Could not access Beezi's local data (EACCES). Check file permissions and try again.\n"), [STATUS]: NO_KEY }, []);
  await capturePlan(ctx, 'k1');
  assert.deepEqual(commands(ctx), [CAPTURE, STATUS]);
  assert.deepEqual(ctx.printed, ["✗ Could not access Beezi's local data (EACCES). Check file permissions and try again."]);
  assert.equal(ctx.asked.length, 0);
});
