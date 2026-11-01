// activities.js: the trips a guest can add to a stay.
//
// An activity leaves at set times (departureTimes, Nairobi time), every day (the lodge runs all
// its trips daily: decided Oct 2026). A departure is one activity on one day at one time.
//
// No seat limit: guests choose a departure and how many people, and that's all. If a departure
// has more people than one vehicle holds (activities.seats, kept as information for staff), the
// lodge adds a vehicle or offers another time, and staff tell the guest. Decided Oct 2026: a
// booking page full of "3 seats left" adds worry over something staff can always sort out.
//
// Which days: from check-in to check-out INCLUSIVE. Unlike a room night, a trip can be on the
// day you leave (a morning game drive before check-out at 11:00).
// And which times on the first and last day (found Nov 2026: a 06:30 drive was offered on the
// arrival day, before the guest could check in): on the check-in day only departures from
// check-in time, and on the check-out day only departures before check-out time.
//
// Cut-off: a departure can be added until ACTIVITY_CUTOFF_MINUTES before it leaves, so the lodge
// has time to arrange the vehicle and guide.
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activities } from '../db/schema.js';
import { config } from '../config.js';
import { addDays } from '../lib/dates.js';

/** The lodge's hours, Nairobi time: what the emails and the booking page tell guests. */
export const CHECK_IN_TIME = '14:00';
export const CHECK_OUT_TIME = '11:00';

/**
 * Is a departure during this stay? Any time on the days in between; on the check-in day from
 * check-in time; on the check-out day before check-out time. Times compare as text: they're
 * always HH:MM.
 */
export function duringStay(day, time, checkIn, checkOut) {
  if (day < checkIn || day > checkOut) return false;
  if (day === checkIn && time < CHECK_IN_TIME) return false;
  if (day === checkOut && time >= CHECK_OUT_TIME) return false;
  return true;
}

/** The moment a departure leaves. Nairobi is UTC+3 all year (no daylight saving). */
export const departsAt = (day, time) => new Date(`${day}T${time}:00+03:00`);

/** True if a departure is still far enough ahead to book. `now` is injectable for tests. */
export function bookable(day, time, now = new Date()) {
  return departsAt(day, time).getTime() - now.getTime() >= config.ACTIVITY_CUTOFF_MINUTES * 60_000;
}

/** Every day a trip can run during a stay: check-in to check-out, both included. */
export function tripDays(checkIn, checkOut) {
  const out = [];
  for (let d = checkIn; d <= checkOut; d = addDays(d, 1)) out.push(d);
  return out;
}

const card = (a) => ({ slug: a.slug, name: a.name, summary: a.summary, durationMinutes: a.durationMinutes, priceKes: a.priceKes });

/** The activities a guest can add to this stay, each with its bookable departures. */
export async function activitiesFor({ checkIn, checkOut, now = new Date() }) {
  const list = await db.select().from(activities).where(eq(activities.active, true)).orderBy(asc(activities.sort), asc(activities.id));
  const days = tripDays(checkIn, checkOut);
  return list.map((a) => ({
    ...card(a),
    departures: days.flatMap((day) =>
      [...a.departureTimes].sort().filter((time) => duringStay(day, time, checkIn, checkOut) && bookable(day, time, now)).map((time) => ({ day, time }))),
  }));
}
