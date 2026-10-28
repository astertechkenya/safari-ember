// Deposits (Phase 3) against fake Safaricom and Paystack servers and a real Postgres.
// What matters most here: nothing is confirmed on a callback's word, a payment settles once,
// a late deposit never overbooks, and every odd case ends somewhere a person can see it.
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { roomTypes, bookings, payments } from '../src/db/schema.js';
import { reconcilePayments, MAX_ATTEMPTS } from '../src/services/payments.js';
import { resetTokenCache } from '../src/services/daraja.js';
import { as, inDays } from './helpers.js';
import { startFakeDaraja, callbackBody } from './fakeDaraja.js';
import { startFakePaystack, signedEvent } from './fakePaystack.js';

const app = createApp();
const SECRET = 'test-only-callback-secret-0123456789abcdef';
let daraja, paystack, room;

beforeAll(async () => {
  daraja = await startFakeDaraja();
  paystack = await startFakePaystack();
  // One unit, so "the room was taken meanwhile" is easy to arrange.
  [room] = await db.insert(roomTypes).values({ slug: 'test-pay', name: 'Test Pay', kind: 'Test', description: 'x', sleeps: 2, units: 1, baseRateKes: 20_000, sort: 95 }).returning();
});
afterAll(async () => {
  await daraja.close();
  await paystack.close();
  await db.execute(sql`truncate bookings, booking_rooms, booking_nights, booking_activities, payments restart identity cascade`);
  await db.delete(roomTypes).where(eq(roomTypes.id, room.id));
  await pool.end();
});
beforeEach(async () => {
  await db.execute(sql`truncate bookings, booking_rooms, booking_nights, booking_activities, payments restart identity cascade`);
  daraja.fake.pushes.length = 0;
  daraja.fake.queries.length = 0;
  paystack.fake.inits.length = 0;
  resetTokenCache();
});

const guest = { firstName: 'Amina', lastName: 'Otieno', email: 'amina@example.com', phone: '0712345678' };
let nextStay = 100;                   // each booking on its own dates unless a test says otherwise
async function hold(extra = {}, at = nextStay++ * 3) {
  const res = await as(app).post('/api/bookings').send({ rooms: [{ room: 'test-pay', units: 1 }], checkIn: inDays(at), checkOut: inDays(at + 2), guests: 2, ...guest, ...extra });
  expect(res.status).toBe(201);
  return { ref: res.body.booking.ref, token: res.body.token, checkIn: inDays(at) };
}
const pay = ({ ref, token }, body) => as(app).post(`/api/bookings/${ref}/pay`).set('x-booking-token', token).send(body);
const look = ({ ref, token }) => as(app).get(`/api/bookings/${ref}`).set('x-booking-token', token);
const paymentOf = async (ref) => (await db.execute(sql`
  select p.* from payments p join bookings b on b.id = p.booking_id where b.ref = ${ref} order by p.created_at desc limit 1`)).rows[0];
const bookingRow = async (ref) => (await db.select().from(bookings).where(eq(bookings.ref, ref)))[0];
const lastPushId = () => [...daraja.fake.outcome.keys()].at(-1);
// Callbacks and webhooks are answered first and processed after: wait for the result.
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}
// The page's checks are throttled to one every few seconds; tests skip the wait.
const forgetLastCheck = () => db.execute(sql`update payments set checked_at = null`);

describe('the booking shows how to pay', () => {
  it('offers both methods and no payment yet', async () => {
    const b = await hold();
    const res = await look(b);
    expect(res.body.booking).toMatchObject({ status: 'HELD', payment: null, refundDue: false, paymentMethods: ['mpesa', 'card'] });
  });

  it('refuses to start a payment without the link’s token', async () => {
    const b = await hold();
    expect((await pay({ ...b, token: b.token.slice(0, -1) + (b.token.endsWith('A') ? 'B' : 'A') }, { method: 'mpesa' })).status).toBe(404);
    expect(daraja.fake.pushes).toHaveLength(0);
  });

  it('never takes an amount from the browser', async () => {
    const b = await hold();
    expect((await pay(b, { method: 'mpesa', amountKes: 1 })).status).toBe(400);
  });
});

