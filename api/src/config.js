// config.js: the only place that reads process.env.
//
// Every setting is validated once, at startup. If something is missing or malformed the
// server refuses to start and says exactly what is wrong. That is much better than
// starting "fine" and failing halfway through a booking because a setting was never made.
import { z } from 'zod';
import { readFileSync } from 'node:fs';

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
  // Most rooms in one booking (all types together). Bigger groups use the enquiry form.
  MAX_ROOMS: z.coerce.number().int().min(1).max(20).default(6),
  // An activity can be added up to this long before it departs (the lodge needs time to
  // arrange the vehicle and guide).
  ACTIVITY_CUTOFF_MINUTES: z.coerce.number().int().min(0).max(2880).default(120),

  // ── Deposits (Phase 3, adapted from NURA) ──────────────────────────────────────────────────
  // M-Pesa through Safaricom's Daraja API. Offered only when all four DARAJA_* values,
  // PUBLIC_API_URL and MPESA_CALLBACK_SECRET are set.
  DARAJA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  DARAJA_CONSUMER_KEY: z.string().min(1).optional(),
  DARAJA_CONSUMER_SECRET: z.string().min(1).optional(),
  DARAJA_SHORTCODE: z.string().regex(/^\d{5,7}$/, 'must be a paybill or till number').optional(),
  DARAJA_PASSKEY: z.string().min(1).optional(),
  // Where Safaricom posts results: the API's own public https address (Render), not the site.
  // Locally Safaricom can't reach your computer, and that's fine: the booking page's checks ask
  // Safaricom directly, so payments still settle. Any https address works there.
  PUBLIC_API_URL: z.url().optional(),
  // Part of the callback address, so only Safaricom (who we gave it to) knows where to post.
  MPESA_CALLBACK_SECRET: z.string().min(32, 'must be at least 32 characters')
    .regex(/^[A-Za-z0-9_-]+$/, 'may only contain letters, digits, - and _ (generate it with the command in api/.env.example)')
    .optional(),
  // Tests point this at a fake Daraja. Leave unset: the address follows DARAJA_ENV.
  DARAJA_BASE_URL: z.url().optional(),
  // SAFETY: in the sandbox the prompt asks for this many shillings, never the real deposit, so a
  // test can't take a real amount from a real phone. Ignored in production.
  DARAJA_SANDBOX_AMOUNT_KES: z.coerce.number().int().positive().default(1),

  // Cards (and Apple Pay) through Paystack. Guests type card details on Paystack's own page,
  // never on Safari Ember. sk_test_… while testing.
  PAYSTACK_SECRET_KEY: z.string().regex(/^sk_(test|live)_[A-Za-z0-9]+$/, 'must be a Paystack secret key (sk_test_… or sk_live_…)').optional(),
  // Tests point this at a fake Paystack. Leave unset.
  PAYSTACK_BASE_URL: z.url().optional(),
  // Starting a payment keeps the room held for at least this long, so a guest typing their
  // M-Pesa PIN at minute 14 doesn't lose the room at minute 15.
  PAYMENT_GRACE_MINUTES: z.coerce.number().int().min(1).max(30).default(5),

  // Email through Resend (adapted from NURA). Without a key, emails are printed in the terminal
  // (development) or only logged (production): nothing else changes.
  RESEND_API_KEY: z.string().regex(/^re_[A-Za-z0-9_]{10,}$/, 'must be a Resend API key (re_…)').optional(),
  // Who emails come from. onboarding@resend.dev works without a domain of your own, but Resend
  // then only delivers to YOUR account's address: see MAIL_ONLY_TO. With a verified domain,
  // use e.g. "Safari Ember <bookings@yourdomain.co.ke>".
  MAIL_FROM: z.string().min(3).default('Safari Ember <onboarding@resend.dev>'),
  // Comma-separated addresses. When set, email goes ONLY to these; anyone else's (a guest's) is
  // logged as held. Set it to your Resend account email while you have no domain (Resend would
  // refuse the others anyway), and remove it once your domain is verified.
  MAIL_ONLY_TO: z.string().optional()
    .transform((s) => (s ? s.split(',').map((a) => a.trim().toLowerCase()).filter(Boolean) : null))
    // Strict on purpose: "<you@x.com>" would match no real recipient, so every email would be
    // silently held. Better to refuse to start and say why.
    .refine((list) => !list || list.every((a) => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/.test(a)),
      'must be plain email addresses like you@example.com: no < >, quotes, spaces or comments on the line; separate several with commas'),
  // The lodge's address: new-booking and new-enquiry alerts go here, and guests' replies to their
  // emails come here. One plain address. Must be in MAIL_ONLY_TO while that is set.
  LODGE_EMAIL: z.string().trim().toLowerCase()
    .regex(/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/, 'must be one plain email address like you@example.com')
    .optional(),
  // Tests point this at a fake Resend. Leave unset.
  RESEND_BASE_URL: z.url().default('https://api.resend.com'),
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
  // A lodge address outside MAIL_ONLY_TO would be held every time, silently: refuse instead.
  if (c.LODGE_EMAIL && c.MAIL_ONLY_TO && !c.MAIL_ONLY_TO.includes(c.LODGE_EMAIL)) {
    throw new Error('Invalid environment configuration:\n  - LODGE_EMAIL: must also be in MAIL_ONLY_TO, or the lodge\'s alerts are never sent\nSee api/.env.example.');
  }

  // WHICH database. Every Safari Ember database is named ember_… (ember_dev, ember_test, later
  // ember_prod). Anything else is another project's, most often because a terminal window still
  // holds a DATABASE_URL set for it (a variable set in the window beats .env). Refusing here
  // stops the API, migrations, the seed and the tests, before a single query.
  const dbName = decodeURIComponent(new URL(c.DATABASE_URL).pathname.slice(1));
  if (!/^ember_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(`Invalid environment configuration:\n  - DATABASE_URL: points at a database called "${dbName}", `
      + 'but Safari Ember\'s are named ember_… (ember_dev, ember_test). If .env is right, this terminal still '
      + 'has a DATABASE_URL from something else: close it and open a new window (check with: $env:DATABASE_URL).');
  }
  // The tests wipe their database at the start of every run: only ever one named …_test.
  if (c.NODE_ENV === 'test' && !dbName.endsWith('_test')) {
    throw new Error(`Invalid environment configuration:\n  - DATABASE_URL: the tests wipe their database, and "${dbName}" isn't a _test database`);
  }
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
  if (c.NODE_ENV === 'production' && c.PAYSTACK_SECRET_KEY?.startsWith('sk_test_') && c.DARAJA_ENV === 'production') {
    // Mixed modes would confirm real bookings with test cards. Pick one.
    throw new Error('Invalid environment configuration:\n  - PAYSTACK_SECRET_KEY: a test key with DARAJA_ENV=production; use both test or both live');
  }
  const mpesaEnabled = Boolean(c.DARAJA_CONSUMER_KEY && c.DARAJA_CONSUMER_SECRET && c.DARAJA_SHORTCODE
    && c.DARAJA_PASSKEY && c.PUBLIC_API_URL && c.MPESA_CALLBACK_SECRET);
  const cardEnabled = Boolean(c.PAYSTACK_SECRET_KEY);
  const mailEnabled = Boolean(c.RESEND_API_KEY);
  return Object.freeze({ ...c, isProd: c.NODE_ENV === 'production', isTest: c.NODE_ENV === 'test', mpesaEnabled, cardEnabled, mailEnabled });
}

/**
 * On your laptop only: two things in api/.env that cause silent surprises. Warns, never stops.
 *   - a key written twice: the LAST one wins, so an empty copy further down switches a feature off
 *   - DATABASE_URL set in the terminal too: the terminal's wins and .env's is ignored
 * Names only, never values.
 */
function checkEnvFile(env) {
  let text;
  try { text = readFileSync('.env', 'utf8'); } catch { return; }      // no .env: nothing to check
  const seen = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) seen.set(m[1], { count: (seen.get(m[1])?.count ?? 0) + 1, value: m[2].trim().replace(/^(['"])(.*)\1$/, '$2') });
  }
  const twice = [...seen].filter(([, v]) => v.count > 1).map(([k]) => k);
  if (twice.length) console.warn(`[config] api/.env sets these more than once (the last one wins): ${twice.join(', ')}`);
  const fileDb = seen.get('DATABASE_URL')?.value;
  if (fileDb && env.DATABASE_URL && env.DATABASE_URL !== fileDb) {
    console.warn('[config] DATABASE_URL is set in this terminal, so the one in api/.env is ignored. Open a new window to use .env.');
  }
}

if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'production') checkEnvFile(process.env);
export const config = load(process.env);
export { load as loadConfig }; // exported for tests
