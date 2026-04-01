import { test, expect, describe, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

import { claimAssignment } from '../db/assignment.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import type { TimConfig } from '../configSchema.js';
import * as workspaceIdentifier from '../assignments/workspace_identifier.js';
import { WorkspaceAutoSelector } from './workspace_auto_selector.js';
import { WorkspaceLock } from './workspace_lock.js';

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn().mockResolvedValue(true),
}));

describe('WorkspaceAutoSelector', () => {
  let testDir: string;
  let configDir: string;
  let selector: WorkspaceAutoSelector;
  let config: TimConfig;
  let getRepositoryIdentitySpy: ReturnType<typeof vi.spyOn>;
  let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };

  async function seedWorkspace(
    repositoryId: string,
    workspacePath: string,
    taskId: string,
    branch?: string,
    workspaceType?: 'standard' | 'primary' | 'auto'
  ) {
    const db = getDatabase();
    const project = getOrCreateProject(db, repositoryId);
    const row = recordWorkspace(db, {
      projectId: project.id,
      workspacePath,
      taskId,
      branch,
      workspaceType,
    });
    return row;
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

    getRepositoryIdentitySpy = vi
      .spyOn(workspaceIdentifier, 'getRepositoryIdentity')
      .mockResolvedValue({
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
    vi.clearAllMocks();
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
    vi.restoreAllMocks();
  });

  test('selectWorkspace returns unlocked workspace when available', async () => {
    const unlockedPath = path.join(testDir, 'workspace-1');
    const lockedPath = path.join(testDir, 'workspace-2');
    await fs.mkdir(unlockedPath, { recursive: true });
    await fs.mkdir(lockedPath, { recursive: true });

    await seedWorkspace('github.com/test/repo', unlockedPath, 'task-1', 'task-1');
    await seedWorkspace('github.com/test/repo', lockedPath, 'task-2', 'task-2');
    await WorkspaceLock.acquireLock(lockedPath, 'tim agent');
    const getLockInfoIncludingStaleSpy = vi
      .spyOn(WorkspaceLock, 'getLockInfoIncludingStale')
      .mockImplementation(async (workspacePath: string) => {
        if (workspacePath === lockedPath) {
          return {
            type: 'persistent',
            command: 'tim agent',
            startedAt: new Date().toISOString(),
            hostname: 'test-host',
            version: 2,
          };
        }
        return null;
      });

    const result = await selector.selectWorkspace('task-3', '/test/plan3.yml', {
      interactive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.taskId).toBe('task-1');
    expect(result?.isNew).toBe(false);
    expect(result?.clearedStaleLock).toBe(false);
    expect(getLockInfoIncludingStaleSpy).toHaveBeenCalledWith(lockedPath);
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

    const clearStaleLockSpy = vi.spyOn(WorkspaceLock, 'clearStaleLock');
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

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue(null);

    await selector.selectWorkspace('task-new', '/test/plan-new.yml', { interactive: false });

    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      testDir,
      'task-new',
      '/test/plan-new.yml',
      config,
      {}
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
    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockImplementation(async () => {
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

  test('preserves checkedOutRemoteBranch when creating a new workspace', async () => {
    const newWorkspacePath = path.join(testDir, 'workspace-remote-checkout');
    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockImplementation(async () => {
        await fs.mkdir(newWorkspacePath, { recursive: true });
        await seedWorkspace('github.com/test/repo', newWorkspacePath, 'task-remote', 'task-remote');
        return {
          path: newWorkspacePath,
          originalPlanFilePath: '/test/plan-remote.yml',
          taskId: 'task-remote',
          checkedOutRemoteBranch: true,
        };
      });

    const result = await selector.selectWorkspace('task-remote', '/test/plan-remote.yml', {
      interactive: false,
      preferNewWorkspace: true,
    });

    expect(createWorkspaceSpy).toHaveBeenCalled();
    expect(result?.isNew).toBe(true);
    expect(result?.workspace.checkedOutRemoteBranch).toBe(true);
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
    await seedWorkspace(
      'github.com/test/repo',
      primaryPath,
      'task-primary',
      'task-primary',
      'primary'
    );

    const result = await selector.selectWorkspace('task-next', '/test/plan-next.yml', {
      interactive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.workspacePath).toBe(standardPath);
    expect(result?.workspace.taskId).toBe('task-standard');
    expect(result?.isNew).toBe(false);
  });

  test('selectWorkspace falls back to any non-primary workspace when no auto workspaces exist', async () => {
    const standardAPath = path.join(testDir, 'workspace-standard-a');
    const standardBPath = path.join(testDir, 'workspace-standard-b');
    const primaryPath = path.join(testDir, 'workspace-primary-fallback');
    await fs.mkdir(standardAPath, { recursive: true });
    await fs.mkdir(standardBPath, { recursive: true });
    await fs.mkdir(primaryPath, { recursive: true });

    await seedWorkspace(
      'github.com/test/repo',
      standardAPath,
      'task-standard-a',
      'task-standard-a',
      'standard'
    );
    await seedWorkspace(
      'github.com/test/repo',
      standardBPath,
      'task-standard-b',
      'task-standard-b',
      'standard'
    );
    await seedWorkspace(
      'github.com/test/repo',
      primaryPath,
      'task-primary',
      'task-primary',
      'primary'
    );
    await WorkspaceLock.acquireLock(standardAPath, 'tim agent');

    const result = await selector.selectWorkspace('task-next', '/test/plan-next.yml', {
      interactive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.workspacePath).toBe(standardBPath);
    expect(result?.workspace.workspaceType).toBe('standard');
    expect(result?.isNew).toBe(false);
  });

  test('selectWorkspace still skips primary when all non-primary workspaces are locked', async () => {
    const primaryPath = path.join(testDir, 'workspace-primary-unlocked');
    const lockedPath = path.join(testDir, 'workspace-non-primary-locked');
    await fs.mkdir(primaryPath, { recursive: true });
    await fs.mkdir(lockedPath, { recursive: true });

    await seedWorkspace(
      'github.com/test/repo',
      primaryPath,
      'task-primary',
      'task-primary',
      'primary'
    );
    await seedWorkspace('github.com/test/repo', lockedPath, 'task-locked', 'task-locked');
    await WorkspaceLock.acquireLock(lockedPath, 'tim agent');

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue(null);

    const result = await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
    });

    expect(result).toBeNull();
    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      testDir,
      'task-new',
      '/test/plan-new.yml',
      config,
      {}
    );
  });

  test('selectWorkspace restricts automatic selection to auto workspaces when any exist', async () => {
    const standardPath = path.join(testDir, 'workspace-standard-preferred');
    const autoPath = path.join(testDir, 'workspace-auto-preferred');
    await fs.mkdir(standardPath, { recursive: true });
    await fs.mkdir(autoPath, { recursive: true });

    await seedWorkspace('github.com/test/repo', standardPath, 'task-standard', 'task-standard');
    await seedWorkspace('github.com/test/repo', autoPath, 'task-auto', 'task-auto', 'auto');

    const result = await selector.selectWorkspace('task-next', '/test/plan-next.yml', {
      interactive: false,
    });

    expect(result?.workspace.workspacePath).toBe(autoPath);
    expect(result?.workspace.workspaceType).toBe('auto');
  });

  test('selectWorkspace ignores standard and primary workspaces when auto workspaces exist', async () => {
    const standardPath = path.join(testDir, 'workspace-standard-ignored');
    const primaryPath = path.join(testDir, 'workspace-primary-ignored');
    const autoPath = path.join(testDir, 'workspace-auto-selected');
    await fs.mkdir(standardPath, { recursive: true });
    await fs.mkdir(primaryPath, { recursive: true });
    await fs.mkdir(autoPath, { recursive: true });

    await seedWorkspace(
      'github.com/test/repo',
      standardPath,
      'task-standard',
      'task-standard',
      'standard'
    );
    await seedWorkspace(
      'github.com/test/repo',
      primaryPath,
      'task-primary',
      'task-primary',
      'primary'
    );
    await seedWorkspace('github.com/test/repo', autoPath, 'task-auto', 'task-auto', 'auto');

    const result = await selector.selectWorkspace('task-next', '/test/plan-next.yml', {
      interactive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.workspacePath).toBe(autoPath);
    expect(result?.workspace.workspaceType).toBe('auto');
  });

  test('selectWorkspace creates new auto workspace when all auto workspaces are locked', async () => {
    const autoPath = path.join(testDir, 'workspace-auto-locked');
    const standardPath = path.join(testDir, 'workspace-standard-unlocked');
    await fs.mkdir(autoPath, { recursive: true });
    await fs.mkdir(standardPath, { recursive: true });

    await seedWorkspace('github.com/test/repo', autoPath, 'task-auto', 'task-auto', 'auto');
    await seedWorkspace('github.com/test/repo', standardPath, 'task-standard', 'task-standard');
    await WorkspaceLock.acquireLock(autoPath, 'tim agent');

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue(null);

    await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
    });

    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      testDir,
      'task-new',
      '/test/plan-new.yml',
      config,
      { workspaceType: 'auto' }
    );
  });

  test('selectWorkspace passes createBranch and base when creating a new workspace', async () => {
    const lockedPath = path.join(testDir, 'workspace-locked-forward-options');
    await fs.mkdir(lockedPath, { recursive: true });
    await seedWorkspace('github.com/test/repo', lockedPath, 'task-locked', 'task-locked');
    await WorkspaceLock.acquireLock(lockedPath, 'manual lock');

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue(null);

    await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
      createBranch: true,
      base: 'develop',
      branchName: 'feature/task-new',
      planData: {
        id: 42,
        title: 'Auto-selected plan',
        issue: ['APP-42'],
      },
    });

    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      testDir,
      'task-new',
      '/test/plan-new.yml',
      config,
      {
        createBranch: true,
        branchName: 'feature/task-new',
        fromBranch: 'develop',
        planData: {
          id: 42,
          title: 'Auto-selected plan',
          issue: ['APP-42'],
        },
      }
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

  test('selectWorkspace ignores assigned primary workspace for current plan and uses non-primary workspace', async () => {
    const assignedPrimaryPath = path.join(testDir, 'workspace-assigned-primary');
    const fallbackPath = path.join(testDir, 'workspace-fallback-non-primary');
    await fs.mkdir(assignedPrimaryPath, { recursive: true });
    await fs.mkdir(fallbackPath, { recursive: true });

    await seedWorkspace(
      'github.com/test/repo',
      assignedPrimaryPath,
      'task-assigned-primary',
      'task-assigned-primary',
      'primary'
    );
    await seedWorkspace('github.com/test/repo', fallbackPath, 'task-fallback', 'task-fallback');
    await seedAssignmentForPlan(
      'github.com/test/repo',
      '33333333-3333-4333-8333-333333333333',
      3,
      assignedPrimaryPath
    );

    const result = await selector.selectWorkspace('task-next', '/test/plan-next.yml', {
      interactive: false,
      preferredPlanUuid: '33333333-3333-4333-8333-333333333333',
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.workspacePath).toBe(fallbackPath);
    expect(result?.workspace.taskId).toBe('task-fallback');
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
