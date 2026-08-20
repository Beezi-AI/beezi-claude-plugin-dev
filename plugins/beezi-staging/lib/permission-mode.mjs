import fs from 'fs';
import { findTranscriptBySessionId } from './transcript.mjs';

// The two permission modes that stop /beezi:login.
//
// 'plan' gates the shell commands the link is made of, so the sign-in script is never reached.
//
// 'auto' hands every command to Claude Code's permission classifier instead of prompting, and the
// classifier denies this plugin's node scripts. Observed on a real machine: the sign-in was allowed
// and completed, then billing-capture.mjs was refused — via both Bash and PowerShell — leaving the
// machine linked with no plan captured and the backfill unrunnable. That half-linked state is the
// exact outcome this guard exists to prevent, and no local check can predict a classifier verdict
// before running the command, so the mode itself has to be the signal.
//
// Every other mode ('default', 'acceptEdits', 'dontAsk', 'bypassPermissions') runs the flow.
// Verified against Claude Code 2.1.235, which stamps 'default' for the `manual` CLI flag.
//
// Plan is matched by substring, the same way session-timeline.mjs matches planning, so a schema
// tweak — 'plan_mode', 'planning' — still catches instead of silently passing the guard. Auto is
// matched exactly: it is a whole mode name, not a family.
export function isPlanMode(mode) {
  return typeof mode === 'string' && mode.toLowerCase().includes('plan');
}

export function isAutoMode(mode) {
  return typeof mode === 'string' && mode.toLowerCase() === 'auto';
}

// The permission mode carried by one transcript line, from either a dedicated
// `type:'permission-mode'` change line or the `permissionMode` stamped on a user prompt line.
// Claude Code's `type:'mode'` lines carry the EDITOR mode ('normal'/'insert'), never this one.
function permissionModeOf(line) {
  if (line == null || typeof line.permissionMode !== 'string' || line.permissionMode === '') return null;
  return line.permissionMode;
}

// Last permission mode set anywhere in a transcript. Forward scan, not a tail read: the field is
// stamped sparsely (a session that never toggled can carry a single stamp near the top and
// nothing after), so reading only the last N lines returns null in the common case.
// Sidechain lines are skipped — a subagent runs under its own mode and must not overwrite the
// main thread's.
// Returns the mode string, or null when the transcript is unreadable or never stamped one.
export function readPermissionMode(transcriptPath) {
  let content;
  try {
    content = fs.readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }
  let mode = null;
  for (const raw of content.split('\n')) {
    if (!raw.trim()) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (line != null && line.isSidechain === true) continue;
    const pm = permissionModeOf(line);
    if (pm !== null) mode = pm;
  }
  return mode;
}

// The permission mode of the session this command runs inside.
//
// Keyed on the session id Claude Code exports into the tool environment and NOTHING else. The
// cwd-based fallbacks resolveSessionTranscript() uses (newest transcript in the project dir,
// newest checkpoint state for the cwd) can resolve a SIBLING session running in the same
// directory — and a sibling sitting in plan mode would hard-block a login from a session that
// is already in normal mode, with advice ("press Shift+Tab") that changes nothing. A guard
// with no way out is worse than a guard that misses.
//
// Fails OPEN everywhere: no session id, no transcript, or a session that never stamped a mode
// all report null, so a detection miss never bricks /beezi:login.
// Returns the mode string, or null when it cannot be determined.
export function detectPermissionMode({ env = process.env } = {}) {
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  const session = sessionId ? findTranscriptBySessionId(sessionId) : null;
  return session == null ? null : readPermissionMode(session.transcriptPath);
}
