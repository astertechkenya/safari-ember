// client.js: one connection pool for the whole app.
//
// A pool keeps a few database connections open and lends them out per query. Opening a
// fresh connection for every request would be slow, and Neon limits how many you can hold.
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as schema from './schema.js';

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,                        // plenty for one small server; Neon's free tier allows more
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000, // fail loudly instead of hanging if the database is unreachable
});

export const db = drizzle({ client: pool, schema, casing: 'snake_case' });

// A connection can drop at any moment: Neon restarts a compute, the Wi-Fi blinks, a router times
// out an idle line. node-postgres reports that as an 'error' EVENT, and in Node an error event
// nobody listens to crashes the whole process ("Unhandled 'error' event ... ECONNRESET"). So listen:
//   - on the pool, for connections sitting idle in it (the pool then throws that one away)
//   - on each connection, for one that's lent out between two queries (e.g. inside a transaction):
//     the query in progress fails with its own error, and the request gets a normal 500
// Either way: one failed request at worst, logged, and the server carries on.
pool.on('error', (err) => logger.warn({ err: err.message, code: err.code }, 'idle database connection dropped; the pool will open a new one'));
pool.on('connect', (client) => {
  client.on('error', (err) => logger.warn({ err: err.message, code: err.code }, 'database connection dropped mid-use'));
});
