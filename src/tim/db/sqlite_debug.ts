import type { Database } from 'bun:sqlite';

import { debugLog } from '../../logging.js';

interface ForeignKeyViolationRow {
  table: string;
  rowid: number;
  parent: string;
  fkid: number;
}

export function isForeignKeyConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /FOREIGN KEY constraint failed/i.test(message);
}

export function logForeignKeyCheck(db: Database, context: string): void {
  try {
    const violations = db.prepare('PRAGMA foreign_key_check').all() as ForeignKeyViolationRow[];
    if (violations.length === 0) {
      debugLog(`[sqlite] ${context}: foreign_key_check returned no violations`);
      return;
    }

    debugLog(`[sqlite] ${context}: foreign_key_check returned ${violations.length} violation(s)`);
    for (const violation of violations.slice(0, 20)) {
      debugLog('[sqlite] foreign_key_check violation:', {
        ...violation,
        row: loadViolationRow(db, violation.table, violation.rowid),
      });
    }
    if (violations.length > 20) {
      debugLog(`[sqlite] ...and ${violations.length - 20} more violation(s)`);
    }
  } catch (checkError) {
    debugLog(`[sqlite] ${context}: foreign_key_check failed:`, checkError);
  }
}

function loadViolationRow(db: Database, table: string, rowid: number): unknown {
  try {
    const safeTable = table.replaceAll('"', '""');
    return db.prepare(`SELECT * FROM "${safeTable}" WHERE rowid = ?`).get(rowid) ?? null;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
