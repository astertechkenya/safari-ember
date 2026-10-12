// client.js: one connection pool for the whole app.
//
// A pool keeps a few database connections open and lends them out per query. Opening a
// fresh connection for every request would be slow, and Neon limits how many you can hold.
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,                        // plenty for one small server; Neon's free tier allows more
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000, // fail loudly instead of hanging if the database is unreachable
});

export const db = drizzle({ client: pool, schema, casing: 'snake_case' });
