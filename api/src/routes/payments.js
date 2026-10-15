// routes/payments.js: where payment providers report back, server to server.
//
//   POST /api/payments/mpesa/callback/:secret   Safaricom's STK result
//   POST /api/payments/paystack/webhook          Paystack's events, signed with our secret key
//
// No cookies, no Origin: these are Safaricom's and Paystack's servers, not browsers. The secret
// in the M-Pesa address keeps out anyone who doesn't know it (404, as if the route didn't
// exist); Paystack signs every event. Even then, a posted "paid" changes nothing by itself:
// services/payments.js asks the provider directly before marking anything paid.
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { handleMpesaCallback, handlePaystackEvent } from '../services/payments.js';
import { signatureValid } from '../services/paystack.js';

export const paymentsRouter = Router();

function secretMatches(given) {
  const want = Buffer.from(config.MPESA_CALLBACK_SECRET ?? '');
  const got = Buffer.from(String(given));
  // timingSafeEqual: a nearly-right guess takes as long to reject as a wrong one.
  return want.length > 0 && want.length === got.length && timingSafeEqual(want, got);
}

paymentsRouter.post('/mpesa/callback/:secret', (req, res) => {
  if (!secretMatches(req.params.secret)) return res.status(404).json({ error: 'Not found' });
  // Answer Safaricom straight away (it retries if we're slow), then do the work.
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  handleMpesaCallback(req.body).catch((err) => logger.error({ err }, 'M-Pesa callback processing failed; the job will re-check'));
});

paymentsRouter.post('/paystack/webhook', (req, res) => {
  if (!config.cardEnabled || !signatureValid(req.rawBody, req.get('x-paystack-signature'))) {
    logger.warn('Paystack webhook with a bad or missing signature: ignored');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  res.sendStatus(200);
  handlePaystackEvent(req.body).catch((err) => logger.error({ err }, 'Paystack webhook processing failed; the job will re-check'));
});
