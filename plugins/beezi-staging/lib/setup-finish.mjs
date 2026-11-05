import { usableAccounts } from './setup-account.mjs';
import { lastLine, outputLines, report, token } from './setup-routing.mjs';
import { offerLine } from './setup-style.mjs';

export const DEFAULT_UNCHANGED = 'The default account is unchanged. /beezi:settings account switches it later.';
export const CRASH_QUESTION = 'How should Beezi crash reports work?';
export const STATUS_LINE_QUESTION = "Show Beezi in Claude Code's status line?";
export const USAGE_CHECK_QUESTION = "Check your plan usage where the status line can't run, like the desktop app?";
export const UPLOAD_LABEL = 'Uploading past sessions…';
// backfill.mjs prints this once per batch; the wizard shows it on the activity line instead.
export const UPLOAD_NOW = 'Upload now';
export const OFFER_OPTIONS = [{ label: UPLOAD_NOW }, { label: 'Not now', description: 'run /beezi:sync any time' }];
// The last, exclusive row of each <ask> multi-select, never pre-ticked (R21).
export const ASK_NOT_NOW = { label: 'Not now', description: 'Nothing more is uploaded. Run /beezi:sync any time.' };
export const UPLOAD_PROGRESS = /^Beezi: (\d+)\/(\d+) sessions read…$/;
const OFFER_OPEN = /^<offer account="[^"]*" tenant="([^"]*)" audit="(yes|no)">$/;
const OFFER_CLOSE = '</offer>';
const NOTICE_OPEN = /^<notice account="[^"]*" tenant="[^"]*">$/;
const COMBINED_OPEN = /^<offers account="[^"]*">$/;
const SHOWN_CLOSE = ['</notice>', '</offers>'];
const ASK_OPEN = /^<ask account="[^"]*" part="\d+" parts="\d+">$/;
const ASK_CLOSE = '</ask>';
const QUESTION = 'question=';
const WORKSPACE = 'workspace=';
const DESCRIPTION = 'description=';
const COMMAND_LINE = /^(upload|decline)-command=/;
const UPLOAD_TOKEN = /^upload-command=.* --offer (\S+)$/;
const ASK_DECLINE = /^decline-command=.* --tenant (\S+)( --audit)? --offer (\S+)$/;
// Summary lines the wizard leaves out: the counts, dry-run progress, per-workspace headers (each question names its workspace),
// and the route and no-sessions lines, whose counts are not the offered set.
const MACHINE_HIDDEN = [/^offers=\d+( notices=\d+)?$/, /^— .+ —$/, /^Beezi \([^)]*\): /, /^✓ Beezi: no past Claude Code sessions found/];
const CRASH_OPTIONS = [
  { label: 'Correlate (recommended)', description: 'Crash reports with an installation ID, so support can find yours', mode: 'correlate' },
  { label: 'On', description: 'Crash reports without an installation ID', mode: 'on' },
  { label: 'Off', description: 'No crash reports; pending ones are deleted', mode: 'off' },
  { label: 'Anonymous', description: 'Stay on, and delete the installation ID and the reports that carry it', mode: 'anonymous' },
];

// Reads one line of an open <ask> part into it; null once the part closes, which keeps it only with a question.
function askLine(ask, line, asks) {
  if (line === ASK_CLOSE) {
    if (ask.question !== null) asks.push(ask);
    return null;
  }
  const last = ask.workspaces[ask.workspaces.length - 1];
  const decline = ASK_DECLINE.exec(line);
  if (line.indexOf(QUESTION) === 0) ask.question = line.slice(QUESTION.length);
  else if (line.indexOf(WORKSPACE) === 0) ask.workspaces.push({ name: line.slice(WORKSPACE.length), description: null, tenant: null, audit: false, token: null });
  else if (line.indexOf(DESCRIPTION) === 0) last.description = line.slice(DESCRIPTION.length);
  else if (decline !== null) Object.assign(last, { tenant: decline[1], audit: decline[2] !== undefined, token: decline[3] });
  return ask;
}

