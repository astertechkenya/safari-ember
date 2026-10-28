// totp.js: the six-digit codes from an authenticator app (Google Authenticator, Authy...).
//
// The standard (RFC 6238) is small enough to write out, so no extra dependency: the app and
// the server share a secret; every 30 seconds both compute HMAC-SHA1(secret, time-step) and
// cut it down to 6 digits. A stolen password alone is no longer enough to get into the admin.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';   // base32: what authenticator apps expect

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error('not base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new random secret (160 bits), as the base32 text you type into the app. */
export const newSecret = () => base32Encode(randomBytes(20));

/** The code for one 30-second step. */
export function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  const n = ((h[offset] & 127) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

/** True if `code` is right now, or one step either side (phone clocks drift a little). */
export function verifyCode(secret, code, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return false;
  const step = Math.floor(now / 30_000);
  return [-1, 0, 1].some((d) => timingSafeEqual(Buffer.from(codeAt(secret, step + d)), Buffer.from(String(code))));
}

/** The link authenticator apps understand (also what a QR code would contain). */
export const otpauthUrl = (secret, email) =>
  `otpauth://totp/Safari%20Ember:${encodeURIComponent(email)}?secret=${secret}&issuer=Safari%20Ember&digits=6&period=30`;
