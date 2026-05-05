import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getTimConfigRoot } from '../../common/config_paths.js';
import { debugLog } from '../../logging.js';
import { importFromJsonFiles, markImportCompleted, shouldRunImport } from './json_import.js';
import { runMigrations } from './migrations.js';
import { isForeignKeyConstraintError, logForeignKeyCheck } from './sqlite_debug.js';

let databaseSingleton: Database | null = null;

export const DATABASE_FILENAME = process.env.TIM_DATABASE_FILENAME || 'tim.db';
export function getDefaultDatabasePath(): string {
  return path.join(getTimConfigRoot(), DATABASE_FILENAME);
}

function applyPragmas(db: Database): void {
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
  db.run('PRAGMA busy_timeout = 5000');
  db.run('PRAGMA synchronous = NORMAL');
}

export function openDatabase(dbPath: string = getDefaultDatabasePath()): Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  debugLog(`[sqlite] Opening database at ${dbPath}`);
  const db = new Database(dbPath);
  try {
    applyPragmas(db);
    debugLog(`[sqlite] Applied pragmas for ${dbPath}`);
    runMigrations(db);
    debugLog(`[sqlite] Migrations completed for ${dbPath}`);

    if (shouldRunImport(db)) {
      const defaultDbPath = getDefaultDatabasePath();
      const configRoot = dbPath === defaultDbPath ? getTimConfigRoot() : path.dirname(dbPath);
      debugLog(`[sqlite] Running legacy JSON import for ${dbPath} from ${configRoot}`);
      importFromJsonFiles(db, configRoot);
      markImportCompleted(db);
      debugLog(`[sqlite] Legacy JSON import completed for ${dbPath}`);
    }
  } catch (err) {
    if (isForeignKeyConstraintError(err)) {
      debugLog(`[sqlite] Foreign key constraint failed while opening ${dbPath}:`, err);
      logForeignKeyCheck(db, `openDatabase(${dbPath})`);
    } else {
      debugLog(`[sqlite] Failed to open ${dbPath}:`, err);
    }
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
