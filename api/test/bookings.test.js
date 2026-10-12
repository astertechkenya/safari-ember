// The booking engine against a real Postgres: availability, holds, overbooking, expiry, closures.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { roomTypes, seasonalRates, closures, bookings } from '../src/db/schema.js';
import { expireHolds, createHold } from '../src/services/bookings.js';
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
  await db.execute(sql`truncate bookings, booking_nights, closures restart identity cascade`);
});

const guest = { firstName: 'Amina', lastName: 'Otieno', email: 'amina@example.com', phone: '0712345678' };
const book = (room, checkIn, checkOut, extra = {}) =>
  as(app).post('/api/bookings').send({ room, checkIn, checkOut, guests: 2, ...guest, ...extra });
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
    expect(roomIn(res, 'test-pair')).toMatchObject({ available: true, fits: true, totalKes: 30_000, depositKes: 9_000, balanceKes: 21_000 });
  });

  it('says how many are left only when few are', async () => {
    const res = await search(inDays(40), inDays(42));
    expect(roomIn(res, 'test-pair').left).toBe(2);
    expect(roomIn(res, 'hearthside-room').left).toBeNull();   // 12 units: not advertised
  });

  it('marks rooms too small for the party, and asks for more rooms when nothing fits', async () => {
    const three = await search(inDays(40), inDays(42), 3);
    expect(roomIn(three, 'test-pair')).toMatchObject({ fits: false, available: false });
    expect(roomIn(three, 'test-solo')).toMatchObject({ fits: true, available: true });
    expect(three.body.needsMoreRooms).toBe(false);
    const five = await search(inDays(40), inDays(42), 5);
    expect(five.body.needsMoreRooms).toBe(true);
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
    expect(b).toMatchObject({ status: 'HELD', nights: 2, guests: 2, totalKes: 20_000, depositKes: 6_000, balanceKes: 14_000, room: { slug: 'test-pair' } });
    expect(b.ref).toMatch(/^SE-[23456789A-HJKMNP-Z]{6}$/);
    expect(b.nightly).toHaveLength(2);
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
    const { rows: [{ n }] } = await db.execute(sql`select count(*)::int as n from bookings where room_type_id = ${solo.id}`);
    expect(n).toBe(1);
  });

  it('never double-books even when two bookings collide mid-way (forced race)', async () => {
    // Real requests finish in about a millisecond, so they rarely overlap by chance. Here both
    // bookings pause for 300 ms right after counting free units: exactly where, without the
    // lock, both would see "1 free" and both insert. With the lock, the second can't even count
    // until the first has committed, so it sees 0 free.
    const input = { room: 'test-solo', checkIn: inDays(75), checkOut: inDays(76), guests: 2, ...guest, phone: '+254712345678' };
    const pause = () => new Promise((r) => setTimeout(r, 300));
    const results = await Promise.allSettled([createHold(input, { afterCount: pause }), createHold(input, { afterCount: pause })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected').reason.status).toBe(409);
    const { rows: [{ n }] } = await db.execute(sql`select count(*)::int as n from bookings where room_type_id = ${solo.id}`);
    expect(n).toBe(1);
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
      expect(body.booking.nightly.map((n) => n.rateKes)).toEqual([10_000, 10_000]);
    } finally {
      await db.update(roomTypes).set({ baseRateKes: 10_000 }).where(eq(roomTypes.id, pair.id));
    }
  });

  it('applies seasonal rates to holds', async () => {
    const [s] = await db.insert(seasonalRates).values({ roomTypeId: pair.id, label: 'Test season', startsOn: inDays(101), endsOn: inDays(102), nightlyRateKes: 15_000 }).returning();
    try {
      const res = await book('test-pair', inDays(100), inDays(103));
      expect(res.body.booking.nightly.map((n) => n.rateKes)).toEqual([10_000, 15_000, 10_000]);
      expect(res.body.booking.totalKes).toBe(35_000);
      expect(res.body.booking.depositKes).toBe(10_500);
    } finally {
      await db.delete(seasonalRates).where(eq(seasonalRates.id, s.id));
    }
  });

  it('checks the party fits the room', async () => {
    const res = await book('test-pair', inDays(50), inDays(51), { guests: 3 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Test Pair sleeps at most 2');
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

  it("aren't touched while still running", async () => {
    await book('test-pair', inDays(110), inDays(111));
    expect(await expireHolds()).toBe(0);
  });
});

describe('closures', () => {
  it('take units out of sale for their nights only', async () => {
    await db.insert(closures).values({ roomTypeId: pair.id, startsOn: inDays(120), endsOn: inDays(122), units: 1, reason: 'Repainting' });
    expect(roomIn(await search(inDays(120), inDays(121)), 'test-pair').left).toBe(1);
    expect(roomIn(await search(inDays(122), inDays(123)), 'test-pair').left).toBe(2);   // ends_on is free
    await book('test-pair', inDays(121), inDays(122));
    expect((await book('test-pair', inDays(121), inDays(122))).status).toBe(409);
  });

  it('can close every room type at once', async () => {
    await db.insert(closures).values({ roomTypeId: null, startsOn: inDays(130), endsOn: inDays(131), reason: 'Private event' });
    const res = await search(inDays(129), inDays(132));
    expect(res.body.rooms.every((r) => !r.available)).toBe(true);
    expect((await search(inDays(131), inDays(132))).body.rooms.some((r) => r.available)).toBe(true);
  });

  it('never make the free count negative', async () => {
    await db.insert(closures).values({ roomTypeId: solo.id, startsOn: inDays(140), endsOn: inDays(141), units: 5, reason: 'Overlapping closures' });
    await db.insert(closures).values({ roomTypeId: null, startsOn: inDays(140), endsOn: inDays(141), reason: 'And another' });
    expect((await freeUnits({ checkIn: inDays(140), checkOut: inDays(141), roomTypeId: solo.id })).get(solo.id)).toBe(0);
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
    const base = { ref: 'SE-TESTXX', roomTypeId: pair.id, guests: 2, totalKes: 10_000, depositKes: 3_000, status: 'CONFIRMED', ...guest };
    const insert = (over) => db.insert(bookings).values({ ...base, checkIn: addDays(inDays(5), 0), checkOut: inDays(6), nights: 1, ...over });
    await expect(insert({ checkOut: inDays(5), nights: 0 })).rejects.toThrow();            // no nights
    await expect(insert({ nights: 3 })).rejects.toThrow();                                  // nights don't match the dates
    await expect(insert({ depositKes: 20_000 })).rejects.toThrow();                         // deposit over total
    await expect(insert({ status: 'HELD', holdExpiresAt: null })).rejects.toThrow();        // a hold with no expiry
  });
});
