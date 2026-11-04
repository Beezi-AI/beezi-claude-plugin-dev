// "resets 4:30pm (Europe/Kiev)" -> the next UTC instant of that wall-clock in that zone after occurredAt.
const RESET_RE = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseRateLimitReset(text, occurredAtIso) {
  if (!text) return null;
  const match = RESET_RE.exec(text);
  if (!match) return null;
  const occurredAt = new Date(occurredAtIso);
  if (isNaN(occurredAt.getTime())) return null;

  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3] ? match[3].toLowerCase() : null;
  const timeZone = match[4].trim();
  if (minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) {
    return null;
  }

  if (!isValidTimeZone(timeZone)) return null;
  return nextOccurrenceUtc(hour, minute, timeZone, occurredAt).toISOString();
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Reads numeric calendar/clock fields of `instant` as rendered with `options`.
function zonedFieldReader(instant, options) {
  const parts = new Intl.DateTimeFormat('en-US', options).formatToParts(instant);
  return (type) => {
    const part = parts.find((p) => p.type === type);
    return Number(part == null ? '0' : part.value);
  };
}

function zonedDateParts(instant, timeZone) {
  const get = zonedFieldReader(instant, { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  return { year: get('year'), month: get('month'), day: get('day') };
}

// Milliseconds to add to a UTC wall-clock to get the real instant in `timeZone` at `instant`.
function tzOffsetMs(instant, timeZone) {
  const get = zonedFieldReader(instant, {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - (instant.getTime() - instant.getMilliseconds());
}

function zonedWallToUtc(date, hour, minute, timeZone) {
  const naiveUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  return new Date(naiveUtc - tzOffsetMs(new Date(naiveUtc), timeZone));
}

function nextOccurrenceUtc(hour, minute, timeZone, after) {
  const candidate = zonedWallToUtc(zonedDateParts(after, timeZone), hour, minute, timeZone);
  if (candidate.getTime() > after.getTime()) return candidate;
  const tomorrow = zonedDateParts(new Date(after.getTime() + DAY_MS), timeZone);
  return zonedWallToUtc(tomorrow, hour, minute, timeZone);
}
