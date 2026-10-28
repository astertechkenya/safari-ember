// emails.js: what Safari Ember's emails say, and when they go out. Adapted from NURA's emails.js
// and alerts.js.
//
//   To the guest (each links to their private booking page; Reply goes to the lodge)
//     confirmed      the deposit is in: the booking is theirs
//     cancelled      the lodge cancelled it, with the reason staff typed
//     expired        the 15-minute hold ran out without a deposit
//   To the lodge (LODGE_EMAIL; each links to the admin)
//     lodge_booking  a new confirmed booking
//     enquiry        a new message from the website's "Get in touch" form
//
// Rules, as in NURA:
//   - Queued AFTER the change that caused it has committed, never inside it: a rolled-back
//     booking must not get an email. Queuing returns at once and never throws (mail.js).
//   - At most once per booking and kind: booking_emails' primary key lets one caller through.
//   - The lodge's alerts carry no guest contact details (phone, email): those stay in the admin,
//     behind the sign-in, not in a mailbox. The reference and a link are enough.
//   - Every value a person typed (a name, a cancel reason) is escaped before it goes into HTML.
//
// Until there's a verified domain, Resend delivers only to the account owner's address, so
// guests' emails are "held" (logged, not sent): MAIL_ONLY_TO in config.js. The code is the same
// either way; adding the domain is a settings change.
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bookings, bookingRooms, bookingActivities, bookingEmails, activities, payments, roomTypes } from '../db/schema.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { bookingUrl } from '../lib/bookingLink.js';
import { esc } from '../lib/html.js';
import { inBackground, sendMail } from './mail.js';

export const kes = (n) => `KES ${Number(n).toLocaleString('en-KE')}`;
const EMBER = '#c8782a';

