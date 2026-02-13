import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getTimConfigRoot } from '../../common/config_paths.js';
import { importFromJsonFiles, markImportCompleted, shouldRunImport } from './json_import.js';
import { runMigrations } from './migrations.js';

let databaseSingleton: Database | null = null;

export function getDefaultDatabasePath(): string {
  return path.join(getTimConfigRoot(), 'tim.db');
}

function applyPragmas(db: Database): void {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA synchronous = NORMAL');
}

export function openDatabase(dbPath: string = getDefaultDatabasePath()): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  try {
    applyPragmas(db);
    runMigrations(db);

    if (shouldRunImport(db)) {
      const defaultDbPath = getDefaultDatabasePath();
      const configRoot = dbPath === defaultDbPath ? getTimConfigRoot() : path.dirname(dbPath);
      importFromJsonFiles(db, configRoot);
      markImportCompleted(db);
    }
  } catch (err) {
    db.close(false);
    throw err;
  }

  return db;
}

export function getDatabase(): Database {
  if (!databaseSingleton) {
    databaseSingleton = openDatabase();
  }

  return databaseSingleton;
}

export function closeDatabaseForTesting(): void {
  if (!databaseSingleton) {
    return;
  }

  databaseSingleton.close(false);
  databaseSingleton = null;
}
