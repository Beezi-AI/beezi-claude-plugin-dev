import { readHookInput } from '../lib/hook-input.mjs';
import { recordPermissionMode } from '../lib/permission-mode-store.mjs';
import { runHook, importHookModule } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';
import { maybeSpawnCostStateSync } from '../lib/cost-state-trigger.mjs';
import { maybeSpawnCoworkLive } from '../lib/cowork-live.mjs';

const input = readHookInput();
if (!input) process.exit(0);
// The launch mode, before the user has typed anything. Belt and braces: UserPromptSubmit fires
// for /beezi:login itself and records the mode before any of its commands run, so the login
// preflight does not depend on this one. Claude Code documents permission_mode as absent from
// some events, and a payload without it records nothing rather than clearing what is there.
recordPermissionMode(input.session_id, input.permission_mode);
function write({ systemMessage, additionalContext }) {
  const out = {};
  if (systemMessage) out.systemMessage = systemMessage;
  if (additionalContext) out.hookSpecificOutput = { hookEventName: 'SessionStart', additionalContext };
  if (Object.keys(out).length > 0) process.stdout.write(JSON.stringify(out));
}

runHook(DIAGNOSTIC_SOURCES.SESSION_START, async () => {
  // Bound before the network work, so a killed or failed start still leaves the checkpoint its hold file.
  let prompt = null;
  try {
    prompt = await importHookModule('./workspace-prompt.mjs');
    if (prompt != null) await prompt.markPendingWorkspace(input);
  } catch { /* the ask is best-effort; the session still starts */ }
  const mod = await importHookModule('./session-start.mjs');
  let systemMessage = null;
  let failure = null;
  try {
    systemMessage = mod == null ? null : await mod.runSessionStart(input);
  } catch (error) { failure = error; }
  if (failure == null) {
    maybeSpawnCostStateSync();
    maybeSpawnCoworkLive();
  }
  let additionalContext = null;
  let targetsNotice = null;
  try {
    // Re-binds on every source with the tenants runSessionStart just refreshed; asks only on startup or clear.
    if (prompt != null) additionalContext = await prompt.buildWorkspacePrompt(input);
    if (prompt != null && input.source !== 'compact') targetsNotice = await prompt.buildTargetsNotice(input);
  } catch { /* the ask is best-effort; the session still starts */ }
  if (targetsNotice != null) systemMessage = systemMessage ? `${systemMessage}\n${targetsNotice}` : targetsNotice;
  if (failure != null) {
    write({ systemMessage: null, additionalContext });
    throw failure;
  }
  return { systemMessage, additionalContext };
}, { onResult: write });
