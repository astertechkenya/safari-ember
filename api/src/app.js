// app.js: builds the Express app (middleware + routes) without starting a server.
//
// Keeping "build" separate from "listen" (server.js) lets the tests import the app and send it
// requests with Supertest, with no real port involved. Same structure as NURA.
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { config } from './config.js';
import { logger, LOG_OPTIONS } from './logger.js';
import { db } from './db/client.js';
import { verifyNetlifySignature } from './lib/clientIp.js';
import { reqSerializer } from './lib/logSafe.js';
import { sameOrigin } from './middleware/sameOrigin.js';
import { notFound, errorHandler } from './middleware/errors.js';
import { roomsRouter } from './routes/rooms.js';
import { availabilityRouter } from './routes/availability.js';
import { activitiesRouter } from './routes/activities.js';
import { bookingsRouter } from './routes/bookings.js';
import { enquiriesRouter } from './routes/enquiries.js';
import { paymentsRouter } from './routes/payments.js';

export function createApp() {
  const app = express();

  // Netlify (the /api proxy) and Render sit in front of us. Trusting exactly one proxy hop makes
  // req.ip the real client (for rate limits) without letting a client fake its IP by sending
  // its own X-Forwarded-For header.
  app.set('trust proxy', 1);
  app.disable('x-powered-by'); // don't advertise the framework

  app.use(helmet()); // sensible security headers on every API response

  // One log line per request, each with an ID that is also returned in error responses.
  app.use(pinoHttp({
    logger,
    genReqId: (req, res) => {
      const id = randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    // Health checks and the uptime monitor would bury real traffic: served, not logged.
    autoLogging: config.isTest ? false : { ignore: (req) => req.url === '/api/health' || req.url === '/api/ping' },
    // Only what's needed to trace a request: no headers, no bodies, no personal query values
    // (Kenya's Data Protection Act asks for data minimisation).
    serializers: {
      req: reqSerializer(verifyNetlifySignature),
      res: (res) => ({ statusCode: res.statusCode }),
      err: LOG_OPTIONS.serializers.err,
    },
  }));

  app.use(express.json({
    limit: '50kb',                // oversized bodies are refused before any route sees them
    // Paystack signs the exact bytes it sends. Keep them for the webhook route only: parsing
    // and re-serialising could change spacing and break the signature check.
    verify: (req, res, buf) => { if (req.url.startsWith('/api/payments/')) req.rawBody = buf; },
  }));

  // Liveness: is the process up? No database query, so frequent checks don't keep Neon awake.
  app.get('/api/ping', (req, res) => res.json({ ok: true }));
  // Readiness, with the database: for checking by hand after a deploy.
  app.get('/api/health', async (req, res) => {
    await db.execute(sql`select 1`);
    res.json({ ok: true });
  });

  // Payment providers' servers, before the CSRF check: they're not browsers (no Origin), and
  // each route authenticates its caller itself (a secret path, an HMAC signature).
  app.use('/api/payments', paymentsRouter);

  app.use(sameOrigin);          // refuse writes triggered by other websites (CSRF)

  app.use('/api/rooms', roomsRouter);
  app.use('/api/availability', availabilityRouter);
  app.use('/api/activities', activitiesRouter);
  app.use('/api/bookings', bookingsRouter);
  app.use('/api/enquiries', enquiriesRouter);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
