import { usableAccounts } from './setup-account.mjs';
import { lastLine, outputLines, report, token } from './setup-routing.mjs';

export const DEFAULT_UNCHANGED = 'The default account is unchanged. /beezi:settings account switches it later.';
export const CRASH_QUESTION = 'How should Beezi crash reports work?';
export const STATUS_LINE_QUESTION = "Show Beezi in Claude Code's status line?";
export const UPLOAD_LABEL = 'Uploading past sessions…';
// backfill.mjs prints this once per batch; the wizard shows it on the activity line instead.
export const UPLOAD_PROGRESS = /^Beezi: (\d+)\/(\d+) sessions read…$/;
const OFFER_OPEN = /^<offer account="[^"]*" tenant="([^"]*)" audit="(yes|no)">$/;
const OFFER_CLOSE = '</offer>';
const QUESTION = 'question=';
const COMMAND_LINE = /^(upload|decline)-command=/;
const UPLOAD_TOKEN = /^upload-command=.* --offer (\S+)$/;
// Summary lines the wizard leaves out: the count, dry-run progress, per-workspace headers (each question names its workspace),
// and the route and no-sessions lines, whose counts are not the offered set.
const SUMMARY_HIDDEN = [/^offers=\d+$/, UPLOAD_PROGRESS, /^— .+ —$/, /^Beezi \([^)]*\): /, /^✓ Beezi: no past Claude Code sessions found/];
const CRASH_OPTIONS = [
  { label: 'Correlate (recommended)', description: 'Crash reports with an installation ID, so support can find yours', mode: 'correlate' },
  { label: 'On', description: 'Crash reports without an installation ID', mode: 'on' },
  { label: 'Off', description: 'No crash reports; pending ones are deleted', mode: 'off' },
  { label: 'Anonymous', description: 'Stay on, and delete the installation ID and the reports that carry it', mode: 'anonymous' },
];

// The summary's output split into its <offer> blocks, [{ tenant, audit, lines, question, token }], and the user-facing lines outside them.
export function parseOffers(stdout) {
  const offers = [];
  const notes = [];
  let open = null;
  outputLines(stdout).forEach((raw) => {
    const line = raw.trimEnd();
    const head = OFFER_OPEN.exec(line);
    if (head !== null) {
      open = { tenant: head[1], audit: head[2] === 'yes', lines: [], question: null, token: null };
    } else if (open !== null && line === OFFER_CLOSE) {
      if (open.question !== null) offers.push(open);
      open = null;
    } else if (open !== null && line.indexOf(QUESTION) === 0) {
      open.question = line.slice(QUESTION.length);
    } else if (open !== null && UPLOAD_TOKEN.test(line)) {
      open.token = UPLOAD_TOKEN.exec(line)[1];
    } else if (open !== null) {
      if (!COMMAND_LINE.test(line)) open.lines.push(line);
    } else if (line.trim() !== '' && !SUMMARY_HIDDEN.some((pattern) => pattern.test(line))) {
      notes.push(line);
    }
  });
  return { offers, notes };
}

// login.md Step 4b in the terminal: a dry-run summary, then one (y/N) question per workspace. Only a yes uploads; a no or
// no answer at all records the decline and prints its line.
export async function offerHistory(ctx, key) {
  const summary = await ctx.run('backfill.mjs', ['--account', key]);
  const { offers, notes } = parseOffers(summary.stdout);
  notes.concat(outputLines(summary.stderr).filter((line) => line.trim() !== '')).forEach((line) => ctx.print(line.trimEnd()));
  for (const offer of offers) {
    offer.lines.forEach((line) => ctx.print(line));
    if (await ctx.ask.confirm(offer.question, false) === true) {
      const shown = offer.token == null ? [] : ['--offer', offer.token];
      await ctx.run('backfill.mjs', ['--account', key, '--accept', offer.tenant].concat(shown), { stream: true, label: UPLOAD_LABEL, live: UPLOAD_PROGRESS });
    } else {
      const decline = ['decline', '--account', key, '--tenant', offer.tenant].concat(offer.audit ? ['--audit'] : []);
      report(ctx, await ctx.run('history.mjs', decline));
    }
  }
}

export async function offerDefault(ctx, account) {
  if (!account.readsElsewhere) return;
  const listing = await ctx.run('accounts.mjs', ['list']);
  const row = usableAccounts(listing.stdout).find((a) => a.key === account.key);
  const name = row === undefined ? 'the account you just linked' : row.description;
  const yes = await ctx.ask.confirm(`Make ${name} the account /beezi:analytics reads from?`, false);
  if (yes === true) report(ctx, await ctx.run('accounts.mjs', ['use', account.key]));
  if (yes === false) ctx.print(DEFAULT_UNCHANGED);
}

// The options with the current mode marked as the default.
export function crashChoice(current) {
  const options = CRASH_OPTIONS.map((option) => (option.mode === current
    ? { label: option.label, description: `${option.description}, current setting`, mode: option.mode }
    : option));
  return { options, defaultIndex: CRASH_OPTIONS.findIndex((option) => option.mode === current) };
}

// Runs telemetry.mjs for every answer, the current mode included.
async function askCrashReports(ctx, current) {
  const choice = crashChoice(current);
  const picked = await ctx.ask.choose(CRASH_QUESTION, choice.options, { defaultIndex: choice.defaultIndex });
  if (picked === null) return;
  report(ctx, await ctx.run('telemetry.mjs', [choice.options[picked].mode]));
}

// Crash reports, then the status line when it is off, from `settings.mjs keys`.
export async function askMachineSettings(ctx) {
  const keys = await ctx.run('settings.mjs', ['keys']);
  if (keys.code !== 0) {
    report(ctx, keys);
    return;
  }
  const line = lastLine(keys.stdout, /^crash=/);
  if (line === null) return;
  await askCrashReports(ctx, token(line, 'crash'));
  if (token(line, 'statusline') !== 'off') return;
  if (await ctx.ask.confirm(STATUS_LINE_QUESTION, true) === true) {
    report(ctx, await ctx.run('statusline-install.mjs', []));
  }
}
