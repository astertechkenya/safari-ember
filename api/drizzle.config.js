// drizzle.config.js: settings for drizzle-kit, the dev tool that writes migrations.
import { defineConfig } from 'drizzle-kit';

try {
  process.loadEnvFile('.env');
} catch (err) {
  if (err.code !== 'ENOENT') throw err; // no .env is fine (real environment); anything else is not
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.js',
  out: './drizzle',               // generated .sql migrations land here and ARE committed
  casing: 'snake_case',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,                   // drizzle-kit asks before anything that could lose data
});