describe('M-Pesa', () => {
  it('prompts the booking’s own number for the sandbox amount, with the reference', async () => {
    const b = await hold();
    const res = await pay(b, { method: 'mpesa' });
    expect(res.status).toBe(202);
    expect(res.body.url).toBeUndefined();
    expect(res.body.booking.payment).toMatchObject({ status: 'PENDING', method: 'mpesa', sent: true, phone: '07•• ••• 678', amountKes: 1 });
    expect(daraja.fake.pushes[0]).toMatchObject({ PhoneNumber: '254712345678', Amount: 1, AccountReference: b.ref, CallBackURL: `https://api.example.test/api/payments/mpesa/callback/${SECRET}` });
  });

  it('can prompt another Kenyan number, but not a foreign one', async () => {
    const b = await hold();
    expect((await pay(b, { method: 'mpesa', phone: '+44 7700 900123' })).body.error).toMatch(/^phone: /);
    expect((await pay(b, { method: 'mpesa', phone: '0798 765 432' })).status).toBe(202);
    expect(daraja.fake.pushes[0].PhoneNumber).toBe('254798765432');
  });

  it('asks for a number when the booking’s is foreign', async () => {
    const b = await hold({ phone: '+447700900123' });
    const res = await pay(b, { method: 'mpesa' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/^phone: enter the Kenyan M-Pesa number/);
  });

  it('allows one prompt at a time', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    const again = await pay(b, { method: 'mpesa' });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/already on its way/);
    expect(daraja.fake.pushes).toHaveLength(1);
  });

  it('ignores a callback with the wrong secret', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    const res = await request(app).post('/api/payments/mpesa/callback/wrong-secret').send(callbackBody(lastPushId()));
    expect(res.status).toBe(404);
    expect((await bookingRow(b.ref)).status).toBe('HELD');
  });

  it('does not believe a "paid" callback until Safaricom confirms it', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    const id = lastPushId();                                     // Safaricom still says "processing"
    const res = await request(app).post(`/api/payments/mpesa/callback/${SECRET}`).send(callbackBody(id));
    expect(res.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    await until(() => daraja.fake.queries.length > 0);
    expect((await paymentOf(b.ref)).status).toBe('PENDING');
    expect((await bookingRow(b.ref)).status).toBe('HELD');
  });

  it('confirms the booking when Safaricom confirms the payment', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await request(app).post(`/api/payments/mpesa/callback/${SECRET}`).send(callbackBody(lastPushId(), { receipt: 'QK99REAL11' }));
    await until(async () => (await bookingRow(b.ref)).status === 'CONFIRMED');
    const res = await look(b);
    expect(res.body.booking).toMatchObject({ status: 'CONFIRMED', holdExpiresAt: null, refundDue: false, payment: { status: 'PAID', receipt: 'QK99REAL11' } });
    expect(res.body.booking.confirmedAt).toBeTruthy();
    // A repeated callback changes nothing.
    await request(app).post(`/api/payments/mpesa/callback/${SECRET}`).send(callbackBody(lastPushId()));
    expect((await db.select().from(payments)).filter((p) => p.status === 'PAID')).toHaveLength(1);
  });

  it('settles when the page asks, with no callback at all (a laptop Safaricom can’t reach)', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await forgetLastCheck();
    expect((await look(b)).body.booking.status).toBe('CONFIRMED');
  });

  it('keeps the receipt from a callback that arrives after the page already settled it', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await forgetLastCheck();
    expect((await look(b)).body.booking.payment.receipt).toBeNull();
    await request(app).post(`/api/payments/mpesa/callback/${SECRET}`).send(callbackBody(lastPushId(), { receipt: 'QK55LATE99' }));
    await until(async () => (await paymentOf(b.ref)).receipt === 'QK55LATE99');
  });

  it('asks Safaricom once, however many pages poll at the same moment', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    await forgetLastCheck();
    // All at once, like several open tabs. (One after another would depend on how fast the
    // database answers: over a slow link, five polls can outlast the few-second throttle.)
    const answers = await Promise.all(Array.from({ length: 5 }, () => look(b)));
    expect(answers.every((r) => r.status === 200)).toBe(true);
    expect(daraja.fake.queries).toHaveLength(1);
  });

  it('explains a cancelled prompt and lets the guest try again', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'failed', code: '1032' });
    await forgetLastCheck();
    const res = await look(b);
    expect(res.body.booking).toMatchObject({ status: 'HELD', payment: { status: 'FAILED', message: 'The M-Pesa prompt was cancelled.' } });
    expect((await pay(b, { method: 'mpesa' })).status).toBe(202);
  });

  it('keeps waiting on an answer that isn’t final, then confirms when the guest pays', async () => {
    // The bug Ethan hit (Oct 2026): Safaricom answered the page's check with a non-zero code that
    // meant "still processing"; it was taken as a failure, then the guest paid on the phone.
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'unclear', code: '4999' });
    await forgetLastCheck();
    expect((await look(b)).body.booking).toMatchObject({ status: 'HELD', payment: { status: 'PENDING' } });
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });                // the PIN goes in
    await forgetLastCheck();
    expect((await look(b)).body.booking).toMatchObject({ status: 'CONFIRMED', payment: { status: 'PAID' } });
  });

  it('confirms a payment we had recorded as failed, when Safaricom later says it was paid', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    const id = lastPushId();
    daraja.fake.outcome.set(id, { state: 'failed', code: '1037' });
    await forgetLastCheck();
    expect((await look(b)).body.booking.payment.status).toBe('FAILED');
    // A "failed" callback for it changes nothing, and asks Safaricom nothing
    const before = daraja.fake.queries.length;
    await request(app).post(`/api/payments/mpesa/callback/${SECRET}`).send(callbackBody(id, { code: 1037 }));
    expect(daraja.fake.queries.length).toBe(before);
    // Then the money turns out to have moved: Safaricom's callback says paid, and its query agrees
    daraja.fake.outcome.set(id, { state: 'paid' });
    await request(app).post(`/api/payments/mpesa/callback/${SECRET}`).send(callbackBody(id, { receipt: 'QK77LATE00' }));
    await until(async () => (await bookingRow(b.ref)).status === 'CONFIRMED');
    expect(await paymentOf(b.ref)).toMatchObject({ status: 'PAID', receipt: 'QK77LATE00' });
  });

  it('still won’t believe a "paid" callback for a failed payment unless Safaricom confirms it', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    const id = lastPushId();
    daraja.fake.outcome.set(id, { state: 'failed', code: '1032' });
    await forgetLastCheck();
    await look(b);
    await request(app).post(`/api/payments/mpesa/callback/${SECRET}`).send(callbackBody(id));   // a forged "paid"
    await until(() => daraja.fake.queries.at(-1)?.CheckoutRequestID === id);
    await new Promise((r) => setTimeout(r, 200));
    expect((await paymentOf(b.ref)).status).toBe('FAILED');
    expect((await bookingRow(b.ref)).status).toBe('HELD');
  });

  it('records a refused push as failed, not stuck', async () => {
    const b = await hold();
    daraja.fake.failNextPush = true;
    const res = await pay(b, { method: 'mpesa' });
    expect(res.status).toBe(202);
    expect(res.body.booking.payment).toMatchObject({ status: 'FAILED', sent: false, message: 'We couldn’t reach M-Pesa. Please try again.' });
  });

  it('flags a payment of a different amount instead of confirming', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await request(app).post(`/api/payments/mpesa/callback/${SECRET}`).send(callbackBody(lastPushId(), { amount: 5 }));
    await until(async () => (await paymentOf(b.ref)).status !== 'PENDING');
    expect(await paymentOf(b.ref)).toMatchObject({ status: 'FLAGGED', received_kes: 5 });
    expect((await bookingRow(b.ref)).status).toBe('HELD');
    expect((await look(b)).body.booking.payment.message).toMatch(/checking this payment/);
  });

  it('stops after the last allowed attempt', async () => {
    const b = await hold();
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      daraja.fake.failNextPush = true;
      // Different numbers, so the per-phone limit doesn't trip first.
      expect((await pay(b, { method: 'mpesa', phone: `07100000${String(i).padStart(2, '0')}` })).status).toBe(202);
    }
    const res = await pay(b, { method: 'mpesa' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/last payment attempt/);
  }, 120_000);   // seven payment attempts: slow against a database on another continent
});

