import { readHookInput } from '../lib/hook-input.mjs';
import { runCheckpoint } from '../lib/checkpoint.mjs';
import { runHook } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

const input = readHookInput();
if (!input) process.exit(0);
runHook(DIAGNOSTIC_SOURCES.REPORT, () => runCheckpoint(input, {}, { emitTimeline: true }));
