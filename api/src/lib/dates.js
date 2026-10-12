// dates.js: stay dates as plain 'YYYY-MM-DD' strings, computed in UTC arithmetic.
//
// A stay date is a calendar day at the lodge, not a moment in time. Doing the arithmetic on
// UTC midnights means no daylight-saving change or server time zone can ever turn
// 2026-12-31 + 1 into anything but 2027-01-01. Kenya has no daylight saving, but Render's
// servers and a developer's laptop might be anywhere.
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date written as YYYY-MM-DD (rejects 2026-02-30). */
export function isIsoDate(s) {
  if (typeof s !== 'string' || !ISO.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const toMs = (s) => Date.parse(`${s}T00:00:00Z`);
const fromMs = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (s, n) => fromMs(toMs(s) + n * DAY_MS);
export const daysBetween = (from, to) => Math.round((toMs(to) - toMs(from)) / DAY_MS);

/** Every night of a stay: check-in up to, NOT including, check-out. */
export function nightsOf(checkIn, checkOut) {
  const out = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Add whole calendar months, clamping to the month's last day (31 Jan + 1 month = 28/29 Feb). */
export function addMonths(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, last));
  return first.toISOString().slice(0, 10);
}

/** Today's date at the lodge (Nairobi), whatever time zone this server runs in. */
export function todayInNairobi(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
