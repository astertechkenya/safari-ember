// services/payments.js: a booking's deposit, from "Pay" to "confirmed". Adapted from NURA's
// payments.js and cardPayments.js; the booking rules are new (docs/BLUEPRINT.md, Phase 3).
//
// The life of one attempt (one row in `payments`):
//
//   PENDING, no providerRef   startPayment() made the row; the prompt / page is being opened
//   PENDING, providerRef set  M-Pesa: the PIN prompt is on the guest's phone
//                             Card:   the guest is on Paystack's page (or closed it)
//   PAID / FAILED / FLAGGED   settled, never changed again
//
// THE ONE RULE: nothing is marked paid on anyone's word. A Safaricom callback, a Paystack
// webhook, or the booking page asking "is it paid yet?" only trigger settle(), which asks the
// provider itself (stkQuery / verify) over HTTPS with our own credentials. Every status change
// is a conditional UPDATE ("… where status = 'PENDING'") inside a row lock, so a payment moves
// forward once, however many answers race in.
//
// WHAT A PAID DEPOSIT DOES TO THE BOOKING (markPaid):
//   hold still running                      → CONFIRMED
//   hold ran out, but the room is still free → CONFIRMED (re-held: the guest paid, the room exists)
//   hold ran out and the room was taken      → stays EXPIRED, refundDue = true (the lodge refunds)
//   already confirmed / cancelled            → refundDue = true (a second or a late deposit)
//   a different amount than we asked         → payment FLAGGED, booking unchanged: a person decides
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bookings, payments, roomTypes } from '../db/schema.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { httpError } from '../middleware/errors.js';
import { normalisePhone, isKenyanMobile } from '../lib/phone.js';
import { bookingUrl } from '../lib/bookingLink.js';
import { freeUnits } from './availability.js';
import { amountToRequest, stkPush, stkQuery } from './daraja.js';
import { initialize, verify } from './paystack.js';

export const MAX_ATTEMPTS = 6;                 // per booking, both methods together
export const PUSHES_PER_PHONE_PER_HOUR = 5;    // M-Pesa prompts to one number
const CHECK_EVERY_MS = 4000;                   // the booking page polls; ask the provider at most this often

/** Which methods the booking page may offer. */
export const paymentMethods = () => [
  ...(config.mpesaEnabled ? ['mpesa'] : []),
  ...(config.cardEnabled ? ['card'] : []),
];

/** What to tell the guest for Safaricom's ResultCodes. */
const MPESA_MESSAGES = {
  1: 'Your M-Pesa balance wasn’t enough for this payment.',
  1032: 'The M-Pesa prompt was cancelled.',
  1037: 'We couldn’t reach your phone. Check it’s on and has signal, then try again.',
  1019: 'The prompt expired before it was answered.',
  2001: 'The M-Pesa PIN was incorrect.',
};
const mpesaMessage = (code) => MPESA_MESSAGES[code] ?? 'M-Pesa couldn’t complete the payment.';

/* ── Starting a payment ─────────────────────────────────────────────────────────────────── */

/** M-Pesa prompts sent to this number in the last hour (counted in the database: restarts don't reset it). */
async function recentPushes(phone, tx = db) {
  const { rows: [{ n }] } = await tx.execute(sql`
    select count(*)::int as n from payments
    where provider = 'DARAJA' and phone = ${phone} and created_at > now() - interval '1 hour'`);
  return n;
}

/**
 * Makes sure the booking holds its room for at least PAYMENT_GRACE_MINUTES more, inside the
 * caller's transaction (the booking row is already locked). A hold that already ran out is
 * renewed only if the room is still free, checked under the room type's lock exactly like a
 * new booking (services/bookings.js), so this can never overbook.
 */
async function keepHeld(tx, b) {
  const graceEnds = new Date(Date.now() + config.PAYMENT_GRACE_MINUTES * 60_000);
  const running = b.status === 'HELD' && b.holdExpiresAt > new Date();
  if (!running) {
    await tx.select({ id: roomTypes.id }).from(roomTypes).where(eq(roomTypes.id, b.roomTypeId)).for('update');
    const free = (await freeUnits({ checkIn: b.checkIn, checkOut: b.checkOut, roomTypeId: b.roomTypeId, executor: tx })).get(b.roomTypeId) ?? 0;
    if (free < 1) throw httpError(409, 'Your hold ran out and the room has since been booked. Please choose other dates or another room.');
  }
  if (!running || b.holdExpiresAt < graceEnds) {
    await tx.update(bookings).set({ status: 'HELD', holdExpiresAt: graceEnds }).where(eq(bookings.id, b.id));
  }
}

