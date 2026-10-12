// bookings.js: create a hold, and read a booking through its signed link.
//   POST /api/bookings          → 201 { booking, token, url }
//   GET  /api/bookings/:ref     with header X-Booking-Token: <token from the link>
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { httpError } from '../middleware/errors.js';
import { stayFields, stayRules } from '../lib/stay.js';
import { personName, email, phone, freeText } from '../lib/fields.js';
import { REF_PATTERN } from '../lib/ref.js';
import { bookingTokenValid } from '../lib/bookingLink.js';
import { createHold, publicBooking } from '../services/bookings.js';
import { wakeJobs } from '../jobs/index.js';

export const bookingsRouter = Router();

// .strict(): any field not listed (a "totalKes", a "status") is refused. Prices and statuses
// come from the server, never from the browser.
const body = z.object({
  room: z.string().trim().regex(/^[a-z0-9-]{1,60}$/, 'must be a room from the list'),
  ...stayFields,
  firstName: personName,
  lastName: personName,
  email,
  phone,
  requests: freeText(1000),
}).strict().superRefine(stayRules());

bookingsRouter.post('/',
  // Each hold takes a room off sale for HOLD_MINUTES. Without a limit, a script could hold every
  // room the lodge has, over and over. 8 holds per 10 minutes is plenty for a real guest
  // changing their mind.
  limit({ windowMs: 10 * 60_000, max: 8, message: 'Too many booking attempts. Please wait a few minutes and try again.' }),
  validate(body),
  async (req, res) => {
    const result = await createHold(req.valid.body);
    wakeJobs();   // a hold is open: the expiry job has work now (jobs/index.js)
    res.status(201).json(result);
  });

bookingsRouter.get('/:ref',
  // Guessing tokens is hopeless (they're HMACs), but there's no reason to let anyone try fast.
  limit({ windowMs: 60_000, max: 30 }),
  async (req, res) => {
    const ref = String(req.params.ref).toUpperCase();
    // A wrong reference and a wrong token get the same answer, so the endpoint can't be used
    // to find out which references exist.
    if (!REF_PATTERN.test(ref) || !bookingTokenValid(ref, req.get('x-booking-token'))) {
      throw httpError(404, 'Booking not found. Please use the link from your confirmation.');
    }
    const booking = await publicBooking(ref);
    if (!booking) throw httpError(404, 'Booking not found. Please use the link from your confirmation.');
    res.set('Cache-Control', 'no-store');
    res.json({ booking });
  });
