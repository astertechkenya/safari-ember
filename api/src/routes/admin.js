// routes/admin.js: the admin API (Phase 5). Sign-in is ported from NURA.
//
//   POST /api/admin/login        { email, password }   step 1: password
//   POST /api/admin/login/code   { code }              step 2: the 6-digit authenticator code
//   POST /api/admin/logout
//   GET  /api/admin/me                                  who am I, and do I still need my code?
//
//   GET   /api/admin/today                          arrivals, departures, in house, holds, tonight
//   GET   /api/admin/bookings?q=&status=&room=      search and filter (status: upcoming, inhouse, held, past, cancelled, all)
//   GET   /api/admin/bookings/:ref                  one booking: rooms, trips, prices, payments, history
//   GET   /api/admin/bookings/:ref/link            the guest's private link (the very one they were given)
//   POST  /api/admin/bookings/:ref/check-in
//   POST  /api/admin/bookings/:ref/check-out
//   POST  /api/admin/bookings/:ref/cancel         { reason }
//   GET   /api/admin/calendar?from=                 three weeks of rooms free per night
//   GET   /api/admin/calendar/night?date=&room=     who is staying in a room type that night
//   GET   /api/admin/rooms
//   PATCH /api/admin/rooms/:id                     { baseRateKes?, units?, active? }
//   GET   /api/admin/experiences?from=              two weeks of departures (who's going) + each trip's settings
//   PATCH /api/admin/experiences/:id               { priceKes?, seats?, departureTimes?, active? }  (every trip runs daily)
//   GET   /api/admin/enquiries
//   POST  /api/admin/enquiries/:id/status          { status: NEW | HANDLED }
//
// Every route after `adminRouter.use(adminGate)` needs a signed-in admin, checked again on
// every request (middleware/adminGate.js). Nothing about a password reaches the browser or the
// logs: the database holds only an argon2id hash, slow to compute on purpose.
import { Router } from 'express';
import { z } from 'zod';
import argon2 from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { admins, bookings } from '../db/schema.js';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { httpError } from '../middleware/errors.js';
import { adminGate, needsTotp } from '../middleware/adminGate.js';
import { SESSION_COOKIE } from '../middleware/session.js';
import { verifyCode } from '../lib/totp.js';
import { isIsoDate, todayInNairobi } from '../lib/dates.js';
import { bookingUrl } from '../lib/bookingLink.js';
import {
  today, listBookings, LIST_FILTERS, bookingDetail, checkIn, checkOut, cancel, calendar, night,
  listRooms, updateRoom, departures, listTrips, updateTrip, listEnquiries, setEnquiryStatus,
} from '../services/admin.js';

export const adminRouter = Router();
adminRouter.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });   // personal: never cached

const MINUTE = 60 * 1000;
// Computed once at startup. A wrong email is still checked against this, so it takes as long
// as a wrong password and response times don't reveal which emails are admins.
const DUMMY_HASH = await argon2.hash('not-a-real-password-just-for-timing');

// express-session uses callbacks; these wrap them so routes can simply `await`.
const regenerate = (req) => new Promise((ok, fail) => req.session.regenerate((e) => (e ? fail(e) : ok())));
const saveSession = (req) => new Promise((ok, fail) => req.session.save((e) => (e ? fail(e) : ok())));
const destroySession = (req) => new Promise((ok, fail) => req.session.destroy((e) => (e ? fail(e) : ok())));
const me = (a, session) => ({ name: a.name, role: a.role, masked: a.role === 'DEMO_ADMIN', needsTotp: needsTotp(a, session) });

/* ── SIGN-IN ──────────────────────────────────────────────────────────────────────────── */

const loginBody = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email('Please enter a valid email address.').max(254)),
  password: z.string().min(1, 'Please enter your password.').max(128),
});

