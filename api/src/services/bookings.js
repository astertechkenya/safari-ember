// bookings.js: searching, holding and reading bookings.
//
// THE OVERBOOKING PROBLEM, and how it's solved
// Two guests want the Ember Penthouse (1 unit) for the same night and press "Book" in the same
// second. Done naively, both requests check availability, both see "1 free", both insert: the
// lodge has sold one penthouse twice.
// Fix: inside one transaction, LOCK the room type's row first (SELECT … FOR UPDATE), then
// count, then insert. Postgres lets only one transaction hold that lock; the second waits at
// the lock until the first commits, then counts again, now seeing the first guest's booking,
// and finds 0 free. Only bookings for the SAME room type wait for each other; a Hearthside
// booking never waits on a Penthouse one. test/bookings.test.js fires simultaneous bookings at
// a last unit to prove exactly one wins.
//
// Why the count is fresh after waiting: Postgres' default isolation (READ COMMITTED) takes a
// new snapshot for every statement, so the count that runs after the lock sees everything
// committed before the lock was granted.
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roomTypes, seasonalRates, bookings, bookingNights } from '../db/schema.js';
import { config } from '../config.js';
import { httpError } from '../middleware/errors.js';
import { freeUnits } from './availability.js';
import { checkBookingPayment, paymentSummary, paymentMethods } from './payments.js';
import { quote } from './pricing.js';
import { newRef } from '../lib/ref.js';
import { bookingToken, bookingUrl } from '../lib/bookingLink.js';
import { todayInNairobi, daysBetween } from '../lib/dates.js';

/** Seasonal rates that touch the stay, grouped by room type id. */
async function seasonsFor(roomTypeIds, checkIn, checkOut, executor = db) {
  if (!roomTypeIds.length) return new Map();
  const rows = await executor.select().from(seasonalRates).where(and(
    inArray(seasonalRates.roomTypeId, roomTypeIds),
    sql`${seasonalRates.startsOn} < ${checkOut}::date`,
    sql`${seasonalRates.endsOn} > ${checkIn}::date`,
  ));
  const map = new Map(roomTypeIds.map((id) => [id, []]));
  for (const r of rows) map.get(r.roomTypeId).push(r);
  return map;
}

const roomCard = (rt) => ({ slug: rt.slug, name: rt.name, kind: rt.kind, description: rt.description, sleeps: rt.sleeps });

/** The rooms list for the site: every active type with its lowest upcoming nightly price. */
export async function listRooms() {
  const types = await db.select().from(roomTypes).where(eq(roomTypes.active, true)).orderBy(asc(roomTypes.sort), asc(roomTypes.id));
  const today = todayInNairobi();
  // A season that hasn't ended yet can make the "from" price lower than the base rate.
  const seasons = await db.select().from(seasonalRates).where(sql`${seasonalRates.endsOn} > ${today}::date`);
  return types.map((rt) => ({
    ...roomCard(rt),
    fromKes: Math.min(rt.baseRateKes, ...seasons.filter((s) => s.roomTypeId === rt.id).map((s) => s.nightlyRateKes)),
  }));
}

/** The availability search: every active room type, whether it can take this stay, and its price. */
export async function search({ checkIn, checkOut, guests }) {
  const types = await db.select().from(roomTypes).where(eq(roomTypes.active, true)).orderBy(asc(roomTypes.sort), asc(roomTypes.id));
  const [free, seasons] = await Promise.all([
    freeUnits({ checkIn, checkOut }),
    seasonsFor(types.map((t) => t.id), checkIn, checkOut),
  ]);
  const rooms = types.map((rt) => {
    const left = free.get(rt.id) ?? 0;
    const fits = guests <= rt.sleeps;
    return {
      ...roomCard(rt),
      fits,                                     // false: too many guests for one of these
      available: fits && left > 0,
      // Exact count only when it's low (FEW_LEFT): "only 2 left" helps the guest decide, but the
      // lodge doesn't advertise how empty it is the rest of the time.
      left: left > 0 && left <= config.FEW_LEFT ? left : null,
      ...quote(rt, checkIn, checkOut, seasons.get(rt.id), config.DEPOSIT_PERCENT),
    };
  });
  const largest = Math.max(0, ...types.map((t) => t.sleeps));
  return {
    checkIn, checkOut, guests,
    nights: daysBetween(checkIn, checkOut),
    rooms,
    // 5+ guests: no single room fits. The site points them to the enquiry form (multi-room later).
    needsMoreRooms: guests > largest,
  };
}

/**
 * Hold one unit while the guest pays the deposit. See the top of this file for the locking.
 * `afterCount` is for tests only: it pauses between counting and inserting, the exact moment two
 * guests could collide, so the test can force the race instead of hoping it happens.
 * @returns { booking, token, url }
 */
