// services/admin.js: what the admin screens read and change (routes/admin.js).
//
// Counting follows the booking engine EXACTLY, so the admin and the website never disagree:
//   - a booking takes its rooms while CONFIRMED, or HELD with a hold that hasn't run out, judged
//     by the database's clock (now()), never this server's (see capacity.js, withHoldRunning);
//   - nights are check_in ≤ night < check_out.
//
// Shown status (what staff see) is the stored status, refined:
//   HELD whose hold has run out → EXPIRED (the expiry job may not have caught up yet)
//   CONFIRMED and checked in    → INHOUSE
//
// Money: once a deposit is PAID the balance due is total − deposit. (Not total − amount paid:
// in the M-Pesa sandbox the prompt asks for KES 1, which would make the balance look huge.)
//
// Masking: the read-only demo admin sees guests' names, emails and phones masked (lib/mask.js).
// Every change is written to admin_events with who did it and what changed.
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import {
  bookings, bookingRooms, bookingNights, bookingActivities, activities, payments, roomTypes,
  enquiries, adminEvents, bookingEmails,
} from '../db/schema.js';
import { httpError } from '../middleware/errors.js';
import { addDays, todayInNairobi } from '../lib/dates.js';
import { lockRoomTypes } from './capacity.js';
import { maskName, maskEmail, maskPhone } from '../lib/mask.js';
import { queueBookingEmail } from './emails.js';

export const CALENDAR_DAYS = 21;

/* ── Helpers ─────────────────────────────────────────────────────────────────────────── */

/** "takes a room right now" and "shown status", as SQL over the bookings table (alias b). */
const HOLDS_ROOM = sql`(b.status = 'CONFIRMED' or (b.status = 'HELD' and b.hold_expires_at > now()))`;
/**
 * Was booking b's room in use on `night` (a SQL date)? For the calendar, which looks back as well
 * as forward. HOLDS_ROOM alone answers "is it taken now" and drops a stay once it's COMPLETED, so
 * past nights showed as free. A completed stay counts for the nights the guest actually stayed:
 * up to their check-out date, or the day they checked out if that was earlier.
 */
const occupiedOn = (night) => sql`(${HOLDS_ROOM} or (b.status = 'COMPLETED' and ${night} <
    least(b.check_out, coalesce((b.checked_out_at at time zone 'Africa/Nairobi')::date, b.check_out))))`;

const SHOWN = sql`case
    when b.status = 'HELD' and b.hold_expires_at <= now() then 'EXPIRED'
    when b.status = 'CONFIRMED' and b.checked_in_at is not null then 'INHOUSE'
    else b.status::text end`;

function guest(row, masked) {
  return masked
    ? { firstName: row.first_name ?? row.firstName, lastName: maskName(row.last_name ?? row.lastName), email: maskEmail(row.email), phone: maskPhone(row.phone) }
    : { firstName: row.first_name ?? row.firstName, lastName: row.last_name ?? row.lastName, email: row.email, phone: row.phone };
}

async function log(executor, adminId, action, bookingId, detail) {
  await executor.insert(adminEvents).values({ adminId, action, bookingId: bookingId ?? null, detail: detail ?? null });
}

/** Rooms per booking as [{ name, units }], for the given booking ids. */
async function roomsFor(ids) {
  if (!ids.length) return new Map();
  const rows = await db.select({ bookingId: bookingRooms.bookingId, name: roomTypes.name, units: bookingRooms.units, roomTypeId: roomTypes.id })
    .from(bookingRooms).innerJoin(roomTypes, eq(roomTypes.id, bookingRooms.roomTypeId))
    .where(sql`${bookingRooms.bookingId} in ${ids}`).orderBy(asc(roomTypes.sort));
  const m = new Map();
  for (const r of rows) (m.get(r.bookingId) ?? m.set(r.bookingId, []).get(r.bookingId)).push({ roomTypeId: r.roomTypeId, name: r.name, units: r.units });
  return m;
}

