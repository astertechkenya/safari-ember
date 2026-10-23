// activities.js: the trips a guest can add to a stay, and the seats left on each departure.
//
// An activity leaves at set times (departureTimes, Nairobi time) on set weekdays, with a number
// of seats per departure. A departure is one activity on one day at one time.
//
// Seats are counted exactly like rooms (services/availability.js): a booking takes its seats
// while it's CONFIRMED, or HELD with a hold that hasn't run out. So an unpaid hold frees its
// seats the moment it lapses, with no job needed.
//
// Which days: from check-in to check-out INCLUSIVE. Unlike a room night, a trip can be on the
// day you leave (a morning game drive before check-out at 11:00).
//
// Cut-off: a departure can be added until ACTIVITY_CUTOFF_MINUTES before it leaves, so the lodge
// has time to arrange the vehicle and guide.
import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { activities } from '../db/schema.js';
import { config } from '../config.js';
import { addDays } from '../lib/dates.js';

/** ISO weekday of a YYYY-MM-DD date: 1 = Monday … 7 = Sunday. */
export function weekdayOf(day) {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();   // 0 = Sunday
  return d === 0 ? 7 : d;
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

/**
 * Seats taken per departure, for the given activities and days.
 * @returns Map 'activityId|day|HH:MM' → people
 */
export async function seatsTaken({ activityIds, from, to, executor = db }) {
  if (!activityIds.length) return new Map();
  const { rows } = await executor.execute(sql`
    select ba.activity_id, ba.day::text as day, ba.departs, sum(ba.people)::int as n
      from booking_activities ba
      join bookings b on b.id = ba.booking_id
     where ba.activity_id in ${activityIds}   -- drizzle writes the array as a list: ($1, $2, …)
       and ba.day between ${from}::date and ${to}::date
       and (b.status = 'CONFIRMED' or (b.status = 'HELD' and b.hold_expires_at > now()))
     group by ba.activity_id, ba.day, ba.departs`);
  return new Map(rows.map((r) => [`${r.activity_id}|${r.day}|${r.departs}`, Number(r.n)]));
}

const card = (a) => ({ slug: a.slug, name: a.name, summary: a.summary, durationMinutes: a.durationMinutes, priceKes: a.priceKes });

/**
 * The activities a guest can add to this stay, each with its bookable departures and seats left.
 * Departures already full are listed with seatsLeft 0, so the page can show them as full.
 */
export async function activitiesFor({ checkIn, checkOut, now = new Date() }) {
  const list = await db.select().from(activities).where(eq(activities.active, true)).orderBy(asc(activities.sort), asc(activities.id));
  const taken = await seatsTaken({ activityIds: list.map((a) => a.id), from: checkIn, to: checkOut });
  const days = tripDays(checkIn, checkOut);
  return list.map((a) => ({
    ...card(a),
    departures: days.filter((d) => a.weekdays.includes(weekdayOf(d))).flatMap((day) =>
      [...a.departureTimes].sort().filter((time) => bookable(day, time, now)).map((time) => ({
        day, time, seatsLeft: Math.max(0, a.seats - (taken.get(`${a.id}|${day}|${time}`) ?? 0)),
      }))),
  }));
}
