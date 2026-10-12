// config.js: the only place that reads process.env.
//
// Every setting is validated once, at startup. If something is missing or malformed the
// server refuses to start and says exactly what is wrong. That is much better than
// starting "fine" and failing halfway through a booking because a setting was never made.
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // postgres://user:password@host/dbname?sslmode=require  (Neon gives you this string)
  // Production (Render) must use sslmode=verify-full and the app login, never an owner (below).
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

  // The site's public address. Used to build links in emails and payment redirects, and to
  // decide which other websites may NOT send us bookings (middleware/sameOrigin.js).
  SITE_URL: z.url().default('http://localhost:8000'),

  // Signs the guest's "view your booking" link (lib/bookingLink.js) and, from Phase 5, the
  // admin's sign-in cookie. Long, random, different per environment, never committed.
  // Changing it makes every booking link already emailed stop working, so only change it if it leaks.
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters (generate one, see api/.env.example)'),

  // Shared secret between Netlify and this API. Netlify signs every request it proxies with it
  // (the x-nf-sign header). Only signed requests may tell us the guest's real IP (lib/clientIp.js).
  // Leave unset locally.
  NETLIFY_PROXY_SECRET: z.string().min(32, 'must be at least 32 characters').optional(),

  // ── Booking rules (docs/BLUEPRINT.md, "The booking rules") ───────────────────────────────
  // Percentage of the stay paid online to confirm. The balance is paid at the lodge.
  DEPOSIT_PERCENT: z.coerce.number().int().min(1).max(100).default(30),
  // How long a started booking holds its room while the guest pays.
  HOLD_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  // Longest stay, and how far ahead a stay may start.
  MAX_NIGHTS: z.coerce.number().int().min(1).max(365).default(30),
  BOOKING_HORIZON_MONTHS: z.coerce.number().int().min(1).max(36).default(18),
  // Show "only N left" when this few units or fewer are free. Above it, just "available":
  // a lodge doesn't want to advertise exactly how empty it is.
  FEW_LEFT: z.coerce.number().int().min(0).max(20).default(3),
});

function load(env) {
  // "KEY=" with nothing after it means "not set", as in .env.example.
  const given = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(given);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Throwing here stops the process before it listens on a port.
    throw new Error(`Invalid environment configuration:\n${problems}\nSee api/.env.example.`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    const db = new URL(c.DATABASE_URL);
    const rules = [];
    // Check Neon's certificate, not only encrypt: without it, anything that can sit between
    // Render and Neon could pose as the database and read every query.
    if (db.searchParams.get('sslmode') !== 'verify-full') rules.push('DATABASE_URL: production must use ?sslmode=verify-full');
    // The live API reads and writes rows; it must never hold the owner login that can drop
    // tables. Neon names owner logins <database>_owner.
    if (/_owner$/.test(decodeURIComponent(db.username))) {
      rules.push(`DATABASE_URL: production must connect as the limited app login, not ${decodeURIComponent(db.username)}`);
    }
    if (rules.length) throw new Error(`Invalid environment configuration:\n${rules.map((r) => `  - ${r}`).join('\n')}`);
  }
  return Object.freeze({ ...c, isProd: c.NODE_ENV === 'production', isTest: c.NODE_ENV === 'test' });
}

export const config = load(process.env);
export { load as loadConfig }; // exported for tests
