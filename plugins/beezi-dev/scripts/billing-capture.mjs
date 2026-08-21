import { parseArgs, buildConfig, reconcileBillingConfig } from '../lib/billing-capture.mjs';
import { writeBillingConfig } from '../lib/billing-config.mjs';
import { readClaudeAccountAnchor } from '../lib/claude-account.mjs';
import { hasCustomGateway } from '../lib/billing.mjs';
import { friendlyMessage } from '../lib/friendly-error.mjs';

try {
  const parsed = parseArgs(process.argv.slice(2));
  // A custom endpoint is reported as a fact, not a conclusion: whether it bills this machine's
  // subscription or its own credits is the one thing only the user can say, and /beezi:login reads
  // this flag to know it has to ask.
  const gateway = hasCustomGateway() ? ' gateway=custom' : '';

  if (parsed.fromClaude) {
    // The same self-healing capture the SessionStart hook runs, forced: ask Claude Code itself
    // (`claude auth status --json`), merge the non-secret oauthAccount metadata, detect an account
    // switch, protect a still-valid self-reported plan, stamp the anchor + heartbeat. No token or
    // credentials file is ever read; the model does not supply any values.
    const { config, outcome } = reconcileBillingConfig({}, { force: true, via: parsed.via });
    if (outcome === 'no-signal' || config == null) {
      // A machine that never did a subscription login still needs /beezi:login to ask what its
      // endpoint bills, and this is the only line it will see.
      console.log(`Beezi: no Claude subscription info found on this machine — nothing captured.${gateway}`);
    } else if (outcome === 'kept') {
      console.log('Beezi: Claude account info still does not name a plan — keeping the self-reported plan.');
    } else {
      const via = config.detectedVia == null ? '' : ` via=${config.detectedVia.replace(/_/g, '-')}`;
      const switched = outcome === 'switched' ? ' account=changed' : '';
      console.log(`✓ Beezi billing captured: source=${config.source} plan=${config.plan == null ? 'n/a' : config.plan}${via}${switched}${gateway}.`);
    }
  } else {
    // Self-report (--plan) or raw-field capture: the user's answer always writes. The cheap file
    // anchor rides along so a later account switch can invalidate this testimony; the CLI is not
    // spawned here — the next session-start heartbeat upgrades the anchor to the email one.
    let anchor = null;
    try { anchor = readClaudeAccountAnchor(); } catch { anchor = null; }
    const config = buildConfig(parsed, process.env, new Date(), null, anchor);
    writeBillingConfig(config);
    console.log(`✓ Beezi billing captured: source=${config.source} plan=${config.plan == null ? 'n/a' : config.plan}${gateway}.`);
  }
} catch (error) {
  console.error(`✗ ${friendlyMessage(error)}`);
  process.exit(1);
}