/** Booking rows (with shown status and deposit-paid) → the list shape every screen uses. */
async function summarise(rows, masked) {
  const rooms = await roomsFor(rows.map((r) => r.id));
  return rows.map((r) => ({
    ref: r.ref, status: r.shown, checkIn: r.check_in, checkOut: r.check_out, nights: r.nights, guests: r.guests,
    ...guest(r, masked),
    rooms: rooms.get(r.id) ?? [],
    totalKes: r.total_kes, depositKes: r.deposit_kes, depositPaid: r.deposit_paid,
    balanceKes: r.deposit_paid ? r.total_kes - r.deposit_kes : r.total_kes,
    holdExpiresAt: r.shown === 'HELD' ? new Date(r.hold_expires_at).getTime() : null,
    checkedInAt: r.checked_in_at ? new Date(r.checked_in_at).getTime() : null,
    requests: r.requests,
    refundOwed: Boolean(r.refund_owed),
  }));
}

/**
 * Money the lodge owes back on booking b: a deposit it couldn't use (refund_due: it arrived after
 * the hold ran out and the room was gone, or a second payment), or a payment of the wrong amount
 * (FLAGGED). Cleared by "Mark refund sent" (refundSent below).
 */
const REFUND_OWED = sql`(b.refund_due or exists (select 1 from payments p where p.booking_id = b.id and p.status = 'FLAGGED'))`;

const LIST_COLUMNS = sql`b.id, b.ref, b.check_in::text, b.check_out::text, b.nights, b.guests, b.first_name, b.last_name,
  b.email, b.phone, b.total_kes, b.deposit_kes, b.hold_expires_at, b.checked_in_at, b.requests, ${SHOWN} as shown,
  exists (select 1 from payments p where p.booking_id = b.id and p.status = 'PAID') as deposit_paid,
  ${REFUND_OWED} as refund_owed`;

/* ── Today ───────────────────────────────────────────────────────────────────────────── */

export async function today(masked) {
  const t = todayInNairobi();
  const { rows } = await db.execute(sql`
    select ${LIST_COLUMNS}
      from bookings b
     where (b.check_in = ${t}::date and b.status = 'CONFIRMED')                                 -- arriving
        or (b.check_out = ${t}::date and b.status = 'CONFIRMED' and b.checked_in_at is not null) -- leaving
        or (b.check_out = ${t}::date and b.status = 'COMPLETED')                                  -- left today
        or (b.status = 'CONFIRMED' and b.checked_in_at is not null)                               -- in house
        or (b.status = 'HELD' and b.hold_expires_at > now())                                      -- holds
     order by b.check_in, b.created_at`);
  const all = await summarise(rows, masked);
  const occ = await occupancy(t, addDays(t, 1));
  const tonight = occ.reduce((s, r) => ({ open: s.open + r.nights[0].open, taken: s.taken + r.nights[0].taken }), { open: 0, taken: 0 });
  const [{ n: newEnquiries }] = (await db.execute(sql`select count(*)::int as n from enquiries where status = 'NEW'`)).rows;
  const refunds = await refundsOwed();
  return {
    date: t,
    arrivals: all.filter((b) => b.checkIn === t && (b.status === 'CONFIRMED' || b.status === 'INHOUSE')),
    departures: all.filter((b) => b.checkOut === t && (b.status === 'INHOUSE' || b.status === 'COMPLETED')),
    inHouse: { bookings: all.filter((b) => b.status === 'INHOUSE').length,
               rooms: all.filter((b) => b.status === 'INHOUSE').reduce((n, b) => n + b.rooms.reduce((m, r) => m + r.units, 0), 0),
               guests: all.filter((b) => b.status === 'INHOUSE').reduce((n, b) => n + b.guests, 0) },
    holds: all.filter((b) => b.status === 'HELD').sort((a, b) => a.holdExpiresAt - b.holdExpiresAt),
    tonight,
    newEnquiries,
    refunds,
  };
}

/* ── Bookings ────────────────────────────────────────────────────────────────────────── */

export const LIST_FILTERS = ['upcoming', 'inhouse', 'held', 'past', 'cancelled', 'refunds', 'all'];

