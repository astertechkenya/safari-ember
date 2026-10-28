// bookings.js: searching, holding and reading bookings.
//
// THE OVERBOOKING PROBLEM, and how it's solved
// Two guests want the Ember Penthouse (1 unit) for the same night and press "Book" in the same
// second. Done naively, both requests check availability, both see "1 free", both insert: the
// lodge has sold one penthouse twice.
// Fix: inside one transaction, LOCK the room type's row first (SELECT … FOR UPDATE), then
// count, then insert. Postgres lets only one transaction hold that lock; the second waits at
// the lock until the first commits, then counts again, now seeing the first guest's booking,
// and finds 0 free. Only bookings sharing a room type (or an activity departure) wait for each
// other; a Hearthside booking never waits on a Penthouse one. test/bookings.test.js fires
// simultaneous bookings at a last unit to prove exactly one wins.
//
// A booking can hold several room types and activities, so it takes several locks, always in
// the same order to avoid deadlocks: see services/capacity.js.
//
// Why the count is fresh after waiting: Postgres' default isolation (READ COMMITTED) takes a
// new snapshot for every statement, so the count that runs after the lock sees everything
// committed before the lock was granted.
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { roomTypes, bookings, bookingNights, bookingRooms, bookingActivities, activities } from '../db/schema.js';
import { config } from '../config.js';
import { httpError } from '../middleware/errors.js';
import { freeUnits } from './availability.js';
import { checkBookingPayment, paymentSummary, paymentMethods } from './payments.js';
import { quote, priceNights, quoteBooking } from './pricing.js';
import { lockRoomTypes, shortfall, withHoldRunning } from './capacity.js';
import { tripDays, weekdayOf, bookable } from './activities.js';
import { newRef } from '../lib/ref.js';
import { bookingToken, bookingUrl } from '../lib/bookingLink.js';
import { daysBetween } from '../lib/dates.js';
import { queueBookingEmail } from './emails.js';

const roomCard = (rt) => ({ slug: rt.slug, name: rt.name, kind: rt.kind, description: rt.description, sleeps: rt.sleeps });

/** The rooms list for the site: every active type with its nightly price. */
export async function listRooms() {
  const types = await db.select().from(roomTypes).where(eq(roomTypes.active, true)).orderBy(asc(roomTypes.sort), asc(roomTypes.id));
  return types.map((rt) => ({ ...roomCard(rt), fromKes: rt.baseRateKes }));
}

/**
 * The most guests `maxRooms` rooms could sleep, given what's free. Choosing the biggest rooms
 * first gives the most beds for a fixed number of rooms, so this is the true maximum.
 */
export function largestParty(types, maxRooms) {
  let rooms = maxRooms, beds = 0;
  for (const t of [...types].sort((a, b) => b.sleeps - a.sleeps)) {
    const take = Math.min(t.free, rooms);
    beds += take * t.sleeps; rooms -= take;
    if (!rooms) break;
  }
  return beds;
}

