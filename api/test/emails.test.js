// Emails: the guest's (confirmed, cancelled, hold ended) and the lodge's alerts (new booking,
// new enquiry). With no Resend key in tests, every message lands in mail.js's outbox.
// What matters: each goes out once, after the change it reports; guests' typed text is escaped;
// the lodge's alerts carry no guest contact details; and nothing here can fail a booking.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'node:http';
import { sql, eq } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { roomTypes, bookings, payments, bookingEmails } from '../src/db/schema.js';
import { outbox, mailSettled, deliver } from '../src/services/mail.js';
import { expireHolds } from '../src/services/bookings.js';
import { cancel, bookingDetail } from '../src/services/admin.js';
import { resetTokenCache } from '../src/services/daraja.js';
import { as, inDays } from './helpers.js';
import { startFakeDaraja } from './fakeDaraja.js';

const app = createApp();
const LODGE = 'lodge@example.test';
let daraja, room;

beforeAll(async () => {
  daraja = await startFakeDaraja();
  [room] = await db.insert(roomTypes).values({ slug: 'test-mail', name: 'Test Mail Room', kind: 'Test', description: 'x', sleeps: 2, units: 2, baseRateKes: 20_000, sort: 97 }).returning();
});
afterAll(async () => {
  await daraja.close();
  await db.execute(sql`truncate bookings, booking_rooms, booking_nights, booking_activities, payments, booking_emails, enquiries restart identity cascade`);
  await db.delete(roomTypes).where(eq(roomTypes.id, room.id));
  await pool.end();
});
beforeEach(async () => {
  await mailSettled();
  await db.execute(sql`truncate bookings, booking_rooms, booking_nights, booking_activities, payments, booking_emails, enquiries, admin_events restart identity cascade`);
  outbox.length = 0;
  resetTokenCache();
});

const guest = { firstName: 'Amina', lastName: 'Otieno', email: 'amina@example.com', phone: '0712345678' };
let nextStay = 0;                     // its own dates each time, inside the 18-month horizon
async function hold(extra = {}) {
  const at = 200 + nextStay++ * 3;
  const res = await as(app).post('/api/bookings').send({ rooms: [{ room: 'test-mail', units: 1 }], checkIn: inDays(at), checkOut: inDays(at + 2), guests: 2, ...guest, ...extra });
  expect(res.status).toBe(201);
  return { ref: res.body.booking.ref, token: res.body.token };
}
const look = ({ ref, token }) => as(app).get(`/api/bookings/${ref}`).set('x-booking-token', token);
const idOf = async (ref) => (await db.select().from(bookings).where(eq(bookings.ref, ref)))[0].id;
/** Pays a held booking by M-Pesa against the fake Safaricom, as a guest's page would. */
async function payByMpesa(b) {
  await as(app).post(`/api/bookings/${b.ref}/pay`).set('x-booking-token', b.token).send({ method: 'mpesa' });
  daraja.fake.outcome.set([...daraja.fake.outcome.keys()].at(-1), { state: 'paid' });
  await db.execute(sql`update payments set checked_at = null`);
  expect((await look(b)).body.booking.status).toBe('CONFIRMED');
  await mailSettled();
}
const to = (addr) => outbox.filter((m) => m.to === addr);

describe('when a deposit confirms a booking', () => {
  it('emails the guest their confirmation and alerts the lodge, once each', async () => {
    const b = await hold();
    await payByMpesa(b);

    const [mine] = to('amina@example.com');
    expect(to('amina@example.com')).toHaveLength(1);
    expect(mine.subject).toBe(`Booking ${b.ref} confirmed · Safari Ember`);
    expect(mine.replyTo).toBe(LODGE);                                   // Reply reaches the lodge
    expect(mine.text).toContain(`booking.html#${b.ref}.`);              // their private link
    expect(mine.text).toMatch(/Your deposit of KES 12,000 is in by M-Pesa/);
    expect(mine.text).toMatch(/balance of KES 28,000 is paid at the lodge/);
    expect(mine.html).toContain('View your booking');

    const [alert] = to(LODGE);
    expect(to(LODGE)).toHaveLength(1);
    expect(alert.subject).toMatch(new RegExp(`^New booking ${b.ref}: `));
    expect(alert.text).toContain(`/admin/#/booking/${b.ref}`);
    // No guest contact details in a mailbox: they stay in the admin
    expect(alert.text + alert.html).not.toMatch(/amina@example\.com|0712345678|712345678/);

    // The guest's page asking again, or a repeat callback, sends nothing more
    await db.execute(sql`update payments set checked_at = null`);
    await look(b);
    await mailSettled();
    expect(outbox).toHaveLength(2);
    const rows = await db.select().from(bookingEmails).where(eq(bookingEmails.bookingId, await idOf(b.ref)));
    expect(rows.map((r) => [r.kind, r.status]).sort()).toEqual([['confirmed', 'sent'], ['lodge_booking', 'sent']]);
  });

  it('shows in the admin what was emailed', async () => {
    const b = await hold();
    await payByMpesa(b);
    const { history } = await bookingDetail(b.ref, false);
    expect(history.map((h) => h.what)).toEqual(expect.arrayContaining(['Confirmation emailed to the guest', 'Lodge alerted by email']));
  });
});