/** How many bookings have money to send back. Today's notice and the Refunds tab. */
export async function refundsOwed() {
  const { rows: [{ n }] } = await db.execute(sql`select count(*)::int as n from bookings b where ${REFUND_OWED}`);
  return n;
}

export async function listBookings({ q, status = 'upcoming', room }, masked) {
  const t = todayInNairobi();
  const where = {
    upcoming: sql`${SHOWN} in ('CONFIRMED', 'HELD') and b.check_out > ${t}::date`,
    inhouse: sql`${SHOWN} = 'INHOUSE'`,
    held: sql`${SHOWN} = 'HELD'`,
    past: sql`b.status = 'COMPLETED'`,
    cancelled: sql`${SHOWN} in ('CANCELLED', 'EXPIRED')`,
    refunds: REFUND_OWED,
    all: sql`true`,
  }[status];
  // Search: reference, names, email or phone. The demo admin can't search by the hidden fields.
  const like = q ? `%${q.toLowerCase().replace(/[%_\\]/g, '\\$&')}%` : null;
  const search = !q ? sql`true` : masked
    ? sql`(lower(b.ref) like ${like} or lower(b.first_name) like ${like})`
    : sql`(lower(b.ref) like ${like} or lower(b.first_name || ' ' || b.last_name) like ${like}
           or lower(b.email) like ${like} or b.phone like ${like})`;
  const roomFilter = room ? sql`exists (select 1 from booking_rooms br where br.booking_id = b.id and br.room_type_id = ${room})` : sql`true`;
  const order = status === 'upcoming' || status === 'held' || status === 'inhouse' || status === 'refunds' ? sql`b.check_in asc, b.created_at` : sql`b.check_in desc, b.created_at desc`;
  const { rows } = await db.execute(sql`
    select ${LIST_COLUMNS} from bookings b
     where ${where} and ${search} and ${roomFilter}
     order by ${order} limit 200`);
  return summarise(rows, masked);
}

