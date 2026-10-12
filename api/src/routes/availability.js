// availability.js: GET /api/availability?checkIn=2026-12-20&checkOut=2026-12-23&guests=2
// Every room type for that stay: can it be booked, how many are left (when few), and the price
// night by night with the total and deposit.
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { stayFields, stayRules } from '../lib/stay.js';
import { search } from '../services/bookings.js';

export const availabilityRouter = Router();

const query = z.object(stayFields).strict().superRefine(stayRules());

availabilityRouter.get('/',
  // Generous: a guest tries many date combinations. This only stops scripts hammering it.
  limit({ windowMs: 60_000, max: 60 }),
  validate(query, 'query'),
  async (req, res) => {
    // Never cached: a room booked a second ago must not still show as free.
    res.set('Cache-Control', 'no-store');
    res.json(await search(req.valid.query));
  });