adminRouter.post(
  '/login',
  // 5 tries per 15 minutes per connection+email, and 20 wrong ones per connection: throttling,
  // not lockout (a lockout would let anyone lock the manager out just by knowing the email).
  limit({ windowMs: 15 * MINUTE, max: 5, by: (req) => req.body?.email, message: 'Too many sign-in attempts. Wait 15 minutes.' }),
  limit({ windowMs: 15 * MINUTE, max: 20, failuresOnly: true, message: 'Too many sign-in attempts from this connection. Wait 15 minutes.' }),
  validate(loginBody),
  async (req, res) => {
    const { email, password } = req.valid.body;
    const [a] = await db.select().from(admins).where(sql`lower(${admins.email}) = ${email}`);
    const ok = await argon2.verify(a?.passwordHash ?? DUMMY_HASH, password);
    if (!a || !ok) throw httpError(401, 'Incorrect email or password.');   // one message for both
    // A NEW session ID on every sign-in defeats session fixation (an attacker planting a known ID).
    await regenerate(req);
    req.session.adminId = a.id;
    req.session.adminSeenAt = Date.now();
    await saveSession(req);
    res.json({ admin: me(a, req.session) });
  },
);

adminRouter.post('/logout', async (req, res) => {
  if (req.session) await destroySession(req);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.status(204).end();
});

adminRouter.use(adminGate);

adminRouter.get('/me', (req, res) => res.json({ admin: me(req.admin, req.session) }));

adminRouter.post(
  '/login/code',
  // 5 WRONG codes per 15 minutes per ACCOUNT, from wherever they come: someone with the password
  // can't spread guesses over many IP addresses.
  limit({ windowMs: 15 * MINUTE, max: 5, by: (req) => req.session?.adminId, ipToo: false, failuresOnly: true, message: 'Too many codes tried. Wait 15 minutes.' }),
  validate(z.strictObject({ code: z.string().regex(/^\d{6}$/, 'The code is 6 digits.') })),
  async (req, res) => {
    if (!req.admin.totpSecret || !verifyCode(req.admin.totpSecret, req.valid.body.code)) {
      throw httpError(401, 'That code isn’t right. Codes change every 30 seconds; try the current one.');
    }
    req.session.totpVerifiedAt = Date.now();
    res.json({ admin: me(req.admin, req.session) });
  },
);

/* ── ADMIN DATA ───────────────────────────────────────────────────────────────────────── */

const isoDate = z.string().refine(isIsoDate, 'must be a date written as YYYY-MM-DD');
const refParams = z.strictObject({ ref: z.string().trim().toUpperCase().regex(/^SE-[A-Z0-9]{6}$/, 'Not a booking reference.') });
const idParams = z.strictObject({ id: z.coerce.number().int().positive() });

adminRouter.get('/today', async (req, res) => res.json(await today(req.masked)));

adminRouter.get('/bookings', validate(z.strictObject({
  q: z.string().trim().min(1).max(60).optional(),
  status: z.enum(LIST_FILTERS).default('upcoming'),
  room: z.coerce.number().int().positive().optional(),
}), 'query'), async (req, res) => {
  res.json({ bookings: await listBookings(req.valid.query, req.masked) });
});

adminRouter.get('/bookings/:ref', validate(refParams, 'params'), async (req, res) => {
  const b = await bookingDetail(req.valid.params.ref, req.masked);
  if (!b) throw httpError(404, 'Booking not found.');
  res.json({ booking: b });
});

// The guest's own link, to read to them or paste into a message. Signed with the booking's
// creation time, so it's the same link they already have. Not for the demo admin: the guest
// page shows the real name and phone, which would undo the masking.
adminRouter.get('/bookings/:ref/link', validate(refParams, 'params'), async (req, res) => {
  if (req.masked) throw httpError(403, 'The demo admin can’t open guests’ private links.');
  const [b] = await db.select({ ref: bookings.ref, createdAt: bookings.createdAt }).from(bookings).where(eq(bookings.ref, req.valid.params.ref));
  if (!b) throw httpError(404, 'Booking not found.');
  res.json({ url: bookingUrl(b.ref, { now: b.createdAt.getTime() }) });
});

