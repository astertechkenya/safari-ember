// Activities added to a stay: listing departures, pricing, schedule rules, and no seat limit.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { roomTypes, activities } from '../src/db/schema.js';
import { bookable, weekdayOf, tripDays } from '../src/services/activities.js';
import { as, inDays } from './helpers.js';

const app = createApp();
afterAll(() => pool.end());

// Test-only room and trips, so numbers don't depend on the seed's placeholders.
let trip, weekly;
beforeAll(async () => {
  await db.insert(roomTypes).values({ slug: 'test-trip-room', name: 'Trip Room', kind: 'Test', description: 'x', sleeps: 4, units: 20, baseRateKes: 10_000, sort: 92 });
  [trip] = await db.insert(activities).values({
    slug: 'test-trip', name: 'Test Trip', summary: 'x', durationMinutes: 120, priceKes: 2_000, seats: 3,
    departureTimes: ['10:00', '15:00'], weekdays: [1, 2, 3, 4, 5, 6, 7], sort: 90,
  }).returning();
  [weekly] = await db.insert(activities).values({
    slug: 'test-weekly', name: 'Weekly Trip', summary: 'x', durationMinutes: 120, priceKes: 1_000, seats: 10,
    departureTimes: ['09:00'], weekdays: [1], sort: 91,                 // Mondays only
  }).returning();
});
beforeEach(async () => {
  await db.execute(sql`truncate bookings, booking_rooms, booking_nights, booking_activities restart identity cascade`);
});

const guest = { firstName: 'Amina', lastName: 'Otieno', email: 'amina@example.com', phone: '0712345678' };
const book = (trips, { checkIn = inDays(60), checkOut = inDays(62), guests = 2, ...extra } = {}) =>
  as(app).post('/api/bookings').send({ rooms: [{ room: 'test-trip-room', units: 1 }], activities: trips, checkIn, checkOut, guests, ...guest, ...extra });
const listFor = (checkIn, checkOut) => as(app).get(`/api/activities?checkIn=${checkIn}&checkOut=${checkOut}`);
const nextMonday = (from) => { let d = from; while (weekdayOf(inDays(d)) !== 1) d += 1; return d; };

describe('listing activities for a stay', () => {
  it('lists the seeded trips with their price per person', async () => {
    const res = await listFor(inDays(60), inDays(62));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const seeded = res.body.activities.filter((a) => !a.slug.startsWith('test-')).map((a) => a.slug);
    expect(seeded).toEqual(['nairobi-national-park', 'giraffe-centre', 'nairobi-safari-walk']);
    expect(res.body.activities[0].summary).toMatch(/paid at the gate/);
  });

  it('offers every departure from check-in to check-out inclusive, with no seat counts', async () => {
    const res = await listFor(inDays(60), inDays(62));
    const t = res.body.activities.find((a) => a.slug === 'test-trip');
    expect(t).toMatchObject({ name: 'Test Trip', priceKes: 2_000, durationMinutes: 120 });
    expect(t.departures).toEqual([60, 61, 62].flatMap((n) => ['10:00', '15:00'].map((time) => ({ day: inDays(n), time }))));
  });

  it('only lists weekdays the trip runs', async () => {
    const mon = nextMonday(60);
    const res = await listFor(inDays(mon - 1), inDays(mon + 1));
    expect(res.body.activities.find((a) => a.slug === 'test-weekly').departures.map((d) => d.day)).toEqual([inDays(mon)]);
  });

  it('stops offering a departure ACTIVITY_CUTOFF_MINUTES before it leaves', () => {
    // 10:00 in Nairobi is 07:00 UTC; the cut-off is 120 minutes.
    expect(bookable('2027-01-10', '10:00', new Date('2027-01-10T04:59:00Z'))).toBe(true);
    expect(bookable('2027-01-10', '10:00', new Date('2027-01-10T05:01:00Z'))).toBe(false);
    expect(tripDays('2027-01-30', '2027-02-01')).toEqual(['2027-01-30', '2027-01-31', '2027-02-01']);
  });
});