/**
 * The guest pressed "Pay with M-Pesa" or "Pay by card".
 *   method 'mpesa': phone optional (the booking's own number if it's a Kenyan mobile)
 * Returns { paymentId, url? }: url only for cards (Paystack's page).
 */
export async function startPayment(ref, { method, phone }) {
  if (!paymentMethods().includes(method)) throw httpError(400, 'That payment method isn’t available.');
  const [b0] = await db.select().from(bookings).where(eq(bookings.ref, ref));
  if (!b0) throw httpError(404, 'Booking not found.');

  // An attempt may already be in flight. Ask its provider first (outside any lock: these are
  // network calls), so a guest who paid and came back is never asked to pay twice.
  const [live] = await db.select().from(payments).where(and(eq(payments.bookingId, b0.id), eq(payments.status, 'PENDING')));
  if (live?.providerRef) {
    const state = await settle(live).catch(() => 'pending');
    if (state === 'paid') throw httpError(409, 'This deposit has just been paid. Your booking is confirmed.');
  }

  const created = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, b0.id)).for('update');
    if (b.status === 'CONFIRMED' || b.status === 'COMPLETED') throw httpError(409, 'This booking is already confirmed.');
    if (b.status === 'CANCELLED') throw httpError(409, 'This booking was cancelled.');

    const [open] = await tx.select().from(payments).where(and(eq(payments.bookingId, b.id), eq(payments.status, 'PENDING'))).for('update');
    if (open) {
      if (open.provider === 'DARAJA') throw httpError(409, 'An M-Pesa prompt is already on its way. Check your phone, or wait a minute and try again.');
      // A card page the guest left open: reuse it for another card attempt, or close it to switch to M-Pesa.
      if (method === 'card' && open.raw?.authorizationUrl) return { reuse: open.raw.authorizationUrl };
      await tx.update(payments).set({ status: 'FAILED', resultCode: 'SUPERSEDED', failureReason: 'Replaced by a new attempt.', updatedAt: new Date() })
        .where(and(eq(payments.id, open.id), eq(payments.status, 'PENDING')));
    }

    const [{ n }] = (await tx.execute(sql`select count(*)::int as n from payments where booking_id = ${b.id}`)).rows;
    if (n >= MAX_ATTEMPTS) throw httpError(409, 'That was the last payment attempt for this booking. Please contact us, or start a new booking.');

    let payPhone = null;
    if (method === 'mpesa') {
      payPhone = phone ? normalisePhone(phone) : b.phone;
      if (!payPhone || !isKenyanMobile(payPhone)) {
        throw httpError(400, phone ? 'phone: M-Pesa needs a Kenyan mobile number, like 0712 345 678' : 'phone: enter the Kenyan M-Pesa number to prompt');
      }
      if (await recentPushes(payPhone, tx) >= PUSHES_PER_PHONE_PER_HOUR) throw httpError(429, 'Too many M-Pesa prompts to this number. Please wait an hour, or pay by card.');
    }

    await keepHeld(tx, b);
    const [p] = await tx.insert(payments).values({
      bookingId: b.id,
      provider: method === 'mpesa' ? 'DARAJA' : 'PAYSTACK',
      phone: payPhone,
      amountKes: method === 'mpesa' ? amountToRequest(b.depositKes) : b.depositKes,
    }).returning({ id: payments.id });
    return { paymentId: p.id };
  }).catch((err) => {
    // Two taps on "Pay" at once: the other tap made the attempt (one PENDING per booking).
    if ((err?.code ?? err?.cause?.code) === '23505') throw httpError(409, 'A payment is already starting. Please wait a moment.');
    throw err;
  });

  if (created.reuse) return { url: created.reuse };
  if (method === 'mpesa') {
    await pushPayment(created.paymentId);
    return { paymentId: created.paymentId };
  }
  const url = await openCardPage(created.paymentId);
  if (!url) throw httpError(502, 'We couldn’t open the card payment page. Please try again in a moment.');
  return { paymentId: created.paymentId, url };
}

/**
 * Sends the STK prompt for a committed PENDING payment. Never throws for a Safaricom problem:
 * the payment becomes FAILED with a reason the guest can read, and they can try again.
 */
