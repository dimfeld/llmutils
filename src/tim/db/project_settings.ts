import type { Database } from 'bun:sqlite';

export interface ProjectSetting {
  project_id: number;
  setting: string;
  value: string;
}

export function getProjectSetting(db: Database, projectId: number, setting: string): unknown {
  const row = db
    .prepare('SELECT value FROM project_setting WHERE project_id = ? AND setting = ?')
    .get(projectId, setting) as Pick<ProjectSetting, 'value'> | null;

  if (!row) {
    return null;
  }

  return JSON.parse(row.value) as unknown;
}

export function getProjectSettings(db: Database, projectId: number): Record<string, unknown> {
  const rows = db
    .prepare('SELECT setting, value FROM project_setting WHERE project_id = ? ORDER BY setting')
    .all(projectId) as Array<Pick<ProjectSetting, 'setting' | 'value'>>;

  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    settings[row.setting] = JSON.parse(row.value) as unknown;
  }

  return settings;
}

export function setProjectSetting(
  db: Database,
  projectId: number,
  setting: string,
  value: unknown
): void {
  if (value === undefined) {
    throw new Error('Cannot set a project setting to undefined. Use deleteProjectSetting instead.');
  }

  const setInTransaction = db.transaction(
    (nextProjectId: number, nextSetting: string, nextValue: unknown): void => {
      db.prepare(
        `
          INSERT OR REPLACE INTO project_setting (project_id, setting, value)
          VALUES (?, ?, ?)
        `
      ).run(nextProjectId, nextSetting, JSON.stringify(nextValue));
    }
  );

  setInTransaction.immediate(projectId, setting, value);
}

export function deleteProjectSetting(db: Database, projectId: number, setting: string): boolean {
  const deleteInTransaction = db.transaction(
    (nextProjectId: number, nextSetting: string): boolean => {
      const result = db
        .prepare('DELETE FROM project_setting WHERE project_id = ? AND setting = ?')
        .run(nextProjectId, nextSetting);

      return result.changes > 0;
    }
  );

  return deleteInTransaction.immediate(projectId, setting);
}
