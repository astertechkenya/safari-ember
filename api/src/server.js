// server.js: starts the HTTP server and shuts it down cleanly.
import { createApp } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { pool } from './db/client.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { pendingMigrations } from './db/schemaCheck.js';

// The database must already have every migration this code expects (see db/schemaCheck.js).
try {
  const pending = await pendingMigrations();
  if (pending.length) {
    const msg = `The database is missing migrations: ${pending.join(', ')}. Run them first: npm run db:migrate`;
    if (config.isProd) { logger.fatal(msg); process.exit(1); }
    logger.warn(msg);
  }
} catch (err) {
  logger.warn({ err }, 'could not check the database for missing migrations (has npm run db:migrate been run?)');
}

const server = createApp().listen(config.PORT, () => {
  logger.info(`Safari Ember API listening on http://localhost:${config.PORT} (${config.NODE_ENV})`);
  startJobs();
});

// Render sends SIGTERM before replacing the server on every deploy. Finishing in-flight requests
// and closing database connections avoids cutting a booking off halfway.
function shutdown(signal) {
  logger.info(`${signal} received, shutting down`);
  stopJobs();
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref(); // don't hang forever
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
