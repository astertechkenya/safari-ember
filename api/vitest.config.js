// vitest.config.js: tests run against a SEPARATE database (TEST_DATABASE_URL), which the test
// setup wipes and rebuilds on every run. Never point it at a database you care about.
import { defineConfig } from 'vitest/config';

// Load api/.env if it exists. Only "file not found" is ignored (CI sets real environment
// variables instead); any other problem, like an unreadable file, is reported.
try {
  process.loadEnvFile('.env');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const testUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testUrl) {
  throw new Error(
    'TEST_DATABASE_URL is empty or missing in api/.env. Put the ember_test connection string ' +
    'after TEST_DATABASE_URL= on one line, with no spaces around the = sign.',
  );
}
if (testUrl === process.env.DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL: the tests wipe their database.');
}
// globalSetup runs in this process and loads config.js, so it needs these too.
const TEST_SESSION_SECRET = 'test-only-session-secret-long-enough-4567';
process.env.DATABASE_URL = testUrl;
process.env.SESSION_SECRET = TEST_SESSION_SECRET;

export default defineConfig({
  test: {
    env: {                   // for the test files: fixed values, whatever api/.env says
      NODE_ENV: 'test',
      DATABASE_URL: testUrl,
      SESSION_SECRET: TEST_SESSION_SECRET,
      NETLIFY_PROXY_SECRET: 'test-only-secret-that-is-long-enough-123', // never a real secret
      SITE_URL: 'http://localhost:8000',
      DEPOSIT_PERCENT: '30',
      HOLD_MINUTES: '15',
      MAX_NIGHTS: '30',
      BOOKING_HORIZON_MONTHS: '18',
      FEW_LEFT: '3',
    },
    globalSetup: ['./test/globalSetup.js'],
    fileParallelism: false,  // files share one database, so run them one at a time
    testTimeout: 30_000,     // Neon can be a continent away; a truly hung test still fails
    hookTimeout: 60_000,
  },
});