// The summary's <ask> parts ([{ question, workspaces: [{ name, description, tenant, audit, token }] }]) and its
// <offer> blocks ([{ tenant, audit, lines, question, token }]); every other line was already streamed.
export function parseOffers(stdout) {
  const asks = [];
  const offers = [];
  let open = null;
  let ask = null;
  outputLines(stdout).forEach((raw) => {
    const line = raw.trimEnd();
    const head = OFFER_OPEN.exec(line);
    if (ask !== null) {
      ask = askLine(ask, line, asks);
    } else if (ASK_OPEN.test(line)) {
      ask = { question: null, workspaces: [] };
    } else if (head !== null) {
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
    }
  });
  return { asks, offers };
}

// The streamed summary's hidden lines: every <offer> and <ask> block (asked after the run), the <notice>/<offers> tags,
// blank lines and MACHINE_HIDDEN; the progress line is left to the runner's live pattern.
export function summaryHide() {
  let inside = false;
  return {
    test(raw) {
      const line = raw.trimEnd();
      if (OFFER_OPEN.test(line) || ASK_OPEN.test(line)) inside = true;
      const hidden = inside || line.trim() === '' || NOTICE_OPEN.test(line) || COMBINED_OPEN.test(line)
        || SHOWN_CLOSE.indexOf(line) !== -1 || MACHINE_HIDDEN.some((pattern) => pattern.test(line));
      if (line === OFFER_CLOSE || line === ASK_CLOSE) inside = false;
      return hidden;
    },
  };
}

const shownArgs = (target) => (target.token == null ? [] : ['--offer', target.token]);

// Uploads one asked workspace ({ tenant, token }), streamed on the upload activity line.
function acceptAsked(ctx, key, target) {
  return ctx.run('backfill.mjs', ['--account', key, '--accept', target.tenant].concat(shownArgs(target)), { stream: true, label: UPLOAD_LABEL, live: UPLOAD_PROGRESS });
}

// Records one asked workspace ({ tenant, audit, token }) as declined.
async function declineAsked(ctx, key, target) {
  const decline = ['decline', '--account', key, '--tenant', target.tenant].concat(target.audit ? ['--audit'] : [], shownArgs(target));
  report(ctx, await ctx.run('history.mjs', decline));
}

// Streams the summary, so a no-ask notice shows before its upload, then asks one Upload now / Not now menu per <offer>
// and one multi-select per <ask> part with every workspace ticked (R12) and a last Not now (R21); only an Upload now or a
// kept tick uploads.
export async function offerHistory(ctx, key) {
  const summary = await ctx.run('backfill.mjs', ['--account', key], { stream: true, hide: summaryHide(), live: UPLOAD_PROGRESS });
  const { asks, offers } = parseOffers(summary.stdout);
  for (const offer of offers) {
    offer.lines.forEach((line) => ctx.print(offerLine(ctx.style, line)));
    if (await ctx.ask.choose(offer.question, OFFER_OPTIONS, { defaultIndex: 0, escape: true }) === 0) await acceptAsked(ctx, key, offer);
    else await declineAsked(ctx, key, offer);
  }
  for (const ask of asks) {
    const options = ask.workspaces.map((w) => ({ label: w.name, description: w.description }));
    const picked = await ctx.ask.chooseMany(ask.question, options.concat([ASK_NOT_NOW]), {
      exclusive: [options.length], initial: options.map((_, i) => i),
    });
    for (let i = 0; i < ask.workspaces.length; i += 1) {
      // A closed terminal answers null: nothing is uploaded without an answer.
      if (picked !== null && picked.indexOf(i) !== -1) await acceptAsked(ctx, key, ask.workspaces[i]);
      else await declineAsked(ctx, key, ask.workspaces[i]);
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

// Crash reports, then the status line and the usage check when each is off, from `settings.mjs keys`.
export async function askMachineSettings(ctx) {
  const keys = await ctx.run('settings.mjs', ['keys']);
  if (keys.code !== 0) {
    report(ctx, keys);
    return;
  }
  const line = lastLine(keys.stdout, /^crash=/);
  if (line === null) return;
  await askCrashReports(ctx, token(line, 'crash'));
  if (token(line, 'statusline') === 'off' && await ctx.ask.confirm(STATUS_LINE_QUESTION, true) === true) {
    report(ctx, await ctx.run('statusline-install.mjs', []));
  }
  if (token(line, 'usage-check') === 'off' && await ctx.ask.confirm(USAGE_CHECK_QUESTION, false) === true) {
    report(ctx, await ctx.run('settings.mjs', ['set', 'usage-check=on']));
  }
}
