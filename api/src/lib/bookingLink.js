// bookingLink.js: the guest's private "view your booking" link.
//
// Guests don't have accounts, so the link itself must prove "this came from Safari Ember, for
// this booking, and hasn't expired". It carries an HMAC (a keyed hash) of the booking reference
// and an expiry time, made with SESSION_SECRET. Nobody without the secret can make one, and
// changing the reference or the expiry breaks it. A reference alone (SE-7K3QXM, which a guest
// might read out on the phone or post in a screenshot) never opens a booking.
//
// The token rides in the #fragment of the link, which browsers never send to any server, so it
// can't end up in Netlify's or Render's logs. The page reads it and sends it in a header.
// Adapted from NURA's lib/orderLink.js.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

// Valid until well after any stay could end (bookings open up to 18 months ahead).
export const BOOKING_LINK_DAYS = 600;
const DAY_MS = 24 * 60 * 60 * 1000;

const sign = (ref, exp, secret) =>
  // "booking-view:" keeps these signatures apart from anything else signed with the same secret.
  createHmac('sha256', secret).update(`booking-view:${ref}:${exp}`).digest('base64url');

export function bookingToken(ref, { now = Date.now(), secret = config.SESSION_SECRET } = {}) {
  const exp = Math.floor((now + BOOKING_LINK_DAYS * DAY_MS) / 1000);   // seconds keep it short
  return `${exp}.${sign(ref, exp, secret)}`;
}

/** True only for a token made by bookingToken for this very booking, not yet expired. */
export function bookingTokenValid(ref, token, { now = Date.now(), secret = config.SESSION_SECRET } = {}) {
  const m = /^(\d{10})\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''));
  if (!m || !secret) return false;
  const exp = Number(m[1]);
  if (exp * 1000 < now) return false;
  const expected = Buffer.from(sign(ref, exp, secret));
  const given = Buffer.from(m[2]);
  // Timing-safe: comparing byte by byte and stopping at the first difference would leak,
  // through response times, how much of a forged signature was right.
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The full link for the confirmation page, emails and Paystack's return. Pass the booking's
 * createdAt as `now` and the link is the same every time it's made, so a guest only ever sees one.
 */
export const bookingUrl = (ref, opts) => `${config.SITE_URL}/booking.html#${ref}.${bookingToken(ref, opts)}`;
