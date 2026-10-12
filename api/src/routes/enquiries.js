// enquiries.js: POST /api/enquiries, the "Get in touch" form.
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { limit } from '../middleware/rateLimit.js';
import { isIsoDate } from '../lib/dates.js';
import { personName, email, phone, freeText } from '../lib/fields.js';
import { saveEnquiry } from '../services/enquiries.js';

export const enquiriesRouter = Router();

const optionalDate = z.string().refine(isIsoDate, 'must be a date written as YYYY-MM-DD').optional();

const body = z.object({
  firstName: personName,
  lastName: personName,
  email,
  phone: phone.optional(),
  subject: freeText(120),
  message: z.string().trim().min(1, 'is required').max(4000, 'must be at most 4000 characters'),
  checkIn: optionalDate,
  checkOut: optionalDate,
  guests: z.coerce.number().int().min(1).max(200).optional(),
  // Honeypot: a field hidden from people with CSS. Bots fill in every box they find; a person
  // never sees it. Filled in = a bot (handled below).
  website: z.string().max(500).optional(),
}).strict().refine((v) => !v.checkIn || !v.checkOut || v.checkOut > v.checkIn, { path: ['checkOut'], message: 'must be after check-in' });

enquiriesRouter.post('/',
  limit({ windowMs: 60 * 60_000, max: 5, message: 'Too many messages. Please try again later, or call us.' }),
  validate(body),
  async (req, res) => {
    const { website, ...enquiry } = req.valid.body;
    // A bot gets the same "thank you" as a person, so it learns nothing, but nothing is saved.
    if (!website) await saveEnquiry(enquiry);
    res.status(201).json({ ok: true });
  });