async function pushPayment(paymentId) {
  const [p] = await db.select({ id: payments.id, phone: payments.phone, amountKes: payments.amountKes, ref: bookings.ref })
    .from(payments).innerJoin(bookings, eq(payments.bookingId, bookings.id))
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'PENDING'), isNull(payments.providerRef)));
  if (!p) return;
  let checkoutRequestId;
  try {
    // Daraja wants 2547XXXXXXXX: no plus sign.
    ({ checkoutRequestId } = await stkPush({ phone: p.phone.replace('+', ''), amountKes: p.amountKes, reference: p.ref }));
  } catch (err) {
    logger.warn({ err: err.message, paymentId }, 'M-Pesa push failed; payment marked FAILED');
    await markFailed(paymentId, 'PUSH_FAILED', null, 'We couldn’t reach M-Pesa. Please try again.');
    return;
  }
  // The prompt IS on the guest's phone now: this ID must not be lost, or their payment could
  // never be matched to the booking. Try twice, then log everything needed to match it by hand.
  for (let attempt = 1; ; attempt++) {
    try {
      await db.update(payments).set({ providerRef: checkoutRequestId, updatedAt: new Date() })
        .where(and(eq(payments.id, p.id), eq(payments.status, 'PENDING'), isNull(payments.providerRef)));
      return;
    } catch (err) {
      if (attempt === 2) {
        logger.error({ err: err.message, paymentId, checkoutRequestId, ref: p.ref }, 'STK prompt sent but its CheckoutRequestID could not be saved: reconcile by hand');
        return;
      }
    }
  }
}

/** Opens Paystack's page for a committed PENDING card payment. Returns its address, or null. */
async function openCardPage(paymentId) {
  const [p] = await db.select({ id: payments.id, amountKes: payments.amountKes, ref: bookings.ref, email: bookings.email, bookedAt: bookings.createdAt })
    .from(payments).innerJoin(bookings, eq(payments.bookingId, bookings.id))
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'PENDING')));
  if (!p) return null;
  // Back to the guest's private booking page. Paystack adds ?trxref=…&reference=… to it; the
  // page ignores those and simply checks the booking (which settles the payment, below).
  // The very link the guest already has (made as of the booking's creation).
  const back = bookingUrl(p.ref, { now: p.bookedAt.getTime() });
  try {
    const { authorizationUrl } = await initialize({
      email: p.email, amountKes: p.amountKes,
      reference: p.id,                               // our payment's random id: unique by design
      callbackUrl: back,
      // cancel_action: where Paystack's "Cancel payment" goes, so a guest who gives up isn't stranded.
      metadata: { booking_ref: p.ref, cancel_action: back },
    });
    await db.update(payments).set({ providerRef: p.id, raw: { authorizationUrl }, updatedAt: new Date() })
      .where(and(eq(payments.id, p.id), eq(payments.status, 'PENDING')));
    return authorizationUrl;
  } catch (err) {
    logger.warn({ err: err.message, paymentId }, 'Paystack initialize failed; payment marked FAILED');
    await markFailed(paymentId, 'INIT_FAILED', null, 'We couldn’t open the card payment page. Please try again.');
    return null;
  }
}

/* ── Settling ───────────────────────────────────────────────────────────────────────────── */

async function markFailed(paymentId, resultCode, raw, message) {
  await db.update(payments)
    .set({ status: 'FAILED', resultCode, failureReason: message, raw: raw ?? undefined, updatedAt: new Date() })
    .where(and(eq(payments.id, paymentId), eq(payments.status, 'PENDING')));
}

/**
 * The provider confirmed money moved. `from.amountKes` is what it says arrived (undefined: not
 * reported). Applies the booking rules at the top of this file, all in one transaction.
 */
