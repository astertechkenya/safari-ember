// mail.js: the one place that sends email. From NURA, unchanged except for replyTo.
//
//   test                       messages go to `outbox`, so tests can read them
//   no RESEND_API_KEY          development prints them in the terminal; production logs that
//                              an email WOULD have been sent (without its content: it may
//                              hold a secret link)
//   RESEND_API_KEY set         sent through Resend (https://resend.com), except to addresses
//                              outside MAIL_ONLY_TO when that is set
//
// Two rules every caller gets for free:
//   1. Sending never blocks the request that caused it. sendMail() starts the delivery and
//      returns at once: a guest's payment is confirmed whether or not Resend answers quickly.
//   2. Sending never breaks the thing that caused it. A Resend outage must not fail a booking
//      or a cancellation; the failure is logged (and, for booking emails, recorded) instead.
import { config } from '../config.js';
import { logger } from '../logger.js';

export const outbox = [];
const inflight = new Set();

/** Waits for deliveries still in progress. For tests and a clean shutdown. */
export function mailSettled() {
  return Promise.allSettled([...inflight]);
}

/** Runs a background job: tracked so mailSettled() can wait for it; errors are logged, never thrown. */
export function inBackground(label, fn) {
  const job = Promise.resolve().then(fn).catch((err) => {
    logger.error({ err, job: label }, 'background email job failed');
    return 'failed';
  });
  inflight.add(job);
  job.finally(() => inflight.delete(job));
  return job;
}

/**
 * sendMail({ to, subject, text, html?, replyTo? }) → a promise of 'sent' | 'held' | 'logged' | 'failed'.
 * Callers normally don't wait for it (rule 1); booking emails do, in the background, to record
 * the outcome.
 */
export function sendMail(msg) {
  if (config.isTest && !config.mailEnabled) {
    outbox.push(msg);                           // synchronous, so tests see it immediately
    return Promise.resolve('sent');
  }
  return inBackground('sendMail', () => dispatch(msg));
}

async function dispatch(msg) {
  if (config.mailEnabled) return deliver(msg, config);
  if (!config.isProd) {
    // console.log on purpose: it shows even when LOG_LEVEL hides info lines.
    console.log(`\n──── email (not sent: no RESEND_API_KEY) ────\nTo: ${msg.to}\nSubject: ${msg.subject}\n\n${msg.text}\n─────────────────────────────────────────────\n`);
    return 'logged';
  }
  logger.warn({ subject: msg.subject }, 'email not sent: RESEND_API_KEY is not set');
  return 'logged';
}

const RETRYABLE = (status) => status === 429 || status >= 500;

/** amina.otieno@gmail.com → am•••o@gmail.com: enough to spot a mismatch in a log, not enough
 *  to read someone's address out of it. */
export const hint = (addr) => String(addr).toLowerCase().replace(/^([^@]*)(@.*)?$/, (all, local, domain = '') =>
  (local.length > 3 ? `${local.slice(0, 2)}•••${local.slice(-1)}` : `${local.slice(0, 1)}•••`) + domain);

/**
 * Sends one message through Resend's API. Exported for tests, which pass their own settings
 * and a fake Resend. Never throws: returns what happened.
 */
export async function deliver({ to, subject, text, html, replyTo }, cfg, { retryDelayMs = 2000 } = {}) {
  if (cfg.MAIL_ONLY_TO && !cfg.MAIL_ONLY_TO.includes(String(to).toLowerCase())) {
    // Not an error: without a verified domain Resend would refuse this address anyway.
    // Both sides, partly masked, so a typo or a different account is visible at a glance.
    logger.info({ subject, recipient: hint(to), mailOnlyTo: cfg.MAIL_ONLY_TO.map(hint) },
      'email held: recipient not in MAIL_ONLY_TO');
    return 'held';
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try {
      res = await fetch(`${cfg.RESEND_BASE_URL}/emails`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        // reply_to: a guest who presses Reply writes to the lodge, not to onboarding@resend.dev
        body: JSON.stringify({ from: cfg.MAIL_FROM, to: [to], subject, text, ...(html ? { html } : {}), ...(replyTo ? { reply_to: replyTo } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      if (attempt === 2) { logger.error({ err, subject }, 'email failed: Resend unreachable'); return 'failed'; }
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    if (res.ok) return 'sent';
    // Resend explains itself in the body ("You can only send testing emails to your own
    // address…"). Log it, but never the recipient or the content: those are personal/secret.
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    if (attempt === 1 && RETRYABLE(res.status)) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
      continue;
    }
    logger.error({ status: res.status, detail, subject }, 'email failed: Resend refused it');
    return 'failed';
  }
  return 'failed';
}
