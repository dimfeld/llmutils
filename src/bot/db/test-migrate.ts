#!/usr/bin/env bun
import Database from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
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
    migrate(db, { migrationsFolder: './src/bot/db/migrations' });

    log('Database migrations completed successfully.');

    // Close the database connection
    sqlite.close();
  } catch (e) {
    error('Error running database migrations:', e);
    process.exit(1);
  }
}

// Run the migrations
runMigrations()
  .then(() => {
    log('Migration script completed');
    process.exit(0);
  })
  .catch((err) => {
    error('Migration script failed:', err);
    process.exit(1);
  });
