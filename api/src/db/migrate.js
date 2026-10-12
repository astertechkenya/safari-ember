// migrate.js: applies any SQL files in api/drizzle/ that the database has not seen yet.
//
// Run by `npm run db:migrate`, from your laptop. For production (Phase 6) it runs as the
// production database's OWNER, before pushing code that needs the change. Render doesn't run
// it: Render's login can't change tables, and the server refuses to start in production while
// a migration is missing (db/schemaCheck.js). It uses the runtime migrator from drizzle-orm
// (not drizzle-kit), so production does not need dev tools installed.
// Drizzle records what it applied in drizzle.__drizzle_migrations, so running it twice is safe.
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';

export async function runMigrations() {
  const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  await migrate(db, { migrationsFolder });
}

// Only run when executed directly (`node src/db/migrate.js`), not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Say who and where (never the password), so a wrong string is obvious before anything runs.
  const target = new URL(process.env.DATABASE_URL ?? 'postgresql://unset');
  console.log(`Migrating ${target.pathname.slice(1)} on ${target.hostname} as ${decodeURIComponent(target.username)}`);
  try {
    await runMigrations();
    console.log('Migrations applied.');
  } catch (err) {
    // Drizzle's own message only says which statement failed; Postgres' reason is in the cause.
    console.error('Migration failed:', (err.message ?? '').split('\nparams:')[0]);
    if (err.cause?.message) console.error('Reason:', err.cause.message);
    if (/permission denied/.test(err.cause?.message ?? '')) {
      console.error('This login can\'t change tables. Migrations need the database OWNER (neondb_owner), not the app login.');
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
