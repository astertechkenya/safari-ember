// schema.js: every table, in one place. drizzle-kit reads this to write the SQL migrations in
// api/drizzle/ (npm run db:generate). docs/BLUEPRINT.md explains the model in plain words.
//
// Two conventions throughout:
//   - Stay dates are Postgres `date`s, handled as 'YYYY-MM-DD' strings (mode: 'string'). A date
//     has no time zone, so nothing can shift a stay by a day between Nairobi, Render and Neon.
//   - Money is whole Kenyan shillings in integer columns ending in _kes. Never floats.
//
// The database enforces the rules it can (CHECK constraints), so even a bug in the API can't
// store an impossible row: a check-out before check-in, a negative price, an unknown status.
import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, serial, integer, text, varchar, date, timestamp, boolean, index, uniqueIndex, check, primaryKey,
  uuid, jsonb,
} from 'drizzle-orm/pg-core';

// ── Rooms ──────────────────────────────────────────────────────────────────────────────────
// A room TYPE with a number of identical units. Guests book a type; the lodge assigns the
// actual room at check-in. Availability is then just a count per night.
export const roomTypes = pgTable('room_types', {
  id: serial().primaryKey(),
  slug: varchar({ length: 60 }).notNull(),            // 'hearthside-room': stable, used by the site
  name: varchar({ length: 100 }).notNull(),           // 'Hearthside Room'
  kind: varchar({ length: 40 }).notNull(),            // 'Deluxe', 'Junior Suite', 'Penthouse'
  description: text().notNull(),
  sleeps: integer().notNull(),                        // most guests in one unit
  units: integer().notNull(),                         // how many identical rooms of this type
  baseRateKes: integer().notNull(),                   // per night, when no seasonal rate applies
  sort: integer().notNull().default(0),               // display order
  active: boolean().notNull().default(true),          // inactive types can't be booked or shown
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('room_types_slug_key').on(t.slug),
  check('room_types_sleeps_check', sql`${t.sleeps} between 1 and 20`),
  check('room_types_units_check', sql`${t.units} >= 0`),
  check('room_types_rate_check', sql`${t.baseRateKes} > 0`),
]);

// A different nightly price for some dates (migration season, festive season…).
// [startsOn, endsOn) like a stay: endsOn itself is NOT included.
// If two seasons overlap on a night, the one starting later wins (it's the more specific one).
export const seasonalRates = pgTable('seasonal_rates', {
  id: serial().primaryKey(),
  roomTypeId: integer().notNull().references(() => roomTypes.id, { onDelete: 'cascade' }),
  label: varchar({ length: 80 }).notNull(),           // 'Migration season'
  startsOn: date({ mode: 'string' }).notNull(),
  endsOn: date({ mode: 'string' }).notNull(),
  nightlyRateKes: integer().notNull(),
}, (t) => [
  index('seasonal_rates_room_idx').on(t.roomTypeId, t.startsOn),
  check('seasonal_rates_dates_check', sql`${t.endsOn} > ${t.startsOn}`),
  check('seasonal_rates_rate_check', sql`${t.nightlyRateKes} > 0`),
]);