export async function bookingDetail(ref, masked) {
  const { rows: [b] } = await db.execute(sql`select ${LIST_COLUMNS}, b.created_at, b.confirmed_at, b.cancelled_at, b.checked_out_at,
      b.cancel_reason, b.refund_due from bookings b where b.ref = ${ref}`);
  if (!b) return null;
  const [summary] = await summarise([b], masked);
  const [nights, trips, pays, events, emails] = await Promise.all([
    db.select({ roomTypeId: bookingNights.roomTypeId, night: bookingNights.night, rateKes: bookingNights.rateKes })
      .from(bookingNights).where(eq(bookingNights.bookingId, b.id)).orderBy(asc(bookingNights.night)),
    db.select({ name: activities.name, day: bookingActivities.day, time: bookingActivities.departs, people: bookingActivities.people, priceKes: bookingActivities.priceKes })
      .from(bookingActivities).innerJoin(activities, eq(activities.id, bookingActivities.activityId))
      .where(eq(bookingActivities.bookingId, b.id)).orderBy(asc(bookingActivities.day), asc(bookingActivities.departs)),
    db.select().from(payments).where(eq(payments.bookingId, b.id)).orderBy(asc(payments.createdAt)),
    db.execute(sql`select e.action, e.detail, e.created_at, a.name as admin from admin_events e left join admins a on a.id = e.admin_id
                    where e.booking_id = ${b.id} order by e.created_at`),
    db.select().from(bookingEmails).where(eq(bookingEmails.bookingId, b.id)),
  ]);
  const ms = (d) => (d ? new Date(d).getTime() : null);
  const history = [{ what: 'Booked online', at: ms(b.created_at) }];
  for (const p of pays) {
    if (p.status === 'PAID') history.push({ what: `Deposit paid · ${p.provider === 'DARAJA' ? 'M-Pesa' : 'Card'}`, at: ms(p.updatedAt) });
    if (p.status === 'FLAGGED' || p.status === 'REFUNDED') history.push({ what: `Payment of the wrong amount · ${p.provider === 'DARAJA' ? 'M-Pesa' : 'Card'}`, at: ms(p.createdAt) });
  }
  const WORDS = { 'check-in': 'Checked in', 'check-out': 'Checked out', cancel: 'Cancelled', 'refund-sent': 'Refund sent' };
  for (const e of events.rows) {
    history.push({ what: (WORDS[e.action] ?? e.action) + (e.action === 'cancel' && e.detail?.reason ? ` · ${e.detail.reason}` : ''), by: e.admin, at: ms(e.created_at) });
  }
  // What the guest (and the lodge) were emailed, and whether it actually went out
  const EMAILED = { confirmed: 'Confirmation emailed to the guest', cancelled: 'Cancellation emailed to the guest',
    expired: '“Hold ended” emailed to the guest', lodge_booking: 'Lodge alerted by email',
    lodge_refund: 'Lodge alerted: refund due', lodge_flagged: 'Lodge alerted: payment of the wrong amount' };
  const OUTCOME = { sent: '', held: ' · held: no email domain yet', logged: ' · not sent: email isn’t set up', failed: ' · failed to send', queued: ' · sending' };
  for (const m of emails) history.push({ what: (EMAILED[m.kind] ?? m.kind) + (OUTCOME[m.status] ?? ` · ${m.status}`), at: ms(m.createdAt) });
  if (summary.status === 'HELD') history.push({ what: 'Hold runs out', at: summary.holdExpiresAt });
  if (summary.status === 'EXPIRED') history.push({ what: 'Hold ran out unpaid', at: ms(b.hold_expires_at) });
  history.sort((x, y) => x.at - y.at);

  return {
    ...summary,
    rooms: summary.rooms.map((r) => {
      const n = nights.filter((x) => x.roomTypeId === r.roomTypeId).map((x) => ({ night: x.night, rateKes: x.rateKes }));
      return { ...r, nightly: n, totalKes: r.units * n.reduce((s, x) => s + x.rateKes, 0) };
    }),
    activities: trips.map((x) => ({ ...x, totalKes: x.people * x.priceKes })),
    payments: pays.filter((p) => ['PAID', 'FLAGGED', 'REFUNDED'].includes(p.status)).map((p) => ({
      provider: p.provider === 'DARAJA' ? 'M-Pesa' : 'Card', status: p.status, receipt: p.receipt, amountKes: p.amountKes,
      receivedKes: p.receivedKes, at: ms(p.updatedAt),
    })),
    history,
    cancelReason: b.cancel_reason, refundDue: b.refund_due,
    createdAt: ms(b.created_at), confirmedAt: ms(b.confirmed_at), checkedOutAt: ms(b.checked_out_at),
    canCheckIn: summary.status === 'CONFIRMED' && summary.checkIn <= todayInNairobi() && summary.checkOut > todayInNairobi(),
    canCheckOut: summary.status === 'INHOUSE',
    canCancel: summary.status === 'CONFIRMED' || summary.status === 'HELD',
    refundOwed: summary.refundOwed,
  };
}

/**
 * The three daily actions. Each locks the booking row, re-reads it, and changes it only from the
 * state the button was shown in (so two receptionists clicking at once can't both act).
 */
async function act(ref, adminId, action, change) {
  return db.transaction(async (tx) => {
    const [b] = await tx.select({ id: bookings.id, status: bookings.status, checkIn: bookings.checkIn, checkOut: bookings.checkOut,
      checkedInAt: bookings.checkedInAt, holdRunning: sql`(${bookings.status} = 'HELD' and ${bookings.holdExpiresAt} > now())`.mapWith(Boolean) })
      .from(bookings).where(eq(bookings.ref, ref)).for('update');
    if (!b) throw httpError(404, 'Booking not found.');
    const set = change(b);
    await tx.update(bookings).set(set.columns).where(eq(bookings.id, b.id));
    await log(tx, adminId, action, b.id, set.detail);
    return ref;
  });
}

export function checkIn(ref, adminId) {
  return act(ref, adminId, 'check-in', (b) => {
    const t = todayInNairobi();
    if (b.status !== 'CONFIRMED' || b.checkedInAt) throw httpError(409, 'Only a confirmed booking that hasn’t arrived yet can be checked in.');
    if (b.checkIn > t) throw httpError(409, `This stay starts on ${b.checkIn}. Check-in opens that day.`);
    if (b.checkOut <= t) throw httpError(409, 'This stay has already ended.');
    return { columns: { checkedInAt: new Date() } };
  });
}

