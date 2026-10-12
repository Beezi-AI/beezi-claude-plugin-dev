import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSettingsEnv } from '../lib/claude-settings-env.mjs';
import { NO_TERMINAL, SESSION_KEYS, STOPPED, realDeps, setupMain } from '../lib/setup-main.mjs';
import { childEnv } from '../lib/setup-runner.mjs';

function harness(overrides) {
  const seen = { printed: [], exits: [], removed: [], exitHandlers: [], interruptHandlers: [], runner: null, prompt: null, ctx: null, closed: 0, made: 0 };
  const terminal = { isTTY: true };
  const output = { write: () => true };
  const deps = Object.assign({
    root: '/plugin',
    env: { PATH: '/bin', CLAUDE_PID: '42', CLAUDE_CODE_SESSION_ID: 's1' },
    settingsEnv: () => ({}),
    output,
    print: (line) => { seen.printed.push(line); },
    openTerminal: () => terminal,
    createPrompt: (io) => { seen.prompt = io; return { close: () => { seen.closed += 1; } }; },
    createRunner: (options) => { seen.runner = options; return 'run-fn'; },
    runSetup: (ctx) => { seen.ctx = ctx; return Promise.resolve(0); },
    makeTempDir: () => { seen.made += 1; return '/tmp/beezi-setup-x'; },
    removeDir: (dir) => { seen.removed.push(dir); },
    onExit: (handler) => { seen.exitHandlers.push(handler); },
    onInterrupt: (handler) => { seen.interruptHandlers.push(handler); },
    exit: (code) => { seen.exits.push(code); },
  }, overrides || {});
  return { deps, seen, terminal, output };
}

test('session identity variables are the two Claude Code exports', () => {
  assert.deepEqual(SESSION_KEYS, ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID']);
});

test('without a terminal it prints the fallback and exits 1 before creating anything', async () => {
  const h = harness({ openTerminal: () => null });
  assert.equal(await setupMain(h.deps), 1);
  assert.equal(NO_TERMINAL, '✗ Beezi setup needs a terminal. Run /beezi:login in Claude Code instead.');
  assert.deepEqual(h.seen.printed, [NO_TERMINAL]);
  assert.equal(h.seen.made, 0);
  assert.equal(h.seen.runner, null);
  assert.equal(h.seen.ctx, null);
});

test('it runs the wizard in a temp cwd with the session keys stripped and the terminal prompt', async () => {
  const h = harness();
  assert.equal(await setupMain(h.deps), 0);
  assert.deepEqual(h.seen.runner, {
    root: '/plugin', cwd: '/tmp/beezi-setup-x', env: { PATH: '/bin', CLAUDE_PID: '42', CLAUDE_CODE_SESSION_ID: 's1' }, sessionKeys: SESSION_KEYS,
  });
  assert.equal(h.seen.prompt.input, h.terminal);
  assert.equal(h.seen.prompt.output, h.output);
  assert.equal(h.seen.ctx.run, 'run-fn');
  assert.equal(h.seen.ctx.print, h.deps.print);
  assert.equal(typeof h.seen.ctx.ask.close, 'function');
  assert.equal(h.seen.closed, 1);
  assert.deepEqual(h.seen.removed, []);
  h.seen.exitHandlers.forEach((handler) => handler());
  assert.deepEqual(h.seen.removed, ['/tmp/beezi-setup-x']);
  assert.deepEqual(h.seen.exits, []);
});

test("the settings env block reaches every child over the shell's values, and session keys are still stripped", async () => {
  const h = harness({
    env: { PATH: '/bin', ANTHROPIC_BASE_URL: 'https://shell.example.com', CLAUDE_PID: '42', CLAUDE_CODE_SESSION_ID: 's1' },
    settingsEnv: () => ({ ANTHROPIC_BASE_URL: 'https://gateway.example.com', CLAUDE_CODE_USE_BEDROCK: '1' }),
  });
  assert.equal(await setupMain(h.deps), 0);
  const env = childEnv(h.seen.runner.env, h.seen.runner.sessionKeys);
  assert.deepEqual(env, {
    PATH: '/bin', ANTHROPIC_BASE_URL: 'https://gateway.example.com', CLAUDE_CODE_USE_BEDROCK: '1', BEEZI_SETUP: '1',
  });
  assert.equal(h.deps.env.ANTHROPIC_BASE_URL, 'https://shell.example.com');
  assert.equal('CLAUDE_CODE_USE_BEDROCK' in h.deps.env, false);
});

test('the wizard exit code passes through, and a crash becomes 1 with a ✗ line', async () => {
  const failed = harness({ runSetup: () => Promise.resolve(1) });
  assert.equal(await setupMain(failed.deps), 1);
  assert.equal(failed.seen.closed, 1);
  const crashed = harness({ runSetup: () => Promise.reject(new Error('boom')) });
  assert.equal(await setupMain(crashed.deps), 1);
  assert.equal(crashed.seen.printed.length, 1);
  assert.match(crashed.seen.printed[0], /^✗ /);
  assert.equal(crashed.seen.closed, 1);
});

test('Ctrl+C prints how to finish and exits 130', async () => {
  const h = harness();
  await setupMain(h.deps);
  assert.equal(h.seen.interruptHandlers.length, 1);
  h.seen.interruptHandlers[0]();
  assert.equal(STOPPED, 'Setup stopped. Run the installer again, or /beezi:login in Claude Code, to finish.');
  assert.deepEqual(h.seen.printed, [`\n${STOPPED}`]);
  assert.deepEqual(h.seen.exits, [130]);
});

test('realDeps makes a fresh beezi-setup- temp dir and removes it only when empty', () => {
  const deps = realDeps('/plugin');
  assert.equal(deps.root, '/plugin');
  assert.equal(deps.env, process.env);
  assert.equal(deps.settingsEnv, readSettingsEnv);
  const dir = deps.makeTempDir();
  assert.ok(dir.startsWith(path.join(os.tmpdir(), 'beezi-setup-')));
  assert.equal(fs.statSync(dir).isDirectory(), true);
  deps.removeDir(dir);
  assert.equal(fs.existsSync(dir), false);
  deps.removeDir(dir);

  const busy = deps.makeTempDir();
  fs.writeFileSync(path.join(busy, 'left.txt'), 'x');
  deps.removeDir(busy);
  assert.equal(fs.existsSync(busy), true);
  fs.rmSync(busy, { recursive: true, force: true });
});
