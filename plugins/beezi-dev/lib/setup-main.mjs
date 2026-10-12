import fs from 'fs';
import os from 'os';
import path from 'path';
import { readSettingsEnv } from './claude-settings-env.mjs';
import { friendlyMessage } from './friendly-error.mjs';
import { createPrompt, openTerminal } from './setup-prompt.mjs';
import { createRunner } from './setup-runner.mjs';
import { runSetup } from './setup-wizard.mjs';

export const SESSION_KEYS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID'];
export const NO_TERMINAL = '✗ Beezi setup needs a terminal. Run /beezi:login in Claude Code instead.';
export const STOPPED = 'Setup stopped. Run the installer again, or /beezi:login in Claude Code, to finish.';

export function realDeps(root) {
  return {
    root,
    env: process.env,
    settingsEnv: readSettingsEnv,
    output: process.stdout,
    print: (line) => { console.log(line); },
    openTerminal,
    createPrompt,
    createRunner,
    runSetup,
    makeTempDir: () => fs.mkdtempSync(path.join(os.tmpdir(), 'beezi-setup-')),
    // Removes the dir when empty; a dir a script wrote into is left for the OS temp cleaner.
    removeDir: (dir) => {
      try {
        fs.rmdirSync(dir);
      } catch (error) { /* not empty, or already gone */ }
    },
    onExit: (handler) => { process.on('exit', handler); },
    onInterrupt: (handler) => { process.on('SIGINT', handler); },
    exit: (code) => { process.exit(code); },
  };
}

// Runs the wizard on the terminal and resolves its exit code.
export function setupMain(deps) {
  const input = deps.openTerminal();
  if (input === null) {
    deps.print(NO_TERMINAL);
    return Promise.resolve(1);
  }
  const cwd = deps.makeTempDir();
  deps.onExit(() => deps.removeDir(cwd));
  deps.onInterrupt(() => {
    deps.print(`\n${STOPPED}`);
    deps.exit(130);
  });
  const ask = deps.createPrompt({ input, output: deps.output });
  // The settings env block over the shell's, as Claude Code gives its hooks.
  const env = Object.assign({}, deps.env, deps.settingsEnv());
  const run = deps.createRunner({ root: deps.root, cwd, env, sessionKeys: SESSION_KEYS });
  return deps.runSetup({ run, ask, print: deps.print })
    .catch((error) => {
      deps.print(`✗ ${friendlyMessage(error)}`);
      return 1;
    })
    .then((code) => {
      ask.close();
      return code;
    });
}
