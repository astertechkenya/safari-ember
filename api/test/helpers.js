// Test helpers: build a token exactly as Netlify's signed proxy does (HS256 JWS).
import { createHmac } from 'node:crypto';

export const TEST_SECRET = 'test-only-secret-that-is-long-enough-123';

export function netlifyToken({ secret = TEST_SECRET, exp = Math.floor(Date.now() / 1000) + 60, iss = 'netlify', alg = 'HS256' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = enc({ alg, typ: 'JWT' });
  const body = enc({ deploy_context: 'production', exp, iss, site_url: 'https://safari-ember.netlify.app' });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// ── Requests ──────────────────────────────────────────────────────────────────────────────
// Every request looks like it came through Netlify from its OWN IP, so one test's rate-limit
// count never affects another's. `sameIp` pins a series of requests to one IP (to test limits).
import request from 'supertest';

let ipCounter = 0;
export const freshIp = () => `10.9.${Math.floor(ipCounter / 250) % 250}.${(ipCounter++ % 250) + 1}`;

export function as(app, ip = freshIp()) {
  const wrap = (m) => (url) => request(app)[m](url).set('x-nf-sign', netlifyToken()).set('x-nf-client-connection-ip', ip);
  return { get: wrap('get'), post: wrap('post'), ip };
}

// ── Dates ─────────────────────────────────────────────────────────────────────────────────
import { addDays, todayInNairobi } from '../src/lib/dates.js';
/** A date `n` days after today at the lodge: always in the future, always within the horizon. */
export const inDays = (n) => addDays(todayInNairobi(), n);
