// GET /api/rooms
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/client.js';

const app = createApp();
afterAll(() => pool.end());

describe('rooms', () => {
  it('lists the three room types on the site, in order, with a "from" price', async () => {
    const res = await request(app).get('/api/rooms');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    const seeded = res.body.rooms.filter((r) => !r.slug.startsWith('test-'));
    expect(seeded.map((r) => r.slug)).toEqual(['hearthside-room', 'coalbed-suite', 'ember-penthouse']);
    // The long-rains rate (85%) is the lowest upcoming price: 28,000 × 0.85 = 23,800 → 24,000.
    expect(seeded[0]).toMatchObject({ name: 'Hearthside Room', kind: 'Deluxe', sleeps: 2, fromKes: 24_000 });
    expect(Object.keys(seeded[0]).sort()).toEqual(['description', 'fromKes', 'kind', 'name', 'sleeps', 'slug']);
  });
});
