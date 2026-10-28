// services/daraja.js: the only file that talks to Safaricom's Daraja API.
//
//   stkPush({ phone, amountKes, reference })  → { checkoutRequestId }   ask the phone for a PIN
//   stkQuery(checkoutRequestId)                → { state, resultCode, resultDesc }
//
// Adapted from NURA (same file, same rules).
// Daraja's callbacks are not signed: anyone who learns the callback address could post a fake
// "paid". So a callback is only a hint that it's time to look, and every payment is settled
// from stkQuery, a request WE make to Safaricom over HTTPS with our own credentials.
import { config } from '../config.js';
import { logger } from '../logger.js';

const BASE = config.DARAJA_BASE_URL
  ?? (config.DARAJA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke');
const TIMEOUT_MS = 15_000;

export class DarajaError extends Error {
  // providerStatus, not status: the error handler treats .status as OUR answer to the browser,
  // so a Paystack/Safaricom 401 would reach the guest as a 401, unlogged. Ours is a 500, logged.
  constructor(message, { status, body } = {}) { super(message); this.providerStatus = status; this.body = body; }
}

/* ── Access token: valid ~1 hour. Cached, and refreshed a minute early. ─────────────── */
let cached = null;   // { token, expiresAt }
export function resetTokenCache() { cached = null; }   // tests

async function accessToken() {
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const basic = Buffer.from(`${config.DARAJA_CONSUMER_KEY}:${config.DARAJA_CONSUMER_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${basic}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new DarajaError('Daraja token request failed', { status: res.status, body });
  cached = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) - 60) * 1000 };
  return cached.token;
}

/** 20260929143005: the current time in NAIROBI, whatever timezone the server runs in. */
export function nairobiTimestamp(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map((x) => [x.type, x.value]));
  return `${p.year}${p.month}${p.day}${p.hour}${p.minute}${p.second}`;
}

const password = (ts) => Buffer.from(`${config.DARAJA_SHORTCODE}${config.DARAJA_PASSKEY}${ts}`).toString('base64');

async function post(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

/** The shillings to request. In the sandbox, a token amount, never the real total. */
export const amountToRequest = (totalKes) =>
  (config.DARAJA_ENV === 'production' ? totalKes : config.DARAJA_SANDBOX_AMOUNT_KES);

export async function stkPush({ phone, amountKes, reference }) {
  const ts = nairobiTimestamp();
  const { res, body } = await post('/mpesa/stkpush/v1/processrequest', {
    BusinessShortCode: config.DARAJA_SHORTCODE,
    Password: password(ts),
    Timestamp: ts,
    TransactionType: 'CustomerPayBillOnline',
    Amount: amountKes,
    PartyA: phone,
    PartyB: config.DARAJA_SHORTCODE,
    PhoneNumber: phone,
    CallBackURL: `${config.PUBLIC_API_URL}/api/payments/mpesa/callback/${config.MPESA_CALLBACK_SECRET}`,
    AccountReference: reference,                 // shown on the guest's phone: "SE-7K3QXM"
    TransactionDesc: 'Safari Ember deposit',
  });
  if (!res.ok || body.ResponseCode !== '0' || !body.CheckoutRequestID) {
    logger.warn({ status: res.status, code: body.errorCode ?? body.ResponseCode, msg: body.errorMessage ?? body.ResponseDescription }, 'STK push refused');
    throw new DarajaError('STK push refused', { status: res.status, body });
  }
  return { checkoutRequestId: body.CheckoutRequestID, merchantRequestId: body.MerchantRequestID };
}

/**
 * The ResultCodes that are a final "no" for a prompt: no balance, couldn't lock the account
 * (another prompt in progress), expired, couldn't send, cancelled, phone unreachable, wrong PIN.
 * Only these fail a payment. Any OTHER non-zero code is not treated as an answer: Safaricom also
 * uses ResultCodes for "still processing" (e.g. 4999), and its codes change without notice.
 * Failing on an unknown code is how a guest gets charged with the page saying it failed.
 */
export const FINAL_FAILURES = new Set(['1', '1001', '1019', '1025', '1032', '1037', '2001']);

/**
 * Asks Safaricom what happened to a push.
 *   state 'paid'    ResultCode 0
 *   state 'failed'  one of FINAL_FAILURES (cancelled, wrong PIN, no funds, timed out...)
 *   state 'pending' Safaricom hasn't decided yet (the guest may still be typing their PIN), or
 *                   answered with a code we don't know as final; resultCode says which
 */
export async function stkQuery(checkoutRequestId) {
  const ts = nairobiTimestamp();
  const { res, body } = await post('/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: config.DARAJA_SHORTCODE,
    Password: password(ts),
    Timestamp: ts,
    CheckoutRequestID: checkoutRequestId,
  });
  // "The transaction is being processed" comes back as an HTTP error with this code.
  if (body.errorCode === '500.001.1001') return { state: 'pending' };
  if (!res.ok || body.ResultCode === undefined) {
    throw new DarajaError('STK query failed', { status: res.status, body });
  }
  const code = String(body.ResultCode);
  if (code === '0') return { state: 'paid', resultCode: code, resultDesc: body.ResultDesc };
  if (FINAL_FAILURES.has(code)) return { state: 'failed', resultCode: code, resultDesc: body.ResultDesc };
  logger.info({ resultCode: code, resultDesc: body.ResultDesc }, 'STK query: not a final answer yet; will ask again');
  return { state: 'pending', resultCode: code, resultDesc: body.ResultDesc };
}