export function checkOut(ref, adminId) {
  return act(ref, adminId, 'check-out', (b) => {
    if (b.status !== 'CONFIRMED' || !b.checkedInAt) throw httpError(409, 'Only a guest who is in house can be checked out.');
    // COMPLETED stops holding rooms, so an early departure frees the remaining nights for sale.
    return { columns: { status: 'COMPLETED', checkedOutAt: new Date() } };
  });
}

export async function cancel(ref, adminId, reason) {
  let bookingId;
  await act(ref, adminId, 'cancel', (b) => {
    bookingId = b.id;
    if (!(b.status === 'CONFIRMED' && !b.checkedInAt) && !b.holdRunning) {
      throw httpError(409, 'Only a held or confirmed booking that hasn’t arrived can be cancelled.');
    }
    // Never refunds by itself: the lodge refunds a deposit from M-Pesa/Paystack per its policy.
    return { columns: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason, holdExpiresAt: null }, detail: { reason } };
  });
  queueBookingEmail(bookingId, 'cancelled');     // after the commit: the guest gets the reason
  return ref;
}

/**
 * "Mark refund sent": the lodge has sent back money it owed on this booking (from M-Pesa or
 * Paystack, outside this system). Clears refund_due and marks wrong-amount payments REFUNDED,
 * so the booking leaves Today's notice and the Refunds tab. Logged with who did it.
 */
export async function refundSent(ref, adminId) {
  return db.transaction(async (tx) => {
    const [x] = await tx.select({ id: bookings.id }).from(bookings).where(eq(bookings.ref, ref));
    if (!x) throw httpError(404, 'Booking not found.');
    // Lock order: payment → booking (as markPaid does), so the two can never deadlock
    const flagged = await tx.select({ id: payments.id }).from(payments)
      .where(and(eq(payments.bookingId, x.id), eq(payments.status, 'FLAGGED'))).for('update');
    const [b] = await tx.select({ id: bookings.id, refundDue: bookings.refundDue }).from(bookings).where(eq(bookings.id, x.id)).for('update');
    if (!b.refundDue && !flagged.length) throw httpError(409, 'Nothing is owed on this booking.');
    await tx.update(bookings).set({ refundDue: false }).where(eq(bookings.id, b.id));
    if (flagged.length) {
      await tx.update(payments).set({ status: 'REFUNDED', updatedAt: new Date() })
        .where(and(eq(payments.bookingId, b.id), eq(payments.status, 'FLAGGED')));
    }
    await log(tx, adminId, 'refund-sent', b.id, { lateDeposit: b.refundDue, wrongAmountPayments: flagged.length });
    return ref;
  });
}

/* ── Calendar ────────────────────────────────────────────────────────────────────────── */

/**
 * Per active room type, per night in [from, to): units, taken and free.
 * The same counting as availability.js, per night instead of the minimum over a stay.
 */
export async function occupancy(from, to) {
  const { rows } = await db.execute(sql`
    with nights as (select generate_series(${from}::date, ${to}::date - 1, interval '1 day')::date as night)
    select rt.id, rt.name, rt.units, rt.sort, nights.night::text as night, taken.n as taken
      from room_types rt cross join nights
     cross join lateral (
       select coalesce(sum(br.units), 0)::int as n from booking_rooms br join bookings b on b.id = br.booking_id
        where br.room_type_id = rt.id and b.check_in <= nights.night and b.check_out > nights.night and ${occupiedOn(sql`nights.night`)}) taken
     where rt.active
     order by rt.sort, rt.id, nights.night`);
  const types = new Map();
  for (const r of rows) {
    const t = types.get(r.id) ?? types.set(r.id, { id: r.id, name: r.name, units: r.units, nights: [] }).get(r.id);
    t.nights.push({ night: r.night, taken: r.taken, open: r.units, free: Math.max(0, r.units - r.taken) });
  }
  return [...types.values()];
}

