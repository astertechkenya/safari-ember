// pricing.js: what a stay costs. Pure functions: no database, no clock, so every rule can be
// tested directly (test/pricing.test.js).
//
// Rules (docs/BLUEPRINT.md, "Prices" and "Deposit"):
//   - Each night costs the room type's base rate, unless a seasonal rate covers that night.
//   - If several seasons cover the same night, the one that starts LATEST wins: a short
//     "Christmas week" inside a long "high season" is the more specific price.
//     (Same start? The one added later, i.e. the higher id.)
//   - Total = sum of the nights. A stay that crosses into a season is priced night by night.
//   - Deposit = DEPOSIT_PERCENT of the total, rounded UP to the next shilling (never under-collect),
//     and never more than the total.
// Money is whole shillings throughout. The deposit maths stays in integers too:
// ceil(total × pct / 100) is computed as a whole-number division, so no 0.1 + 0.2 surprises.
import { nightsOf } from '../lib/dates.js';

/**
 * The price of each night of a stay.
 * @param roomType  { baseRateKes }
 * @param seasons   that room type's seasonal rates: [{ id, label, startsOn, endsOn, nightlyRateKes }]
 * @returns [{ night, rateKes, season }]  season is the label, or null for the base rate
 */
export function priceNights(roomType, checkIn, checkOut, seasons = []) {
  // Most specific first: latest start, then latest added.
  const ordered = [...seasons].sort((a, b) => (a.startsOn === b.startsOn ? b.id - a.id : (a.startsOn < b.startsOn ? 1 : -1)));
  return nightsOf(checkIn, checkOut).map((night) => {
    // Dates are YYYY-MM-DD strings, so plain string comparison is date order.
    const s = ordered.find((x) => x.startsOn <= night && night < x.endsOn);
    return { night, rateKes: s ? s.nightlyRateKes : roomType.baseRateKes, season: s ? s.label : null };
  });
}

export function depositFor(totalKes, percent) {
  // ceil(a / b) for positive integers, without floats: (a + b - 1) / b, floored.
  const deposit = Math.floor((totalKes * percent + 99) / 100);
  return Math.min(Math.max(deposit, 1), totalKes);
}

/** Everything the guest is told about a price: the nights, the total, the deposit, the balance. */
export function quote(roomType, checkIn, checkOut, seasons, depositPercent) {
  const nightly = priceNights(roomType, checkIn, checkOut, seasons);
  const totalKes = nightly.reduce((sum, n) => sum + n.rateKes, 0);
  const depositKes = depositFor(totalKes, depositPercent);
  return { nightly, totalKes, depositKes, balanceKes: totalKes - depositKes, depositPercent };
}
