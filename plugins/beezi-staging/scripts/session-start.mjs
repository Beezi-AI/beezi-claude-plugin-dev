import { readHookInput } from '../lib/hook-input.mjs';
import { runSessionStart } from '../lib/session-start.mjs';
import { runHook } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

const input = readHookInput();
if (!input) process.exit(0);
runHook(DIAGNOSTIC_SOURCES.SESSION_START, () => runSessionStart(input), {
  onResult: (msg) => { if (msg) process.stdout.write(JSON.stringify({ systemMessage: msg })); },
});