async function markPaid(paymentId, from = {}) {
  const outcome = await db.transaction(async (tx) => {
    const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for('update');
    if (!p || p.status !== 'PENDING') return null;                 // already settled: nothing to do
    const now = new Date();
    const wrongAmount = from.amountKes !== undefined && from.amountKes !== p.amountKes;
    await tx.update(payments).set({
      status: wrongAmount ? 'FLAGGED' : 'PAID',
      receivedKes: wrongAmount && from.amountKes > 0 ? from.amountKes : null,
      receipt: from.receipt ?? null,
      resultCode: '0',
      failureReason: wrongAmount ? `Paid ${from.amountKes} KES, expected ${p.amountKes}` : null,
      raw: from.raw ?? null,
      updatedAt: now,
    }).where(eq(payments.id, p.id));
    if (wrongAmount) return { flagged: true, paymentId };

    // Lock order: payment → booking → room type. Booking creation locks only the room type and
    // inserts; nothing locks a booking then waits on a payment, so these can't deadlock.
    const [b] = await tx.select().from(bookings).where(eq(bookings.id, p.bookingId)).for('update');
    const confirm = () => tx.update(bookings).set({ status: 'CONFIRMED', confirmedAt: now, holdExpiresAt: null }).where(eq(bookings.id, b.id));
    if (b.status === 'HELD' && b.holdExpiresAt > now) { await confirm(); return { confirmed: b.ref }; }
    if (b.status === 'HELD' || b.status === 'EXPIRED') {
      await tx.select({ id: roomTypes.id }).from(roomTypes).where(eq(roomTypes.id, b.roomTypeId)).for('update');
      const free = (await freeUnits({ checkIn: b.checkIn, checkOut: b.checkOut, roomTypeId: b.roomTypeId, executor: tx })).get(b.roomTypeId) ?? 0;
      if (free >= 1) { await confirm(); return { confirmed: b.ref, late: true }; }
    }
    await tx.update(bookings).set({ refundDue: true, ...(b.status === 'HELD' ? { status: 'EXPIRED' } : {}) }).where(eq(bookings.id, b.id));
    return { refundDue: b.ref, status: b.status };
  });
  if (outcome?.confirmed) logger.info({ ref: outcome.confirmed, late: Boolean(outcome.late) }, 'deposit paid: booking confirmed');
  if (outcome?.refundDue) logger.warn({ ref: outcome.refundDue, status: outcome.status }, 'deposit arrived but the booking can’t use it: refund due');
  if (outcome?.flagged) logger.warn({ paymentId }, 'deposit amount mismatch: payment FLAGGED for review');
}

/**
 * Ask the provider about one PENDING payment and record the answer.
 * Returns 'paid' | 'failed' | 'pending'. `hint` carries what a callback said (receipt, amount).
 */
export async function settle(payment, hint = {}) {
  await db.update(payments).set({ checkedAt: new Date() }).where(eq(payments.id, payment.id));
  if (payment.provider === 'DARAJA') {
    const a = await stkQuery(payment.providerRef);
    if (a.state === 'paid') await markPaid(payment.id, { receipt: hint.receipt, amountKes: hint.amountKes, raw: hint.raw });
    else if (a.state === 'failed') await markFailed(payment.id, a.resultCode, { resultDesc: a.resultDesc }, mpesaMessage(a.resultCode));
    return a.state;
  }
  const v = await verify(payment.providerRef);
  if (v.state === 'paid') {
    // Another currency counts as a wrong amount: FLAGGED, never paid.
    const amountKes = v.currency === 'KES' ? v.amountKes : -1;
    await markPaid(payment.id, { amountKes, receipt: v.last4 ? `Card •••• ${v.last4}` : `Paystack ${v.id}`, raw: { paystack: v } });
    return 'paid';
  }
  if (v.state === 'failed') {
    await markFailed(payment.id, 'CARD_DECLINED', { paystack: v }, v.message ? `The card payment didn’t go through: ${v.message}.` : 'The card payment didn’t go through.');
    return 'failed';
  }
  return 'pending';
}

/**
 * The booking page asked about this booking. If a payment is waiting and we haven't asked its
 * provider in the last few seconds, ask now. This is what settles payments on a laptop, where
 * Safaricom's callback can't reach us. Provider trouble is logged, never shown as an error.
 */
export async function checkBookingPayment(bookingId) {
  // Claim the check in ONE statement: "mark it checked now, if nobody did in the last few
  // seconds". Two tabs polling at the same instant can't both win, so the provider is asked
  // once. (A read-then-update would let both read "not checked yet" before either wrote.)
  const [p] = await db.update(payments).set({ checkedAt: new Date() })
    .where(and(eq(payments.bookingId, bookingId), eq(payments.status, 'PENDING'), isNotNull(payments.providerRef),
      or(isNull(payments.checkedAt), lt(payments.checkedAt, new Date(Date.now() - CHECK_EVERY_MS)))))
    .returning();
  if (!p) return;
  try { await settle(p); } catch (err) { logger.warn({ err: err.message, paymentId: p.id }, 'payment check failed; will retry'); }
}

/* ── Provider callbacks (routes/payments.js) ────────────────────────────────────────────── */

/** Reads Safaricom's callback body. Returns null if it isn't one. */
export function parseMpesaCallback(body) {
  const cb = body?.Body?.stkCallback;
  if (!cb || typeof cb.CheckoutRequestID !== 'string') return null;
  const items = Object.fromEntries((cb.CallbackMetadata?.Item ?? []).map((i) => [i.Name, i.Value]));
  return {
    checkoutRequestId: cb.CheckoutRequestID,
    amountKes: items.Amount !== undefined ? Number(items.Amount) : undefined,
    receipt: typeof items.MpesaReceiptNumber === 'string' ? items.MpesaReceiptNumber : undefined,
    raw: body,
  };
}

