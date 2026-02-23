import * as path from 'node:path';
import { getDatabase } from '../db/database.js';
import { SQL_NOW_ISO_UTC } from '../db/sql_utils.js';
import { getOrCreateProject, getProject, getProjectById } from '../db/project.js';
import {
  findWorkspacesByProjectId,
  findWorkspacesByTaskId,
  getWorkspaceByPath,
  getWorkspaceIssues,
  listAllWorkspaces,
  patchWorkspace,
  setWorkspaceIssues,
  type PatchWorkspaceInput,
  type WorkspaceRow,
} from '../db/workspace.js';

export interface WorkspaceInfo {
  taskId: string;
  originalPlanFilePath?: string;
  repositoryId?: string;
  workspacePath: string;
  branch?: string;
  createdAt: string;
  lockedBy?: {
    type: 'persistent' | 'pid';
    pid?: number;
    startedAt: string;
    hostname: string;
    command: string;
  };
  name?: string;
  description?: string;
  planId?: string;
  planTitle?: string;
  issueUrls?: string[];
  isPrimary?: boolean;
  updatedAt?: string;
}

export interface WorkspaceMetadataPatch {
  name?: string;
  description?: string;
  planId?: string;
  planTitle?: string;
  issueUrls?: string[];
  repositoryId?: string;
  branch?: string;
  isPrimary?: boolean;
}

export function workspaceRowToInfo(
  row: WorkspaceRow,
  db = getDatabase(),
  repositoryId?: string
): WorkspaceInfo {
  const project = repositoryId ? null : getProjectById(db, row.project_id);
  const issueUrls = getWorkspaceIssues(db, row.id);

  return {
    taskId: row.task_id ?? path.basename(row.workspace_path),
    originalPlanFilePath: row.original_plan_file_path ?? undefined,
    repositoryId: repositoryId ?? project?.repository_id,
    workspacePath: row.workspace_path,
    branch: row.branch ?? undefined,
    createdAt: row.created_at,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    planId: row.plan_id ?? undefined,
    planTitle: row.plan_title ?? undefined,
    issueUrls: issueUrls.length > 0 ? issueUrls : undefined,
    isPrimary: row.is_primary === 1 ? true : undefined,
    updatedAt: row.updated_at,
  };
}

export function findWorkspaceInfosByTaskId(taskId: string): WorkspaceInfo[] {
  const db = getDatabase();
  return findWorkspacesByTaskId(db, taskId).map((row) => workspaceRowToInfo(row, db));
}

export function getWorkspaceInfoByPath(workspacePath: string): WorkspaceInfo | null {
  const db = getDatabase();
  const row = getWorkspaceByPath(db, workspacePath);
  return row ? workspaceRowToInfo(row, db) : null;
}

export function findWorkspaceInfosByRepositoryId(repositoryId: string): WorkspaceInfo[] {
  const db = getDatabase();
  const project = getProject(db, repositoryId);
  if (!project) {
    return [];
  }

  return findWorkspacesByProjectId(db, project.id).map((row) =>
    workspaceRowToInfo(row, db, repositoryId)
  );
}

export function findPrimaryWorkspaceForRepository(repositoryId: string): WorkspaceInfo | null {
  return (
    findWorkspaceInfosByRepositoryId(repositoryId).find((workspace) => workspace.isPrimary) ?? null
  );
}

export function listAllWorkspaceInfos(): WorkspaceInfo[] {
  const db = getDatabase();
  return listAllWorkspaces(db).map((row) => workspaceRowToInfo(row, db));
}

export function patchWorkspaceInfo(
  workspacePath: string,
  patch: WorkspaceMetadataPatch
): WorkspaceInfo {
  const db = getDatabase();
  const patchInput: PatchWorkspaceInput = {};

  if (patch.name !== undefined) {
    patchInput.name = patch.name === '' ? null : patch.name;
  }
  if (patch.description !== undefined) {
    patchInput.description = patch.description === '' ? null : patch.description;
  }
  if (patch.planId !== undefined) {
    patchInput.planId = patch.planId === '' ? null : patch.planId;
  }
  if (patch.planTitle !== undefined) {
    patchInput.planTitle = patch.planTitle === '' ? null : patch.planTitle;
  }
  if (patch.branch !== undefined) {
    patchInput.branch = patch.branch === '' ? null : patch.branch;
  }
  if (patch.repositoryId !== undefined && patch.repositoryId !== '') {
    getOrCreateProject(db, patch.repositoryId);
    patchInput.repositoryId = patch.repositoryId;
  }
  if (patch.isPrimary !== undefined) {
    patchInput.isPrimary = patch.isPrimary;
  }

  const updated = patchWorkspace(db, workspacePath, patchInput);
  if (!updated) {
    throw new Error(`Workspace not found: ${workspacePath}`);
  }

  if (patch.issueUrls !== undefined) {
    setWorkspaceIssues(db, updated.id, patch.issueUrls);
  }

  return workspaceRowToInfo(updated, db);
}

export function touchWorkspaceInfo(workspacePath: string): void {
  const db = getDatabase();
  db.prepare(`UPDATE workspace SET updated_at = ${SQL_NOW_ISO_UTC} WHERE workspace_path = ?`).run(
    workspacePath
  );
}
