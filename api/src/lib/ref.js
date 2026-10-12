// ref.js: booking references like SE-7K3QXM.
//
// What the guest sees, writes down and reads out on the phone, so: short, no letters that
// look like digits (no 0/O, 1/I/L), and random, so references don't reveal how many
// bookings the lodge has. 31 symbols ^ 6 = about 887 million possibilities; the database's unique
// index catches the rare repeat and the booking simply tries a new one (services/bookings.js).
import { randomInt } from 'node:crypto';

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // 31 symbols, none easily confused

export function newRef() {
  let s = '';
  for (let i = 0; i < 6; i += 1) s += ALPHABET[randomInt(ALPHABET.length)];
  return `SE-${s}`;
}

export const REF_PATTERN = /^SE-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/;
