// capacity.js: locking what a booking needs, then checking it still fits. Used when a booking
// is created (services/bookings.js) and when a late deposit re-holds an expired one
// (services/payments.js), so both follow exactly the same rules.
//
// WHY THE LOCKS, AND WHY THE ORDER
// To stop two guests buying the same last room, a booking locks each room type it uses
// (SELECT … FOR UPDATE), then counts, then inserts (the full story is at the top of
// services/bookings.js). A booking can now use several room types and activities, so it takes
// several locks. If one booking locked Hearthside then Coalbed while another locked Coalbed then
// Hearthside, each could end up holding one lock and waiting forever for the other: a DEADLOCK
// (Postgres would notice and fail one of them). The cure is a fixed order everyone follows:
//
//     payment → booking → room types (by id) → activities (by id)
//
// Two bookings needing overlapping things then always queue for them in the same order, so one
// simply waits for the other to finish.
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { bookings, roomTypes, bookingRooms, bookingActivities, activities } from '../db/schema.js';
import { freeUnits } from './availability.js';
import { seatsTaken } from './activities.js';

/**
 * Select every booking column plus holdRunning: "HELD, and the hold hasn't run out", judged by
 * the database's clock.
 *
 * WHY THE DATABASE'S CLOCK: holds are created (now() + 15 min), counted as taking a room
 * (availability.js) and expired (expireHolds) using Postgres's now(). If this server compared
 * them with its own clock (new Date()) instead, and that clock were a few seconds behind the
 * database's (two machines, Render and Neon, are never exactly in step), a hold could count as
 * "running" here after the database had already freed its room for someone else, and a late
 * deposit would confirm it without re-checking: two guests, one room. One clock decides holds.
 */
export const withHoldRunning = {
  ...getTableColumns(bookings),
  holdRunning: sql`(${bookings.status} = 'HELD' and ${bookings.holdExpiresAt} > now())`.mapWith(Boolean),
};

/** Locks room types one at a time in id order. Returns the rows (active ones only when activeOnly). */
export async function lockRoomTypes(tx, ids, { activeOnly = false } = {}) {
  const locked = [];
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const [rt] = await tx.select().from(roomTypes)
      .where(activeOnly ? and(eq(roomTypes.id, id), eq(roomTypes.active, true)) : eq(roomTypes.id, id))
      .for('update');
    if (rt) locked.push(rt);
  }
  return locked;
}

/** Locks activities one at a time in id order. */
export async function lockActivityRows(tx, ids) {
  const locked = [];
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    const [a] = await tx.select().from(activities).where(eq(activities.id, id)).for('update');
    if (a) locked.push(a);
  }
  return locked;
}

/**
 * The first thing in `need` that no longer fits, as a message for the guest, or null if it all
 * fits. Call only with the room types and activities already locked.
 *   need: { checkIn, checkOut, rooms: [{ roomType, units }], trips: [{ activity, day, departs, people }] }
 */
export async function shortfall(tx, { checkIn, checkOut, rooms, trips }) {
  const free = await freeUnits({ checkIn, checkOut, executor: tx });
  for (const { roomType, units } of rooms) {
    const left = free.get(roomType.id) ?? 0;
    if (left < units) {
      return left === 0
        ? `${roomType.name} has just been booked for those dates.`
        : `Only ${left} ${roomType.name}${left === 1 ? ' is' : 's are'} left for those dates.`;
    }
  }
  if (trips.length) {
    const days = trips.map((t) => t.day).sort();
    const taken = await seatsTaken({ activityIds: trips.map((t) => t.activity.id), from: days[0], to: days.at(-1), executor: tx });
    for (const t of trips) {
      const left = t.activity.seats - (taken.get(`${t.activity.id}|${t.day}|${t.departs}`) ?? 0);
      if (left < t.people) {
        return left <= 0
          ? `${t.activity.name} at ${t.departs} on ${t.day} is now full.`
          : `${t.activity.name} at ${t.departs} on ${t.day} has only ${left} seat${left === 1 ? '' : 's'} left.`;
      }
    }
  }
  return null;
}

/**
 * For a booking that lost its hold (or never had one confirmed): lock everything it needs in the
 * standard order and check it still fits. The booking row itself must already be locked.
 * Returns null if it fits, else the reason.
 */
export async function bookingStillFits(tx, b) {
  const roomRows = await tx.select().from(bookingRooms).where(eq(bookingRooms.bookingId, b.id));
  const tripRows = await tx.select().from(bookingActivities).where(eq(bookingActivities.bookingId, b.id));
  const types = await lockRoomTypes(tx, roomRows.map((r) => r.roomTypeId));
  const acts = await lockActivityRows(tx, tripRows.map((t) => t.activityId));
  const typeById = new Map(types.map((t) => [t.id, t]));
  const actById = new Map(acts.map((a) => [a.id, a]));
  return shortfall(tx, {
    checkIn: b.checkIn, checkOut: b.checkOut,
    rooms: roomRows.map((r) => ({ roomType: typeById.get(r.roomTypeId), units: r.units })),
    trips: tripRows.map((t) => ({ activity: actById.get(t.activityId), day: t.day, departs: t.departs, people: t.people })),
  });
}