export async function calendar(from = todayInNairobi()) {
  const to = addDays(from, CALENDAR_DAYS);
  const rooms = await occupancy(from, to);
  return { from, days: CALENDAR_DAYS, today: todayInNairobi(), rooms };
}

export async function night(date, roomTypeId, masked) {
  const [rt] = await db.select().from(roomTypes).where(eq(roomTypes.id, roomTypeId));
  if (!rt) return null;
  const { rows } = await db.execute(sql`
    select ${LIST_COLUMNS}, br.units as units_here from bookings b join booking_rooms br on br.booking_id = b.id
     where br.room_type_id = ${roomTypeId} and b.check_in <= ${date}::date and b.check_out > ${date}::date and ${occupiedOn(sql`${date}::date`)}
     order by b.check_in`);
  const list = await summarise(rows, masked);
  const [occ] = (await occupancy(date, addDays(date, 1))).filter((r) => r.id === roomTypeId);
  return { date, room: { id: rt.id, name: rt.name, units: rt.units }, free: occ?.nights[0].free ?? 0,
    bookings: list.map((b, i) => ({ ...b, unitsHere: rows[i].units_here })) };
}

/* ── Rooms & rates ───────────────────────────────────────────────────────────────────── */

export async function listRooms() {
  const t = todayInNairobi();
  const occ = new Map((await occupancy(t, addDays(t, 1))).map((r) => [r.id, r.nights[0].free]));
  const rows = await db.select().from(roomTypes).orderBy(asc(roomTypes.sort), asc(roomTypes.id));
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, kind: r.kind, sleeps: r.sleeps, units: r.units,
    baseRateKes: r.baseRateKes, active: r.active, freeTonight: r.active ? occ.get(r.id) ?? 0 : null }));
}

/**
 * Change a room type's base rate, units or "bookable". The units rule: never below the rooms
 * already booked on any night from today on. The room type is locked first (the same lock a
 * new booking takes), so no booking can slip in between the check and the change.
 */
export async function updateRoom(id, change, adminId) {
  return db.transaction(async (tx) => {
    const [rt] = await lockRoomTypes(tx, [id]);
    if (!rt) throw httpError(404, 'Room type not found.');
    if (change.units !== undefined && change.units < rt.units) {
      const { rows: [busiest] } = await tx.execute(sql`
        select n.night::date::text as night, coalesce(sum(br.units), 0)::int as taken
          from bookings b join booking_rooms br on br.booking_id = b.id
          cross join lateral generate_series(greatest(b.check_in, ${todayInNairobi()}::date), b.check_out - 1, interval '1 day') as n(night)
         where br.room_type_id = ${id} and b.check_out > ${todayInNairobi()}::date and ${HOLDS_ROOM}
         group by n.night order by taken desc, n.night limit 1`);
      if (busiest && busiest.taken > change.units) {
        throw httpError(409, `${rt.name}: ${busiest.taken} rooms are booked on ${busiest.night}, so units can’t go below ${busiest.taken}.`);
      }
    }
    const before = { baseRateKes: rt.baseRateKes, units: rt.units, active: rt.active };
    const [after] = await tx.update(roomTypes).set(change).where(eq(roomTypes.id, id)).returning();
    await log(tx, adminId, 'room.update', null, { roomTypeId: id, before, after: { baseRateKes: after.baseRateKes, units: after.units, active: after.active } });
    return after;
  });
}

/* ── Experiences ─────────────────────────────────────────────────────────────────────── */

export const DEPARTURE_DAYS = 14;

/**
 * Upcoming departures with who's on them, for staff to arrange vehicles. A booking counts while
 * it holds its rooms (confirmed, or held and not yet lapsed), exactly like rooms do. Seats are
 * one vehicle's seats: never a limit for guests, only "how many vehicles" for staff.
 */