describe('cards (Paystack)', () => {
  it('opens Paystack’s page for the full deposit, returning to the private link', async () => {
    const b = await hold();
    const res = await pay(b, { method: 'card' });
    expect(res.status).toBe(202);
    expect(res.body.url).toMatch(/^https:\/\/checkout\.paystack\.test\//);
    const init = paystack.fake.inits[0];
    expect(init.amount).toBe(res.body.booking.depositKes * 100);    // Paystack counts cents
    expect(init.callback_url).toBe(`http://localhost:8000/booking.html#${b.ref}.${b.token}`);
    expect(res.body.booking.payment).toMatchObject({ status: 'PENDING', method: 'card', amountKes: res.body.booking.depositKes });
  });

  it('reuses the open page for another card attempt', async () => {
    const b = await hold();
    const first = await pay(b, { method: 'card' });
    const second = await pay(b, { method: 'card' });
    expect(second.body.url).toBe(first.body.url);
    expect(paystack.fake.inits).toHaveLength(1);
  });

  it('closes an unpaid card page when the guest switches to M-Pesa', async () => {
    const b = await hold();
    await pay(b, { method: 'card' });
    expect((await pay(b, { method: 'mpesa' })).status).toBe(202);
    const rows = await db.select().from(payments);
    expect(rows.map((p) => [p.provider, p.status, p.resultCode]).sort()).toEqual([['DARAJA', 'PENDING', null], ['PAYSTACK', 'FAILED', 'SUPERSEDED']]);
  });

  it('won’t switch method if the card was in fact paid', async () => {
    const b = await hold();
    const first = await pay(b, { method: 'card' });
    paystack.fake.result.set(first.body.url.split('/').pop(), { status: 'success' });
    const res = await pay(b, { method: 'mpesa' });
    expect(res.status).toBe(409);
    expect((await bookingRow(b.ref)).status).toBe('CONFIRMED');
    expect(daraja.fake.pushes).toHaveLength(0);
  });

  it('confirms on a signed webhook once Paystack’s verify agrees', async () => {
    const b = await hold();
    const first = await pay(b, { method: 'card' });
    const reference = first.body.url.split('/').pop();
    paystack.fake.result.set(reference, { status: 'success', last4: '4081' });
    const { raw, signature } = signedEvent({ event: 'charge.success', data: { reference } });
    const res = await request(app).post('/api/payments/paystack/webhook').set('content-type', 'application/json').set('x-paystack-signature', signature).send(raw);
    expect(res.status).toBe(200);
    await until(async () => (await bookingRow(b.ref)).status === 'CONFIRMED');
    expect((await look(b)).body.booking.payment).toMatchObject({ status: 'PAID', receipt: 'Card •••• 4081' });
  });

  it('rejects a webhook with a bad signature', async () => {
    const b = await hold();
    const first = await pay(b, { method: 'card' });
    const reference = first.body.url.split('/').pop();
    paystack.fake.result.set(reference, { status: 'success' });
    const { raw } = signedEvent({ event: 'charge.success', data: { reference } });
    const forged = signedEvent({ event: 'charge.success', data: { reference } }, 'sk_test_someoneElsesKey').signature;
    const res = await request(app).post('/api/payments/paystack/webhook').set('content-type', 'application/json').set('x-paystack-signature', forged).send(raw);
    expect(res.status).toBe(401);
    expect((await bookingRow(b.ref)).status).toBe('HELD');
  });

  it('flags a payment in another currency', async () => {
    const b = await hold();
    const first = await pay(b, { method: 'card' });
    paystack.fake.result.set(first.body.url.split('/').pop(), { status: 'success', currency: 'USD' });
    await forgetLastCheck();
    await look(b);
    expect((await paymentOf(b.ref)).status).toBe('FLAGGED');
    expect((await bookingRow(b.ref)).status).toBe('HELD');
  });

  it('reports a declined card and allows a fresh try', async () => {
    const b = await hold();
    const first = await pay(b, { method: 'card' });
    paystack.fake.result.set(first.body.url.split('/').pop(), { status: 'failed', message: 'Insufficient funds' });
    await forgetLastCheck();
    expect((await look(b)).body.booking.payment).toMatchObject({ status: 'FAILED', message: 'The card payment didn’t go through: Insufficient funds.' });
    const again = await pay(b, { method: 'card' });
    expect(again.body.url).not.toBe(first.body.url);
  });
});

describe('time running out', () => {
  const lapse = (ref) => db.execute(sql`update bookings set hold_expires_at = now() - interval '1 minute' where ref = ${ref}`);

  it('starting a payment gives the guest at least the grace period', async () => {
    const b = await hold();
    await db.execute(sql`update bookings set hold_expires_at = now() + interval '30 seconds' where ref = ${b.ref}`);
    await pay(b, { method: 'mpesa' });
    const left = (await bookingRow(b.ref)).holdExpiresAt - Date.now();
    expect(left).toBeGreaterThan(4 * 60_000);
  });

  it('re-holds an expired booking to pay, if the room is still free', async () => {
    const b = await hold();
    await lapse(b.ref);
    const res = await pay(b, { method: 'mpesa' });
    expect(res.status).toBe(202);
    expect(res.body.booking.status).toBe('HELD');
  });

  it('refuses to re-hold when someone else has the room now', async () => {
    const b = await hold({}, 520);
    await lapse(b.ref);
    await hold({ email: 'other@example.com' }, 520);              // the only unit, same nights
    const res = await pay(b, { method: 'mpesa' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/has since been booked: Test Pay has just been booked/);
  });

  it('confirms a late deposit when the room is still free', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    await lapse(b.ref);
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await forgetLastCheck();
    expect((await look(b)).body.booking).toMatchObject({ status: 'CONFIRMED', refundDue: false });
  });

  it('marks a late deposit for refund when the room went to someone else, never overbooking', async () => {
    const b = await hold({}, 525);
    await pay(b, { method: 'mpesa' });
    await lapse(b.ref);
    const other = await hold({ email: 'other@example.com' }, 525);
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await forgetLastCheck();
    expect((await look(b)).body.booking).toMatchObject({ status: 'EXPIRED', refundDue: true, payment: { status: 'PAID' } });
    expect((await bookingRow(other.ref)).status).toBe('HELD');
  });

  it("never overbooks when this server's clock is behind the database's", async () => {
    // The hold ran out by the DATABASE's clock and the room went to someone else; the API's own
    // clock, five minutes slow, would still call the hold running. The database's clock must win.
    const b = await hold({}, 535);
    await pay(b, { method: 'mpesa' });
    await lapse(b.ref);
    const other = await hold({ email: 'other@example.com' }, 535);
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await forgetLastCheck();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() - 5 * 60_000));   // this server five minutes slow
    try {
      expect((await look(b)).body.booking).toMatchObject({ status: 'EXPIRED', refundDue: true, payment: { status: 'PAID' } });
    } finally {
      vi.useRealTimers();
    }
    expect((await bookingRow(other.ref)).status).toBe('HELD');
  });

  it('refunds a late deposit on a group booking when even one of its rooms was taken', async () => {
    // Two rooms: the only Test Pay unit and a Hearthside (plenty free). Only Test Pay goes to
    // someone else, which is enough: the booking can't be confirmed without all its rooms.
    const b = await hold({ rooms: [{ room: 'test-pay', units: 1 }, { room: 'hearthside-room', units: 1 }], guests: 3 }, 530);
    await pay(b, { method: 'mpesa' });
    await lapse(b.ref);
    const other = await hold({ email: 'other@example.com' }, 530);
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await forgetLastCheck();
    expect((await look(b)).body.booking).toMatchObject({ status: 'EXPIRED', refundDue: true });
    expect((await bookingRow(other.ref)).status).toBe('HELD');
  });

  it('marks a second deposit on a confirmed booking for refund', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await forgetLastCheck();
    await look(b);
    expect((await pay(b, { method: 'mpesa' })).body.error).toMatch(/already confirmed/);
    // A duplicate that slipped through some other way (a second open payment can't exist
    // through the API): the rule in markPaid still holds.
    const bk = await bookingRow(b.ref);
    const [p] = await db.insert(payments).values({ bookingId: bk.id, provider: 'DARAJA', amountKes: 1, phone: '+254712345678', providerRef: 'dup-1' }).returning();
    daraja.fake.outcome.set('dup-1', { state: 'paid' });
    await request(app).post(`/api/payments/mpesa/callback/${SECRET}`).send(callbackBody('dup-1'));
    await until(async () => (await bookingRow(b.ref)).refundDue);
    expect((await db.select().from(payments).where(eq(payments.id, p.id)))[0].status).toBe('PAID');
  });
});

