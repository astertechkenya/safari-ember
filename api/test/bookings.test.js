// The booking engine against a real Postgres: availability, holds, overbooking, expiry.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { roomTypes, bookings } from '../src/db/schema.js';
import { expireHolds, createHold, largestParty } from '../src/services/bookings.js';
import { freeUnits } from '../src/services/availability.js';
import { addDays } from '../src/lib/dates.js';
import { as, inDays } from './helpers.js';

const app = createApp();
afterAll(() => pool.end());

// Test-only room types, so the numbers don't depend on the seed's placeholder prices.
let pair, solo;           // 2 units sleeping 2; 1 unit sleeping 4
beforeAll(async () => {
  [pair] = await db.insert(roomTypes).values({ slug: 'test-pair', name: 'Test Pair', kind: 'Test', description: 'x', sleeps: 2, units: 2, baseRateKes: 10_000, sort: 90 }).returning();
  [solo] = await db.insert(roomTypes).values({ slug: 'test-solo', name: 'Test Solo', kind: 'Test', description: 'x', sleeps: 4, units: 1, baseRateKes: 50_000, sort: 91 }).returning();
});
beforeEach(async () => {
  await db.execute(sql`truncate bookings, booking_rooms, booking_nights, booking_activities restart identity cascade`);
});

const guest = { firstName: 'Amina', lastName: 'Otieno', email: 'amina@example.com', phone: '0712345678' };
// One room of one type, the simplest booking. bookRooms() sends several.
const book = (room, checkIn, checkOut, extra = {}) =>
  as(app).post('/api/bookings').send({ rooms: [{ room, units: 1 }], checkIn, checkOut, guests: 2, ...guest, ...extra });
const bookRooms = (rooms, checkIn, checkOut, extra = {}) =>
  as(app).post('/api/bookings').send({ rooms: Object.entries(rooms).map(([room, units]) => ({ room, units })), checkIn, checkOut, guests: 2, ...guest, ...extra });
const unitsHeld = async (rt) => (await db.execute(sql`select coalesce(sum(units), 0)::int as n from booking_rooms where room_type_id = ${rt.id}`)).rows[0].n;
const search = (checkIn, checkOut, guests = 2) =>
  as(app).get(`/api/availability?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}`);
const roomIn = (res, slug) => res.body.rooms.find((r) => r.slug === slug);

