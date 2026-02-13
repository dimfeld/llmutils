import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { openDatabase } from './database.js';
import { getOrCreateProject } from './project.js';
import {
  addWorkspaceIssue,
  deleteWorkspace,
  findWorkspacesByProjectId,
  findWorkspacesByTaskId,
  getWorkspaceByPath,
  getWorkspaceIssues,
  patchWorkspace,
  recordWorkspace,
  setWorkspaceIssues,
} from './workspace.js';

describe('tim db/workspace', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-workspace-db-test-'));
    db = openDatabase(path.join(tempDir, 'tim.db'));
    projectId = getOrCreateProject(db, 'repo-1').id;
    otherProjectId = getOrCreateProject(db, 'repo-2').id;
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('recordWorkspace inserts a new workspace row', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
      name: 'Workspace One',
      planId: '191',
    });

    expect(workspace.project_id).toBe(projectId);
    expect(workspace.task_id).toBe('task-1');
    expect(workspace.workspace_path).toBe('/tmp/workspace-1');
    expect(workspace.name).toBe('Workspace One');
    expect(workspace.plan_id).toBe('191');
  });

  test('recordWorkspace updates existing row on workspace_path conflict', () => {
    recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
      name: 'Old Name',
    });

    const updated = recordWorkspace(db, {
      projectId: otherProjectId,
      taskId: 'task-2',
      workspacePath: '/tmp/workspace-1',
      name: 'New Name',
      description: 'Updated',
    });

    expect(updated.project_id).toBe(otherProjectId);
    expect(updated.task_id).toBe('task-2');
    expect(updated.name).toBe('New Name');
    expect(updated.description).toBe('Updated');
  });

  test('getWorkspaceByPath returns null for missing workspace', () => {
    expect(getWorkspaceByPath(db, '/tmp/missing')).toBeNull();
  });

  test('findWorkspacesByTaskId and findWorkspacesByProjectId filter correctly', () => {
    recordWorkspace(db, {
      projectId,
      taskId: 'task-a',
      workspacePath: '/tmp/workspace-a',
    });
    recordWorkspace(db, {
      projectId,
      taskId: 'task-b',
      workspacePath: '/tmp/workspace-b',
    });
    recordWorkspace(db, {
      projectId: otherProjectId,
      taskId: 'task-a',
      workspacePath: '/tmp/workspace-c',
    });

    expect(
      findWorkspacesByTaskId(db, 'task-a')
        .map((workspace) => workspace.workspace_path)
        .sort()
    ).toEqual(['/tmp/workspace-a', '/tmp/workspace-c']);

    expect(
      findWorkspacesByProjectId(db, projectId)
        .map((workspace) => workspace.workspace_path)
        .sort()
    ).toEqual(['/tmp/workspace-a', '/tmp/workspace-b']);
  });

  test('patchWorkspace updates selected fields only', () => {
    recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
      name: 'Old Name',
      description: 'Old Description',
      planId: '191',
    });

    const patched = patchWorkspace(db, '/tmp/workspace-1', {
      name: 'New Name',
      branch: 'feature/new-name',
      repositoryId: 'repo-2',
      taskId: 'task-2',
    });

    expect(patched).not.toBeNull();
    expect(patched?.name).toBe('New Name');
    expect(patched?.description).toBe('Old Description');
    expect(patched?.branch).toBe('feature/new-name');
    expect(patched?.project_id).toBe(otherProjectId);
    expect(patched?.task_id).toBe('task-2');
  });

  test('patchWorkspace returns null for missing workspace', () => {
    expect(patchWorkspace(db, '/tmp/missing', { name: 'Nope' })).toBeNull();
  });

  test('deleteWorkspace removes existing workspace', () => {
    recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
    });

    expect(deleteWorkspace(db, '/tmp/workspace-1')).toBe(true);
    expect(deleteWorkspace(db, '/tmp/workspace-1')).toBe(false);
  });

  test('workspace issue helpers manage issue URLs', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      taskId: 'task-1',
      workspacePath: '/tmp/workspace-1',
    });

    addWorkspaceIssue(db, workspace.id, 'https://issues.example/1');
    addWorkspaceIssue(db, workspace.id, 'https://issues.example/2');
    expect(getWorkspaceIssues(db, workspace.id)).toEqual([
      'https://issues.example/1',
      'https://issues.example/2',
    ]);

    setWorkspaceIssues(db, workspace.id, ['https://issues.example/3']);
    expect(getWorkspaceIssues(db, workspace.id)).toEqual(['https://issues.example/3']);

    setWorkspaceIssues(db, workspace.id, []);
    expect(getWorkspaceIssues(db, workspace.id)).toEqual([]);
  });

  test('workspace issue helpers ignore duplicate issue URLs', () => {
    const workspace = recordWorkspace(db, {
      projectId,
      taskId: 'task-duplicate-issues',
      workspacePath: '/tmp/workspace-duplicate-issues',
    });

    addWorkspaceIssue(db, workspace.id, 'https://issues.example/dup');
    addWorkspaceIssue(db, workspace.id, 'https://issues.example/dup');
    expect(getWorkspaceIssues(db, workspace.id)).toEqual(['https://issues.example/dup']);

    setWorkspaceIssues(db, workspace.id, [
      'https://issues.example/a',
      'https://issues.example/a',
      'https://issues.example/b',
    ]);
    expect(getWorkspaceIssues(db, workspace.id)).toEqual([
      'https://issues.example/a',
      'https://issues.example/b',
    ]);
  });

  test('deleting a project cascades to its workspaces', () => {
    recordWorkspace(db, {
      projectId,
      taskId: 'task-delete-project',
      workspacePath: '/tmp/workspace-delete-project',
    });

    db.prepare('DELETE FROM project WHERE id = ?').run(projectId);

    expect(getWorkspaceByPath(db, '/tmp/workspace-delete-project')).toBeNull();
  });
});