/** "Tue 24 Nov 2026" from '2026-11-24', read as a calendar date (no timezone can shift it). */
const day = (iso, opts = {}) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB',
  { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC', ...opts });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The email's frame: one centred column with inline styles, because email clients ignore
 * stylesheets and most modern CSS. Light, with the site's ember, so it reads in any inbox.
 */
export function layout({ heading, intro, body = '', button }) {
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f3efe8;">
<div style="max-width:560px;margin:0 auto;padding:32px 20px;font-family:Helvetica,Arial,sans-serif;color:#1c1610;">
  <p style="margin:0 0 26px;font-family:Georgia,serif;font-size:18px;letter-spacing:5px;color:${EMBER};">SAFARI EMBER</p>
  <div style="background:#fff;padding:28px 24px;border-top:3px solid ${EMBER};">
    <h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:24px;font-weight:400;line-height:1.3;">${heading}</h1>
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;">${intro}</p>
    ${body}
    ${button ? `<p style="margin:24px 0 0;"><a href="${esc(button.href)}" style="display:inline-block;background:${EMBER};color:#120c06;text-decoration:none;padding:13px 26px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${esc(button.label)}</a></p>` : ''}
  </div>
  <p style="margin:20px 0 0;font-size:12px;color:#6b5a48;line-height:1.6;">Safari Ember · Nairobi, Kenya · <a href="${esc(config.SITE_URL)}" style="color:#6b5a48;">${esc(config.SITE_URL.replace(/^https?:\/\//, ''))}</a></p>
</div></body></html>`;
}

/* ── The booking, as the emails need it ─────────────────────────────────────────── */

/** Everything an email says about a booking, from the database. Null if it doesn't exist. */
export async function loadForEmail(bookingId) {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId));
  if (!b) return null;
  const [rooms, trips, [paid]] = await Promise.all([
    db.select({ name: roomTypes.name, units: bookingRooms.units }).from(bookingRooms)
      .innerJoin(roomTypes, eq(roomTypes.id, bookingRooms.roomTypeId))
      .where(eq(bookingRooms.bookingId, b.id)).orderBy(asc(roomTypes.sort), asc(roomTypes.id)),
    db.select({ name: activities.name, day: bookingActivities.day, time: bookingActivities.departs, people: bookingActivities.people })
      .from(bookingActivities).innerJoin(activities, eq(activities.id, bookingActivities.activityId))
      .where(eq(bookingActivities.bookingId, b.id)).orderBy(asc(bookingActivities.day), asc(bookingActivities.departs)),
    db.select({ provider: payments.provider, receipt: payments.receipt }).from(payments)
      .where(and(eq(payments.bookingId, b.id), eq(payments.status, 'PAID'))).limit(1),
  ]);
  return {
    id: b.id, ref: b.ref, status: b.status, firstName: b.firstName, email: b.email,
    checkIn: b.checkIn, checkOut: b.checkOut, nights: b.nights, guests: b.guests,
    totalKes: b.totalKes, depositKes: b.depositKes, cancelReason: b.cancelReason,
    rooms, trips, paid: paid ?? null,
    // The same private link the guest was given when they booked (signed from its creation time)
    link: bookingUrl(b.ref, { now: b.createdAt.getTime() }),
    adminLink: `${config.SITE_URL}/admin/#/booking/${b.ref}`,
  };
}

const roomsText = (b) => b.rooms.map((r) => `${r.units > 1 ? `${r.units} × ` : ''}${r.name}`).join(', ');
const method = (p) => (p?.provider === 'DARAJA' ? 'M-Pesa' : p ? 'card' : null);

/** The stay, as a small table (HTML) and as lines (text). */
function stay(b) {
  const rows = [
    ['Reference', b.ref],
    [b.rooms.reduce((n, r) => n + r.units, 0) > 1 ? 'Rooms' : 'Room', roomsText(b)],
    ['Check in', `${day(b.checkIn)}, from 14:00`],
    ['Check out', `${day(b.checkOut)}, by 11:00`],
    ['Guests', String(b.guests)],
    ...b.trips.map((t) => ['Experience', `${t.name} · ${day(t.day, { year: undefined })}, ${t.time} · ${plural(t.people, 'person', 'people')}`]),
    ['Total', `${kes(b.totalKes)} · ${plural(b.nights, 'night')}`],
  ];
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows.map(([k, v]) =>
    `<tr><td style="padding:7px 12px 7px 0;border-bottom:1px solid #eee;font-size:13px;color:#6b5a48;white-space:nowrap;vertical-align:top;">${k}</td>`
    + `<td style="padding:7px 0;border-bottom:1px solid #eee;font-size:14px;">${esc(v)}</td></tr>`).join('')}</table>`;
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  return { html, text };
}

/* ── Guest emails ───────────────────────────────────────────────────────────────── */

const GUEST = {
  confirmed: (b) => {
    const balance = b.totalKes - b.depositKes;
    const paidBy = method(b.paid) ? ` by ${method(b.paid)}${b.paid.receipt ? ` (${b.paid.receipt})` : ''}` : '';
    return {
      subject: `Booking ${b.ref} confirmed · Safari Ember`,
      heading: `You’re booked, ${esc(b.firstName)}`,
      intro: `Your deposit of <strong>${kes(b.depositKes)}</strong> is in${esc(paidBy)}, so your ${b.rooms.length > 1 || b.rooms[0]?.units > 1 ? 'rooms are' : 'room is'} yours. The balance of <strong>${kes(balance)}</strong> is paid at the lodge.`,
      introText: `Your deposit of ${kes(b.depositKes)} is in${paidBy}. The balance of ${kes(balance)} is paid at the lodge.`,
    };
  },
  cancelled: (b) => {
    // A full stop after the note, unless staff ended it with one (or ? or !) themselves
    const stop = (t) => (/[.!?]$/.test(t.trim()) ? '' : '.');
    const reason = b.cancelReason ? [` The lodge’s note: “${esc(b.cancelReason.trim())}${stop(b.cancelReason)}”`, ` The lodge's note: "${b.cancelReason.trim()}${stop(b.cancelReason)}"`] : ['', ''];
    // Never promise a refund (the lodge decides by its policy) and never deny one: say who to ask.
    const deposit = b.paid
      ? [` About your deposit of <strong>${kes(b.depositKes)}</strong>: reply to this email and the lodge will sort it out with you.`,
         ` About your deposit of ${kes(b.depositKes)}: reply to this email and the lodge will sort it out with you.`]
      : [' No payment was taken.', ' No payment was taken.'];
    return {
      subject: `Booking ${b.ref} cancelled · Safari Ember`,
      heading: 'Your booking has been cancelled',
      intro: `We’ve cancelled booking ${esc(b.ref)}.${reason[0]}${deposit[0]}`,
      introText: `We've cancelled booking ${b.ref}.${reason[1]}${deposit[1]}`,
    };
  },
  // Careful wording: a deposit can still land in the last seconds. If it does, the booking is
  // confirmed after all (and that email follows), or the lodge refunds it. Either way: don't pay twice.
  expired: (b) => ({
    subject: `Your hold on ${b.ref} has ended · Safari Ember`,
    heading: 'Your hold has ended',
    intro: 'We held your rooms for 15 minutes, but the deposit didn’t arrive in time, so they’ve gone back on sale. If money did leave your account, please don’t pay again: your booking page shows what happened, and the lodge will be in touch.',
    introText: "We held your rooms for 15 minutes, but the deposit didn't arrive in time, so they've gone back on sale. If money did leave your account, please don't pay again: your booking page shows what happened, and the lodge will be in touch.",
  }),
};

export function guestMessage(kind, b) {
  const t = GUEST[kind](b);
  const s = stay(b);
  return {
    to: b.email,
    replyTo: config.LODGE_EMAIL,
    subject: t.subject,
    text: `${t.introText}\n\n${s.text}\n\nYour booking: ${b.link}\nKeep this link private: it opens your booking.\n`,
    html: layout({ heading: t.heading, intro: t.intro, body: s.html, button: { href: b.link, label: 'View your booking' } }),
  };
}

/* ── Lodge alerts ───────────────────────────────────────────────────────────────── */

export function lodgeBookingMessage(b) {
  const s = stay(b);
  const paidBy = method(b.paid) ? ` by ${method(b.paid)}` : '';
  return {
    to: config.LODGE_EMAIL,
    subject: `New booking ${b.ref}: ${day(b.checkIn, { weekday: undefined, year: undefined })} – ${day(b.checkOut, { weekday: undefined, year: undefined })}, ${roomsText(b)}`,
    text: `Deposit of ${kes(b.depositKes)} paid${paidBy}. Guest details are in the admin.\n\n${s.text}\n\nOpen in the admin: ${b.adminLink}\n`,
    html: layout({ heading: 'A new booking', intro: `Deposit of <strong>${kes(b.depositKes)}</strong> paid${esc(paidBy)}. The guest’s details are in the admin.`,
      body: s.html, button: { href: b.adminLink, label: 'Open in the admin' } }),
  };
}

export function lodgeEnquiryMessage() {
  const link = `${config.SITE_URL}/admin/#/enquiries`;
  return {
    to: config.LODGE_EMAIL,
    subject: 'New enquiry from the website · Safari Ember',
    text: `Someone sent a message through the website's "Get in touch" form. Read it and reply in the admin:\n${link}\n`,
    html: layout({ heading: 'A new enquiry', intro: 'Someone sent a message through the website’s “Get in touch” form. Read it and reply in the admin.',
      button: { href: link, label: 'Open enquiries' } }),
  };
}

/* ── Sending ────────────────────────────────────────────────────────────────────── */

const GUEST_KINDS = new Set(['confirmed', 'cancelled', 'expired']);

/**
 * Sends one booking email (a guest's, or 'lodge_booking'), at most once per booking and kind,
 * in the background. Call it AFTER the change that caused it has committed. Returns at once.
 */
export function queueBookingEmail(bookingId, kind) {
  return inBackground(`booking email ${kind}`, async () => {
    if (kind === 'lodge_booking' && !config.LODGE_EMAIL) return 'skipped';     // no lodge address set
    // Claim first: the primary key (booking_id, kind) lets exactly one caller through.
    const claimed = await db.insert(bookingEmails).values({ bookingId, kind }).onConflictDoNothing().returning();
    if (!claimed.length) return 'duplicate';
    const mark = (status) => db.update(bookingEmails).set({ status })
      .where(and(eq(bookingEmails.bookingId, bookingId), eq(bookingEmails.kind, kind)));
    try {
      const b = await loadForEmail(bookingId);
      const status = await sendMail(GUEST_KINDS.has(kind) ? guestMessage(kind, b) : lodgeBookingMessage(b));
      await mark(status);
      return status;
    } catch (err) {
      // Claimed but not sent: say so, so the admin shows "failed" rather than "queued" forever.
      await mark('failed').catch(() => {});
      throw err;
    }
  });
}

/** The lodge's alert for a new enquiry. Nothing to deduplicate: each enquiry is saved once. */
export function queueEnquiryAlert() {
  if (!config.LODGE_EMAIL) {
    logger.info('new enquiry: no LODGE_EMAIL set, so no alert sent');
    return Promise.resolve('skipped');
  }
  return inBackground('enquiry alert', () => sendMail(lodgeEnquiryMessage()));
}