/** The availability search: every active room type, how many can be booked, and its price per room. */
export async function search({ checkIn, checkOut, guests }) {
  const types = await db.select().from(roomTypes).where(eq(roomTypes.active, true)).orderBy(asc(roomTypes.sort), asc(roomTypes.id));
  const free = await freeUnits({ checkIn, checkOut });
  const rooms = types.map((rt) => {
    const left = free.get(rt.id) ?? 0;
    return {
      ...roomCard(rt),
      available: left > 0,
      // How many of this type the guest may choose (the counter's maximum): never more than one
      // booking may take, so the exact stock isn't revealed beyond MAX_ROOMS.
      maxUnits: Math.min(left, config.MAX_ROOMS),
      // Exact count only when it's low (FEW_LEFT): "only 2 left" helps the guest decide, but the
      // lodge doesn't advertise how empty it is the rest of the time.
      left: left > 0 && left <= config.FEW_LEFT ? left : null,
      ...quote(rt, checkIn, checkOut, config.DEPOSIT_PERCENT),   // for ONE room
    };
  });
  return {
    checkIn, checkOut, guests,
    nights: daysBetween(checkIn, checkOut),
    maxRooms: config.MAX_ROOMS,
    rooms,
    // false: even the best mix of free rooms (up to MAX_ROOMS) can't sleep this party. The site
    // points them to the enquiry form.
    partyFits: largestParty(types.map((t) => ({ sleeps: t.sleeps, free: free.get(t.id) ?? 0 })), config.MAX_ROOMS) >= guests,
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Hold rooms (and any activities) while the guest pays the deposit. See the top of this file and
 * services/capacity.js for the locking. Rules (docs/BLUEPRINT.md):
 *   rooms       one or more types, at most MAX_ROOMS units in all, sleeping the whole party
 *   activities  on a day from check-in to check-out, on a weekday and at a time the trip runs,
 *               at least ACTIVITY_CUTOFF_MINUTES ahead, for 1 to `guests` people
 * `afterCount` is for tests only: it pauses between counting and inserting, the exact moment two
 * guests could collide, so the test can force the race instead of hoping it happens.
 * @returns { booking, token, url }
 */
export async function createHold({ rooms, activities: trips = [], checkIn, checkOut, guests, firstName, lastName, email, phone, requests }, { afterCount } = {}) {
  const created = await db.transaction(async (tx) => {
    // 1. Find and lock the room types, in id order.
    const wanted = await tx.select({ id: roomTypes.id, slug: roomTypes.slug }).from(roomTypes)
      .where(and(inArray(roomTypes.slug, rooms.map((r) => r.room)), eq(roomTypes.active, true)));
    if (wanted.length !== rooms.length) throw httpError(404, 'One of those rooms is not available to book');
    const types = await lockRoomTypes(tx, wanted.map((w) => w.id), { activeOnly: true });
    if (types.length !== rooms.length) throw httpError(404, 'One of those rooms is not available to book');
    const typeBySlug = new Map(types.map((t) => [t.slug, t]));
    const lines = rooms.map((r) => ({ roomType: typeBySlug.get(r.room), units: r.units }));

    const beds = lines.reduce((sum, l) => sum + l.units * l.roomType.sleeps, 0);
    if (guests > beds) throw httpError(400, `Those rooms sleep ${beds} at most, for ${plural(guests, 'guest')}. Please add a room.`);

    // 2. The activities: check each against its schedule. No seat count: the lodge arranges
    //    vehicles for however many come (services/activities.js), so there's nothing to lock.
    const tripList = [];
    if (trips.length) {
      const found = await tx.select().from(activities)
        .where(and(inArray(activities.slug, [...new Set(trips.map((t) => t.activity))]), eq(activities.active, true)));
      const bySlug = new Map(found.map((a) => [a.slug, a]));
      const days = tripDays(checkIn, checkOut);
      for (const t of trips) {
        const a = bySlug.get(t.activity);
        if (!a) throw httpError(404, 'One of those activities is not available to book');
        if (!days.includes(t.day)) throw httpError(400, `${a.name} must be on a day of your stay`);
        if (!a.weekdays.includes(weekdayOf(t.day)) || !a.departureTimes.includes(t.time)) {
          throw httpError(400, `${a.name} doesn’t leave at ${t.time} on ${t.day}`);
        }
        if (!bookable(t.day, t.time)) throw httpError(400, `${a.name} at ${t.time} on ${t.day} is too soon to book. Please choose a later departure.`);
        if (t.people > guests) throw httpError(400, `${a.name}: at most ${plural(guests, 'guest')}, the size of your party`);
        tripList.push({ activity: a, day: t.day, departs: t.time, people: t.people });
      }
    }

    // 3. Count, now that nobody else can take these rooms until we're done.
    const short = await shortfall(tx, { checkIn, checkOut, rooms: lines });
    if (short) throw httpError(409, `${short} Please choose other dates or rooms.`);
    if (afterCount) await afterCount();

    // 4. Price it, from the rates as they are right now.
    for (const l of lines) l.nightly = priceNights(l.roomType, checkIn, checkOut);
    const q = quoteBooking({
      rooms: lines, activities: tripList.map((t) => ({ people: t.people, priceKes: t.activity.priceKes })),
      depositPercent: config.DEPOSIT_PERCENT,
    });

    // 5. Insert with a fresh reference. A repeated reference (about 1 in 887 million per pair)
    //    is skipped by ON CONFLICT and simply retried with a new one.
    let row;
    for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
      [row] = await tx.insert(bookings).values({
        ref: newRef(), checkIn, checkOut, nights: daysBetween(checkIn, checkOut), guests,
        totalKes: q.totalKes, depositKes: q.depositKes, status: 'HELD',
        holdExpiresAt: sql`now() + make_interval(mins => ${config.HOLD_MINUTES})`,
        firstName, lastName, email, phone, requests: requests || null,
      }).onConflictDoNothing({ target: bookings.ref }).returning();
    }
    if (!row) throw new Error('could not find an unused booking reference');
    await tx.insert(bookingRooms).values(lines.map((l) => ({ bookingId: row.id, roomTypeId: l.roomType.id, units: l.units })));
    await tx.insert(bookingNights).values(lines.flatMap((l) => l.nightly.map((n) => ({
      bookingId: row.id, roomTypeId: l.roomType.id, night: n.night, rateKes: n.rateKes,
    }))));
    if (tripList.length) {
      await tx.insert(bookingActivities).values(tripList.map((t) => ({
        bookingId: row.id, activityId: t.activity.id, day: t.day, departs: t.departs, people: t.people, priceKes: t.activity.priceKes,
      })));
    }
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
  const [x] = await db.select({ id: bookings.id }).from(bookings).where(eq(bookings.ref, ref));
  if (!x) return null;
  if (check) await checkBookingPayment(x.id);
  const [b] = await db.select(withHoldRunning).from(bookings).where(eq(bookings.id, x.id));

  const [roomRows, nights, trips] = await Promise.all([
    db.select({ line: bookingRooms, room: roomTypes }).from(bookingRooms)
      .innerJoin(roomTypes, eq(roomTypes.id, bookingRooms.roomTypeId))
      .where(eq(bookingRooms.bookingId, b.id)).orderBy(asc(roomTypes.sort), asc(roomTypes.id)),
    db.select().from(bookingNights).where(eq(bookingNights.bookingId, b.id)).orderBy(asc(bookingNights.night)),
    db.select({ trip: bookingActivities, activity: activities }).from(bookingActivities)
      .innerJoin(activities, eq(activities.id, bookingActivities.activityId))
      .where(eq(bookingActivities.bookingId, b.id)).orderBy(asc(bookingActivities.day), asc(bookingActivities.departs)),
  ]);
  const roomList = roomRows.map(({ line, room }) => {
    const nightly = nights.filter((n) => n.roomTypeId === room.id).map((n) => ({ night: n.night, rateKes: n.rateKes }));
    return {
      slug: room.slug, name: room.name, kind: room.kind, units: line.units, nightly,
      totalKes: line.units * nightly.reduce((s, n) => s + n.rateKes, 0),
    };
  });
  const tripList = trips.map(({ trip, activity }) => ({
    slug: activity.slug, name: activity.name, durationMinutes: activity.durationMinutes,
    day: trip.day, time: trip.departs, people: trip.people, priceKes: trip.priceKes, totalKes: trip.people * trip.priceKes,
  }));

  // A HELD booking whose time ran out is EXPIRED, whether or not the job has caught up.
  // "Ran out" is decided by the DATABASE's clock (holdRunning), never this server's: see withHoldRunning in capacity.js.
  const lapsed = b.status === 'HELD' && !b.holdRunning;
  return {
    ref: b.ref,
    status: lapsed ? 'EXPIRED' : b.status,
    checkIn: b.checkIn, checkOut: b.checkOut, nights: b.nights, guests: b.guests,
    rooms: roomList,
    activities: tripList,
    roomsKes: roomList.reduce((s, r) => s + r.totalKes, 0),
    activitiesKes: tripList.reduce((s, t) => s + t.totalKes, 0),
    totalKes: b.totalKes, depositKes: b.depositKes, balanceKes: b.totalKes - b.depositKes,
    holdExpiresAt: b.status === 'HELD' && !lapsed ? b.holdExpiresAt.toISOString() : null,
    // Only what confirms "this is my booking". The link may be forwarded, so no email or phone.
    guest: { firstName: b.firstName, lastName: b.lastName },
    createdAt: b.createdAt.toISOString(),
    confirmedAt: b.confirmedAt ? b.confirmedAt.toISOString() : null,
    // Phase 3: the deposit. payment is the latest attempt (null before the first);
    // refundDue means money arrived that this booking couldn't use, and the lodge owes it back.
    payment: await paymentSummary(b.id),
    refundDue: b.refundDue,
    // Why the lodge cancelled (Phase 5), shown on the guest's page until guest emails exist
    cancelReason: b.status === 'CANCELLED' ? b.cancelReason ?? null : null,
    paymentMethods: paymentMethods(),
  };
}

/** HELD bookings past their hold become EXPIRED. Run every minute while holds are open. */
export async function expireHolds(executor = db) {
  const rows = await executor.update(bookings)
    .set({ status: 'EXPIRED' })
    .where(and(eq(bookings.status, 'HELD'), lte(bookings.holdExpiresAt, sql`now()`)))
    .returning({ id: bookings.id });
  // Each guest whose hold just ran out is told (once: emails.js), after the update has committed.
  for (const r of rows) queueBookingEmail(r.id, 'expired');
  return rows.length;
}

export async function anyOpenHolds() {
  const { rows: [r] } = await db.execute(sql`select exists(select 1 from bookings where status = 'HELD') as open`);
  return r.open;
}
