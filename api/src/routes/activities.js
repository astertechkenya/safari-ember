// activities.js: GET /api/activities?checkIn=2026-12-20&checkOut=2026-12-23
// The trips a guest can add to that stay: each with its price per person and every departure
// from check-in to check-out (inclusive) that's still far enough ahead, with the seats left.
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { stayFields, stayRules } from '../lib/stay.js';
import { activitiesFor } from '../services/activities.js';

export const activitiesRouter = Router();

const query = z.object({ checkIn: stayFields.checkIn, checkOut: stayFields.checkOut }).strict().superRefine(stayRules());

activitiesRouter.get('/',
  limit({ windowMs: 60_000, max: 60 }),
  validate(query, 'query'),
  async (req, res) => {
    res.set('Cache-Control', 'no-store');   // seats change as people book
    res.json({ activities: await activitiesFor(req.valid.query) });
  });
