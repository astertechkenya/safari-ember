// Runs once before all tests: empty the test database, apply every migration, seed it.
// Starting from zero each time means tests never depend on leftovers from a previous run.
export default async function setup() {
  const { db, pool } = await import('../src/db/client.js');
  const { sql } = await import('drizzle-orm');
  const { runMigrations } = await import('../src/db/migrate.js');
  const { seed } = await import('../src/db/seed.js');
  await db.execute(sql`DROP SCHEMA IF EXISTS public CASCADE`);
  await db.execute(sql`DROP SCHEMA IF EXISTS drizzle CASCADE`);
  await db.execute(sql`CREATE SCHEMA public`);
  await runMigrations();
  await seed({ log: () => {} });
  await pool.end();
}
