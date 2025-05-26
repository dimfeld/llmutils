#!/usr/bin/env bun
import { loadConfig } from '../config.js';
import { getDb } from './index.js';
import { tasks, workspaces } from './schema.js';
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
  log('Error querying tasks table:', e);
}

log('Testing database by selecting from workspaces table...');

try {
  const result = db.select().from(workspaces).limit(1).all();
  log(`Query successful. Found ${result.length} workspaces.`);
} catch (e) {
  log('Error querying workspaces table:', e);
}

log('Database test completed.');