/** Safaricom posted a result. Find its payment; if still open, go and ask Safaricom. */
export async function handleMpesaCallback(body) {
  const cb = parseMpesaCallback(body);
  if (!cb) { logger.warn('M-Pesa callback without a stkCallback: ignored'); return; }
  const [p] = await db.select().from(payments).where(and(eq(payments.providerRef, cb.checkoutRequestId), eq(payments.provider, 'DARAJA')));
  if (!p) { logger.warn('M-Pesa callback for an unknown payment: ignored'); return; }
  if (p.status === 'PAID' && !p.receipt && cb.receipt) {
    // Already settled by our own query (the guest's page asked first), which doesn't return the
    // M-Pesa receipt number. Keep it from the callback: it's only for display, since the
    // payment was confirmed with Safaricom already.
    await db.update(payments).set({ receipt: cb.receipt, updatedAt: new Date() })
      .where(and(eq(payments.id, p.id), eq(payments.status, 'PAID'), isNull(payments.receipt)));
    return;
  }
  if (p.status !== 'PENDING') return;                             // a repeat
  await settle(p, cb);
}

/** A signed Paystack webhook. Only charge.success matters; everything else is ignored. */
export async function handlePaystackEvent(event) {
  if (event?.event !== 'charge.success' || typeof event.data?.reference !== 'string') return;
  const [p] = await db.select().from(payments).where(and(eq(payments.providerRef, event.data.reference), eq(payments.provider, 'PAYSTACK')));
  if (!p) { logger.warn('Paystack event for an unknown payment: ignored'); return; }
  if (p.status !== 'PENDING') return;
  await settle(p);
}

/* ── Every minute (jobs/index.js) ───────────────────────────────────────────────────────── */

/**
 * Settles payments nobody has asked about: an M-Pesa prompt with no callback after a minute,
 * a card page with no answer after two. Gives up on prompts that never got sent, and on card
 * pages left open for over an hour (Paystack pages don't expire on their own).
 */
export async function reconcilePayments(now = new Date()) {
  const ago = (ms) => new Date(now.getTime() - ms);
  const open = await db.select().from(payments)
    .where(and(eq(payments.status, 'PENDING'), isNotNull(payments.providerRef),
      or(and(eq(payments.provider, 'DARAJA'), lt(payments.createdAt, ago(60_000))),
         and(eq(payments.provider, 'PAYSTACK'), lt(payments.createdAt, ago(120_000))))))
    .limit(20);
  let settled = 0;
  for (const p of open) {
    try {
      const state = await settle(p);
      if (state !== 'pending') settled += 1;
      else if (p.provider === 'PAYSTACK' && p.createdAt < ago(60 * 60_000)) {
        await markFailed(p.id, 'ABANDONED', null, 'The card payment wasn’t completed.');
      }
    } catch (err) {
      logger.warn({ err: err.message, paymentId: p.id }, 'payment check failed; will retry next minute');
    }
  }
  await db.update(payments)
    .set({ status: 'FAILED', resultCode: 'PUSH_FAILED', failureReason: 'We couldn’t reach M-Pesa. Please try again.', updatedAt: now })
    .where(and(eq(payments.status, 'PENDING'), isNull(payments.providerRef), lt(payments.createdAt, ago(120_000))));
  return settled;
}

export async function anyPendingPayments() {
  const { rows: [r] } = await db.execute(sql`select exists(select 1 from payments where status = 'PENDING') as open`);
  return r.open;
}

/* ── What the guest sees ────────────────────────────────────────────────────────────────── */

/** 07•• ••• 678: enough for the guest to recognise their number, not enough to be useful to anyone else. */
const maskPhone = (e164) => (e164 ? `0${e164.slice(4, 5)}•• ••• ${e164.slice(-3)}` : null);

/** The latest attempt, as the booking page shows it. */
export async function paymentSummary(bookingId) {
  const [p] = await db.select().from(payments).where(eq(payments.bookingId, bookingId)).orderBy(desc(payments.createdAt)).limit(1);
  if (!p) return null;
  return {
    status: p.status,
    method: p.provider === 'DARAJA' ? 'mpesa' : 'card',
    sent: Boolean(p.providerRef),
    phone: maskPhone(p.phone),
    amountKes: p.amountKes,                 // what was asked for (a token amount in the M-Pesa sandbox)
    receipt: p.status === 'PAID' ? p.receipt : null,
    message: p.status === 'FAILED' ? p.failureReason : p.status === 'FLAGGED' ? 'We’re checking this payment and will be in touch.' : null,
  };
}
