import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { ModuleMocker } from '../../testing.js';
import { claimAssignment } from '../db/assignment.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import type { TimConfig } from '../configSchema.js';
import * as workspaceIdentifier from '../assignments/workspace_identifier.js';
import { WorkspaceAutoSelector } from './workspace_auto_selector.js';
import { WorkspaceLock } from './workspace_lock.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('WorkspaceAutoSelector', () => {
  let testDir: string;
  let configDir: string;
  let selector: WorkspaceAutoSelector;
  let config: TimConfig;
  let getRepositoryIdentitySpy: ReturnType<typeof spyOn>;
  let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };

  async function seedWorkspace(
    repositoryId: string,
    workspacePath: string,
    taskId: string,
    branch?: string
  ) {
    const db = getDatabase();
    const project = getOrCreateProject(db, repositoryId);
    return recordWorkspace(db, {
      projectId: project.id,
      workspacePath,
      taskId,
      branch,
    });
  }

  async function seedAssignmentForPlan(
    repositoryId: string,
    planUuid: string,
    planId: number,
    workspacePath: string
  ) {
    const db = getDatabase();
    const project = getOrCreateProject(db, repositoryId);
    const workspace = db
      .prepare('SELECT id FROM workspace WHERE workspace_path = ?')
      .get(workspacePath) as { id: number } | null;
    if (!workspace) {
      throw new Error(`Missing workspace for assignment seed: ${workspacePath}`);
    }

    claimAssignment(db, project.id, planUuid, planId, workspace.id, 'test-user');
  }

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-auto-selector-test-'));
    configDir = path.join(testDir, 'config');
    await fs.mkdir(configDir, { recursive: true });

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.APPDATA;
    closeDatabaseForTesting();

    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: mock(() => true),
    }));

    getRepositoryIdentitySpy = spyOn(
      workspaceIdentifier,
      'getRepositoryIdentity'
    ).mockResolvedValue({
      repositoryId: 'github.com/test/repo',
      remoteUrl: 'https://github.com/test/repo.git',
      gitRoot: testDir,
    });

    config = {
      modelSettings: {
        temperature: 0.7,
        maxTokens: 4096,
      },
      workspaceCreation: {
        repositoryId: 'github.com/test/repo',
        cloneLocation: testDir,
      },
    };

    selector = new WorkspaceAutoSelector(testDir, config);
  });

  afterEach(async () => {
    moduleMocker.clear();
    closeDatabaseForTesting();

    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }

    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }

    await fs.rm(testDir, { recursive: true, force: true });
    mock.restore();
  });

  test('selectWorkspace returns unlocked workspace when available', async () => {
    const unlockedPath = path.join(testDir, 'workspace-1');
    const lockedPath = path.join(testDir, 'workspace-2');
    await fs.mkdir(unlockedPath, { recursive: true });
    await fs.mkdir(lockedPath, { recursive: true });

    await seedWorkspace('github.com/test/repo', unlockedPath, 'task-1', 'task-1');
    await seedWorkspace('github.com/test/repo', lockedPath, 'task-2', 'task-2');
    await WorkspaceLock.acquireLock(lockedPath, 'tim agent');

    const result = await selector.selectWorkspace('task-3', '/test/plan3.yml', {
      interactive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.taskId).toBe('task-1');
    expect(result?.isNew).toBe(false);
    expect(result?.clearedStaleLock).toBe(false);
  });

  test('selectWorkspace clears stale lock in non-interactive mode', async () => {
    const workspacePath = path.join(testDir, 'workspace-stale');
    await fs.mkdir(workspacePath, { recursive: true });
    await seedWorkspace('github.com/test/repo', workspacePath, 'task-stale', 'task-stale');

    await WorkspaceLock.acquireLock(workspacePath, 'tim agent', { type: 'pid' });
    const db = getDatabase();
    const workspace = db
      .prepare('SELECT id FROM workspace WHERE workspace_path = ?')
      .get(workspacePath) as { id: number };
    db.prepare(
      "UPDATE workspace_lock SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE workspace_id = ?"
    ).run(workspace.id);

    const result = await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.taskId).toBe('task-stale');
    expect(result?.isNew).toBe(false);
    expect(result?.clearedStaleLock).toBe(true);
  });

  test('selectWorkspace does not clear stale lock when unlocked workspace exists', async () => {
    const unlockedPath = path.join(testDir, 'workspace-unlocked');
    const stalePath = path.join(testDir, 'workspace-stale-skipped');
    await fs.mkdir(unlockedPath, { recursive: true });
    await fs.mkdir(stalePath, { recursive: true });

    await seedWorkspace('github.com/test/repo', unlockedPath, 'task-unlocked', 'task-unlocked');
    await seedWorkspace('github.com/test/repo', stalePath, 'task-stale', 'task-stale');

    await WorkspaceLock.acquireLock(stalePath, 'tim agent', { type: 'pid' });
    const db = getDatabase();
    const staleWorkspace = db
      .prepare('SELECT id FROM workspace WHERE workspace_path = ?')
      .get(stalePath) as { id: number };
    db.prepare(
      "UPDATE workspace_lock SET started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-25 hours') WHERE workspace_id = ?"
    ).run(staleWorkspace.id);

    const clearStaleLockSpy = spyOn(WorkspaceLock, 'clearStaleLock');
    const result = await selector.selectWorkspace('task-next', '/test/plan-next.yml', {
      interactive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.taskId).toBe('task-unlocked');
    expect(result?.clearedStaleLock).toBe(false);
    expect(clearStaleLockSpy).not.toHaveBeenCalled();
    expect(await WorkspaceLock.getLockInfoIncludingStale(stalePath)).not.toBeNull();
  });

  test('selectWorkspace creates new workspace when all are locked', async () => {
    const lockedPath = path.join(testDir, 'workspace-locked');
    await fs.mkdir(lockedPath, { recursive: true });
    await seedWorkspace('github.com/test/repo', lockedPath, 'task-locked', 'task-locked');
    await WorkspaceLock.acquireLock(lockedPath, 'manual lock');

    const createWorkspaceSpy = spyOn(
      await import('./workspace_manager.js'),
      'createWorkspace'
    ).mockResolvedValue(null);

    await selector.selectWorkspace('task-new', '/test/plan-new.yml', { interactive: false });

    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      testDir,
      'task-new',
      '/test/plan-new.yml',
      config
    );
  });

  test('preferNewWorkspace option creates new workspace first', async () => {
    await seedWorkspace(
      'github.com/test/repo',
      path.join(testDir, 'workspace-existing'),
      'task-existing',
      'task-existing'
    );

    const newWorkspacePath = path.join(testDir, 'workspace-new');
    const createWorkspaceSpy = spyOn(
      await import('./workspace_manager.js'),
      'createWorkspace'
    ).mockImplementation(async () => {
      await fs.mkdir(newWorkspacePath, { recursive: true });
      await seedWorkspace('github.com/test/repo', newWorkspacePath, 'task-new', 'task-new');
      return {
        path: newWorkspacePath,
        originalPlanFilePath: '/test/plan-new.yml',
        taskId: 'task-new',
      };
    });

    const result = await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
      preferNewWorkspace: true,
    });

    expect(createWorkspaceSpy).toHaveBeenCalled();
    expect(result?.isNew).toBe(true);
    expect(result?.workspace.taskId).toBe('task-new');
  });

  test('selectWorkspace uses repository identity fallback when origin is missing', async () => {
    const repositoryId = 'local/jj-repo';
    getRepositoryIdentitySpy.mockResolvedValue({
      repositoryId,
      remoteUrl: null,
      gitRoot: testDir,
    });

    await seedWorkspace(repositoryId, path.join(testDir, 'workspace-1'), 'task-1', 'task-1');

    const localSelector = new WorkspaceAutoSelector(testDir, {
      modelSettings: {
        temperature: 0.7,
        maxTokens: 4096,
      },
      workspaceCreation: {
        cloneLocation: testDir,
      },
    });

    const result = await localSelector.selectWorkspace('task-2', '/test/plan2.yml', {
      interactive: false,
    });

    expect(getRepositoryIdentitySpy).toHaveBeenCalled();
    expect(result?.workspace.taskId).toBe('task-1');
  });

  test('selectWorkspace skips primary workspace during auto-selection', async () => {
    const standardPath = path.join(testDir, 'workspace-standard');
    const primaryPath = path.join(testDir, 'workspace-primary');
    await fs.mkdir(standardPath, { recursive: true });
    await fs.mkdir(primaryPath, { recursive: true });

    await seedWorkspace('github.com/test/repo', standardPath, 'task-standard', 'task-standard');
    await seedWorkspace('github.com/test/repo', primaryPath, 'task-primary', 'task-primary');

    const db = getDatabase();
    db.prepare('UPDATE workspace SET is_primary = 1 WHERE workspace_path = ?').run(primaryPath);

    const result = await selector.selectWorkspace('task-next', '/test/plan-next.yml', {
      interactive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.workspacePath).toBe(standardPath);
    expect(result?.workspace.taskId).toBe('task-standard');
    expect(result?.isNew).toBe(false);
  });

  test('selectWorkspace still skips primary when all non-primary workspaces are locked', async () => {
    const primaryPath = path.join(testDir, 'workspace-primary-unlocked');
    const lockedPath = path.join(testDir, 'workspace-non-primary-locked');
    await fs.mkdir(primaryPath, { recursive: true });
    await fs.mkdir(lockedPath, { recursive: true });

    await seedWorkspace('github.com/test/repo', primaryPath, 'task-primary', 'task-primary');
    await seedWorkspace('github.com/test/repo', lockedPath, 'task-locked', 'task-locked');

    const db = getDatabase();
    db.prepare('UPDATE workspace SET is_primary = 1 WHERE workspace_path = ?').run(primaryPath);
    await WorkspaceLock.acquireLock(lockedPath, 'tim agent');

    const createWorkspaceSpy = spyOn(
      await import('./workspace_manager.js'),
      'createWorkspace'
    ).mockResolvedValue(null);

    const result = await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
    });

    expect(result).toBeNull();
    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      testDir,
      'task-new',
      '/test/plan-new.yml',
      config
    );
  });

  test('selectWorkspace prefers assigned workspace for current plan when unlocked', async () => {
    const assignedPath = path.join(testDir, 'workspace-assigned');
    const otherPath = path.join(testDir, 'workspace-other');
    await fs.mkdir(assignedPath, { recursive: true });
    await fs.mkdir(otherPath, { recursive: true });

    await seedWorkspace('github.com/test/repo', assignedPath, 'task-assigned', 'task-assigned');
    await seedWorkspace('github.com/test/repo', otherPath, 'task-other', 'task-other');
    await seedAssignmentForPlan(
      'github.com/test/repo',
      '11111111-1111-4111-8111-111111111111',
      1,
      assignedPath
    );

    const result = await selector.selectWorkspace('task-next', '/test/plan-next.yml', {
      interactive: false,
      preferredPlanUuid: '11111111-1111-4111-8111-111111111111',
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.workspacePath).toBe(assignedPath);
    expect(result?.workspace.taskId).toBe('task-assigned');
    expect(result?.isNew).toBe(false);
    expect(result?.clearedStaleLock).toBe(false);
  });

  test('selectWorkspace skips assigned workspace when locked and uses another unlocked workspace', async () => {
    const assignedPath = path.join(testDir, 'workspace-assigned-locked');
    const otherPath = path.join(testDir, 'workspace-fallback-unlocked');
    await fs.mkdir(assignedPath, { recursive: true });
    await fs.mkdir(otherPath, { recursive: true });

    await seedWorkspace('github.com/test/repo', assignedPath, 'task-assigned', 'task-assigned');
    await seedWorkspace('github.com/test/repo', otherPath, 'task-other', 'task-other');
    await seedAssignmentForPlan(
      'github.com/test/repo',
      '22222222-2222-4222-8222-222222222222',
      2,
      assignedPath
    );
    await WorkspaceLock.acquireLock(assignedPath, 'tim agent');

    const result = await selector.selectWorkspace('task-next', '/test/plan-next.yml', {
      interactive: false,
      preferredPlanUuid: '22222222-2222-4222-8222-222222222222',
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.workspacePath).toBe(otherPath);
    expect(result?.workspace.taskId).toBe('task-other');
    expect(result?.isNew).toBe(false);
    expect(result?.clearedStaleLock).toBe(false);
  });
});
