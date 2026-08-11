// Fallback rendering for machines with no status line of their own.
//
// Chaining exists so a user who already built a status line keeps it byte-for-byte. Someone with
// no `statusLine` at all has nothing to chain — and since Claude Code treats an absent setting as
// "disabled", printing nothing would leave them with a configured status line that renders empty.
// So we render the one thing this plugin is uniquely placed to show: how close the account is to
// its plan ceilings. Set BEEZI_STATUSLINE_SILENT=1 for capture with no display.
//
// Every field here is optional by contract — the docs warn that context and rate-limit values are
// null early in a session and absent outside subscription billing — so each segment is dropped
// rather than defaulted, and an all-empty result returns '' instead of a line of separators.

function basename(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  const parts = dir.split(/[/\\]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

const pct = (value) => (typeof value === 'number' ? `${Math.round(value)}%` : null);

export function renderDefaultStatusline(payload) {
  const segments = [];

  const dir = basename(payload?.workspace?.current_dir ?? payload?.cwd);
  const model = payload?.model?.display_name;
  if (dir && model) segments.push(`${dir} [${model}]`);
  else if (dir) segments.push(dir);
  else if (model) segments.push(`[${model}]`);

  const fiveHour = pct(payload?.rate_limits?.five_hour?.used_percentage);
  const sevenDay = pct(payload?.rate_limits?.seven_day?.used_percentage);
  const limits = [fiveHour && `5h ${fiveHour}`, sevenDay && `7d ${sevenDay}`].filter(Boolean);
  if (limits.length) segments.push(limits.join(' '));

  const context = pct(payload?.context_window?.used_percentage);
  if (context) segments.push(`ctx ${context}`);

  return segments.join(' · ');
}
