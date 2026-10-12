import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { NETWORK_ERRORS, STILL_READS } from '../lib/setup-account.mjs';
import { CRASH_QUESTION, FINALIZED, crashChoice } from '../lib/setup-finish.mjs';
import { NO_INFO } from '../lib/setup-plan.mjs';

// Every fragment the setup wizard parses or relies on, by the file that prints or accepts it.
const CONTRACT = {
  'scripts/accounts.mjs': [
    "if (cmd === 'list' || cmd == null)",
    "if (cmd === 'use')",
    '${i + 1}. ${describeAccount(a)}',
    " [${flags.join(', ')}]",
    ' key=${a.key}',
    "a.key === def ? 'default' : null",
    "a.status === AccountStatus.REVOKED ? 'revoked' : null",
  ],
  'scripts/login.mjs': ['runLogin().then(() => { maybeSpawnCoworkLive(); })'],
  'scripts/session-start.mjs': ['maybeSpawnCoworkLive();'],
  'lib/cowork-live.mjs': ["env.BEEZI_SETUP === '1'"],
  'lib/diagnostics-trigger.mjs': ["env.BEEZI_SETUP === '1'"],
  'lib/setup-runner.mjs': ["out.BEEZI_SETUP = '1';"],
  'lib/login.mjs': ['log(`account=${existing.key}`);', 'log(`account=${key}`);', STILL_READS],
  'lib/friendly-error.mjs': NETWORK_ERRORS,
  'scripts/billing-capture.mjs': [
    NO_INFO,
    "hasCustomGateway() ? ' gateway=custom' : ''",
    'keeping ${kept}.',
    "'the self-reported plan'",
    "source=${config.source} plan=${config.plan == null ? 'n/a' : config.plan}",
  ],
  'lib/billing.mjs': ["THIRD_PARTY: 'third_party'", "ANTHROPIC_API_KEY: 'anthropic_api_key'", "return 'unknown';"],
  'lib/billing-capture.mjs': [
    "const SELF_REPORTED_PLANS = Object.freeze(['pro', 'max_5x', 'max_20x', 'team', 'enterprise']);",
    "const SELF_REPORTED_API_KEY = 'api_key';",
    "const SELF_REPORTED_GATEWAY = 'gateway';",
    "flag === '--from-claude'",
    "flag === '--via'",
  ],
  'scripts/key-resolve.mjs': [
    "status: 'no_key',",
    "status: 'not_linked',",
    "status: 'auth_unavailable',",
    "status: 'unavailable',",
    'emit({ ok: true, ...rest });',
    "if (arg === 'status')",
    "else if (arg === '--plan')",
    "else if (arg === '--target')",
  ],
  'lib/key-resolution.mjs': [
    "const KNOWN_STATUSES = ['resolved', 'unlinked', 'unknown_key'];",
    'subscriptionPlan: str(body.subscriptionPlan),',
    'selectablePlans: plans(body.selectablePlans),',
    'subscriptions: subscriptions(body.subscriptions),',
    'out.push({ plan, label:',
    'out.push({ target, label:',
  ],
  'scripts/backfill.mjs': [FINALIZED],
  'scripts/settings.mjs': [
    "if (cmd === 'keys')",
    "crash=${crashMode()} statusline=${statuslineInstalled() ? 'on' : 'off'}",
    "if (!isTelemetryGranted()) return 'off';",
    "if (isCorrelationGranted()) return 'correlate';",
    "? 'anonymous' : 'on';",
  ],
  'scripts/telemetry.mjs': [
    "if (mode === 'on')",
    "if (mode === 'off')",
    "if (mode === 'correlate')",
    "if (mode === 'anonymous')",
    'setTelemetry(process.argv[2])',
  ],
  'scripts/statusline-install.mjs': [': installStatusline();'],
  'scripts/workspace.mjs': [
    'W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} role=${roleLabel(t)}',
    "W. ${t.name ? t.name : t.id} account=${row.key} tenant=${t.id} new=${newIds.indexOf(t.id) === -1 ? 'no' : 'yes'} role=${roleLabel(t)}",
    'P${total}. ${labeled(g)}, ${sessionsCount(g.sessions)} account=${row.key} kind=${g.kind} match=${g.match}',
    'J${total}. ${labeled(place)}, ${sessionsCount(place.sessions)}, now: ${where} account=${row.key} kind=${place.kind} match=${place.match} now=${',
    '`${shortLabel(key)} (${key.label})`',
    "return `${n} session${n === 1 ? '' : 's'}`;",
    ': you joined ${joinTenantNames(row, newIds)} — ${count} to review account=${row.key} new=${',
    "const count = places.length === 1 ? '1 repo or folder' : `${places.length} repos or folders`;",
    "'1 other past session has no recorded folder and is not sent.'",
    'other past sessions have no recorded folder and are not sent.`',
    'routes=${total}',
    'joined=${total}',
    "new-folders=${newFoldersNow.mode} set=${newFoldersNow.set ? 'yes' : 'no'} multi=yes account=${row.key}",
    'new-folders=n/a multi=no account=${row.key}',
    "const TARGET_FLAGS = ['--current', '--repo', '--folder', '--outside'];",
    "if (sub === 'add-all') { await ruleAddAll(rest); return; }",
    "if (sub === 'add-all') { await joinedAddAll(after); return; }",
    "if (sub === 'done') { await joinedDone(after); return; }",
    "(mode !== 'ask' && mode !== 'send' && mode !== 'none')",
  ],
};

const source = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

for (const file of Object.keys(CONTRACT)) {
  test(`${file} still has what the setup wizard reads`, () => {
    const text = source(file);
    CONTRACT[file].forEach((fragment) => {
      assert.ok(text.includes(fragment), `${file} no longer contains: ${fragment}`);
    });
  });
}

test('the crash question and options are still the ones commands/settings.md offers, word for word', () => {
  const text = source('commands/settings.md').replace(/\s+/g, ' ');
  assert.ok(text.includes(`"${CRASH_QUESTION}"`), CRASH_QUESTION);
  crashChoice(null).options.forEach((option, i) => {
    const words = i === 0 ? `"${option.label}" (description "${option.description}")` : `"${option.label}" ("${option.description}")`;
    assert.ok(text.includes(words), `commands/settings.md no longer offers: ${words}`);
  });
});