export async function createHold({ room, checkIn, checkOut, guests, firstName, lastName, email, phone, requests }, { afterCount } = {}) {
  const created = await db.transaction(async (tx) => {
    // 1. Lock this room type. Every other booking for it waits here until we commit or roll back.
    const [rt] = await tx.select().from(roomTypes)
      .where(and(eq(roomTypes.slug, room), eq(roomTypes.active, true)))
      .for('update');
    if (!rt) throw httpError(404, 'That room is not available to book');
    if (guests > rt.sleeps) throw httpError(400, `${rt.name} sleeps at most ${rt.sleeps}`);

    // 2. Count, now that nobody else can add a booking for this type until we're done.
    const free = (await freeUnits({ checkIn, checkOut, roomTypeId: rt.id, executor: tx })).get(rt.id) ?? 0;
    if (free < 1) throw httpError(409, `${rt.name} has just been booked for those dates. Please choose other dates or another room.`);
    if (afterCount) await afterCount();

    // 3. Price it, from the rates as they are right now.
    const seasons = (await seasonsFor([rt.id], checkIn, checkOut, tx)).get(rt.id);
    const q = quote(rt, checkIn, checkOut, seasons, config.DEPOSIT_PERCENT);

    // 4. Insert with a fresh reference. A repeated reference (about 1 in 887 million per pair)
    //    is skipped by ON CONFLICT and simply retried with a new one.
    let row;
    for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
      [row] = await tx.insert(bookings).values({
        ref: newRef(), roomTypeId: rt.id, checkIn, checkOut, nights: q.nightly.length, guests,
        totalKes: q.totalKes, depositKes: q.depositKes, status: 'HELD',
        holdExpiresAt: sql`now() + make_interval(mins => ${config.HOLD_MINUTES})`,
        firstName, lastName, email, phone, requests: requests || null,
      }).onConflictDoNothing({ target: bookings.ref }).returning();
    }
    if (!row) throw new Error('could not find an unused booking reference');
    await tx.insert(bookingNights).values(q.nightly.map((n) => ({ bookingId: row.id, night: n.night, rateKes: n.rateKes })));
    return row;
  });
  // Tokens are made as of the booking's creation: the same link whenever it's made again.
  const asOf = { now: created.createdAt.getTime() };
  return { booking: await publicBooking(created.ref), token: bookingToken(created.ref, asOf), url: bookingUrl(created.ref, asOf) };
}

/**
 * A booking as the guest may see it (through their signed link).
 * check: true when the guest's page is asking (GET): a payment still waiting is checked with
 * its provider first, so the answer is fresh. Throttled in services/payments.js.
 */
export async function publicBooking(ref, { check = false } = {}) {
  if (check) {
    const [row] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ref, ref));
    if (row) await checkBookingPayment(row.id);
  }
  const [b] = await db.select({ booking: bookings, room: roomTypes })
    .from(bookings).innerJoin(roomTypes, eq(roomTypes.id, bookings.roomTypeId))
    .where(eq(bookings.ref, ref));
  if (!b) return null;
  const nights = await db.select().from(bookingNights).where(eq(bookingNights.bookingId, b.booking.id)).orderBy(asc(bookingNights.night));
  const { booking: x, room } = b;
  // A HELD booking whose time ran out is EXPIRED, whether or not the job has caught up.
  const lapsed = x.status === 'HELD' && x.holdExpiresAt <= new Date();
  return {
    ref: x.ref,
    status: lapsed ? 'EXPIRED' : x.status,
    room: { slug: room.slug, name: room.name, kind: room.kind },
    checkIn: x.checkIn, checkOut: x.checkOut, nights: x.nights, guests: x.guests,
    nightly: nights.map((n) => ({ night: n.night, rateKes: n.rateKes })),
    totalKes: x.totalKes, depositKes: x.depositKes, balanceKes: x.totalKes - x.depositKes,
    holdExpiresAt: x.status === 'HELD' && !lapsed ? x.holdExpiresAt.toISOString() : null,
    // Only what confirms "this is my booking". The link may be forwarded, so no email or phone.
    guest: { firstName: x.firstName, lastName: x.lastName },
    createdAt: x.createdAt.toISOString(),
    confirmedAt: x.confirmedAt ? x.confirmedAt.toISOString() : null,
    // Phase 3: the deposit. payment is the latest attempt (null before the first);
    // refundDue means money arrived that this booking couldn't use, and the lodge owes it back.
    payment: await paymentSummary(x.id),
    refundDue: x.refundDue,
    paymentMethods: paymentMethods(),
  };
}

/** HELD bookings past their hold become EXPIRED. Run every minute while holds are open. */
export async function expireHolds(executor = db) {
  const rows = await executor.update(bookings)
    .set({ status: 'EXPIRED' })
    .where(and(eq(bookings.status, 'HELD'), lte(bookings.holdExpiresAt, sql`now()`)))
    .returning({ id: bookings.id });
  return rows.length;
}

export async function anyOpenHolds() {
  const { rows: [r] } = await db.execute(sql`select exists(select 1 from bookings where status = 'HELD') as open`);
  return r.open;
}
