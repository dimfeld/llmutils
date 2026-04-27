import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface ProjectSetting {
  project_id: number;
  setting: string;
  value: string;
  revision: number;
  updated_at: string | null;
  updated_by_node: string | null;
}

export interface ProjectSettingWithMetadata {
  value: unknown;
  revision: number;
  updatedAt: string | null;
  updatedByNode: string | null;
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

export function getProjectSettingWithMetadata(
  db: Database,
  projectId: number,
  setting: string
): ProjectSettingWithMetadata | null {
  const row = db
    .prepare(
      `
        SELECT value, revision, updated_at, updated_by_node
        FROM project_setting
        WHERE project_id = ? AND setting = ?
      `
    )
    .get(projectId, setting) as Pick<
    ProjectSetting,
    'value' | 'revision' | 'updated_at' | 'updated_by_node'
  > | null;

  if (!row) {
    return null;
  }

  return {
    value: JSON.parse(row.value) as unknown,
    revision: row.revision,
    updatedAt: row.updated_at,
    updatedByNode: row.updated_by_node,
  };
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

export function getProjectSettingsWithMetadata(
  db: Database,
  projectId: number
): Record<string, ProjectSettingWithMetadata> {
  const rows = db
    .prepare(
      `
        SELECT setting, value, revision, updated_at, updated_by_node
        FROM project_setting
        WHERE project_id = ?
        ORDER BY setting
      `
    )
    .all(projectId) as Array<
    Pick<ProjectSetting, 'setting' | 'value' | 'revision' | 'updated_at' | 'updated_by_node'>
  >;

  const settings: Record<string, ProjectSettingWithMetadata> = {};
  for (const row of rows) {
    settings[row.setting] = {
      value: JSON.parse(row.value) as unknown,
      revision: row.revision,
      updatedAt: row.updated_at,
      updatedByNode: row.updated_by_node,
    };
  }

  return settings;
}

export function setProjectSetting(
  db: Database,
  projectId: number,
  setting: string,
  value: unknown,
  options: { updatedByNode?: string | null } = {}
): void {
  if (value === undefined) {
    throw new Error('Cannot set a project setting to undefined. Use deleteProjectSetting instead.');
  }

  const setInTransaction = db.transaction(
    (
      nextProjectId: number,
      nextSetting: string,
      nextValue: unknown,
      updatedByNode: string | null
    ): void => {
      db.prepare(
        `
          INSERT INTO project_setting (
            project_id,
            setting,
            value,
            revision,
            updated_at,
            updated_by_node
          ) VALUES (?, ?, ?, 1, ${SQL_NOW_ISO_UTC}, ?)
          ON CONFLICT(project_id, setting) DO UPDATE SET
            value = excluded.value,
            revision = project_setting.revision + 1,
            updated_at = ${SQL_NOW_ISO_UTC},
            updated_by_node = excluded.updated_by_node
        `
      ).run(nextProjectId, nextSetting, JSON.stringify(nextValue), updatedByNode);
    }
  );

  setInTransaction.immediate(projectId, setting, value, options.updatedByNode ?? null);
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