describe('when the lodge cancels', () => {
  it('emails the guest the reason, and about their deposit if they paid one', async () => {
    const b = await hold();
    await payByMpesa(b);
    outbox.length = 0;
    await cancel(b.ref, null, 'Flooding on the access road');
    await mailSettled();
    const [m] = to('amina@example.com');
    expect(m.subject).toBe(`Booking ${b.ref} cancelled · Safari Ember`);
    expect(m.text).toContain('The lodge\'s note: "Flooding on the access road." About your deposit');
    expect(m.text).toMatch(/About your deposit of KES 12,000: reply to this email/);
    expect(to(LODGE)).toHaveLength(0);                      // staff did this themselves
  });

  it('says no payment was taken for a hold, and escapes what staff typed', async () => {
    const b = await hold();
    await cancel(b.ref, null, '<img src=x onerror=alert(1)> double-booked');
    await mailSettled();
    const [m] = to('amina@example.com');
    expect(m.text).toMatch(/No payment was taken/);
    expect(m.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(m.html).not.toContain('<img src=x');
  });
});

describe('when a hold runs out', () => {
  it('tells the guest once, without saying they did anything wrong', async () => {
    const b = await hold();
    await db.update(bookings).set({ holdExpiresAt: sql`now() - interval '1 minute'` }).where(eq(bookings.ref, b.ref));
    expect(await expireHolds()).toBe(1);
    await mailSettled();
    const [m] = to('amina@example.com');
    expect(m.subject).toBe(`Your hold on ${b.ref} has ended · Safari Ember`);
    expect(m.text).toMatch(/please don't pay again/);
    expect(await expireHolds()).toBe(0);
    await mailSettled();
    expect(outbox).toHaveLength(1);
  });
});

describe('enquiries', () => {
  it('alert the lodge with a link to the inbox, not the message itself', async () => {
    const res = await as(app).post('/api/enquiries').send({ name: 'Mary Wanjiku', email: 'mary@example.com', message: 'A private question' });
    expect(res.status).toBe(201);
    await mailSettled();
    const [m] = to(LODGE);
    expect(m.subject).toBe('New enquiry from the website · Safari Ember');
    expect(m.text).toContain('/admin/#/enquiries');
    expect(m.text + m.html).not.toMatch(/mary@example\.com|A private question/);
  });

  it('send nothing for a bot that filled the hidden field', async () => {
    await as(app).post('/api/enquiries').send({ name: 'Bot', email: 'bot@example.com', message: 'spam', website: 'http://spam.example' });
    await mailSettled();
    expect(outbox).toHaveLength(0);
  });
});

describe('sending through Resend', () => {
  let server, got;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''; req.on('data', (c) => { raw += c; });
      req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(raw) }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"id":"x"}'); });
    });
    await new Promise((ok) => server.listen(4596, '127.0.0.1', ok));
  });
  afterAll(() => new Promise((ok) => server.close(ok)));
  beforeEach(() => { got = []; });
  const cfg = { RESEND_BASE_URL: 'http://127.0.0.1:4596', RESEND_API_KEY: 're_test_0123456789', MAIL_FROM: 'Safari Ember <onboarding@resend.dev>', MAIL_ONLY_TO: null };

  it('passes the lodge as reply-to', async () => {
    expect(await deliver({ to: 'amina@example.com', subject: 's', text: 't', replyTo: LODGE }, cfg)).toBe('sent');
    expect(got[0]).toMatchObject({ auth: 'Bearer re_test_0123456789', body: { to: ['amina@example.com'], reply_to: LODGE, from: 'Safari Ember <onboarding@resend.dev>' } });
  });

  it('holds a guest\'s email while only the owner\'s address may receive (no domain yet)', async () => {
    const only = { ...cfg, MAIL_ONLY_TO: [LODGE] };
    expect(await deliver({ to: 'amina@example.com', subject: 's', text: 't' }, only)).toBe('held');
    expect(await deliver({ to: LODGE, subject: 's', text: 't' }, only)).toBe('sent');
    expect(got).toHaveLength(1);
  });
});