// Each action answers with the booking as it now is, so the page can redraw from the truth.
adminRouter.post('/bookings/:ref/check-in', validate(refParams, 'params'), async (req, res) => {
  await checkIn(req.valid.params.ref, req.admin.id);
  res.json({ booking: await bookingDetail(req.valid.params.ref, req.masked) });
});
adminRouter.post('/bookings/:ref/check-out', validate(refParams, 'params'), async (req, res) => {
  await checkOut(req.valid.params.ref, req.admin.id);
  res.json({ booking: await bookingDetail(req.valid.params.ref, req.masked) });
});
adminRouter.post('/bookings/:ref/cancel', validate(refParams, 'params'),
  validate(z.strictObject({ reason: z.string().trim().min(3, 'Give the guest a short reason.').max(300) })),
  async (req, res) => {
    await cancel(req.valid.params.ref, req.admin.id, req.valid.body.reason);
    res.json({ booking: await bookingDetail(req.valid.params.ref, req.masked) });
  });

adminRouter.get('/calendar', validate(z.strictObject({ from: isoDate.optional() }), 'query'), async (req, res) => {
  res.json(await calendar(req.valid.query.from));
});
adminRouter.get('/calendar/night', validate(z.strictObject({ date: isoDate, room: z.coerce.number().int().positive() }), 'query'), async (req, res) => {
  const n = await night(req.valid.query.date, req.valid.query.room, req.masked);
  if (!n) throw httpError(404, 'Room type not found.');
  res.json(n);
});

const kes = z.coerce.number().int('Whole shillings only.').min(1, 'Must be more than 0.').max(10_000_000);

adminRouter.get('/rooms', async (req, res) => res.json({ rooms: await listRooms() }));
adminRouter.patch('/rooms/:id', validate(idParams, 'params'), validate(z.strictObject({
  baseRateKes: kes.optional(),
  units: z.coerce.number().int().min(0).max(99).optional(),
  active: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nothing to change.')), async (req, res) => {
  await updateRoom(req.valid.params.id, req.valid.body, req.admin.id);
  res.json({ rooms: await listRooms() });
});

// Experiences: upcoming departures (who's going) and each trip's settings
adminRouter.get('/experiences', validate(z.strictObject({ from: isoDate.optional() }), 'query'), async (req, res) => {
  const [d, trips] = await Promise.all([departures(req.valid.query.from ?? todayInNairobi(), req.masked), listTrips()]);
  res.json({ ...d, trips });
});
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Times are written as HH:MM, e.g. 06:30.');
adminRouter.patch('/experiences/:id', validate(idParams, 'params'), validate(z.strictObject({
  priceKes: kes.optional(),
  seats: z.coerce.number().int('Whole seats only.').min(1, 'At least 1 seat.').max(100).optional(),
  departureTimes: z.array(hhmm).min(1, 'Keep at least one departure time.').max(6, 'At most 6 departure times.')
    .refine((t) => new Set(t).size === t.length, 'A departure time is listed twice.')
    .transform((t) => [...t].sort()).optional(),
  active: z.boolean().optional(),
}).refine((b) => Object.keys(b).length > 0, 'Nothing to change.')), async (req, res) => {
  const { trip, offSchedule } = await updateTrip(req.valid.params.id, req.valid.body, req.admin.id);
  res.json({ trip, offSchedule });
});

adminRouter.get('/enquiries', async (req, res) => res.json({ enquiries: await listEnquiries(req.masked) }));
adminRouter.post('/enquiries/:id/status', validate(idParams, 'params'),
  validate(z.strictObject({ status: z.enum(['NEW', 'HANDLED']) })), async (req, res) => {
    res.json({ status: await setEnquiryStatus(req.valid.params.id, req.valid.body.status, req.admin.id) });
  });
