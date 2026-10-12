// fields.js: how a guest's details must look, shared by bookings and enquiries.
import { z } from 'zod';
import { normalisePhone } from './phone.js';

// Letters from any language (é, ñ, Ø, Wanjikũ), spaces, apostrophes, hyphens and dots.
// Digits and symbols are refused: they're never part of a name, and refusing them keeps
// markup and links out of anything the lodge will read.
export const personName = z.string().trim()
  .min(1, 'is required').max(60, 'is too long')
  .regex(/^\p{L}[\p{L}\p{M} .'’-]*$/u, 'may only contain letters, spaces, hyphens and apostrophes');

export const email = z.string().trim().toLowerCase().max(254, 'is too long').pipe(z.email('must be a valid email address'));

export const phone = z.string().trim().max(30)
  .transform((s, ctx) => {
    const p = normalisePhone(s);
    if (!p) {
      ctx.addIssue({ code: 'custom', message: 'must be a Kenyan mobile (0712 345 678) or start with + and the country code' });
      return z.NEVER;
    }
    return p;
  });

/** Free text: trimmed, length-capped, and empty treated as "not given". */
export const freeText = (max) => z.string().trim().max(max, `must be at most ${max} characters`)
  .transform((s) => s || undefined).optional();
