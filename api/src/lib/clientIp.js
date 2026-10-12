// clientIp.js: who is really asking?
//
// Requests reach the API two ways:
//   guest → Netlify (/api proxy) → Render → us       (every request from the site)
//   anything → Render → us                           (payment callbacks, curl, attackers)
// Behind the proxy, the connection comes from Netlify's servers, so req.ip is Netlify, not
// the guest. Netlify puts the guest's IP in `x-nf-client-connection-ip`, but a header is
// just text: anyone calling Render directly could send a fake one to dodge rate limits.
// So that header is believed only when the request also carries a valid `x-nf-sign`
// signature, which only Netlify can produce because only Netlify and we know the secret.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const b64url = (buf) => buf.toString('base64url');

/**
 * Verifies Netlify's signed-proxy token: a JWS (header.payload.signature) signed with
 * HMAC-SHA256. Returns the payload if valid, otherwise null. Never throws on bad input.
 */
export function verifyNetlifySignature(token, secret = config.NETLIFY_PROXY_SECRET, now = Date.now()) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const expected = Buffer.from(b64url(createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest()));
  const given = Buffer.from(sigB64);
  // timingSafeEqual compares in constant time, so an attacker can't guess the signature
  // byte by byte from how long the comparison takes. Lengths must match first.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let header, payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;                        // no algorithm tricks
  if (payload.iss !== 'netlify') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null; // expired
  return payload;
}

/** The guest's IP when the request came through our signed Netlify proxy, else req.ip. */
export function clientIp(req) {
  const forwarded = req.get('x-nf-client-connection-ip');
  if (forwarded && verifyNetlifySignature(req.get('x-nf-sign'))) return forwarded.trim();
  return req.ip;
}

