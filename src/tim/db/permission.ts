import type { Database } from 'bun:sqlite';

export interface Permissions {
  allow: string[];
  deny: string[];
}

type PermissionType = 'allow' | 'deny';

interface PermissionRow {
  permission_type: PermissionType;
  pattern: string;
}

export function getPermissions(db: Database, projectId: number): Permissions {
  const rows = db
    .prepare(
      `
      SELECT permission_type, pattern
      FROM permission
      WHERE project_id = ?
      ORDER BY permission_type, pattern
    `
    )
    .all(projectId) as PermissionRow[];

  const permissions: Permissions = {
    allow: [],
    deny: [],
  };

  for (const row of rows) {
    permissions[row.permission_type].push(row.pattern);
  }

  return permissions;
}

export function addPermission(
  db: Database,
  projectId: number,
  type: PermissionType,
  pattern: string
): boolean {
  const addInTransaction = db.transaction(
    (nextProjectId: number, nextType: PermissionType, nextPattern: string): boolean => {
      const existing = db
        .prepare(
          `
          SELECT id
          FROM permission
          WHERE project_id = ? AND permission_type = ? AND pattern = ?
        `
        )
        .get(nextProjectId, nextType, nextPattern) as { id?: number } | null;

      if (existing) {
        return false;
      }

      db.prepare(
        `
        INSERT INTO permission (project_id, permission_type, pattern)
        VALUES (?, ?, ?)
      `
      ).run(nextProjectId, nextType, nextPattern);

      return true;
    }
  );

  return addInTransaction.immediate(projectId, type, pattern);
}

export function removePermission(
  db: Database,
  projectId: number,
  type: PermissionType,
  pattern: string
): boolean {
  const removeInTransaction = db.transaction(
    (nextProjectId: number, nextType: PermissionType, nextPattern: string): boolean => {
      const result = db
        .prepare(
          `
          DELETE FROM permission
          WHERE project_id = ? AND permission_type = ? AND pattern = ?
        `
        )
        .run(nextProjectId, nextType, nextPattern);
      return result.changes > 0;
    }
  );

  return removeInTransaction.immediate(projectId, type, pattern);
}

export function setPermissions(db: Database, projectId: number, permissions: Permissions): void {
  const setInTransaction = db.transaction(
    (nextProjectId: number, nextPermissions: Permissions): void => {
      db.prepare('DELETE FROM permission WHERE project_id = ?').run(nextProjectId);

      const insertPermission = db.prepare(
        `
      INSERT INTO permission (project_id, permission_type, pattern)
      VALUES (?, ?, ?)
    `
      );

      for (const pattern of nextPermissions.allow) {
        insertPermission.run(nextProjectId, 'allow', pattern);
      }
      for (const pattern of nextPermissions.deny) {
        insertPermission.run(nextProjectId, 'deny', pattern);
      }
    }
  );

  setInTransaction.immediate(projectId, permissions);
}