export async function departures(from, masked) {
  const to = addDays(from, DEPARTURE_DAYS);
  const { rows } = await db.execute(sql`
    select ba.activity_id, a.name, a.seats, ba.day::text as day, ba.departs, ba.people,
           b.ref, b.first_name, b.last_name, b.email, b.phone, ${SHOWN} as shown
      from booking_activities ba
      join bookings b on b.id = ba.booking_id
      join activities a on a.id = ba.activity_id
     where ba.day >= ${from}::date and ba.day < ${to}::date and ${HOLDS_ROOM}
     order by ba.day, ba.departs, a.sort, b.ref`);
  const out = [];
  for (const r of rows) {
    let d = out.at(-1);
    if (!d || d.day !== r.day || d.time !== r.departs || d.activityId !== r.activity_id) {
      d = { day: r.day, time: r.departs, activityId: r.activity_id, name: r.name, seats: r.seats, people: 0, bookings: [] };
      out.push(d);
    }
    d.people += r.people;
    const g = guest(r, masked);
    d.bookings.push({ ref: r.ref, status: r.shown, firstName: g.firstName, lastName: g.lastName, phone: g.phone, people: r.people });
  }
  for (const d of out) d.vehicles = Math.ceil(d.people / d.seats);
  return { from, days: DEPARTURE_DAYS, today: todayInNairobi(), departures: out };
}

const tripShape = (a) => ({ id: a.id, slug: a.slug, name: a.name, durationMinutes: a.durationMinutes, priceKes: a.priceKes,
  seats: a.seats, departureTimes: a.departureTimes, active: a.active });

export async function listTrips() {
  return (await db.select().from(activities).orderBy(asc(activities.sort), asc(activities.id))).map(tripShape);
}

/**
 * Changes a trip. Price changes apply to new bookings only (each booking froze its price).
 * Every trip runs daily (the lodge's choice, Oct 2026). Removing a departure time doesn't touch existing bookings: they keep their slot and
 * still show in the departures list. The answer says how many are on a slot that no longer
 * runs, so staff can contact those guests.
 */
export async function updateTrip(id, change, adminId) {
  return db.transaction(async (tx) => {
    const [a] = await tx.select().from(activities).where(eq(activities.id, id)).for('update');
    if (!a) throw httpError(404, 'Experience not found.');
    const [after] = await tx.update(activities).set(change).where(eq(activities.id, id)).returning();
    const { rows: [{ n }] } = await tx.execute(sql`
      select count(*)::int as n from booking_activities ba join bookings b on b.id = ba.booking_id
       where ba.activity_id = ${id} and ba.day >= ${todayInNairobi()}::date and ${HOLDS_ROOM}
         -- Arrays go in as text: Drizzle would expand a JS array into separate values
         and (not (ba.departs = any(string_to_array(${after.departureTimes.join(',')}, ',')))
              or not ${after.active})`);
    await log(tx, adminId, 'activity.update', null, { activityId: id, before: tripShape(a), after: tripShape(after) });
    return { trip: tripShape(after), offSchedule: n };
  });
}

/* ── Enquiries ───────────────────────────────────────────────────────────────────────── */

// The database keeps NEW / REPLIED / CLOSED; the admin shows NEW or HANDLED.
const shownEnquiry = (s) => (s === 'NEW' ? 'NEW' : 'HANDLED');

export async function listEnquiries(masked) {
  const rows = await db.select().from(enquiries).orderBy(desc(enquiries.createdAt)).limit(200);
  return rows.map((e) => ({
    id: e.id, ...guest(e, masked), subject: e.subject, message: e.message,
    checkIn: e.checkIn, checkOut: e.checkOut, guests: e.guests, status: shownEnquiry(e.status), createdAt: e.createdAt.getTime(),
  }));
}

export async function setEnquiryStatus(id, shown, adminId) {
  const [row] = await db.update(enquiries).set({ status: shown === 'NEW' ? 'NEW' : 'CLOSED' }).where(eq(enquiries.id, id)).returning();
  if (!row) throw httpError(404, 'Enquiry not found.');
  await log(db, adminId, 'enquiry.' + (shown === 'NEW' ? 'reopen' : 'handled'), null, { enquiryId: id });
  return shownEnquiry(row.status);
}
