// session.js: who is signed in to the admin, remembered with a cookie. Ported from NURA.
//
// The cookie holds only a random session ID. Everything else (which admin, whether they've
// entered their code) lives in the `sessions` table, so the browser never holds anything worth
// stealing except that ID, and the cookie is set up so page JavaScript can't read even that.
// Only /api/admin uses sessions: guests never get a cookie from Safari Ember.
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { config } from '../config.js';
import { pool } from '../db/client.js';

const PgStore = connectPgSimple(session);

export const sessionStore = new PgStore({
  pool,
  tableName: 'sessions',            // created by our Drizzle migration (0003), not by the library
  createTableIfMissing: false,
  // Delete expired sessions every 6 hours (the 15-minute default would wake Neon 96 times a day
  // for nothing: an expired session is refused when read anyway).
  pruneSessionInterval: config.isTest ? false : 6 * 60 * 60,
});

export const SESSION_COOKIE = 'se.sid';
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

export const sessionMiddleware = session({
  store: sessionStore,
  name: SESSION_COOKIE,
  secret: config.SESSION_SECRET,
  resave: false,                    // don't rewrite unchanged sessions on every request
  saveUninitialized: false,         // no cookie at all until someone signs in
  rolling: true,                    // each visit pushes the expiry forward
  proxy: true,                      // Netlify/Render terminate HTTPS in front of us
  cookie: {
    httpOnly: true,                 // invisible to page JavaScript: an injected script can't steal it
    secure: config.isProd,          // only ever sent over HTTPS in production
    sameSite: 'lax',                // not sent on cross-site form posts (CSRF protection, layer 1)
    maxAge: TWELVE_HOURS_MS,        // a working day at reception; the gate also ends 8 idle hours
  },
});
