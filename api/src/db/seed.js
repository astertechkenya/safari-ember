// seed.js: the starting data: the three room types on the site and the trips guests can add
// to a stay.
//
//   npm run db:seed
//
// Safe to run again: room types already present (by slug) are left alone, and a room type that
// So it never overwrites prices the lodge has changed in the admin.
//
// Placeholder numbers for the portfolio (docs/BLUEPRINT.md, "Rooms"). One nightly rate per room
// type, all year (no seasonal prices).
import { fileURLToPath } from 'node:url';
import { db, pool } from './client.js';
import { roomTypes, activities } from './schema.js';

export const ROOM_TYPES = [
  {
    slug: 'hearthside-room', name: 'Hearthside Room', kind: 'Deluxe', sleeps: 2, units: 12, baseRateKes: 28_000, sort: 1,
    description: 'Rich amber tones, king bed, and a private terrace with sweeping city views. Handcrafted furniture, Italian linens, and a deep soaking tub.',
  },
  {
    slug: 'coalbed-suite', name: 'The Coalbed Suite', kind: 'Junior Suite', sleeps: 3, units: 6, baseRateKes: 45_000, sort: 2,
    description: 'A split-level sanctuary dressed in velvet and warm oak. Features a freestanding soaking tub, parlour lounge, and private butler service.',
  },
  {
    slug: 'ember-penthouse', name: 'The Ember Penthouse', kind: 'Penthouse', sleeps: 4, units: 1, baseRateKes: 120_000, sort: 3,
    description: 'Our crown jewel. Panoramic floor-to-ceiling views, a dedicated private butler, bespoke in-room dining, and a rooftop terrace for exclusive use.',
  },
];

// Trips the lodge runs from Thika: transport and a guide, at set departure times. Placeholder
// prices for the portfolio. Entry fees belong to the places themselves (Kenya Wildlife Service,
// the Giraffe Centre) and are paid at the gate, so they're not in the price; each summary says so.
export const ACTIVITIES = [
  {
    slug: 'nairobi-national-park', name: 'Nairobi National Park game drive', sort: 1,
    summary: 'A guided game drive in an open safari vehicle: lions, rhinos and giraffes with the city skyline behind them. Park entry fees are paid at the gate.',
    durationMinutes: 300, priceKes: 9_500, seats: 6, departureTimes: ['06:30', '14:30'],
  },
  {
    slug: 'giraffe-centre', name: 'Giraffe Centre', sort: 2,
    summary: 'Meet the endangered Rothschild’s giraffes at eye level from the raised platform. Return transfer and a guide; the centre’s entry fee is paid at the door.',
    durationMinutes: 240, priceKes: 5_500, seats: 10, departureTimes: ['09:30', '13:30'],
  },
  {
    slug: 'nairobi-safari-walk', name: 'Nairobi Safari Walk', sort: 3,
    summary: 'A raised boardwalk through wetland, savannah and forest, past animals rescued and cared for by Kenya Wildlife Service. Return transfer and a guide; entry is paid at the gate.',
    durationMinutes: 240, priceKes: 5_000, seats: 10, departureTimes: ['09:00', '14:00'],
  },
];

export async function seed({ log = console.log } = {}) {
  for (const rt of ROOM_TYPES) {
    const [inserted] = await db.insert(roomTypes).values(rt).onConflictDoNothing({ target: roomTypes.slug }).returning();
    log(`${inserted ? 'added  ' : 'kept   '} ${rt.name}`);
  }
  // Activities already present (by slug) are left alone, like room types.
  for (const a of ACTIVITIES) {
    const [inserted] = await db.insert(activities).values(a).onConflictDoNothing({ target: activities.slug }).returning();
    log(`${inserted ? 'added  ' : 'kept   '} ${a.name}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await seed();
    console.log('Seed done.');
  } catch (err) {
    console.error('Seed failed:', err.message);
    if (err.cause?.message) console.error('Reason:', err.cause.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
