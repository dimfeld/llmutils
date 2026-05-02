import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

// Canonical helpers write the main-node-confirmed mirror table and require an
// explicit revision from that canonical source. Projection helpers write the
// user-visible working table and keep the legacy local revision bump behavior.
// Sync-aware code must route writes through sync/write_router.ts.

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

type ProjectSettingTable = 'project_setting' | 'project_setting_canonical';
type RevisionWriteMode = 'auto' | 'explicit';

function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function getProjectSettingRow(
  db: Database,
  table: ProjectSettingTable,
  projectId: number,
  setting: string
): ProjectSetting | null {
  return (
    (db
      .prepare(
        `
          SELECT project_id, setting, value, revision, updated_at, updated_by_node
          FROM ${table}
          WHERE project_id = ? AND setting = ?
        `
      )
      .get(projectId, setting) as ProjectSetting | null) ?? null
  );
}

export function writeProjectionProjectSettingRow(
  db: Database,
  projectId: number,
  setting: string,
  value: unknown,
  options: { revision?: number; updatedByNode?: string | null } = {}
): boolean {
  return writeProjectSettingRow(
    db,
    'project_setting',
    projectId,
    setting,
    value,
    options,
    typeof options.revision === 'number' ? 'explicit' : 'auto'
  );
}

export function writeCanonicalProjectSettingRow(
  db: Database,
  projectId: number,
  setting: string,
  value: unknown,
  options: { revision: number; updatedAt?: string | null; updatedByNode?: string | null }
): boolean {
  return writeProjectSettingRow(
    db,
    'project_setting_canonical',
    projectId,
    setting,
    value,
    options,
    'explicit'
  );
}

function writeProjectSettingRow(
  db: Database,
  table: ProjectSettingTable,
  projectId: number,
  setting: string,
  value: unknown,
  options: { revision?: number; updatedAt?: string | null; updatedByNode?: string | null } = {},
  revisionMode: RevisionWriteMode
): boolean {
  if (value === undefined) {
    throw new Error('Cannot set a project setting to undefined. Use deleteProjectSetting instead.');
  }
  if (revisionMode === 'explicit' && typeof options.revision !== 'number') {
    throw new Error('Explicit project setting writes require a revision');
  }

  const nextValueJson = JSON.stringify(value);
  const updatedByNode = options.updatedByNode ?? null;
  const updatedAtSql = options.updatedAt === undefined ? SQL_NOW_ISO_UTC : '?';
  const nextRevision = revisionMode === 'explicit' ? options.revision! : 1;
  const existing = getProjectSettingRow(db, table, projectId, setting);
  if (
    existing &&
    canonicalJsonStringify(JSON.parse(existing.value)) === canonicalJsonStringify(value) &&
    existing.updated_by_node === updatedByNode &&
    (options.updatedAt === undefined || existing.updated_at === options.updatedAt) &&
    (revisionMode === 'auto' || existing.revision === nextRevision)
  ) {
    return false;
  }

  db.prepare(
    `
      INSERT INTO ${table} (
        project_id,
        setting,
        value,
        revision,
        updated_at,
        updated_by_node
      ) VALUES (?, ?, ?, ?, ${updatedAtSql}, ?)
      ON CONFLICT(project_id, setting) DO UPDATE SET
        value = excluded.value,
        revision = ${revisionMode === 'explicit' ? 'excluded.revision' : `${table}.revision + 1`},
        updated_at = excluded.updated_at,
        updated_by_node = excluded.updated_by_node
    `
  ).run(
    projectId,
    setting,
    nextValueJson,
    nextRevision,
    ...(options.updatedAt === undefined ? [] : [options.updatedAt]),
    updatedByNode
  );
  return true;
}

export function deleteProjectionProjectSettingRow(
  db: Database,
  projectId: number,
  setting: string
): boolean {
  return deleteProjectSettingRow(db, 'project_setting', projectId, setting);
}

export function deleteCanonicalProjectSettingRow(
  db: Database,
  projectId: number,
  setting: string
): boolean {
  return deleteProjectSettingRow(db, 'project_setting_canonical', projectId, setting);
}

function deleteProjectSettingRow(
  db: Database,
  table: ProjectSettingTable,
  projectId: number,
  setting: string
): boolean {
  const result = db
    .prepare(`DELETE FROM ${table} WHERE project_id = ? AND setting = ?`)
    .run(projectId, setting);

  return result.changes > 0;
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

/**
 * @deprecated Sync-aware code MUST go through write_router.ts. This legacy
 * helper writes projection state and mirrors it to canonical for local/main
 * setup paths where canonical and projection are equivalent.
 */
export function setProjectSetting(
  db: Database,
  projectId: number,
  setting: string,
  value: unknown,
  options: { updatedByNode?: string | null } = {}
): void {
  const setInTransaction = db.transaction(
    (
      nextProjectId: number,
      nextSetting: string,
      nextValue: unknown,
      updatedByNode: string | null
    ): void => {
      writeProjectionProjectSettingRow(db, nextProjectId, nextSetting, nextValue, {
        updatedByNode,
      });
      const row = getProjectSettingRow(db, 'project_setting', nextProjectId, nextSetting);
      if (row) {
        writeCanonicalProjectSettingRow(
          db,
          nextProjectId,
          nextSetting,
          JSON.parse(row.value) as unknown,
          {
            revision: row.revision,
            updatedAt: row.updated_at,
            updatedByNode: row.updated_by_node,
          }
        );
      }
    }
  );

  setInTransaction.immediate(projectId, setting, value, options.updatedByNode ?? null);
}

/**
 * @deprecated Sync-aware code MUST go through write_router.ts. This legacy
 * helper deletes projection state and mirrors the deletion to canonical for
 * local/main setup paths where canonical and projection are equivalent.
 */
export function deleteProjectSetting(db: Database, projectId: number, setting: string): boolean {
  const deleteInTransaction = db.transaction(
    (nextProjectId: number, nextSetting: string): boolean => {
      const changed = deleteProjectionProjectSettingRow(db, nextProjectId, nextSetting);
      deleteCanonicalProjectSettingRow(db, nextProjectId, nextSetting);
      return changed;
    }
  );

  return deleteInTransaction.immediate(projectId, setting);
}
