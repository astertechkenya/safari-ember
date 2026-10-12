// stay.js: the rules for a valid stay, shared by the availability search and booking creation,
// so the two can never disagree about what counts as bookable (docs/BLUEPRINT.md, "Limits").
//
//   - real dates, YYYY-MM-DD
//   - check-out after check-in, at most MAX_NIGHTS nights
//   - check-in from today (Nairobi) to BOOKING_HORIZON_MONTHS ahead
//   - 1 to 20 guests (each room type's own "sleeps" is checked against the room, later)
import { z } from 'zod';
import { config } from '../config.js';
import { isIsoDate, daysBetween, addMonths, todayInNairobi } from './dates.js';

const isoDate = z.string().refine(isIsoDate, 'must be a date written as YYYY-MM-DD');

export const stayFields = {
  checkIn: isoDate,
  checkOut: isoDate,
  guests: z.coerce.number().int('must be a whole number').min(1, 'at least 1 guest').max(20, 'at most 20 guests'),
};

/** Zod refinement adding the rules between fields. `today` is injectable for tests. */
export const stayRules = (today = () => todayInNairobi()) => (v, ctx) => {
  if (!isIsoDate(v.checkIn) || !isIsoDate(v.checkOut)) return;   // already reported per field
  const nights = daysBetween(v.checkIn, v.checkOut);
  const t = today();
  const problem = (path, message) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (nights < 1) return problem('checkOut', 'must be after check-in');
  if (nights > config.MAX_NIGHTS) return problem('checkOut', `stays can be at most ${config.MAX_NIGHTS} nights`);
  if (v.checkIn < t) return problem('checkIn', 'is in the past');
  if (v.checkIn > addMonths(t, config.BOOKING_HORIZON_MONTHS)) {
    return problem('checkIn', `can be at most ${config.BOOKING_HORIZON_MONTHS} months ahead`);
  }
};
