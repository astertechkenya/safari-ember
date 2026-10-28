// pricing.js: what a stay costs. Pure functions: no database, no clock, so every rule can be
// tested directly (test/pricing.test.js).
//
// Rules (docs/BLUEPRINT.md, "Prices" and "Deposit"):
//   - Each night costs the room type's base rate. (There are no seasonal prices: one rate per
//     room type, changed in the admin, keeps pricing predictable for guests and staff.)
//   - Total = sum of the nights. Each night is still stored on its own (booking_nights), so a
//     rate change never alters what an existing guest owes.
//   - A booking's total = every room's nights × its units, plus each activity's price per person
//     × people. The deposit is taken on that whole total.
//   - Deposit = DEPOSIT_PERCENT of the total, rounded UP to the next shilling (never under-collect),
//     and never more than the total.
// Money is whole shillings throughout. The deposit maths stays in integers too:
// ceil(total × pct / 100) is computed as a whole-number division, so no 0.1 + 0.2 surprises.
import { nightsOf } from '../lib/dates.js';

/**
 * The price of each night of a stay.
 * @param roomType  { baseRateKes }
 * @returns [{ night, rateKes }]
 */
export function priceNights(roomType, checkIn, checkOut) {
  return nightsOf(checkIn, checkOut).map((night) => ({ night, rateKes: roomType.baseRateKes }));
}

export function depositFor(totalKes, percent) {
  // ceil(a / b) for positive integers, without floats: (a + b - 1) / b, floored.
  const deposit = Math.floor((totalKes * percent + 99) / 100);
  return Math.min(Math.max(deposit, 1), totalKes);
}

/** Everything the guest is told about a price: the nights, the total, the deposit, the balance. */
export function quote(roomType, checkIn, checkOut, depositPercent) {
  const nightly = priceNights(roomType, checkIn, checkOut);
  const totalKes = nightly.reduce((sum, n) => sum + n.rateKes, 0);
  const depositKes = depositFor(totalKes, depositPercent);
  return { nightly, totalKes, depositKes, balanceKes: totalKes - depositKes, depositPercent };
}

/**
 * The price of a whole booking: several rooms and any activities.
 * @param rooms       [{ units, nightly }]   nightly from priceNights(), for ONE unit
 * @param activities  [{ people, priceKes }] priceKes per person
 */
export function quoteBooking({ rooms, activities = [], depositPercent }) {
  const roomsKes = rooms.reduce((sum, r) => sum + r.units * r.nightly.reduce((s, n) => s + n.rateKes, 0), 0);
  const activitiesKes = activities.reduce((sum, a) => sum + a.people * a.priceKes, 0);
  const totalKes = roomsKes + activitiesKes;
  const depositKes = depositFor(totalKes, depositPercent);
  return { roomsKes, activitiesKes, totalKes, depositKes, balanceKes: totalKes - depositKes, depositPercent };
}
