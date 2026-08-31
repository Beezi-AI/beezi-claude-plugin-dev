import { readHookInput } from '../lib/hook-input.mjs';
import { runHook } from '../lib/hook-runner.mjs';
import { DIAGNOSTIC_SOURCES } from '../lib/telemetry-codes.mjs';

// UserPromptSubmit hook: when the user submits /beezi:track, run the tracking flow HERE and
// surface the result as a hook systemMessage — rendered by the terminal with no model round
// trip, so /beezi:track shows its result even when the API is down (no credits, outage),
// which is exactly when it gets reached for. Every other prompt exits on this fast path.
const input = readHookInput();
const prompt = input != null && typeof input.prompt === 'string' ? input.prompt.trim() : '';
if (!/^\/beezi:track\b/.test(prompt)) process.exit(0);

runHook(DIAGNOSTIC_SOURCES.TRACK_PROMPT, async () => {
  // Heavy imports only on the slow path so the every-prompt cost stays at node startup.
  const { trackSession } = await import('../lib/track-session.mjs');
  const { friendlyMessage } = await import('../lib/friendly-error.mjs');

  const { ok, message } = await trackSession({
    sessionId: input.session_id,
    transcriptPath: input.transcript_path,
    cwd: input.cwd,
  }).catch((error) => ({ ok: false, message: friendlyMessage(error) }));

  return `${ok ? '✓' : '✗'} ${message}`;
}, {
  onResult: (msg) => { console.log(JSON.stringify({ systemMessage: msg })); },
});
