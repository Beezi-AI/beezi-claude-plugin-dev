import { STOPPED, lastLine, outputLines, report, token } from './setup-routing.mjs';

const FAILURE_LINE = /^(?:✗ |Beezi: )/;

// A failed upload's stdout ✗ and Beezi: lines, then its stderr; never its route summary, workspace headers or progress.
function failureLines(result) {
  const said = outputLines(result.stdout).map((line) => line.trim()).filter((line) => FAILURE_LINE.test(line));
  const lines = said.concat(outputLines(result.stderr).map((line) => line.trimEnd()).filter((line) => line !== ''));
  return lines.length > 0 ? lines : [STOPPED];
}

// Queues the consented upload and says how many sessions are on their way; a failure prints only its failure lines.
export async function uploadPast(ctx, key) {
  const result = await ctx.run('backfill.mjs', ['--account', key, '--consented']);
  if (result.code !== 0) {
    failureLines(result).forEach((line) => ctx.print(line));
    return;
  }
  const line = lastLine(result.stdout, /^uploading=\d+ /);
  const n = line === null ? 0 : Number(token(line, 'uploading'));
  if (n === 1) ctx.print('✓ 1 past session is uploading in the background');
  if (n > 1) ctx.print(`✓ ${n} past sessions are uploading in the background`);
}

// The `crash=… statusline=…` line of `settings.mjs keys`, or null.
async function machineLine(ctx) {
  const keys = await ctx.run('settings.mjs', ['keys']);
  if (keys.code !== 0) report(ctx, keys);
  return lastLine(keys.stdout, /^crash=/);
}

// Crash reports on for an undecided machine and the status line installed when off; resolves what is on afterwards.
export async function applyDefaults(ctx) {
  const telemetry = await ctx.run('telemetry.mjs', ['default']);
  if (telemetry.code !== 0) report(ctx, telemetry);
  let line = await machineLine(ctx);
  if (line !== null && token(line, 'statusline') === 'off') {
    // A settings file the installer can't parse is not an error here: the status line just stays off.
    await ctx.run('statusline-install.mjs', []);
    line = await machineLine(ctx);
  }
  return {
    crash: line !== null && token(line, 'crash') !== 'off',
    statusline: line !== null && token(line, 'statusline') === 'on',
  };
}
