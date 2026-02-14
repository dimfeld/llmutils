import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface Project {
  id: number;
  repository_id: string;
  remote_url: string | null;
  last_git_root: string | null;
  external_config_path: string | null;
  external_tasks_dir: string | null;
  remote_label: string | null;
  highest_plan_id: number;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectOptions {
  remoteUrl?: string | null;
  lastGitRoot?: string | null;
  externalConfigPath?: string | null;
  externalTasksDir?: string | null;
  remoteLabel?: string | null;
  highestPlanId?: number;
}

export interface UpdateProjectOptions {
  remoteUrl?: string | null;
  lastGitRoot?: string | null;
  externalConfigPath?: string | null;
  externalTasksDir?: string | null;
  remoteLabel?: string | null;
}

function mapRowToProject(row: unknown): Project | null {
  return (row as Project | null) ?? null;
}

export function getProject(db: Database, repositoryId: string): Project | null {
  const row = db
    .prepare('SELECT * FROM project WHERE repository_id = ?')
    .get(repositoryId) as Record<string, unknown> | null;

  return mapRowToProject(row);
}

export function getProjectById(db: Database, projectId: number): Project | null {
  const row = db.prepare('SELECT * FROM project WHERE id = ?').get(projectId) as Record<
    string,
    unknown
  > | null;

  return mapRowToProject(row);
}

export function getOrCreateProject(
  db: Database,
  repositoryId: string,
  options: CreateProjectOptions = {}
): Project {
  // `options` are applied only during initial insert; existing rows are returned unchanged.
  const createOrGet = db.transaction(
    (repoId: string, createOptions: CreateProjectOptions): Project => {
      db.prepare(
        `
        INSERT OR IGNORE INTO project (
          repository_id,
          remote_url,
          last_git_root,
          external_config_path,
          external_tasks_dir,
          remote_label,
          highest_plan_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
      `
      ).run(
        repoId,
        createOptions.remoteUrl ?? null,
        createOptions.lastGitRoot ?? null,
        createOptions.externalConfigPath ?? null,
        createOptions.externalTasksDir ?? null,
        createOptions.remoteLabel ?? null,
        createOptions.highestPlanId ?? 0
      );

      const project = getProject(db, repoId);
      if (!project) {
        throw new Error(`Failed to create or fetch project for repository ${repoId}`);
      }

      return project;
    }
  );

  return createOrGet.immediate(repositoryId, options);
}

export function updateProject(
  db: Database,
  projectId: number,
  updates: UpdateProjectOptions
): Project | null {
  const updateAndFetch = db.transaction(
    (id: number, nextUpdates: UpdateProjectOptions): Project | null => {
      const fields: string[] = [];
      const values: Array<string | null> = [];

      if ('remoteUrl' in nextUpdates) {
        fields.push('remote_url = ?');
        values.push(nextUpdates.remoteUrl ?? null);
      }
      if ('lastGitRoot' in nextUpdates) {
        fields.push('last_git_root = ?');
        values.push(nextUpdates.lastGitRoot ?? null);
      }
      if ('externalConfigPath' in nextUpdates) {
        fields.push('external_config_path = ?');
        values.push(nextUpdates.externalConfigPath ?? null);
      }
      if ('externalTasksDir' in nextUpdates) {
        fields.push('external_tasks_dir = ?');
        values.push(nextUpdates.externalTasksDir ?? null);
      }
      if ('remoteLabel' in nextUpdates) {
        fields.push('remote_label = ?');
        values.push(nextUpdates.remoteLabel ?? null);
      }

      if (fields.length > 0) {
        fields.push(`updated_at = ${SQL_NOW_ISO_UTC}`);
        db.prepare(`UPDATE project SET ${fields.join(', ')} WHERE id = ?`).run(...values, id);
      }

      const row = db.prepare('SELECT * FROM project WHERE id = ?').get(id) as Record<
        string,
        unknown
      > | null;
      return mapRowToProject(row);
    }
  );

  return updateAndFetch.immediate(projectId, updates);
}

export function reserveNextPlanId(
  db: Database,
  repositoryId: string,
  localMaxId: number,
  count = 1,
  remoteUrl?: string | null
): { startId: number; endId: number } {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`count must be a positive integer, received: ${count}`);
  }

  const reserveInTransaction = db.transaction(
    (
      repoId: string,
      localMax: number,
      reservationCount: number,
      remoteUrlValue?: string | null
    ): { startId: number; endId: number } => {
      getOrCreateProject(
        db,
        repoId,
        remoteUrlValue !== undefined ? { remoteUrl: remoteUrlValue } : {}
      );

      db.prepare(
        `
        UPDATE project
        SET
          highest_plan_id = max(highest_plan_id, ?) + ?,
          updated_at = ${SQL_NOW_ISO_UTC}
        WHERE repository_id = ?
      `
      ).run(localMax, reservationCount, repoId);

      const row = db
        .prepare('SELECT highest_plan_id FROM project WHERE repository_id = ?')
        .get(repoId) as { highest_plan_id?: number } | null;

      if (!row || typeof row.highest_plan_id !== 'number') {
        throw new Error(`Failed to reserve plan IDs for repository ${repoId}`);
      }

      const endId = row.highest_plan_id;
      const startId = endId - reservationCount + 1;
      return { startId, endId };
    }
  );

  return reserveInTransaction.immediate(repositoryId, localMaxId, count, remoteUrl);
}

export function listProjects(db: Database): Project[] {
  return db.prepare('SELECT * FROM project ORDER BY repository_id').all() as Project[];
}

export function clearExternalStoragePaths(db: Database, projectId: number): Project | null {
  return updateProject(db, projectId, {
    externalConfigPath: null,
    externalTasksDir: null,
  });
}