// Units taken out of sale for some nights: maintenance, a private event, the lodge closed.
// roomTypeId null = every room type. units null = all units of the type(s).
export const closures = pgTable('closures', {
  id: serial().primaryKey(),
  roomTypeId: integer().references(() => roomTypes.id, { onDelete: 'cascade' }),
  startsOn: date({ mode: 'string' }).notNull(),
  endsOn: date({ mode: 'string' }).notNull(),
  units: integer(),
  reason: varchar({ length: 200 }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('closures_dates_idx').on(t.startsOn, t.endsOn),
  check('closures_dates_check', sql`${t.endsOn} > ${t.startsOn}`),
  check('closures_units_check', sql`${t.units} is null or ${t.units} > 0`),
]);

// ── Bookings ───────────────────────────────────────────────────────────────────────────────
//   HELD       a unit is held while the guest pays the deposit (until holdExpiresAt)
//   CONFIRMED  deposit paid (Phase 3)
//   EXPIRED    the hold ran out unpaid; the unit is free again
//   CANCELLED  cancelled after confirming (by the lodge, Phase 5)
//   COMPLETED  the guest stayed
// A booking takes a unit while HELD (and not past its hold) or CONFIRMED.
export const bookingStatus = pgEnum('booking_status', ['HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'COMPLETED']);

export const bookings = pgTable('bookings', {
  id: serial().primaryKey(),
  ref: varchar({ length: 12 }).notNull(),             // 'SE-7K3QXM': what the guest sees and quotes
  roomTypeId: integer().notNull().references(() => roomTypes.id, { onDelete: 'restrict' }),
  checkIn: date({ mode: 'string' }).notNull(),
  checkOut: date({ mode: 'string' }).notNull(),
  nights: integer().notNull(),
  guests: integer().notNull(),
  totalKes: integer().notNull(),
  depositKes: integer().notNull(),
  status: bookingStatus().notNull().default('HELD'),
  holdExpiresAt: timestamp({ withTimezone: true }),   // only meaningful while HELD
  firstName: varchar({ length: 60 }).notNull(),
  lastName: varchar({ length: 60 }).notNull(),
  email: varchar({ length: 254 }).notNull(),
  phone: varchar({ length: 20 }).notNull(),           // +2547XXXXXXXX: M-Pesa needs it in Phase 3
  requests: text(),                                   // "late arrival", "anniversary"…
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp({ withTimezone: true }),
  cancelledAt: timestamp({ withTimezone: true }),
  // A deposit arrived that the booking can't use: after the hold ran out and the room was
  // taken, after a cancellation, or a second deposit. The lodge refunds it (admin, Phase 5).
  refundDue: boolean().notNull().default(false),
}, (t) => [
  uniqueIndex('bookings_ref_key').on(t.ref),
  // Availability asks "which bookings of this type overlap these nights and still hold a unit?"
  index('bookings_room_dates_idx').on(t.roomTypeId, t.checkIn, t.checkOut),
  index('bookings_status_idx').on(t.status, t.holdExpiresAt),
  check('bookings_dates_check', sql`${t.checkOut} > ${t.checkIn}`),
  check('bookings_nights_check', sql`${t.nights} = ${t.checkOut} - ${t.checkIn}`),
  check('bookings_guests_check', sql`${t.guests} between 1 and 20`),
  check('bookings_money_check', sql`${t.totalKes} > 0 and ${t.depositKes} > 0 and ${t.depositKes} <= ${t.totalKes}`),
  check('bookings_hold_check', sql`${t.status} <> 'HELD' or ${t.holdExpiresAt} is not null`),
]);

// Each night's price, frozen when the guest books: changing a rate later never changes what an
// existing guest owes, and the confirmation can show the price night by night.
export const bookingNights = pgTable('booking_nights', {
  bookingId: integer().notNull().references(() => bookings.id, { onDelete: 'cascade' }),
  night: date({ mode: 'string' }).notNull(),
  rateKes: integer().notNull(),
}, (t) => [
  primaryKey({ columns: [t.bookingId, t.night] }),
  check('booking_nights_rate_check', sql`${t.rateKes} > 0`),
]);

// ── Payments (Phase 3) ─────────────────────────────────────────────────────────────────────
// One row per attempt to pay a deposit, by M-Pesa (DARAJA) or card (PAYSTACK).
//   PENDING   waiting: the prompt is on the guest's phone, or they're on Paystack's page
//   PAID      the provider confirmed it (always by OUR question to them, never a callback's word)
//   FAILED    cancelled, declined, timed out, or never sent
//   FLAGGED   paid, but not the amount we asked for: a person decides (admin, Phase 5)
// A row only ever moves forward from PENDING, once (every update says "where status = PENDING").
export const paymentProvider = pgEnum('payment_provider', ['DARAJA', 'PAYSTACK']);
export const paymentStatus = pgEnum('payment_status', ['PENDING', 'PAID', 'FAILED', 'FLAGGED']);

export const payments = pgTable('payments', {
  // Random, not 1, 2, 3: it's also the reference Paystack sees, and it shouldn't reveal how many
  // payments the lodge takes.
  id: uuid().primaryKey().defaultRandom(),
  bookingId: integer().notNull().references(() => bookings.id, { onDelete: 'restrict' }),
  provider: paymentProvider().notNull(),
  status: paymentStatus().notNull().default('PENDING'),
  amountKes: integer().notNull(),                     // what we asked for (a token amount in the M-Pesa sandbox)
  receivedKes: integer(),                             // set only when a different amount arrived (FLAGGED)
  phone: varchar({ length: 20 }),                     // M-Pesa: the number prompted
  providerRef: varchar({ length: 100 }),              // Safaricom's CheckoutRequestID, or our id at Paystack
  receipt: varchar({ length: 60 }),                   // M-Pesa receipt (QK12AB34CD) or "Card •••• 4081"
  resultCode: varchar({ length: 30 }),
  failureReason: text(),                              // written for the guest
  raw: jsonb(),                                       // the provider's answer, for reconciling by hand
  checkedAt: timestamp({ withTimezone: true }),       // last time we asked the provider (throttles page checks)
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('payments_provider_ref_key').on(t.providerRef),
  // One payment in flight per booking: a double tap on "Pay" can't send two prompts.
  uniqueIndex('payments_one_pending_key').on(t.bookingId).where(sql`${t.status} = 'PENDING'`),
  index('payments_booking_idx').on(t.bookingId, t.createdAt),
  index('payments_open_idx').on(t.status, t.provider, t.createdAt),
  index('payments_phone_idx').on(t.phone, t.createdAt),
  check('payments_amount_check', sql`${t.amountKes} > 0`),
]);

// ── Enquiries ("Get in touch") ─────────────────────────────────────────────────────────────
export const enquiryStatus = pgEnum('enquiry_status', ['NEW', 'REPLIED', 'CLOSED']);

export const enquiries = pgTable('enquiries', {
  id: serial().primaryKey(),
  firstName: varchar({ length: 60 }).notNull(),
  lastName: varchar({ length: 60 }).notNull(),
  email: varchar({ length: 254 }).notNull(),
  phone: varchar({ length: 20 }),
  subject: varchar({ length: 120 }),                  // free text on the site's form, optional
  message: text().notNull(),
  checkIn: date({ mode: 'string' }),                  // optional: "around these dates"
  checkOut: date({ mode: 'string' }),
  guests: integer(),
  status: enquiryStatus().notNull().default('NEW'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('enquiries_status_idx').on(t.status, t.createdAt),
  check('enquiries_dates_check', sql`${t.checkIn} is null or ${t.checkOut} is null or ${t.checkOut} > ${t.checkIn}`),
]);