describe('the minute job', () => {
  it('settles a quiet M-Pesa payment after a minute, and leaves young ones alone', async () => {
    const quiet = await hold();
    await pay(quiet, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    const young = await hold();
    await pay(young, { method: 'mpesa', phone: '0798765432' });
    daraja.fake.outcome.set(lastPushId(), { state: 'paid' });
    await db.execute(sql`update payments p set created_at = now() - interval '2 minutes' from bookings b where b.id = p.booking_id and b.ref = ${quiet.ref}`);
    expect(await reconcilePayments()).toBe(1);
    expect((await bookingRow(quiet.ref)).status).toBe('CONFIRMED');
    expect((await bookingRow(young.ref)).status).toBe('HELD');
  });

  it('gives up on an M-Pesa prompt with no final answer after 3 minutes, so the guest can try again', async () => {
    const b = await hold();
    await pay(b, { method: 'mpesa' });
    daraja.fake.outcome.set(lastPushId(), { state: 'unclear', code: '4999' });
    await db.execute(sql`update payments set created_at = now() - interval '2 minutes'`);
    await reconcilePayments();
    expect((await paymentOf(b.ref)).status).toBe('PENDING');                // 2 minutes: still waiting
    await db.execute(sql`update payments set created_at = now() - interval '4 minutes'`);
    await reconcilePayments();
    expect(await paymentOf(b.ref)).toMatchObject({ status: 'FAILED', result_code: 'NO_ANSWER' });
    expect((await look(b)).body.booking.payment.message).toMatch(/don’t pay again/);
    expect((await pay(b, { method: 'mpesa' })).status).toBe(202);
  });

  it('gives up on a card page left open for over an hour', async () => {
    const b = await hold();
    await pay(b, { method: 'card' });
    await db.execute(sql`update payments set created_at = now() - interval '61 minutes'`);
    await reconcilePayments();
    expect(await paymentOf(b.ref)).toMatchObject({ status: 'FAILED', result_code: 'ABANDONED' });
  });
});