describe('adding activities to a booking', () => {
  it('prices them per person into the total and the deposit', async () => {
    const res = await book([{ activity: 'test-trip', day: inDays(61), time: '10:00', people: 2 }]);
    expect(res.status).toBe(201);
    const b = res.body.booking;
    // 2 nights × 10,000 + 2 people × 2,000 = 24,000; deposit 30% = 7,200
    expect(b).toMatchObject({ roomsKes: 20_000, activitiesKes: 4_000, totalKes: 24_000, depositKes: 7_200 });
    expect(b.activities).toEqual([{ slug: 'test-trip', name: 'Test Trip', durationMinutes: 120, day: inDays(61), time: '10:00', people: 2, priceKes: 2_000, totalKes: 4_000 }]);
  });

  it('has no seat limit: staff arrange vehicles for however many book a departure', async () => {
    // Test Trip's vehicle seats 3. Four people on one departure is fine: the lodge adds a
    // vehicle or offers another time, and staff tell the guests (services/activities.js).
    const first = await book([{ activity: 'test-trip', day: inDays(61), time: '10:00', people: 2 }]);
    const second = await book([{ activity: 'test-trip', day: inDays(61), time: '10:00', people: 2 }]);
    expect([first.status, second.status]).toEqual([201, 201]);
    const { rows: [{ n }] } = await db.execute(sql`select sum(people)::int as n from booking_activities where activity_id = ${trip.id}`);
    expect(n).toBe(4);
  });

  it('keeps each trip to the schedule and the party', async () => {
    const mon = nextMonday(70);
    const cases = [
      [[{ activity: 'test-trip', day: inDays(65), time: '10:00', people: 1 }], 400, 'Test Trip must be on a day of your stay'],
      [[{ activity: 'test-trip', day: inDays(61), time: '11:00', people: 1 }], 400, `Test Trip doesn’t leave at 11:00 on ${inDays(61)}`],
      [[{ activity: 'test-trip', day: inDays(61), time: '10:00', people: 3 }], 400, 'Test Trip: at most 2 guests, the size of your party'],
      [[{ activity: 'no-such-trip', day: inDays(61), time: '10:00', people: 1 }], 404, 'One of those activities is not available to book'],
      [[{ activity: 'test-trip', day: inDays(61), time: '10:00', people: 1 }, { activity: 'test-trip', day: inDays(61), time: '10:00', people: 1 }], 400,
        'activities: list each departure once, with how many people'],
      [[{ activity: 'test-trip', day: inDays(61), time: '25:00', people: 1 }], 400, 'activities.0.time: must be a time written as HH:MM'],
    ];
    for (const [trips, status, error] of cases) {
      const res = await book(trips);
      expect(res.status, JSON.stringify(trips)).toBe(status);
      expect(res.body.error).toBe(error);
    }
    const notMonday = await book([{ activity: 'test-weekly', day: inDays(mon + 1), time: '09:00', people: 1 }], { checkIn: inDays(mon), checkOut: inDays(mon + 2) });
    expect(notMonday.body.error).toBe(`Weekly Trip doesn’t leave at 09:00 on ${inDays(mon + 1)}`);
    expect((await book([{ activity: 'test-weekly', day: inDays(mon), time: '09:00', people: 1 }], { checkIn: inDays(mon), checkOut: inDays(mon + 2) })).status).toBe(201);
  });

  it('refuses a trip that has been switched off', async () => {
    await db.update(activities).set({ active: false }).where(eq(activities.id, trip.id));
    try {
      expect((await book([{ activity: 'test-trip', day: inDays(61), time: '10:00', people: 1 }])).status).toBe(404);
      expect((await listFor(inDays(60), inDays(62))).body.activities.some((a) => a.slug === 'test-trip')).toBe(false);
    } finally {
      await db.update(activities).set({ active: true }).where(eq(activities.id, trip.id));
    }
  });

  it('freezes the price per person at booking time', async () => {
    const res = await book([{ activity: 'test-trip', day: inDays(61), time: '10:00', people: 2 }]);
    await db.update(activities).set({ priceKes: 9_999 }).where(eq(activities.id, trip.id));
    try {
      const view = await as(app).get(`/api/bookings/${res.body.booking.ref}`).set('x-booking-token', res.body.token);
      expect(view.body.booking.activities[0]).toMatchObject({ priceKes: 2_000, totalKes: 4_000 });
    } finally {
      await db.update(activities).set({ priceKes: 2_000 }).where(eq(activities.id, trip.id));
    }
  });

  it('refuses activity requests that are unknown fields or the wrong shape', async () => {
    const res = await book([{ activity: 'test-trip', day: inDays(61), time: '10:00', people: 1, priceKes: 1 }]);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown field: activities.0.priceKes');
  });
});
