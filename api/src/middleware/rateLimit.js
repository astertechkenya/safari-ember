// rateLimit.js: "at most N requests per window, per visitor".
//
// Keyed by the real client IP (see lib/clientIp.js). IPv6 users get whole address blocks
// counted together (ipKeyGenerator), because one IPv6 customer can own millions of addresses.
//
// The counts live in memory. That's fine while the API runs as one Render instance; a restart
// resets them. They'd move into Postgres if the API ever ran on several machines.
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { clientIp } from '../lib/clientIp.js';

/**
 * `by` optionally narrows the key: e.g. (req) => req.body.email counts per IP *and* email,
 * so one person mistyping their own password doesn't lock out a whole office sharing one IP.
 *
 * `ipToo: false` counts per `by` ALONE. Use it when `by` is an account that is already signed
 * in (2FA codes, the current password on the account page): otherwise someone holding a stolen
 * session could rotate through IP addresses and get a fresh allowance of guesses on each.
 *
 * `failuresOnly: true` counts only refused attempts (status 400 and up): five WRONG guesses
 * lock it, but an admin signing in correctly on several devices never trips it.
 */
export function limit({ windowMs, max, by, ipToo = true, failuresOnly = false, message = 'Too many requests. Please try again later.' }) {
  if (!ipToo && !by) throw new Error('limit({ ipToo: false }) needs a `by` to count per');
  return rateLimit({
    windowMs,
    limit: max,
    skipSuccessfulRequests: failuresOnly,
    standardHeaders: 'draft-8',   // tells well-behaved clients how long to wait (RateLimit headers)
    legacyHeaders: false,
    keyGenerator: (req) => {
      const who = by ? String(by(req) ?? '').toLowerCase().trim() : '';
      if (!ipToo) return `account|${who}`;
      const ip = ipKeyGenerator(clientIp(req));
      return by ? `${ip}|${who}` : ip;
    },
    handler: (req, res) => res.status(429).json({ error: message }),
    // We deliberately key on our own verified IP, not Express's req.ip.
    validate: { trustProxy: false, xForwardedForHeader: false },
  });
}
