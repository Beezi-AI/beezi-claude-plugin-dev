import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPlanMode, isAutoMode, readPermissionMode, detectPermissionMode } from '../lib/permission-mode.mjs';

// Point claudeProjectsDir() at a temp root for the duration of one test.
function makeClaudeRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  t.after(() => {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
    fs.rmSync(dir, { recursive: true });
  });
  return path.join(dir, 'projects');
}

function writeTranscript(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tr-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf-8');
  return file;
}

test('plan and auto are the modes that block the login flow; nothing else does', () => {
  assert.equal(isPlanMode('plan'), true);
  assert.equal(isAutoMode('auto'), true);
  for (const mode of ['default', 'acceptEdits', 'dontAsk', 'bypassPermissions']) {
    assert.equal(isPlanMode(mode), false, mode);
    assert.equal(isAutoMode(mode), false, mode);
  }
  // The two predicates are disjoint — a mode is one or the other, never both.
  assert.equal(isAutoMode('plan'), false);
  assert.equal(isPlanMode('auto'), false);
});

// Auto is a whole mode name, not a family: matched exactly, so a future mode that merely starts
// with it is not swept into the block by accident.
test('auto is matched exactly and case-insensitively', () => {
  assert.equal(isAutoMode('Auto'), true);
  assert.equal(isAutoMode('autoCompact'), false);
  assert.equal(isAutoMode('auto-allow'), false);
  assert.equal(isAutoMode(null), false);
  assert.equal(isAutoMode(''), false);
});

test('a renamed plan mode still blocks; nothing else is caught by the substring match', () => {
  assert.equal(isPlanMode('plan_mode'), true);
  assert.equal(isPlanMode('planning'), true);
  assert.equal(isPlanMode('Plan'), true);
  // The substring match is deliberately wide — no real mode string contains 'plan' by accident.
  assert.equal(isPlanMode(''), false);
  assert.equal(isPlanMode(null), false);
  assert.equal(isPlanMode(undefined), false);
});

test('the last mode set wins, from change lines and prompt stamps alike', (t) => {
  const file = writeTranscript(t, [
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'user', message: { content: 'do X' }, permissionMode: 'plan' },
    { type: 'assistant', message: { content: 'ok' } },
    { type: 'permission-mode', permissionMode: 'auto' },
    { type: 'assistant', message: { content: 'more' } },
  ]);
  assert.equal(readPermissionMode(file), 'auto');
});

test('a single stamp at the top of a long session is still found', (t) => {
  const lines = [{ type: 'permission-mode', permissionMode: 'auto' }];
  for (let i = 0; i < 200; i += 1) lines.push({ type: 'assistant', message: { content: `line ${i}` } });
  assert.equal(readPermissionMode(writeTranscript(t, lines)), 'auto');
});

test('a subagent turn does not overwrite the main thread mode', (t) => {
  const file = writeTranscript(t, [
    { type: 'permission-mode', permissionMode: 'auto' },
    { type: 'user', isSidechain: true, permissionMode: 'bypassPermissions', message: { content: 'sub' } },
  ]);
  assert.equal(readPermissionMode(file), 'auto');
});

test('malformed and blank lines are skipped instead of losing the mode', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tr-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `{"type":"permission-mode","permissionMode":"plan"}\n\n{not json\n\n`, 'utf-8');
  assert.equal(readPermissionMode(file), 'plan');
});

test('an unstamped or unreadable transcript reports no mode', (t) => {
  const file = writeTranscript(t, [{ type: 'user', message: { content: 'hi' } }]);
  assert.equal(readPermissionMode(file), null);
  assert.equal(readPermissionMode(path.join(path.dirname(file), 'missing.jsonl')), null);
});

function writeSessionTranscript(projects, sessionId, mode) {
  const dir = path.join(projects, 'C--some-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'permission-mode', permissionMode: mode }),
    'utf-8',
  );
}

test('detection reads the session transcript Claude Code exported into the environment', (t) => {
  const projects = makeClaudeRoot(t);
  writeSessionTranscript(projects, 'sess-1', 'auto');
  assert.equal(detectPermissionMode({ env: { CLAUDE_CODE_SESSION_ID: 'sess-1' } }), 'auto');
});

test('detection fails open when no transcript can be resolved', (t) => {
  makeClaudeRoot(t);
  assert.equal(detectPermissionMode({ env: { CLAUDE_CODE_SESSION_ID: 'no-such-session' } }), null);
});

// A sibling session in the same directory must never decide this one's verdict: being blocked on
// another session's plan mode leaves no way out, since switching THIS session's mode changes
// nothing. Without a session id there is no way to tell them apart, so the guard stands down.
test('a sibling session transcript never blocks this one', (t) => {
  const projects = makeClaudeRoot(t);
  writeSessionTranscript(projects, 'other-session', 'plan');
  assert.equal(detectPermissionMode({ env: {} }), null);
});
