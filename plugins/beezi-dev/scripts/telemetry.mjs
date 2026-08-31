import fs from 'fs';
import path from 'path';
import { grantConsent, denyConsent, isTelemetryGranted } from '../lib/telemetry-consent.mjs';
import { telemetryDir } from '../lib/paths.mjs';

export function setTelemetry(mode) {
  if (mode === 'on') {
    grantConsent();
    return 'Beezi diagnostics are ON. Crash reports about the plugin will be sent — never your code or prompts.';
  }
  if (mode === 'off') {
    denyConsent();
    // Anything already recorded must not be sent after the user says no.
    try {
      const dir = telemetryDir();
      for (const file of fs.readdirSync(dir)) {
        try { fs.unlinkSync(path.join(dir, file)); } catch { /* best-effort */ }
      }
    } catch { /* nothing pending */ }
    return 'Beezi diagnostics are OFF. Pending reports were deleted.';
  }
  return `Beezi diagnostics are ${isTelemetryGranted() ? 'ON' : 'OFF'}. Use /beezi:telemetry on|off to change.`;
}

if (process.argv[1] && process.argv[1].endsWith('telemetry.mjs')) {
  process.stdout.write(`${setTelemetry(process.argv[2])}\n`);
}
