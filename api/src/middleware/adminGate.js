// adminGate.js: who may use /api/admin, decided again on EVERY request. Ported from NURA.
//
//   not signed in      → 401
//   DEMO_ADMIN         → may look (GET) at everything, with guests' names, emails and phones
//                        masked; any change → 403. The account portfolio visitors use.
//   ADMIN              → everything, after the six-digit code from their authenticator app
//
// The account is read from the database each time, never trusted from the session: removing
// or demoting an admin takes effect on their very next click. Sessions end after 8 hours idle.
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { admins } from '../db/schema.js';
import { config } from '../config.js';
import { httpError } from './errors.js';
import { SESSION_COOKIE } from './session.js';

export const ADMIN_IDLE_MS = 8 * 60 * 60 * 1000;
const READ = new Set(['GET', 'HEAD']);

/** Does this admin still need to enter a code in this session? */
export function needsTotp(admin, session) {
  if (admin.role !== 'ADMIN') return false;
  if (!admin.totpSecret) return config.isProd;             // production: two-factor is compulsory
  return !session.totpVerifiedAt;
}

export async function adminGate(req, res, next) {
  const id = req.session?.adminId;
  const [a] = id ? await db.select().from(admins).where(eq(admins.id, id)) : [];
  if (!a) return next(httpError(401, 'Please sign in.'));

  const now = Date.now();
  if (req.session.adminSeenAt && now - req.session.adminSeenAt > ADMIN_IDLE_MS) {
    await new Promise((ok) => req.session.destroy(() => ok()));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    return next(httpError(401, 'Your session ended after 8 hours idle. Please sign in again.'));
  }
  req.session.adminSeenAt = now;

  req.admin = a;
  req.masked = a.role === 'DEMO_ADMIN';
  // "Who am I" and the code check must work before the code is entered.
  const open = req.path === '/me' || req.path === '/login/code';
  if (!open && needsTotp(a, req.session)) {
    const err = httpError(401, a.totpSecret ? 'Enter the code from your authenticator app.' : 'Two-factor isn’t set up for this admin. Run npm run create-admin.');
    err.needsTotp = true;
    return next(err);
  }
  if (req.masked && !READ.has(req.method) && req.path !== '/login/code') {
    return next(httpError(403, 'The demo admin can look around but can’t change anything.'));
  }
  next();
}
