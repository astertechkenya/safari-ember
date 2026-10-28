// The "Get in touch" form.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app.js';
import { db, pool } from '../src/db/client.js';
import { enquiries } from '../src/db/schema.js';
import { as, inDays } from './helpers.js';

const app = createApp();
afterAll(() => pool.end());
beforeEach(() => db.execute(sql`truncate enquiries restart identity`));

const valid = { firstName: 'James', lastName: 'Kanini', email: 'James@Example.com', subject: 'Wedding party', message: 'Could we book the whole lodge for a weekend?' };
const send = (body, ip) => as(app, ip).post('/api/enquiries').send(body);

describe('enquiries', () => {
  it('saves a message', async () => {
    const res = await send(valid);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
    const rows = await db.select().from(enquiries);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ firstName: 'James', email: 'james@example.com', subject: 'Wedding party', status: 'NEW', phone: null });
  });

  it('takes one "Your name" box, as on the homepage', async () => {
    const { firstName, lastName, subject, ...rest } = valid;
    expect((await send({ ...rest, name: '  Amina  Wanjiru Otieno ' })).status).toBe(201);
    expect((await send({ ...rest, name: 'Ophelia' })).status).toBe(201);
    const rows = await db.select().from(enquiries).orderBy(enquiries.id);
    expect(rows.map((r) => [r.firstName, r.lastName])).toEqual([['Amina', 'Wanjiru Otieno'], ['Ophelia', '']]);
  });

  it('takes optional dates, guests and phone', async () => {
    const res = await send({ ...valid, checkIn: inDays(30), checkOut: inDays(33), guests: 14, phone: '+44 7700 900123' });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(enquiries);
    expect(row).toMatchObject({ guests: 14, phone: '+447700900123', checkIn: inDays(30) });
  });

  it('thanks a bot that fills the hidden field, but saves nothing', async () => {
    const res = await send({ ...valid, website: 'http://spam.example' });
    expect(res.status).toBe(201);
    expect(await db.select().from(enquiries)).toHaveLength(0);
  });

  it('refuses incomplete or malformed messages', async () => {
    const cases = [
      [{ ...valid, message: '  ' }, 'message: is required'],
      [{ ...valid, email: 'nope' }, 'email: must be a valid email address'],
      [{ ...valid, lastName: undefined }, 'name: is required'],
      [{ email: 'a@b.co', message: 'Hi' }, 'name: is required'],
      [{ ...valid, checkIn: inDays(5), checkOut: inDays(4) }, 'checkOut: must be after check-in'],
      [{ ...valid, admin: true }, 'Unknown field: admin'],
    ];
    for (const [body, error] of cases) {
      const res = await send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(error);
    }
  });

  it('allows 5 messages an hour from one address, then asks to wait', async () => {
    const ip = '10.200.0.1';
    for (let i = 0; i < 5; i += 1) expect((await send(valid, ip)).status).toBe(201);
    const sixth = await send(valid, ip);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toMatch(/Too many messages/);
  });
});
