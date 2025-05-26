import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { config, loadConfig } from '../config.js';
import * as schema from './schema.js';

let _db: ReturnType<typeof drizzle> | null = null;
let _sqlite: Database.Database | null = null;

export function getDb() {
  if (!_db) {
    // Ensure config is loaded
    if (!config.DATABASE_PATH) {
      loadConfig();
    }

    _sqlite = new Database(config.DATABASE_PATH);
    _db = drizzle(_sqlite, { schema });
  }
  return _db;
}

// Export db as a getter to lazy-load
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(target, prop) {
    const database = getDb();
    return database[prop as keyof typeof database];
  },
});

export * from './schema.js';
export * from './task_checkpoints_manager.js';
