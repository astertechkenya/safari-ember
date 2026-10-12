// phone.js: one stored form for every phone number: +<country><number> (E.164).
//
// Lodge guests come from everywhere, so a phone may be Kenyan or international:
//   Kenyan mobiles in any usual form  0712 345 678, 712345678, 254712345678, +254 712-345-678
//                                     → +254712345678
//   anything else must start with +   +44 7700 900123 → +447700900123
// M-Pesa (Phase 3) is offered only for Kenyan mobiles; isKenyanMobile tells which.
// The Kenyan rule is NURA's (lib/kenya.js), extended with the international case.

export function normalisePhone(input) {
  const raw = String(input ?? '').replace(/[\s\-().]/g, '');
  const ke = raw.match(/^(?:\+?254|0)?([17]\d{8})$/);
  if (ke) return `+254${ke[1]}`;
  // E.164: a + then a country code that doesn't start with 0, up to 15 digits in all.
  const intl = raw.match(/^\+([1-9]\d{6,14})$/);
  return intl ? `+${intl[1]}` : null;
}

export const isKenyanMobile = (e164) => /^\+254[17]\d{8}$/.test(String(e164 ?? ''));
