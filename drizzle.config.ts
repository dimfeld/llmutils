import type { Config } from 'drizzle-kit';
import * as dotenv from 'dotenv/config'; // ensure .env is loaded

if (!process.env.DATABASE_PATH) {
  throw new Error('DATABASE_PATH environment variable is not set');
}

export default {
  schema: './src/bot/db/schema.ts',
  out: './src/bot/db/migrations',
  driver: 'better-sqlite',
  dbCredentials: {
    url: process.env.DATABASE_PATH,
  },
  verbose: true,
  strict: true,
} satisfies Config;
