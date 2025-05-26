#!/usr/bin/env bun
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { loadConfig } from '../config.js';
import * as schema from './schema.js';
import { log, error } from '../../logging.js';

async function runMigrations() {
  log('Running database migrations...');
  try {
    // Load config
    const config = loadConfig();

    // Create database connection
    const sqlite = new Database(config.DATABASE_PATH);
    const db = drizzle(sqlite, { schema });

    // Run migrations
    await migrate(db, { migrationsFolder: './src/bot/db/migrations' });

    log('Database migrations completed successfully.');

    // Close the database connection
    sqlite.close();
  } catch (e) {
    error('Error running database migrations:', e);
    process.exit(1);
  }
}

// Check if the script is being run directly
if (import.meta.main) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
