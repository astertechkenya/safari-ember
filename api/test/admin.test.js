// The admin API (Phase 5): sign-in with two-factor, the demo account, and every screen's data
// and actions, against a real Postgres. Sign-in is NURA's, so these tests mirror NURA's.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { sql, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { admins, roomTypes, bookings, payments, enquiries, adminEvents, activities } from '../src/db/schema.js';
import { createHold } from '../src/services/bookings.js';
import { freeUnits } from '../src/services/availability.js';
import { newSecret, codeAt } from '../src/lib/totp.js';
import { netlifyToken, freshIp, inDays } from './helpers.js';

const app = createApp();
afterAll(() => pool.end());

const PASSWORD = 'correct horse battery staple';
let room, trip, secret, demoId;

/** A browser: keeps its cookie between requests, like the admin page does. */
function browser(ip = freshIp()) {
  const agent = request.agent(app);
  const wrap = (m) => (url) => agent[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
  return { get: wrap('get'), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
}
const code = (s = secret) => codeAt(s, Math.floor(Date.now() / 30_000));

/** A fully signed-in admin (password, then code). */
async function signedIn(email = 'manager@example.com') {
  const b = browser();
  expect((await b.post('/api/admin/login').send({ email, password: PASSWORD })).status).toBe(200);
  expect((await b.post('/api/admin/login/code').send({ code: code() })).status).toBe(200);
  return b;
}
async function demo() {
  const b = browser();
  expect((await b.post('/api/admin/login').send({ email: 'demo@example.com', password: PASSWORD })).status).toBe(200);
  return b;
}

const guest = { firstName: 'Amani', lastName: 'Wanjiru', email: 'amani@example.com', phone: '+254710100100' };
/** A booking in the test room, confirmed with a sandbox deposit (KES 1 asked, like Daraja's sandbox). */
async function confirmed(checkIn, checkOut, extra = {}) {
  const { booking } = await createHold({ rooms: [{ room: 'test-admin-room', units: 1 }], checkIn, checkOut, guests: 2, ...guest, ...extra });
  const [b] = await db.update(bookings).set({ status: 'CONFIRMED', holdExpiresAt: null, confirmedAt: new Date() }).where(eq(bookings.ref, booking.ref)).returning();
  await db.insert(payments).values({ bookingId: b.id, provider: 'DARAJA', status: 'PAID', amountKes: 1, providerRef: 'test-' + b.ref, receipt: 'QK12AB34CD' });
  return booking.ref;
}

beforeAll(async () => {
  secret = newSecret();
  const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
  await db.insert(admins).values([
    { email: 'manager@example.com', name: 'Ethan K.', role: 'ADMIN', passwordHash, totpSecret: secret },
    { email: 'tries@example.com', name: 'Tries', role: 'ADMIN', passwordHash, totpSecret: newSecret() },
  ]);
  [{ id: demoId }] = await db.insert(admins).values({ email: 'demo@example.com', name: 'Visitor', role: 'DEMO_ADMIN', passwordHash }).returning();
  [trip] = await db.insert(activities).values({ slug: 'test-admin-trip', name: 'Admin Test Trip', summary: 'x', durationMinutes: 120,
    priceKes: 3_000, seats: 3, departureTimes: ['09:00', '14:00'], weekdays: [1, 2, 3, 4, 5, 6, 7], sort: 96 }).returning();
  [room] = await db.insert(roomTypes).values({ slug: 'test-admin-room', name: 'Admin Test Room', kind: 'Test', description: 'x', sleeps: 2, units: 3, baseRateKes: 20_000, sort: 95 }).returning();
});
beforeEach(async () => {
  await db.execute(sql`truncate bookings, booking_rooms, booking_nights, booking_activities, payments, admin_events restart identity cascade`);
});

describe('signing in', () => {
  it('refuses a wrong password and an unknown email with the same message', async () => {
    const wrong = await browser().post('/api/admin/login').send({ email: 'manager@example.com', password: 'nope' });
    const nobody = await browser().post('/api/admin/login').send({ email: 'nobody@example.com', password: 'nope' });
    expect([wrong.status, nobody.status]).toEqual([401, 401]);
    expect(wrong.body.error).toBe(nobody.body.error);
  });

  it('lets nothing through without a session', async () => {
    for (const url of ['/api/admin/today', '/api/admin/bookings', '/api/admin/rooms', '/api/admin/enquiries', '/api/admin/me']) {
      expect((await browser().get(url)).status, url).toBe(401);
    }
  });

  it('asks for the authenticator code before any data, and only accepts the right one', async () => {
    const b = browser();
    const login = await b.post('/api/admin/login').send({ email: 'Manager@Example.com', password: PASSWORD });
    expect(login.body.admin).toMatchObject({ name: 'Ethan K.', needsTotp: true });
    const cookie = login.headers['set-cookie'][0];
    expect(cookie).toMatch(/^se\.sid=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);

    const early = await b.get('/api/admin/today');
    expect(early.status).toBe(401);
    expect(early.body.needsTotp).toBe(true);
    expect((await b.post('/api/admin/login/code').send({ code: '000000' })).status).toBe(401);
    expect((await b.post('/api/admin/login/code').send({ code: code() })).body.admin.needsTotp).toBe(false);
    expect((await b.get('/api/admin/today')).status).toBe(200);
  });

  it('stops guessing codes after 5 wrong ones, per account', async () => {
    const b = browser();
    await b.post('/api/admin/login').send({ email: 'tries@example.com', password: PASSWORD });
    for (let i = 0; i < 5; i++) expect((await b.post('/api/admin/login/code').send({ code: '123456' })).status).toBe(401);
    expect((await b.post('/api/admin/login/code').send({ code: '123456' })).status).toBe(429);
  });

  it('signs out', async () => {
    const b = await signedIn();
    expect((await b.post('/api/admin/logout')).status).toBe(204);
    expect((await b.get('/api/admin/me')).status).toBe(401);
  });

  it('refuses sign-in posted from another website, and unknown fields', async () => {
    const evil = await browser().post('/api/admin/login').set('Origin', 'https://evil.example').send({ email: 'manager@example.com', password: PASSWORD });
    expect(evil.status).toBe(403);
    const extra = await browser().post('/api/admin/login').send({ email: 'manager@example.com', password: PASSWORD, role: 'ADMIN' });
    expect(extra.status).toBe(400);
  });
});

describe('the demo admin', () => {
  it('can look at everything, with guests’ details masked on the server', async () => {
    const ref = await confirmed(inDays(10), inDays(12));
    const d = await demo();
    expect((await d.get('/api/admin/me')).body.admin).toMatchObject({ role: 'DEMO_ADMIN', masked: true, needsTotp: false });
    const { body } = await d.get(`/api/admin/bookings/${ref}`);
    expect(body.booking).toMatchObject({ firstName: 'Amani', lastName: 'W.', email: 'a•••@example.com', phone: '+254 7•• ••• 100' });
    expect(JSON.stringify(body)).not.toContain('amani@example.com');
  });

  it('can’t open a guest’s private link (it would show the real details)', async () => {
    const ref = await confirmed(inDays(10), inDays(12));
    expect((await (await demo()).get(`/api/admin/bookings/${ref}/link`)).status).toBe(403);
  });

  it('can change nothing', async () => {
    const ref = await confirmed(inDays(0), inDays(2));
    const d = await demo();
    expect((await d.post(`/api/admin/bookings/${ref}/check-in`)).status).toBe(403);
    expect((await d.patch(`/api/admin/rooms/${room.id}`).send({ baseRateKes: 1 })).status).toBe(403);
    expect((await db.select().from(adminEvents)).length).toBe(0);
  });
});

describe('Today and the daily actions', () => {
  it('lists today’s arrival, checks them in, then out, and logs who did it', async () => {
    const ref = await confirmed(inDays(0), inDays(2), { requests: 'Arriving late' });
    const b = await signedIn();
    let t = (await b.get('/api/admin/today')).body;
    expect(t.arrivals.map((x) => x.ref)).toEqual([ref]);
    expect(t.arrivals[0]).toMatchObject({ status: 'CONFIRMED', requests: 'Arriving late', rooms: [{ name: 'Admin Test Room', units: 1 }] });

    const inRes = await b.post(`/api/admin/bookings/${ref}/check-in`);
    expect(inRes.body.booking).toMatchObject({ status: 'INHOUSE', canCheckIn: false, canCheckOut: true });
    t = (await b.get('/api/admin/today')).body;
    expect(t.inHouse).toMatchObject({ bookings: 1, rooms: 1, guests: 2 });
    expect((await b.post(`/api/admin/bookings/${ref}/check-in`)).status).toBe(409);   // not twice

    const out = await b.post(`/api/admin/bookings/${ref}/check-out`);
    expect(out.body.booking.status).toBe('COMPLETED');
    // Leaving early frees the rest of the stay for sale
    expect((await freeUnits({ checkIn: inDays(1), checkOut: inDays(2), roomTypeId: room.id })).get(room.id)).toBe(3);
    const log = await db.execute(sql`select e.action, a.name from admin_events e join admins a on a.id = e.admin_id order by e.id`);
    expect(log.rows).toEqual([{ action: 'check-in', name: 'Ethan K.' }, { action: 'check-out', name: 'Ethan K.' }]);
  });

  it('won’t check in a stay that starts later', async () => {
    const ref = await confirmed(inDays(5), inDays(7));
    const res = await (await signedIn()).post(`/api/admin/bookings/${ref}/check-in`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Check-in opens that day/);
  });

  it('cancels with a reason, which frees the room and never refunds by itself', async () => {
    const ref = await confirmed(inDays(20), inDays(22));
    const b = await signedIn();
    expect((await b.post(`/api/admin/bookings/${ref}/cancel`).send({})).status).toBe(400);
    const res = await b.post(`/api/admin/bookings/${ref}/cancel`).send({ reason: 'Guest asked by phone' });
    expect(res.body.booking).toMatchObject({ status: 'CANCELLED', cancelReason: 'Guest asked by phone', refundDue: false, canCancel: false });
    expect(res.body.booking.history.at(-1).what).toBe('Cancelled · Guest asked by phone');
    expect((await freeUnits({ checkIn: inDays(20), checkOut: inDays(22), roomTypeId: room.id })).get(room.id)).toBe(3);
    expect((await b.post(`/api/admin/bookings/${ref}/cancel`).send({ reason: 'again' })).status).toBe(409);
  });

  it('shows the balance as total minus deposit, whatever the sandbox charged', async () => {
    const ref = await confirmed(inDays(30), inDays(32));
    const { booking } = (await (await signedIn()).get(`/api/admin/bookings/${ref}`)).body;
    expect(booking.totalKes).toBe(40_000);
    expect(booking.balanceKes).toBe(40_000 - booking.depositKes);
    expect(booking.rooms[0]).toMatchObject({ name: 'Admin Test Room', units: 1, totalKes: 40_000 });
    expect(booking.rooms[0].nightly).toHaveLength(2);
    expect(booking.payments).toEqual([expect.objectContaining({ provider: 'M-Pesa', status: 'PAID', receipt: 'QK12AB34CD' })]);
  });
});

describe('the guest’s link', () => {
  it('is the very link the guest was given, and it opens their booking', async () => {
    const { booking, url } = await createHold({ rooms: [{ room: 'test-admin-room', units: 1 }], checkIn: inDays(70), checkOut: inDays(71), guests: 2, ...guest });
    const res = await (await signedIn()).get(`/api/admin/bookings/${booking.ref}/link`);
    expect(res.body.url).toBe(url);
  });
});

describe('the bookings list', () => {
  it('searches by name, reference, email or phone, and filters', async () => {
    const a = await confirmed(inDays(40), inDays(41));
    await confirmed(inDays(42), inDays(43), { firstName: 'Brian', lastName: 'Kiprop', email: 'brian@example.com', phone: '+254711222333' });
    const b = await signedIn();
    const find = async (q, extra = '') => (await b.get(`/api/admin/bookings?status=all&q=${encodeURIComponent(q)}${extra}`)).body.bookings.map((x) => x.firstName);
    expect(await find('kiprop')).toEqual(['Brian']);
    expect(await find(a.toLowerCase())).toEqual(['Amani']);
    expect(await find('brian@')).toEqual(['Brian']);
    expect(await find('711222')).toEqual(['Brian']);
    expect(await find('%')).toEqual([]);                                   // a wildcard is just a character
    expect((await b.get(`/api/admin/bookings?status=held`)).body.bookings).toEqual([]);
    expect((await b.get(`/api/admin/bookings?room=${room.id}`)).body.bookings).toHaveLength(2);
    expect((await b.get('/api/admin/bookings?status=nonsense')).status).toBe(400);
  });
});

describe('the calendar', () => {
  it('counts rooms per night exactly like availability, and lists who is staying', async () => {
    await confirmed(inDays(50), inDays(52));
    const b = await signedIn();
    const cal = (await b.get(`/api/admin/calendar?from=${inDays(50)}`)).body;
    const r = cal.rooms.find((x) => x.id === room.id);
    expect(r.nights.slice(0, 3).map((n) => n.free)).toEqual([2, 2, 3]);
    expect(cal.days).toBe(21);
    const n = (await b.get(`/api/admin/calendar/night?date=${inDays(51)}&room=${room.id}`)).body;
    expect(n).toMatchObject({ free: 2, room: { name: 'Admin Test Room' } });
    expect(n.bookings.map((x) => x.firstName)).toEqual(['Amani']);
  });

  it('still counts stays on past nights once the guests have checked out, up to the day they left', async () => {
    // Two past stays in the 3-unit test room: one left on its check-out day, one left a day early
    const full = await confirmed(inDays(40), inDays(43));
    const early = await confirmed(inDays(44), inDays(47), { firstName: 'Baraka' });
    await db.execute(sql`update bookings set status = 'COMPLETED', check_in = ${inDays(-5)}::date, check_out = ${inDays(-2)}::date,
      checked_in_at = now() - interval '5 days', checked_out_at = (${inDays(-2)}::date + time '10:00') at time zone 'Africa/Nairobi' where ref = ${full}`);
    await db.execute(sql`update bookings set status = 'COMPLETED', check_in = ${inDays(-5)}::date, check_out = ${inDays(-2)}::date,
      checked_in_at = now() - interval '5 days', checked_out_at = (${inDays(-3)}::date + time '10:00') at time zone 'Africa/Nairobi' where ref = ${early}`);
    const b = await signedIn();
    const r = (await b.get(`/api/admin/calendar?from=${inDays(-6)}`)).body.rooms.find((x) => x.id === room.id);
    // nights -6 … -1: nobody, both, both, the full stay only (the other left on -3), nobody, nobody
    expect(r.nights.slice(0, 6).map((n) => n.free)).toEqual([3, 1, 1, 2, 3, 3]);
    const who = async (d) => (await b.get(`/api/admin/calendar/night?date=${inDays(d)}&room=${room.id}`)).body.bookings.map((x) => [x.firstName, x.status]);
    expect(await who(-4)).toEqual([['Amani', 'COMPLETED'], ['Baraka', 'COMPLETED']]);
    expect(await who(-3)).toEqual([['Amani', 'COMPLETED']]);
    expect(await who(-2)).toEqual([]);
    // Looking forward is unchanged: a stay that ended early never holds the nights it skipped
    expect((await b.get(`/api/admin/calendar?from=${inDays(0)}`)).body.rooms.find((x) => x.id === room.id).nights[0].free).toBe(3);
  });
});

describe('rooms and rates', () => {
  it('changes a base rate and logs the before and after', async () => {
    const b = await signedIn();
    const res = await b.patch(`/api/admin/rooms/${room.id}`).send({ baseRateKes: 22_000 });
    expect(res.body.rooms.find((x) => x.id === room.id).baseRateKes).toBe(22_000);
    const [e] = await db.select().from(adminEvents);
    expect(e).toMatchObject({ action: 'room.update', detail: { before: { baseRateKes: 20_000 }, after: { baseRateKes: 22_000 } } });
    await db.update(roomTypes).set({ baseRateKes: 20_000 }).where(eq(roomTypes.id, room.id));
  });

  it('never lowers units below the rooms already booked on a future night', async () => {
    await confirmed(inDays(60), inDays(61));
    await confirmed(inDays(60), inDays(61));
    const b = await signedIn();
    const res = await b.patch(`/api/admin/rooms/${room.id}`).send({ units: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(`Admin Test Room: 2 rooms are booked on ${inDays(60)}, so units can’t go below 2.`);
    expect((await b.patch(`/api/admin/rooms/${room.id}`).send({ units: 2 })).status).toBe(200);
    expect((await b.patch(`/api/admin/rooms/${room.id}`).send({})).status).toBe(400);
    await db.update(roomTypes).set({ units: 3 }).where(eq(roomTypes.id, room.id));
  });

  it('shows a new base rate in the very next booking-page search, while booked guests keep theirs', async () => {
    const before = await confirmed(inDays(60), inDays(62));             // booked at 20,000 a night
    const b = await signedIn();
    expect((await b.patch(`/api/admin/rooms/${room.id}`).send({ baseRateKes: 23_000 })).status).toBe(200);
    try {
      // Any dates, any time of year: one rate, no season can override it
      for (const [from, to] of [[inDays(10), inDays(12)], [inDays(200), inDays(202)], [inDays(300), inDays(302)]]) {
        const search = await request(app).get(`/api/availability?checkIn=${from}&checkOut=${to}&guests=2`).set('x-nf-sign', netlifyToken());
        const mine = search.body.rooms.find((r) => r.slug === 'test-admin-room');
        expect(mine.nightly.map((n) => n.rateKes)).toEqual([23_000, 23_000]);
        expect(mine.totalKes).toBe(46_000);
      }
      const { booking } = (await b.get(`/api/admin/bookings/${before}`)).body;
      expect(booking.totalKes).toBe(40_000);                             // frozen when they booked
    } finally {
      await db.update(roomTypes).set({ baseRateKes: 20_000 }).where(eq(roomTypes.id, room.id));
    }
  });

});

describe('experiences', () => {
  const xp = (day, time, people) => ({ activities: [{ activity: 'test-admin-trip', day, time, people }] });

  it('lists each departure with who is going, the headcount and the vehicles it needs', async () => {
    const day = inDays(6);
    const a = await confirmed(inDays(5), inDays(7), xp(day, '09:00', 2));
    const { booking: held } = await createHold({ rooms: [{ room: 'test-admin-room', units: 1 }], checkIn: inDays(5), checkOut: inDays(7), guests: 2,
      ...guest, firstName: 'Baraka', ...xp(day, '09:00', 2) });
    const gone = await confirmed(inDays(5), inDays(7), xp(day, '09:00', 1));
    await (await signedIn()).post(`/api/admin/bookings/${gone}/cancel`).send({ reason: 'Plans changed' });   // cancelled: not going
    await confirmed(inDays(5), inDays(7), xp(day, '14:00', 1));

    const res = await (await signedIn()).get('/api/admin/experiences');
    expect(res.status).toBe(200);
    const mine = res.body.departures.filter((d) => d.activityId === trip.id);
    expect(mine.map((d) => [d.day, d.time, d.people, d.vehicles])).toEqual([[day, '09:00', 4, 2], [day, '14:00', 1, 1]]);  // 3 seats a vehicle
    expect(mine[0].bookings.map((b) => [b.ref, b.status, b.people])).toEqual(
      [[a, 'CONFIRMED', 2], [held.ref, 'HELD', 2]].sort((x, y) => (x[0] < y[0] ? -1 : 1)));
    expect(mine[0].bookings.find((b) => b.ref === a)).toMatchObject({ firstName: 'Amani', lastName: 'Wanjiru', phone: '+254710100100' });
    expect(res.body.trips.find((t) => t.id === trip.id)).toMatchObject({ priceKes: 3_000, seats: 3, departureTimes: ['09:00', '14:00'], active: true });

    // Two weeks from `from` only
    const later = await (await signedIn()).get(`/api/admin/experiences?from=${inDays(30)}`);
    expect(later.body.departures.filter((d) => d.activityId === trip.id)).toEqual([]);

    // The demo account sees the same departures, with guests masked
    const shown = (await (await demo()).get('/api/admin/experiences')).body.departures.find((d) => d.activityId === trip.id);
    expect(shown.bookings.find((b) => b.ref === a)).toMatchObject({ firstName: 'Amani', lastName: 'W.', phone: '+254 7•• ••• 100' });
  });

  it('changes a trip for new bookings, and counts bookings left on a time it no longer runs', async () => {
    const ref = await confirmed(inDays(5), inDays(7), xp(inDays(6), '09:00', 2));
    const b = await signedIn();
    try {
      const res = await b.patch(`/api/admin/experiences/${trip.id}`).send({ priceKes: 3_500, departureTimes: ['15:00', '10:00'] });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ trip: { priceKes: 3_500, departureTimes: ['10:00', '15:00'] }, offSchedule: 1 });
      // Guests are offered only the new times, at the new price
      const offer = (await request(app).get(`/api/activities?checkIn=${inDays(20)}&checkOut=${inDays(21)}`).set('x-nf-sign', netlifyToken()))
        .body.activities.find((a) => a.slug === 'test-admin-trip');
      expect(offer.priceKes).toBe(3_500);
      expect([...new Set(offer.departures.map((d) => d.time))]).toEqual(['10:00', '15:00']);
      // The booked guest keeps their departure and their price
      const { booking } = (await b.get(`/api/admin/bookings/${ref}`)).body;
      expect(booking.activities[0]).toMatchObject({ time: '09:00', priceKes: 3_000 });
      const [ev] = await db.select().from(adminEvents).where(eq(adminEvents.action, 'activity.update'));
      expect(ev.detail).toMatchObject({ before: { priceKes: 3_000 }, after: { priceKes: 3_500 } });

      // Switching it off: guests stop seeing it
      expect((await b.patch(`/api/admin/experiences/${trip.id}`).send({ active: false })).body.offSchedule).toBe(1);
      const off = (await request(app).get(`/api/activities?checkIn=${inDays(20)}&checkOut=${inDays(21)}`).set('x-nf-sign', netlifyToken()))
        .body.activities.find((a) => a.slug === 'test-admin-trip');
      expect(off).toBeUndefined();

      // Refused: nothing to change, a repeated time, days (every trip runs daily), a bad time, the demo account
      expect((await b.patch(`/api/admin/experiences/${trip.id}`).send({})).status).toBe(400);
      expect((await b.patch(`/api/admin/experiences/${trip.id}`).send({ departureTimes: ['09:00', '09:00'] })).status).toBe(400);
      expect((await b.patch(`/api/admin/experiences/${trip.id}`).send({ weekdays: [1, 2, 3] })).status).toBe(400);
      expect((await b.patch(`/api/admin/experiences/${trip.id}`).send({ departureTimes: ['9am'] })).status).toBe(400);
      expect((await b.patch('/api/admin/experiences/999999').send({ active: true })).status).toBe(404);
      expect((await (await demo()).patch(`/api/admin/experiences/${trip.id}`).send({ active: true })).status).toBe(403);
    } finally {
      await db.update(activities).set({ priceKes: 3_000, departureTimes: ['09:00', '14:00'], active: true }).where(eq(activities.id, trip.id));
    }
  });
});

describe('enquiries', () => {
  it('lists them and marks one handled, which lowers Today’s count', async () => {
    const [e] = await db.insert(enquiries).values({ firstName: 'Rachel', lastName: 'Kimani', email: 'rachel@example.com', message: 'Group of 9?' }).returning();
    const b = await signedIn();
    const before = (await b.get('/api/admin/today')).body.newEnquiries;
    expect((await b.get('/api/admin/enquiries')).body.enquiries.find((x) => x.id === e.id)).toMatchObject({ firstName: 'Rachel', status: 'NEW' });
    expect((await b.post(`/api/admin/enquiries/${e.id}/status`).send({ status: 'HANDLED' })).body.status).toBe('HANDLED');
    expect((await b.get('/api/admin/today')).body.newEnquiries).toBe(before - 1);
  });
});
