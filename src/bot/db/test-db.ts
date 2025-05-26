#!/usr/bin/env bun
import { loadConfig } from '../config.js';
import { getDb } from './index.js';
import { tasks } from './schema.js';
import { log } from '../../logging.js';

// Load config first
loadConfig();

// Test database connection
const db = getDb();

log('Database connection established successfully');
log('Testing database by selecting from tasks table...');

try {
  const result = db.select().from(tasks).limit(1).all();
  log(`Query successful. Found ${result.length} tasks.`);
} catch (e) {
  log('Error querying database:', e);
}

log('Database test completed.');
