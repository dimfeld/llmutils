import type { Database } from 'bun:sqlite';
import { SQL_NOW_ISO_UTC } from './sql_utils.js';

export interface WorkspaceRow {
  id: number;
  project_id: number;
  task_id: string | null;
  workspace_path: string;
  original_plan_file_path: string | null;
  branch: string | null;
  name: string | null;
  description: string | null;
  plan_id: string | null;
  plan_title: string | null;
  is_primary: number;
  created_at: string;
  updated_at: string;
}

export interface RecordWorkspaceInput {
  projectId: number;
  taskId?: string | null;
  workspacePath: string;
  originalPlanFilePath?: string | null;
  branch?: string | null;
  name?: string | null;
  description?: string | null;
  planId?: string | null;
  planTitle?: string | null;
}

export interface PatchWorkspaceInput {
  name?: string | null;
  description?: string | null;
  planId?: string | null;
  planTitle?: string | null;
  branch?: string | null;
  repositoryId?: string;
  taskId?: string;
  isPrimary?: boolean;
}

export function recordWorkspace(db: Database, input: RecordWorkspaceInput): WorkspaceRow {
  const recordInTransaction = db.transaction((nextInput: RecordWorkspaceInput): WorkspaceRow => {
    db.prepare(
      `
      INSERT INTO workspace (
        project_id,
        task_id,
        workspace_path,
        original_plan_file_path,
        branch,
        name,
        description,
        plan_id,
        plan_title,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${SQL_NOW_ISO_UTC}, ${SQL_NOW_ISO_UTC})
      ON CONFLICT(workspace_path) DO UPDATE SET
        project_id = excluded.project_id,
        task_id = COALESCE(excluded.task_id, workspace.task_id),
        original_plan_file_path = COALESCE(
          excluded.original_plan_file_path,
          workspace.original_plan_file_path
        ),
        branch = COALESCE(excluded.branch, workspace.branch),
        name = COALESCE(excluded.name, workspace.name),
        description = COALESCE(excluded.description, workspace.description),
        plan_id = COALESCE(excluded.plan_id, workspace.plan_id),
        plan_title = COALESCE(excluded.plan_title, workspace.plan_title),
        updated_at = ${SQL_NOW_ISO_UTC}
    `
    ).run(
      nextInput.projectId,
      nextInput.taskId ?? null,
      nextInput.workspacePath,
      nextInput.originalPlanFilePath ?? null,
      nextInput.branch ?? null,
      nextInput.name ?? null,
      nextInput.description ?? null,
      nextInput.planId ?? null,
      nextInput.planTitle ?? null
    );

    const row = getWorkspaceByPath(db, nextInput.workspacePath);
    if (!row) {
      throw new Error(`Failed to record workspace at path ${nextInput.workspacePath}`);
    }

    return row;
  });

  return recordInTransaction.immediate(input);
}

export function getWorkspaceByPath(db: Database, workspacePath: string): WorkspaceRow | null {
  return (
    (db
      .prepare('SELECT * FROM workspace WHERE workspace_path = ?')
      .get(workspacePath) as WorkspaceRow | null) ?? null
  );
}

export function getWorkspaceById(db: Database, workspaceId: number): WorkspaceRow | null {
  return (
    (db.prepare('SELECT * FROM workspace WHERE id = ?').get(workspaceId) as WorkspaceRow | null) ??
    null
  );
}

export function findWorkspacesByTaskId(db: Database, taskId: string): WorkspaceRow[] {
  return db
    .prepare('SELECT * FROM workspace WHERE task_id = ? ORDER BY created_at DESC, id DESC')
    .all(taskId) as WorkspaceRow[];
}

export function findWorkspacesByProjectId(db: Database, projectId: number): WorkspaceRow[] {
  return db
    .prepare('SELECT * FROM workspace WHERE project_id = ? ORDER BY created_at DESC, id DESC')
    .all(projectId) as WorkspaceRow[];
}

export function listAllWorkspaces(db: Database): WorkspaceRow[] {
  return db
    .prepare('SELECT * FROM workspace ORDER BY created_at DESC, id DESC')
    .all() as WorkspaceRow[];
}

