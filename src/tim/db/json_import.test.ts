import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getAssignment } from './assignment.js';
import { openDatabase } from './database.js';
import { importFromJsonFiles, markImportCompleted, shouldRunImport } from './json_import.js';
import { getPermissions } from './permission.js';
import { getProject } from './project.js';
import { getWorkspaceByPath, getWorkspaceIssues } from './workspace.js';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

describe('tim db/json_import', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir('tim-db-import-test-');
    dbPath = path.join(tempDir, 'tim.db');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('imports complete JSON fixtures and data is queryable through CRUD functions', async () => {
    const workspacePath = '/tmp/workspaces/repo-1-task-1';

    await writeJson(path.join(tempDir, 'shared', 'test-repo-1', 'assignments.json'), {
      repositoryId: 'test-repo-1',
      repositoryRemoteUrl: 'https://github.com/example/test-repo-1.git',
      version: 1,
      highestPlanId: 42,
      assignments: {
        '11111111-1111-4111-8111-111111111111': {
          planId: 12,
          workspacePaths: [workspacePath],
          workspaceOwners: {
            [workspacePath]: 'alice',
          },
          users: ['alice'],
          status: 'pending',
          assignedAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-02T00:00:00.000Z',
        },
      },
    });

    await writeJson(path.join(tempDir, 'shared', 'test-repo-1', 'permissions.json'), {
      repositoryId: 'test-repo-1',
      version: 3,
      permissions: {
        allow: ['Read(*.md)'],
        deny: ['Write(tasks/**)'],
      },
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    await writeJson(path.join(tempDir, 'workspaces.json'), {
      [workspacePath]: {
        taskId: 'task-1',
        repositoryId: 'test-repo-1',
        workspacePath,
        originalPlanFilePath: '/repo/tasks/12-example.plan.md',
        branch: 'feature/import-test',
        createdAt: '2025-01-01T00:00:00.000Z',
        name: 'Import Test Workspace',
        description: 'Workspace from JSON',
        planId: '12',
        planTitle: 'Test Plan',
        issueUrls: ['https://github.com/example/test-repo-1/issues/10'],
        updatedAt: '2025-01-02T00:00:00.000Z',
      },
    });

    await writeJson(path.join(tempDir, 'repositories', 'test-repo-1', 'metadata.json'), {
      repositoryName: 'test-repo-1',
      remoteLabel: 'github.com/example/test-repo-1',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-03T00:00:00.000Z',
      lastGitRoot: '/repo',
      externalConfigPath: '/repo/.tim',
      externalTasksDir: '/repo/tasks',
    });

    const db = openDatabase(dbPath);

    const project = getProject(db, 'test-repo-1');
    expect(project).not.toBeNull();
    expect(project?.remote_url).toBe('https://github.com/example/test-repo-1.git');
    expect(project?.highest_plan_id).toBe(42);
    expect(project?.last_git_root).toBe('/repo');
    expect(project?.external_config_path).toBe('/repo/.tim');
    expect(project?.external_tasks_dir).toBe('/repo/tasks');
    expect(project?.remote_label).toBe('github.com/example/test-repo-1');

    const workspace = getWorkspaceByPath(db, workspacePath);
    expect(workspace).not.toBeNull();
    expect(workspace?.task_id).toBe('task-1');
    expect(workspace?.project_id).toBe(project?.id);
    expect(workspace?.original_plan_file_path).toBe('/repo/tasks/12-example.plan.md');
    expect(workspace?.branch).toBe('feature/import-test');
    expect(workspace?.name).toBe('Import Test Workspace');
    expect(workspace?.description).toBe('Workspace from JSON');
    expect(workspace?.plan_id).toBe('12');
    expect(workspace?.plan_title).toBe('Test Plan');
    expect(workspace ? getWorkspaceIssues(db, workspace.id) : []).toEqual([
      'https://github.com/example/test-repo-1/issues/10',
    ]);

    const permissions = project ? getPermissions(db, project.id) : { allow: [], deny: [] };
    expect(permissions).toEqual({
      allow: ['Read(*.md)'],
      deny: ['Write(tasks/**)'],
    });

    const assignment = project
      ? getAssignment(db, project.id, '11111111-1111-4111-8111-111111111111')
      : null;
    expect(assignment).not.toBeNull();
    expect(assignment?.plan_id).toBe(12);
    expect(assignment?.workspace_id).toBe(workspace?.id ?? null);
    expect(assignment?.claimed_by_user).toBe('alice');
    expect(assignment?.status).toBe('pending');
    expect(assignment?.assigned_at).toBe('2025-01-01T00:00:00.000Z');
    expect(assignment?.updated_at).toBe('2025-01-02T00:00:00.000Z');

    db.close(false);
  });

  test('import handles missing files gracefully', async () => {
    const workspacePath = '/tmp/workspaces/repo-2-task-1';

    await writeJson(path.join(tempDir, 'workspaces.json'), {
      [workspacePath]: {
        taskId: 'task-2',
        repositoryId: 'test-repo-2',
        workspacePath,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    });

    const db = openDatabase(dbPath);
    const project = getProject(db, 'test-repo-2');
    const workspace = getWorkspaceByPath(db, workspacePath);

    expect(project).not.toBeNull();
    expect(workspace).not.toBeNull();
    expect(project?.highest_plan_id).toBe(0);

    db.close(false);
  });

  test('multi-workspace assignment import picks the most recently updated workspace owner', async () => {
    const olderWorkspacePath = '/tmp/workspaces/repo-3-old';
    const newerWorkspacePath = '/tmp/workspaces/repo-3-new';

    await writeJson(path.join(tempDir, 'shared', 'test-repo-3', 'assignments.json'), {
      repositoryId: 'test-repo-3',
      version: 1,
      assignments: {
        '22222222-2222-4222-8222-222222222222': {
          planId: 34,
          workspacePaths: [olderWorkspacePath, newerWorkspacePath],
          workspaceOwners: {
            [olderWorkspacePath]: 'old-owner',
            [newerWorkspacePath]: 'new-owner',
          },
          users: ['fallback-user'],
          status: 'in_progress',
          assignedAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      },
    });

    await writeJson(path.join(tempDir, 'workspaces.json'), {
      [olderWorkspacePath]: {
        taskId: 'task-3a',
        repositoryId: 'test-repo-3',
        workspacePath: olderWorkspacePath,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-02T00:00:00.000Z',
      },
      [newerWorkspacePath]: {
        taskId: 'task-3b',
        repositoryId: 'test-repo-3',
        workspacePath: newerWorkspacePath,
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-03T00:00:00.000Z',
      },
    });

    const db = openDatabase(dbPath);
    const project = getProject(db, 'test-repo-3');
    const newerWorkspace = getWorkspaceByPath(db, newerWorkspacePath);

    const assignment = project
      ? getAssignment(db, project.id, '22222222-2222-4222-8222-222222222222')
      : null;

    expect(assignment).not.toBeNull();
    expect(assignment?.workspace_id).toBe(newerWorkspace?.id ?? null);
    expect(assignment?.claimed_by_user).toBe('new-owner');

    db.close(false);
  });

  test('importFromJsonFiles is idempotent', async () => {
    const workspacePath = '/tmp/workspaces/repo-4-task-1';

    await writeJson(path.join(tempDir, 'shared', 'test-repo-4', 'assignments.json'), {
      repositoryId: 'test-repo-4',
      version: 1,
      assignments: {
        '33333333-3333-4333-8333-333333333333': {
          planId: 7,
          workspacePaths: [workspacePath],
          users: ['sam'],
          status: 'pending',
          assignedAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      },
    });

    await writeJson(path.join(tempDir, 'workspaces.json'), {
      [workspacePath]: {
        taskId: 'task-4',
        repositoryId: 'test-repo-4',
        workspacePath,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    });

    const db = openDatabase(dbPath);

    importFromJsonFiles(db, tempDir);
    importFromJsonFiles(db, tempDir);

    const projectCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM project')
      .get();
    const workspaceCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM workspace')
      .get();
    const assignmentCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM assignment')
      .get();

    expect(projectCount?.count).toBe(1);
    expect(workspaceCount?.count).toBe(1);
    expect(assignmentCount?.count).toBe(1);

    db.close(false);
  });

  test('shouldRunImport reflects import_completed flag and markImportCompleted updates it', () => {
    const db = openDatabase(dbPath);

    expect(shouldRunImport(db)).toBe(false);

    db.run('UPDATE schema_version SET import_completed = 0');
    expect(shouldRunImport(db)).toBe(true);

    importFromJsonFiles(db, tempDir);
    expect(shouldRunImport(db)).toBe(true);

    markImportCompleted(db);
    expect(shouldRunImport(db)).toBe(false);

    db.close(false);
  });

  test('imports empty assignments object without creating assignment rows', async () => {
    await writeJson(path.join(tempDir, 'shared', 'empty-assignment-repo', 'assignments.json'), {
      repositoryId: 'empty-assignment-repo',
      version: 1,
      highestPlanId: 3,
      assignments: {},
    });

    const db = openDatabase(dbPath);
    const project = getProject(db, 'empty-assignment-repo');
    const assignmentCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM assignment')
      .get();

    expect(project).not.toBeNull();
    expect(project?.highest_plan_id).toBe(3);
    expect(assignmentCount?.count).toBe(0);

    db.close(false);
  });

  test('imports assignment with empty workspacePaths and falls back to first user', async () => {
    await writeJson(path.join(tempDir, 'shared', 'no-workspace-assignment', 'assignments.json'), {
      repositoryId: 'no-workspace-assignment',
      version: 1,
      assignments: {
        '44444444-4444-4444-8444-444444444444': {
          planId: 9,
          workspacePaths: [],
          workspaceOwners: {},
          users: ['fallback-owner'],
          status: 'pending',
          assignedAt: '2025-01-01T00:00:00.000Z',
          updatedAt: '2025-01-01T00:00:00.000Z',
        },
      },
    });

    const db = openDatabase(dbPath);
    const project = getProject(db, 'no-workspace-assignment');
    const assignment = project
      ? getAssignment(db, project.id, '44444444-4444-4444-8444-444444444444')
      : null;

    expect(project).not.toBeNull();
    expect(assignment).not.toBeNull();
    expect(assignment?.workspace_id).toBeNull();
    expect(assignment?.claimed_by_user).toBe('fallback-owner');

    db.close(false);
  });

  test('skips workspace entries that do not have a repositoryId', async () => {
    await writeJson(path.join(tempDir, 'workspaces.json'), {
      '/tmp/workspaces/no-repo': {
        taskId: 'task-no-repo',
        repositoryId: '',
        workspacePath: '/tmp/workspaces/no-repo',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    });

    const db = openDatabase(dbPath);
    const workspaceCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM workspace')
      .get();
    const projectCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM project')
      .get();

    expect(workspaceCount?.count).toBe(0);
    expect(projectCount?.count).toBe(0);
    expect(getWorkspaceByPath(db, '/tmp/workspaces/no-repo')).toBeNull();

    db.close(false);
  });

  test('skips malformed workspace entries during import', async () => {
    await writeJson(path.join(tempDir, 'workspaces.json'), {
      '/tmp/workspaces/valid': {
        taskId: 'task-valid',
        repositoryId: 'repo-valid',
        workspacePath: '/tmp/workspaces/valid',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      '/tmp/workspaces/invalid': {
        taskId: 'task-invalid',
        repositoryId: 'repo-invalid',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    });

    const db = openDatabase(dbPath);

    expect(getWorkspaceByPath(db, '/tmp/workspaces/valid')).not.toBeNull();
    expect(getWorkspaceByPath(db, '/tmp/workspaces/invalid')).toBeNull();

    db.close(false);
  });

  test('ignores repository metadata with invalid field types', async () => {
    await writeJson(path.join(tempDir, 'repositories', 'repo-meta', 'metadata.json'), {
      repositoryName: 'repo-meta',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      remoteLabel: 123,
    });

    const db = openDatabase(dbPath);
    expect(getProject(db, 'repo-meta')).toBeNull();

    db.close(false);
  });

  test('invalid JSON files are ignored gracefully', async () => {
    const invalidAssignmentsPath = path.join(
      tempDir,
      'shared',
      'invalid-json-repo',
      'assignments.json'
    );
    await fs.mkdir(path.dirname(invalidAssignmentsPath), { recursive: true });
    await fs.writeFile(invalidAssignmentsPath, '{not valid json', 'utf8');

    const db = openDatabase(dbPath);
    const projectCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM project')
      .get();
    const assignmentCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM assignment')
      .get();

    expect(projectCount?.count).toBe(0);
    expect(assignmentCount?.count).toBe(0);
    expect(shouldRunImport(db)).toBe(false);

    db.close(false);
  });

  test('import from an empty config root directory is a no-op', () => {
    const db = openDatabase(dbPath);

    const projectCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM project')
      .get();
    const workspaceCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM workspace')
      .get();
    const assignmentCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM assignment')
      .get();
    const permissionCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM permission')
      .get();

    expect(projectCount?.count).toBe(0);
    expect(workspaceCount?.count).toBe(0);
    expect(assignmentCount?.count).toBe(0);
    expect(permissionCount?.count).toBe(0);
    expect(shouldRunImport(db)).toBe(false);

    db.close(false);
  });
});
