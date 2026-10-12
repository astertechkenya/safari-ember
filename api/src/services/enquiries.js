// enquiries.js: the "Get in touch" form. Saved for the admin inbox (Phase 5) and emailed to
// the lodge (Phase 4).
import { db } from '../db/client.js';
import { enquiries } from '../db/schema.js';

export async function saveEnquiry(e) {
  const [row] = await db.insert(enquiries).values({
    firstName: e.firstName, lastName: e.lastName, email: e.email, phone: e.phone ?? null,
    subject: e.subject || null, message: e.message,
    checkIn: e.checkIn ?? null, checkOut: e.checkOut ?? null, guests: e.guests ?? null,
  }).returning({ id: enquiries.id });
  return row.id;
}
