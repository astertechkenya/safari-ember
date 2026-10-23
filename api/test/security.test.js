// The basics every request gets: headers, error format, CSRF, body size, rate limits, logs.
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { Writable } from 'node:stream';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/client.js';
import { createLogger } from '../src/logger.js';
import { safeUrl } from '../src/lib/logSafe.js';
import { loadConfig } from '../src/config.js';
import { as, inDays } from './helpers.js';

const app = createApp();
afterAll(() => pool.end());

describe('every response', () => {
  it('carries security headers and hides the framework', async () => {
    const res = await request(app).get('/api/ping');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports errors as { error, requestId }, never a stack trace', async () => {
    const res = await request(app).get('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    const bad = await request(app).post('/api/enquiries').set('content-type', 'application/json').send('{"broken"');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toMatch(/at .*\.js|node_modules/);
  });

  it('refuses oversized bodies', async () => {
    const res = await as(app).post('/api/enquiries').send({ message: 'x'.repeat(60_000) });
    expect(res.status).toBe(413);
  });

  it('answers the database health check', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
  });
});

describe('cross-site requests (CSRF)', () => {
  const body = { firstName: 'A', lastName: 'B', email: 'a@b.co', message: 'hi' };
  it('refuses a write sent from another website', async () => {
    const res = await as(app).post('/api/enquiries').set('origin', 'https://evil.example').send(body);
    expect(res.status).toBe(403);
  });
  it('accepts the site itself, and the local preview', async () => {
    for (const origin of ['http://localhost:8000', 'http://127.0.0.1:8000']) {
      expect((await as(app).post('/api/enquiries').set('origin', origin).send(body)).status).toBe(201);
    }
  });
});

describe('rate limits', () => {
  it('allow 8 holds per 10 minutes from one address', async () => {
    // Invalid bookings still count (they're stopped by validation after the limiter), so this
    // doesn't need to use up real rooms.
    const ip = '10.201.0.1';
    const hold = () => as(app, ip).post('/api/bookings').send({ rooms: [{ room: 'hearthside-room', units: 1 }], checkIn: inDays(10), checkOut: inDays(11), guests: 2 });
    for (let i = 0; i < 8; i += 1) expect((await hold()).status).toBe(400);
    expect((await hold()).status).toBe(429);
  });

  it("can't be dodged by inventing an IP header without Netlify's signature", async () => {
    const ip = '10.202.0.1';
    const unsigned = (fake) => request(app).post('/api/bookings').set('x-nf-client-connection-ip', fake).send({});
    // Without a valid signature the header is ignored, so all of these count against ONE address.
    for (let i = 0; i < 8; i += 1) expect((await unsigned(`${ip}${i}`)).status).toBe(400);
    expect((await unsigned('10.202.9.9')).status).toBe(429);
  });
});

describe('logs', () => {
  it('never contain guest details', async () => {
    const lines = [];
    const log = createLogger('info', new Writable({ write(chunk, enc, cb) { lines.push(chunk.toString()); cb(); } }));
    log.info({ booking: { firstName: 'Amina', email: 'amina@example.com', phone: '+254712345678', requests: 'Anniversary' }, bookingId: 7 }, 'hold created');
    const out = lines.join('');
    expect(out).toContain('"bookingId":7');
    expect(out).not.toMatch(/Amina|amina@|712345678|Anniversary/);
  });
  it('keep stay dates but drop anything personal from URLs', () => {
    expect(safeUrl('/api/availability?checkIn=2027-01-01&checkOut=2027-01-03&guests=2&email=a@b.co'))
      .toBe('/api/availability?checkIn=2027-01-01&checkOut=2027-01-03&guests=2&email=[redacted]');
  });
});

describe('settings', () => {
  const base = { DATABASE_URL: 'postgresql://ember_app:x@db.example/ember_prod?sslmode=verify-full', SESSION_SECRET: 'z'.repeat(40) };
  it('refuse to start without a session secret, or with a short one', () => {
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/at least 32/);
  });
  it('refuse a production database login that could drop tables, or an unverified connection', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' })).not.toThrow();
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DATABASE_URL: 'postgresql://neondb_owner:x@db.example/ember_prod?sslmode=verify-full' })).toThrow(/limited app login/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', DATABASE_URL: 'postgresql://ember_app:x@db.example/ember_prod?sslmode=require' })).toThrow(/verify-full/);
  });
  it('check the booking rules are sensible numbers', () => {
    expect(() => loadConfig({ ...base, DEPOSIT_PERCENT: '0' })).toThrow(/DEPOSIT_PERCENT/);
    expect(() => loadConfig({ ...base, DEPOSIT_PERCENT: '' })).not.toThrow();     // empty = default
    expect(loadConfig(base).DEPOSIT_PERCENT).toBe(30);
  });

  it('only connects to Safari Ember databases, and the tests only to a _test one', () => {
    const at = (name, env = {}) => () => loadConfig({ ...base, DATABASE_URL: `postgresql://u:x@db.example/${name}?sslmode=require`, ...env });
    expect(at('nura_prod')).toThrow(/"nura_prod".*ember_/);
    expect(at('neondb')).toThrow(/"neondb"/);
    expect(at('ember_dev')).not.toThrow();
    expect(at('ember_dev', { NODE_ENV: 'test' })).toThrow(/isn't a _test database/);
    expect(at('ember_test', { NODE_ENV: 'test' })).not.toThrow();
  });
});
