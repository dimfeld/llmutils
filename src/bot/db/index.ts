import { drizzle } from 'drizzle-orm/better-sqlite3';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import * as schema from './schema.js';

const sqlite = new Database(config.DATABASE_PATH);
export const db = drizzle(sqlite, { schema });

export * from './schema.js';