describe('availability search', () => {
  it('lists every active room type with its price for the stay', async () => {
    const res = await search(inDays(40), inDays(43));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.nights).toBe(3);
    expect(res.body.rooms.map((r) => r.slug)).toEqual(expect.arrayContaining(['hearthside-room', 'coalbed-suite', 'ember-penthouse', 'test-pair']));
    expect(roomIn(res, 'test-pair')).toMatchObject({ available: true, maxUnits: 2, totalKes: 30_000, depositKes: 9_000, balanceKes: 21_000 });
  });

  it('says how many are left only when few are', async () => {
    const res = await search(inDays(40), inDays(42));
    expect(roomIn(res, 'test-pair').left).toBe(2);
    expect(roomIn(res, 'hearthside-room').left).toBeNull();   // 12 units: not advertised
  });

  it('offers small rooms to a big party too (they can take several), and says when no mix fits', async () => {
    const three = await search(inDays(40), inDays(42), 3);
    expect(roomIn(three, 'test-pair')).toMatchObject({ available: true, maxUnits: 2 });
    expect(three.body).toMatchObject({ partyFits: true, maxRooms: 6 });
    // With nothing free, not even one guest fits.
    expect(largestParty([{ sleeps: 2, free: 0 }, { sleeps: 4, free: 0 }], 6)).toBe(0);
  });

  it('refuses impossible stays with a readable reason', async () => {
    const cases = [
      [`checkIn=${inDays(-1)}&checkOut=${inDays(2)}&guests=2`, 'checkIn: is in the past'],
      [`checkIn=${inDays(5)}&checkOut=${inDays(5)}&guests=2`, 'checkOut: must be after check-in'],
      [`checkIn=${inDays(5)}&checkOut=${inDays(36)}&guests=2`, 'checkOut: stays can be at most 30 nights'],
      [`checkIn=${inDays(600)}&checkOut=${inDays(602)}&guests=2`, 'checkIn: can be at most 18 months ahead'],
      ['checkIn=2027-02-30&checkOut=2027-03-02&guests=2', 'checkIn: must be a date written as YYYY-MM-DD'],
      [`checkIn=${inDays(5)}&checkOut=${inDays(6)}&guests=0`, 'guests: at least 1 guest'],
      [`checkIn=${inDays(5)}&checkOut=${inDays(6)}&guests=2&sort=price`, 'Unknown field: sort'],
    ];
    for (const [q, error] of cases) {
      const res = await as(app).get(`/api/availability?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.body.error, q).toBe(error);
    }
  });

  it('allows a stay starting today', async () => {
    expect((await search(inDays(0), inDays(1))).status).toBe(200);
  });
});

describe('holding a room', () => {
  it('holds a unit, prices it night by night and returns a signed link', async () => {
    const res = await book('test-pair', inDays(50), inDays(52));
    expect(res.status).toBe(201);
    const b = res.body.booking;
    expect(b).toMatchObject({ status: 'HELD', nights: 2, guests: 2, totalKes: 20_000, depositKes: 6_000, balanceKes: 14_000, roomsKes: 20_000, activitiesKes: 0, activities: [] });
    expect(b.rooms).toEqual([{ slug: 'test-pair', name: 'Test Pair', kind: 'Test', units: 1, totalKes: 20_000,
      nightly: [{ night: inDays(50), rateKes: 10_000 }, { night: inDays(51), rateKes: 10_000 }] }]);
    expect(b.ref).toMatch(/^SE-[23456789A-HJKMNP-Z]{6}$/);
    expect(new Date(b.holdExpiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    expect(res.body.url).toBe(`http://localhost:8000/booking.html#${b.ref}.${res.body.token}`);
    // The link carries the guest's name, not their contact details (links get forwarded).
    expect(b.guest).toEqual({ firstName: 'Amina', lastName: 'Otieno' });
    expect(JSON.stringify(b)).not.toMatch(/amina@example\.com|712345678/);
  });

  it('stores the phone in one form and the email in lower case', async () => {
    const res = await book('test-pair', inDays(50), inDays(51), { email: 'Amina@Example.COM', phone: '+254 712-345-678' });
    const [row] = await db.select().from(bookings).where(eq(bookings.ref, res.body.booking.ref));
    expect(row).toMatchObject({ email: 'amina@example.com', phone: '+254712345678' });
  });

  it('counts held units as taken', async () => {
    await book('test-pair', inDays(50), inDays(53));
    expect(roomIn(await search(inDays(51), inDays(52)), 'test-pair').left).toBe(1);
    await book('test-pair', inDays(52), inDays(54));
    const res = await search(inDays(52), inDays(53));
    expect(roomIn(res, 'test-pair').available).toBe(false);
    expect((await book('test-pair', inDays(52), inDays(53))).status).toBe(409);
  });

  it('frees the check-out day for the next guest', async () => {
    await book('test-solo', inDays(60), inDays(63));
    expect((await book('test-solo', inDays(63), inDays(65))).status).toBe(201);   // arrives as the first leaves
    expect((await book('test-solo', inDays(58), inDays(60))).status).toBe(201);   // leaves as the first arrives
  });

  it('refuses a stay when any single night in it is full', async () => {
    await book('test-solo', inDays(61), inDays(62));                              // one night in the middle
    const res = await book('test-solo', inDays(60), inDays(64));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/has just been booked/);
  });

  it('never lets two guests take the last unit at the same moment', async () => {
    // Ten guests press "Book" on the one Test Solo unit simultaneously.
    const results = await Promise.all(Array.from({ length: 10 }, () => book('test-solo', inDays(70), inDays(72))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(9);
    expect(await unitsHeld(solo)).toBe(1);
  });

  it('never double-books even when two bookings collide mid-way (forced race)', async () => {
    // Real requests finish in about a millisecond, so they rarely overlap by chance. Here both
    // bookings pause for 300 ms right after counting free units: exactly where, without the
    // lock, both would see "1 free" and both insert. With the lock, the second can't even count
    // until the first has committed, so it sees 0 free.
    const input = { rooms: [{ room: 'test-solo', units: 1 }], checkIn: inDays(75), checkOut: inDays(76), guests: 2, ...guest, phone: '+254712345678' };
    const pause = () => new Promise((r) => setTimeout(r, 300));
    const results = await Promise.allSettled([createHold(input, { afterCount: pause }), createHold(input, { afterCount: pause })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.status).toBe(409);
    expect(await unitsHeld(solo)).toBe(1);
  });

  it("doesn't make other room types wait or fail", async () => {
    const results = await Promise.all([
      book('test-solo', inDays(80), inDays(81)), book('test-solo', inDays(80), inDays(81)),
      book('test-pair', inDays(80), inDays(81)), book('test-pair', inDays(80), inDays(81)),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409]);
  });

  it('keeps the price a guest booked at, even if rates change afterwards', async () => {
    const res = await book('test-pair', inDays(90), inDays(92));
    await db.update(roomTypes).set({ baseRateKes: 99_000 }).where(eq(roomTypes.id, pair.id));
    try {
      const { body } = await as(app).get(`/api/bookings/${res.body.booking.ref}`).set('x-booking-token', res.body.token);
      expect(body.booking.totalKes).toBe(20_000);
      expect(body.booking.rooms[0].nightly.map((n) => n.rateKes)).toEqual([10_000, 10_000]);
    } finally {
      await db.update(roomTypes).set({ baseRateKes: 10_000 }).where(eq(roomTypes.id, pair.id));
    }
  });

  it('checks the party fits the rooms', async () => {
    const res = await book('test-pair', inDays(50), inDays(51), { guests: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Those rooms sleep 2 at most, for 3 guests. Please add a room.');
  });

  it('refuses unknown or inactive rooms', async () => {
    expect((await book('no-such-room', inDays(50), inDays(51))).status).toBe(404);
    await db.update(roomTypes).set({ active: false }).where(eq(roomTypes.id, pair.id));
    try {
      expect((await book('test-pair', inDays(50), inDays(51))).status).toBe(404);
      expect(roomIn(await search(inDays(50), inDays(51)), 'test-pair')).toBeUndefined();
    } finally {
      await db.update(roomTypes).set({ active: true }).where(eq(roomTypes.id, pair.id));
    }
  });

  it('refuses fields the browser must not set, and bad guest details', async () => {
    const cases = [
      [{ totalKes: 1 }, 'Unknown field: totalKes'],
      [{ status: 'CONFIRMED' }, 'Unknown field: status'],
      [{ phone: '12345' }, 'phone: must be a Kenyan mobile (0712 345 678) or start with + and the country code'],
      [{ email: 'not-an-email' }, 'email: must be a valid email address'],
      [{ firstName: '<script>' }, 'firstName: may only contain letters, spaces, hyphens and apostrophes'],
      [{ firstName: '   ' }, 'firstName: is required'],
      [{ requests: 'x'.repeat(1001) }, 'requests: must be at most 1000 characters'],
    ];
    for (const [extra, error] of cases) {
      const res = await book('test-pair', inDays(50), inDays(51), extra);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body.error).toBe(error);
    }
  });

  it('accepts names from any language', async () => {
    const res = await book('test-pair', inDays(50), inDays(51), { firstName: 'Wanjikũ', lastName: "O'Brien-Núñez" });
    expect(res.status).toBe(201);
  });
});

describe('booking several rooms', () => {
  it('holds a mix of room types in one booking, one reference and one deposit', async () => {
    const res = await bookRooms({ 'test-pair': 2, 'test-solo': 1 }, inDays(200), inDays(202), { guests: 7 });
    expect(res.status).toBe(201);
    const b = res.body.booking;
    // 2 nights × (2 × 10,000 + 1 × 50,000) = 140,000; deposit 30%
    expect(b).toMatchObject({ guests: 7, totalKes: 140_000, roomsKes: 140_000, depositKes: 42_000, balanceKes: 98_000 });
    expect(b.rooms.map((r) => [r.slug, r.units, r.totalKes])).toEqual([['test-pair', 2, 40_000], ['test-solo', 1, 100_000]]);
    // Every unit of both types is now taken for those nights.
    const after = await search(inDays(200), inDays(202));
    expect(roomIn(after, 'test-pair')).toMatchObject({ available: false, maxUnits: 0 });
    expect(roomIn(after, 'test-solo').available).toBe(false);
  });

  it('counts units, not bookings: two rooms in one booking leave none of two', async () => {
    await bookRooms({ 'test-pair': 2 }, inDays(205), inDays(206), { guests: 4 });
    expect(roomIn(await search(inDays(205), inDays(206)), 'test-pair').available).toBe(false);
    expect((await book('test-pair', inDays(205), inDays(206))).status).toBe(409);
  });

  it('says how many are left when the guest asks for more than that', async () => {
    await book('test-pair', inDays(210), inDays(211));
    const res = await bookRooms({ 'test-pair': 2 }, inDays(210), inDays(211), { guests: 4 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Only 1 Test Pair is left for those dates. Please choose other dates or rooms.');
  });

  it('checks the whole party fits the rooms chosen', async () => {
    const res = await bookRooms({ 'test-pair': 1, 'test-solo': 1 }, inDays(212), inDays(213), { guests: 7 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Those rooms sleep 6 at most, for 7 guests. Please add a room.');
  });

  it('caps a booking at MAX_ROOMS rooms, and wants each type listed once', async () => {
    const seven = await bookRooms({ 'hearthside-room': 7 }, inDays(214), inDays(215));
    expect(seven.status).toBe(400);
    const tooMany = await bookRooms({ 'hearthside-room': 4, 'coalbed-suite': 3 }, inDays(214), inDays(215));
    expect(tooMany.body.error).toBe('rooms: at most 6 rooms in one booking; for larger groups please send an enquiry');
    const twice = await as(app).post('/api/bookings').send({ rooms: [{ room: 'test-pair', units: 1 }, { room: 'test-pair', units: 1 }], checkIn: inDays(214), checkOut: inDays(215), guests: 2, ...guest });
    expect(twice.body.error).toBe('rooms: list each room type once, with how many');
    const none = await as(app).post('/api/bookings').send({ rooms: [], checkIn: inDays(214), checkOut: inDays(215), guests: 2, ...guest });
    expect(none.body.error).toBe('rooms: choose at least one room');
  });

  it('never deadlocks when two group bookings want the same rooms in opposite order', async () => {
    // A asks for pair then solo, B for solo then pair, and both pause mid-way while holding
    // their locks. Without a fixed lock order each could hold one type and wait forever for the
    // other. With it, B simply waits for A: exactly one wins (there's one solo), and neither
    // fails with a database error.
    const pause = () => new Promise((r) => setTimeout(r, 300));
    const base = { checkIn: inDays(220), checkOut: inDays(221), guests: 4, ...guest, phone: '+254712345678' };
    const a = createHold({ ...base, rooms: [{ room: 'test-pair', units: 1 }, { room: 'test-solo', units: 1 }] }, { afterCount: pause });
    const b = createHold({ ...base, rooms: [{ room: 'test-solo', units: 1 }, { room: 'test-pair', units: 1 }] }, { afterCount: pause });
    const results = await Promise.allSettled([a, b]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.status).toBe(409);
    expect(await unitsHeld(solo)).toBe(1);
  });

  it('works out the largest party a few rooms can sleep', () => {
    const types = [{ sleeps: 2, free: 12 }, { sleeps: 3, free: 6 }, { sleeps: 4, free: 1 }];
    expect(largestParty(types, 6)).toBe(4 + 5 * 3);       // the 4-bed, then five 3-beds
    expect(largestParty(types, 1)).toBe(4);
    expect(largestParty([{ sleeps: 2, free: 0 }], 6)).toBe(0);
  });
});

describe('expired holds', () => {
  const lapse = (ref) => db.update(bookings).set({ holdExpiresAt: sql`now() - interval '1 second'` }).where(eq(bookings.ref, ref));

  it('free the unit the moment they lapse, before any job has run', async () => {
    const first = await book('test-solo', inDays(110), inDays(112));
    expect((await book('test-solo', inDays(110), inDays(112))).status).toBe(409);
    await lapse(first.body.booking.ref);
    expect((await book('test-solo', inDays(110), inDays(112))).status).toBe(201);
  });

  it('show as EXPIRED to the guest, and the job tidies them', async () => {
    const res = await book('test-pair', inDays(110), inDays(111));
    await lapse(res.body.booking.ref);
    const view = await as(app).get(`/api/bookings/${res.body.booking.ref}`).set('x-booking-token', res.body.token);
    expect(view.body.booking).toMatchObject({ status: 'EXPIRED', holdExpiresAt: null });
    expect(await expireHolds()).toBe(1);
    const [row] = await db.select().from(bookings).where(eq(bookings.ref, res.body.booking.ref));
    expect(row.status).toBe('EXPIRED');
    expect(await expireHolds()).toBe(0);
  });

  it("go by the database's clock, even when this server's clock is behind it", async () => {
    // Render's clock and Neon's clock are never exactly in step. Holds are created, counted and
    // expired by the database's clock, so "has it run out?" must be too. Here the API's clock
    // runs five minutes slow: the guest must still see EXPIRED, because the room is already free.
    const res = await book('test-pair', inDays(110), inDays(111));
    await lapse(res.body.booking.ref);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 5 * 60_000));   // this server five minutes slow
    try {
      const view = await as(app).get(`/api/bookings/${res.body.booking.ref}`).set('x-booking-token', res.body.token);
      expect(view.body.booking).toMatchObject({ status: 'EXPIRED', holdExpiresAt: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aren't touched while still running", async () => {
    await book('test-pair', inDays(110), inDays(111));
    expect(await expireHolds()).toBe(0);
  });
});

describe('the free count', () => {
  it('never goes below zero, even if units were lowered under the rooms booked', async () => {
    expect((await book('test-solo', inDays(140), inDays(141))).status).toBe(201);
    await db.update(roomTypes).set({ units: 0 }).where(eq(roomTypes.id, solo.id));   // straight in the database
    try {
      expect((await freeUnits({ checkIn: inDays(140), checkOut: inDays(141), roomTypeId: solo.id })).get(solo.id)).toBe(0);
    } finally {
      await db.update(roomTypes).set({ units: 1 }).where(eq(roomTypes.id, solo.id));
    }
  });
});

describe('reading a booking', () => {
  it('needs the token from the link, and says the same for a wrong token as for no booking', async () => {
    const res = await book('test-pair', inDays(150), inDays(151));
    const { ref } = res.body.booking;
    const ok = await as(app).get(`/api/bookings/${ref}`).set('x-booking-token', res.body.token);
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');

    const noToken = await as(app).get(`/api/bookings/${ref}`);
    const wrongRef = await as(app).get('/api/bookings/SE-ZZZZZZ').set('x-booking-token', res.body.token);
    const junk = await as(app).get('/api/bookings/../../etc/passwd');
    for (const r of [noToken, wrongRef]) {
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('Booking not found. Please use the link from your confirmation.');
    }
    expect(junk.status).toBe(404);
  });

  it('accepts the reference in lower case (typed by hand)', async () => {
    const res = await book('test-pair', inDays(150), inDays(151));
    const r = await as(app).get(`/api/bookings/${res.body.booking.ref.toLowerCase()}`).set('x-booking-token', res.body.token);
    expect(r.status).toBe(200);
  });
});

describe('the database itself', () => {
  it('refuses impossible rows even if the API had a bug', async () => {
    const base = { ref: 'SE-TESTXX', guests: 2, totalKes: 10_000, depositKes: 3_000, status: 'CONFIRMED', ...guest };
    const insert = (over) => db.insert(bookings).values({ ...base, checkIn: addDays(inDays(5), 0), checkOut: inDays(6), nights: 1, ...over });
    await expect(insert({ checkOut: inDays(5), nights: 0 })).rejects.toThrow();            // no nights
    await expect(insert({ nights: 3 })).rejects.toThrow();                                  // nights don't match the dates
    await expect(insert({ depositKes: 20_000 })).rejects.toThrow();                         // deposit over total
    await expect(insert({ status: 'HELD', holdExpiresAt: null })).rejects.toThrow();        // a hold with no expiry
  });
});
