// seed.js: the starting data: the three room types on the site and their seasonal prices.
//
//   npm run db:seed
//
// Safe to run again: room types already present (by slug) are left alone, and a room type that
// already has seasonal rates gets none added. So it never overwrites prices the lodge has
// changed in the admin area (Phase 5).
//
// Placeholder numbers for the portfolio (docs/BLUEPRINT.md, "Rooms"). Seasons follow the Kenyan
// safari calendar: the Great Migration (July to October) and Christmas/New Year are peak; the
// long rains (April to May) are quiet.
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from './client.js';
import { roomTypes, seasonalRates } from './schema.js';

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

// Percent of the base rate, rounded to the nearest 500 shillings (prices people would actually set).
const SEASONS = [
  { label: 'Long rains', from: '04-01', to: '06-01', pct: 85 },
  { label: 'Migration season', from: '07-01', to: '11-01', pct: 125 },
  { label: 'Festive season', from: '12-20', to: '01-04', pct: 135 },   // runs into the next year
];
const round500 = (n) => Math.round(n / 500) * 500;

export function seasonsFor(baseRateKes, years) {
  return years.flatMap((y) => SEASONS.map((s) => ({
    label: s.label,
    startsOn: `${y}-${s.from}`,
    endsOn: s.to < s.from ? `${y + 1}-${s.to}` : `${y}-${s.to}`,
    nightlyRateKes: round500((baseRateKes * s.pct) / 100),
  })));
}

export async function seed({ log = console.log, years } = {}) {
  const thisYear = new Date().getUTCFullYear();
  years ??= [thisYear, thisYear + 1, thisYear + 2];   // covers the 18-month booking horizon
  for (const rt of ROOM_TYPES) {
    const [inserted] = await db.insert(roomTypes).values(rt).onConflictDoNothing({ target: roomTypes.slug }).returning();
    const [row] = inserted ? [inserted] : await db.select().from(roomTypes).where(eq(roomTypes.slug, rt.slug));
    const { rows: [{ n }] } = await db.execute(sql`select count(*)::int as n from seasonal_rates where room_type_id = ${row.id}`);
    if (n === 0) {
      await db.insert(seasonalRates).values(seasonsFor(row.baseRateKes, years).map((s) => ({ ...s, roomTypeId: row.id })));
    }
    log(`${inserted ? 'added  ' : 'kept   '} ${rt.name}${n === 0 ? ' (+ seasonal rates)' : ''}`);
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
