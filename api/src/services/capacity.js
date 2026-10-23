// capacity.js: locking what a booking needs, then checking it still fits. Used when a booking
// is created (services/bookings.js) and when a late deposit re-holds an expired one
// (services/payments.js), so both follow exactly the same rules.
//
// WHY THE LOCKS, AND WHY THE ORDER
// To stop two guests buying the same last room, a booking locks each room type it uses
// (SELECT … FOR UPDATE), then counts, then inserts (the full story is at the top of
// services/bookings.js). A booking can use several room types, so it takes several locks. If one booking locked Hearthside then Coalbed while another locked Coalbed then
// Hearthside, each could end up holding one lock and waiting forever for the other: a DEADLOCK
// (Postgres would notice and fail one of them). The cure is a fixed order everyone follows:
//
//     payment → booking → room types (by id)
//
// Two bookings needing overlapping things then always queue for them in the same order, so one
// simply waits for the other to finish.
//
// Activities take no lock: they have no limit to protect. How many people go on a departure is
// the lodge's to arrange (more vehicles, another time) and staff tell the guest; see
// services/activities.js.
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { bookings, roomTypes, bookingRooms } from '../db/schema.js';
import { freeUnits } from './availability.js';

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

/**
 * The first room in `need` that no longer fits, as a message for the guest, or null if they all
 * fit. Call only with the room types already locked.
 *   need: { checkIn, checkOut, rooms: [{ roomType, units }] }
 */
export async function shortfall(tx, { checkIn, checkOut, rooms }) {
  const free = await freeUnits({ checkIn, checkOut, executor: tx });
  for (const { roomType, units } of rooms) {
    const left = free.get(roomType.id) ?? 0;
    if (left < units) {
      return left === 0
        ? `${roomType.name} has just been booked for those dates.`
        : `Only ${left} ${roomType.name}${left === 1 ? ' is' : 's are'} left for those dates.`;
    }
  }
  return null;
}

/**
 * For a booking that lost its hold (or never had one confirmed): lock its room types in the
 * standard order and check they're still free. The booking row itself must already be locked.
 * Returns null if it fits, else the reason.
 */
export async function bookingStillFits(tx, b) {
  const roomRows = await tx.select().from(bookingRooms).where(eq(bookingRooms.bookingId, b.id));
  const types = await lockRoomTypes(tx, roomRows.map((r) => r.roomTypeId));
  const typeById = new Map(types.map((t) => [t.id, t]));
  return shortfall(tx, {
    checkIn: b.checkIn, checkOut: b.checkOut,
    rooms: roomRows.map((r) => ({ roomType: typeById.get(r.roomTypeId), units: r.units })),
  });
}
