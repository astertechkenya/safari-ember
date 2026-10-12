// schemaCheck.js: is the database's structure as new as this code?
//
// Migrations don't run on Render: Render's API will connect as a limited app login, which may read and
// write rows but not create or alter tables (ops/README.md). They run from your laptop, as the
// production database's owner, BEFORE you push code that needs them. If that step is
// forgotten, the new code would start against old tables and fail on its first query that
// touches the change, possibly halfway through a booking. So the server checks at startup:
// every migration in drizzle/ must be recorded in the database. In production it refuses to
// start otherwise, and Render keeps the previous version running.
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from './client.js';

export const journal = () =>
  JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')).entries;

/**
 * The migrations this code has that the database hasn't run, by name (e.g. 0001_seasonal_rates).
 * Drizzle records each applied migration's "when" (from the journal) as created_at.
 */
export async function pendingMigrations(entries = journal()) {
  const { rows } = await db.execute(sql`select created_at from drizzle.__drizzle_migrations`);
  const applied = new Set(rows.map((r) => Number(r.created_at)));
  return entries.filter((e) => !applied.has(Number(e.when))).map((e) => e.tag);
}