export function patchWorkspace(
  db: Database,
  workspacePath: string,
  patch: PatchWorkspaceInput
): WorkspaceRow | null {
  const patchInTransaction = db.transaction(
    (nextWorkspacePath: string, nextPatch: PatchWorkspaceInput): WorkspaceRow | null => {
      const existing = getWorkspaceByPath(db, nextWorkspacePath);
      if (!existing) {
        return null;
      }

      const fields: string[] = [];
      const values: Array<string | number | null> = [];

      if ('name' in nextPatch) {
        fields.push('name = ?');
        values.push(nextPatch.name ?? null);
      }
      if ('description' in nextPatch) {
        fields.push('description = ?');
        values.push(nextPatch.description ?? null);
      }
      if ('planId' in nextPatch) {
        fields.push('plan_id = ?');
        values.push(nextPatch.planId ?? null);
      }
      if ('planTitle' in nextPatch) {
        fields.push('plan_title = ?');
        values.push(nextPatch.planTitle ?? null);
      }
      if ('branch' in nextPatch) {
        fields.push('branch = ?');
        values.push(nextPatch.branch ?? null);
      }
      if ('taskId' in nextPatch) {
        fields.push('task_id = ?');
        values.push(nextPatch.taskId ?? null);
      }
      if ('isPrimary' in nextPatch) {
        fields.push('is_primary = ?');
        values.push(nextPatch.isPrimary ? 1 : 0);
      }
      if ('repositoryId' in nextPatch) {
        if (nextPatch.repositoryId === undefined) {
          throw new Error('Cannot patch workspace: repositoryId must be defined when provided');
        }

        const project = db
          .prepare('SELECT id FROM project WHERE repository_id = ?')
          .get(nextPatch.repositoryId) as { id?: number } | null;
        if (!project || typeof project.id !== 'number') {
          throw new Error(
            `Cannot patch workspace: project not found for repository_id=${nextPatch.repositoryId}`
          );
        }

        fields.push('project_id = ?');
        values.push(project.id);
      }

      if (fields.length === 0) {
        return existing;
      }

      fields.push(`updated_at = ${SQL_NOW_ISO_UTC}`);
      db.prepare(`UPDATE workspace SET ${fields.join(', ')} WHERE workspace_path = ?`).run(
        ...values,
        nextWorkspacePath
      );

      return getWorkspaceByPath(db, nextWorkspacePath);
    }
  );

  return patchInTransaction.immediate(workspacePath, patch);
}

export function deleteWorkspace(db: Database, workspacePath: string): boolean {
  const result = db.prepare('DELETE FROM workspace WHERE workspace_path = ?').run(workspacePath);
  return result.changes > 0;
}

export function addWorkspaceIssue(db: Database, workspaceId: number, issueUrl: string): void {
  const addInTransaction = db.transaction((nextWorkspaceId: number, nextIssueUrl: string): void => {
    db.prepare(
      `
      INSERT OR IGNORE INTO workspace_issue (workspace_id, issue_url)
      VALUES (?, ?)
    `
    ).run(nextWorkspaceId, nextIssueUrl);
  });

  addInTransaction.immediate(workspaceId, issueUrl);
}

export function getWorkspaceIssues(db: Database, workspaceId: number): string[] {
  const rows = db
    .prepare(
      `
      SELECT issue_url
      FROM workspace_issue
      WHERE workspace_id = ?
      ORDER BY id
    `
    )
    .all(workspaceId) as Array<{ issue_url: string }>;

  return rows.map((row) => row.issue_url);
}

export function setWorkspaceIssues(db: Database, workspaceId: number, issueUrls: string[]): void {
  const setInTransaction = db.transaction(
    (nextWorkspaceId: number, nextIssueUrls: string[]): void => {
      db.prepare('DELETE FROM workspace_issue WHERE workspace_id = ?').run(nextWorkspaceId);

      const insertIssue = db.prepare(
        `
        INSERT OR IGNORE INTO workspace_issue (workspace_id, issue_url)
        VALUES (?, ?)
      `
      );
      for (const issueUrl of nextIssueUrls) {
        insertIssue.run(nextWorkspaceId, issueUrl);
      }
    }
  );

  setInTransaction.immediate(workspaceId, issueUrls);
}
