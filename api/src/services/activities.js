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
//
// Cut-off: a departure can be added until ACTIVITY_CUTOFF_MINUTES before it leaves, so the lodge
// has time to arrange the vehicle and guide.
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activities } from '../db/schema.js';
import { config } from '../config.js';
import { addDays } from '../lib/dates.js';

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
      [...a.departureTimes].sort().filter((time) => bookable(day, time, now)).map((time) => ({ day, time }))),
  }));
}
