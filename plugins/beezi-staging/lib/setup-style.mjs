const RESET = '\x1b[0m';
const VIOLETS = [183, 177, 171, 141, 135, 99, 98, 97, 63, 62, 61, 60, 60, 60];

// True when the stream is a terminal, NO_COLOR is unset and TERM is not dumb.
export function colorEnabled(options) {
  return options.stream.isTTY === true && !options.env.NO_COLOR && options.env.TERM !== 'dumb';
}

// True when single keys can be read from input while output is a terminal.
export function canReadKeys(options) {
  return options.input.isTTY === true
    && typeof options.input.setRawMode === 'function'
    && options.output.isTTY === true
    && options.env.TERM !== 'dumb';
}

// ANSI wrappers that return the text unchanged when colour is off.
export function createStyle(options) {
  const enabled = Boolean(options.enabled);
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}${RESET}` : text);
  return {
    enabled,
    bold: wrap('1'),
    dim: wrap('2'),
    cyan: wrap('36'),
    boldCyan: wrap('1;36'),
    blue: wrap('1;34'),
    green: wrap('32'),
    boldGreen: wrap('1;32'),
    yellow: wrap('33'),
    red: wrap('31'),
    magenta: wrap('35'),
    violet: (level, text) => (enabled ? `\x1b[38;5;${VIOLETS[level]}m${text}${RESET}` : text),
  };
}

const MAX_ROW = 100;
const SGR = /\x1b\[[0-9;]*m/g;
const OFFER_H1 = /^(Beezi found \d+ past .+ sessions?) (\(.+\))$/;
const OFFER_H2 = /^ {2}in (.+?)( \+\d+ more)?$/;
const OFFER_ITEM = /^ {4}([✓◆✕]) (.+)$/;
const OFFER_HIDDEN = '  Hidden by your workspace';
const OFFER_HIDDEN_NOTE = ' — Beezi gets made-up names';

// Visible characters, with SGR colour codes not counted.
function visible(text) {
  return Array.from(text.replace(SGR, '')).length;
}

// The style a line's leading ✓, ⚠, ✗ or "Setup stopped" calls for, or null.
function toneOf(body) {
  if (body.startsWith('✓')) return 'green';
  if (body.startsWith('⚠')) return 'yellow';
  if (body.startsWith('✗') || body.startsWith('Setup stopped')) return 'red';
  return null;
}

// Colours a line by its leading ✓, ⚠, ✗, "Setup stopped" or "==> ", keeping its leading whitespace.
export function paint(style, line) {
  const body = line.replace(/^\s+/, '');
  const lead = line.slice(0, line.length - body.length);
  const tone = toneOf(body);
  if (tone !== null) return lead + style[tone](body);
  if (body.startsWith('==> ')) return `${lead}${style.blue('==>')}${body.slice(3)}`;
  return line;
}

// Styles one K7-C past-sessions line by its exact shape (H1, H2, Sent, Hidden, Never sent, ✓/◆/✕ items); any other line comes back unchanged.
export function offerLine(style, line) {
  const head = OFFER_H1.exec(line);
  if (head !== null) return `${style.bold(head[1])} ${style.dim(head[2])}`;
  const item = OFFER_ITEM.exec(line);
  if (item !== null && item[1] === '✓') return `    ${style.green('✓')} ${item[2]}`;
  if (item !== null && item[1] === '◆') return `    ${style.magenta('◆')} ${item[2]}`;
  if (item !== null) return `    ${style.dim('✕')} ${style.dim(item[2])}`;
  if (line === '  Sent') return `  ${style.green('Sent')}`;
  if (line === `${OFFER_HIDDEN}${OFFER_HIDDEN_NOTE}`) return `  ${style.magenta(OFFER_HIDDEN.trim())}${style.dim(OFFER_HIDDEN_NOTE)}`;
  if (line === '  Never sent') return `  ${style.dim('Never sent')}`;
  const folders = OFFER_H2.exec(line);
  if (folders !== null) return `  ${style.dim('in')} ${folders[1]}${folders[2] === undefined ? '' : ` ${style.dim(folders[2].trim())}`}`;
  return line;
}

// Rows of at most min(columns − 1, 100) visible characters, broken at spaces: later rows keep the line's indent plus 2; a word longer than a row stays whole.
export function wrapLines(line, columns) {
  const room = Math.min(Math.max((columns || 80) - 1, 20), MAX_ROW);
  if (visible(line) <= room) return [line];
  const body = line.replace(/^\s+/, '');
  const lead = line.slice(0, line.length - body.length);
  const hang = `${lead}  `;
  const rows = [];
  let row = '';
  body.split(' ').forEach((word) => {
    const prefix = rows.length === 0 ? lead : hang;
    if (row === '') {
      row = word;
    } else if (visible(`${prefix}${row} ${word}`) > room) {
      rows.push(prefix + row);
      row = word;
    } else {
      row = `${row} ${word}`;
    }
  });
  rows.push((rows.length === 0 ? lead : hang) + row);
  return rows;
}

// Wrapped rows joined with \n: the first painted as paint() does, every later one in the first row's tone.
export function paintRows(style, rows) {
  const tone = toneOf(rows[0].replace(/^\s+/, ''));
  return rows.map((row, i) => {
    if (i === 0) return paint(style, row);
    if (tone === null) return row;
    const rest = row.replace(/^\s+/, '');
    return row.slice(0, row.length - rest.length) + style[tone](rest);
  }).join('\n');
}

// One printed line wrapped to the terminal and painted; each \n-separated part wraps on its own.
export function formatLine(style, line, columns) {
  return String(line).split('\n').map((part) => paintRows(style, wrapLines(part, columns))).join('\n');
}
