import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceAutoSelector } from './workspace_auto_selector';
import { createWorkspace } from './workspace_manager';
import { WorkspaceLock } from './workspace_lock';
import * as workspaceTracker from './workspace_tracker';
import * as workspaceIdentifier from '../assignments/workspace_identifier.js';
import type { TimConfig } from '../configSchema';
import type { WorkspaceInfo } from './workspace_tracker';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock functions will be set up in beforeEach

describe('WorkspaceAutoSelector', () => {
  let testDir: string;
  let selector: WorkspaceAutoSelector;
  let config: TimConfig;
  let findWorkspacesByRepositoryIdSpy: any;
  let updateWorkspaceLockStatusSpy: any;
  let findWorkspacesByTaskIdSpy: any;
  let recordWorkspaceSpy: any;
  let getDefaultTrackingFilePathSpy: any;
  let getRepositoryIdentitySpy: any;
  let originalLockDir: string | undefined;

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'workspace-auto-selector-test-'));
    // Set test lock directory to use the temp directory
    const lockDir = path.join(testDir, 'locks');
    await fs.promises.mkdir(lockDir, { recursive: true });
    WorkspaceLock.setTestLockDirectory(lockDir);

    // Mock @inquirer/prompts for non-interactive tests
    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: mock(() => true),
    }));

    // Setup spies for workspace tracker functions
    findWorkspacesByRepositoryIdSpy = spyOn(
      workspaceTracker,
      'findWorkspacesByRepositoryId'
    ).mockResolvedValue([]);
    updateWorkspaceLockStatusSpy = spyOn(
      workspaceTracker,
      'updateWorkspaceLockStatus'
    ).mockImplementation((workspaces: any[]) => Promise.resolve(workspaces));
    findWorkspacesByTaskIdSpy = spyOn(workspaceTracker, 'findWorkspacesByTaskId').mockResolvedValue(
      []
    );
    recordWorkspaceSpy = spyOn(workspaceTracker, 'recordWorkspace').mockResolvedValue(undefined);
    getDefaultTrackingFilePathSpy = spyOn(
      workspaceTracker,
      'getDefaultTrackingFilePath'
    ).mockReturnValue('/default/tracking/path.json');
    getRepositoryIdentitySpy = spyOn(
      workspaceIdentifier,
      'getRepositoryIdentity'
    ).mockResolvedValue({
      repositoryId: 'github.com/test/repo',
      remoteUrl: 'https://github.com/test/repo.git',
      gitRoot: testDir,
    });

    // Setup test config
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
    // Clean up mocks
    moduleMocker.clear();

    // Reset test lock directory
    WorkspaceLock.setTestLockDirectory(undefined);

    await fs.promises.rm(testDir, { recursive: true, force: true });
    mock.restore();
  });

  test('selectWorkspace returns unlocked workspace when available', async () => {
    const mockWorkspaces: WorkspaceInfo[] = [
      {
        taskId: 'task-1',
        originalPlanFilePath: '/test/plan1.yml',
        repositoryId: 'github.com/test/repo',
        workspacePath: path.join(testDir, 'workspace-1'),
        branch: 'llmutils-task/task-1',
        createdAt: new Date().toISOString(),
      },
      {
        taskId: 'task-2',
        originalPlanFilePath: '/test/plan2.yml',
        repositoryId: 'github.com/test/repo',
        workspacePath: path.join(testDir, 'workspace-2'),
        branch: 'llmutils-task/task-2',
        createdAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        lockedBy: {
          type: 'pid',
          pid: 99999,
          startedAt: new Date().toISOString(),
          hostname: 'other-host',
          command: 'tim agent',
        },
      },
    ];

    findWorkspacesByRepositoryIdSpy.mockResolvedValue(mockWorkspaces);
    updateWorkspaceLockStatusSpy.mockResolvedValue(mockWorkspaces);

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
    await fs.promises.mkdir(workspacePath, { recursive: true });

    // Create a stale lock
    const staleLock = {
      type: 'pid' as const,
      pid: 99999,
      command: 'tim agent',
      startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
      hostname: os.hostname(),
      version: 1,
    };
    const lockFilePath = WorkspaceLock.getLockFilePath(workspacePath);
    await fs.promises.mkdir(path.dirname(lockFilePath), { recursive: true });
    await fs.promises.writeFile(lockFilePath, JSON.stringify(staleLock));

    const mockWorkspaces: WorkspaceInfo[] = [
      {
        taskId: 'task-stale',
        originalPlanFilePath: '/test/plan-stale.yml',
        repositoryId: 'github.com/test/repo',
        workspacePath,
        branch: 'llmutils-task/task-stale',
        createdAt: new Date().toISOString(),
        lockedBy: {
          type: 'pid',
          pid: staleLock.pid,
          startedAt: staleLock.startedAt,
          hostname: staleLock.hostname,
          command: staleLock.command,
        },
      },
    ];

    findWorkspacesByRepositoryIdSpy.mockResolvedValue(mockWorkspaces);
    updateWorkspaceLockStatusSpy.mockResolvedValue(mockWorkspaces);

    const result = await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
    });

    expect(result).not.toBeNull();
    expect(result?.workspace.taskId).toBe('task-stale');
    expect(result?.isNew).toBe(false);
    expect(result?.clearedStaleLock).toBe(true);

    // Verify lock was cleared
    const lockExists = await fs.promises
      .access(WorkspaceLock.getLockFilePath(workspacePath))
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  test('selectWorkspace creates new workspace when all are locked', async () => {
    const mockWorkspaces: WorkspaceInfo[] = [
      {
        taskId: 'task-locked',
        originalPlanFilePath: '/test/plan-locked.yml',
        repositoryId: 'github.com/test/repo',
        workspacePath: path.join(testDir, 'workspace-locked'),
        branch: 'llmutils-task/task-locked',
        createdAt: new Date().toISOString(),
        lockedBy: {
          type: 'persistent',
          pid: process.pid, // Current process, so not stale
          startedAt: new Date().toISOString(),
          hostname: os.hostname(),
          command: 'manual lock',
        },
      },
    ];

    findWorkspacesByRepositoryIdSpy.mockResolvedValue(mockWorkspaces);
    updateWorkspaceLockStatusSpy.mockResolvedValue(mockWorkspaces);

    // Mock workspace creation
    const createWorkspaceSpy = spyOn(
      await import('./workspace_manager'),
      'createWorkspace'
    ).mockResolvedValue(null);

    const result = await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
    });

    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      testDir,
      'task-new',
      '/test/plan-new.yml',
      config
    );
  });

  test('preferNewWorkspace option creates new workspace first', async () => {
    const mockWorkspaces: WorkspaceInfo[] = [
      {
        taskId: 'task-existing',
        originalPlanFilePath: '/test/plan-existing.yml',
        repositoryId: 'github.com/test/repo',
        workspacePath: path.join(testDir, 'workspace-existing'),
        branch: 'llmutils-task/task-existing',
        createdAt: new Date().toISOString(),
      },
    ];

    findWorkspacesByRepositoryIdSpy.mockResolvedValue(mockWorkspaces);

    // Mock workspace creation
    const newWorkspace = {
      path: path.join(testDir, 'workspace-new'),
      originalPlanFilePath: '/test/plan-new.yml',
      taskId: 'task-new',
    };

    const createWorkspaceSpy = spyOn(
      await import('./workspace_manager'),
      'createWorkspace'
    ).mockResolvedValue(newWorkspace);

    findWorkspacesByTaskIdSpy.mockResolvedValue([
      {
        ...newWorkspace,
        workspacePath: newWorkspace.path,
        repositoryId: 'github.com/test/repo',
        branch: 'llmutils-task/task-new',
        createdAt: new Date().toISOString(),
      },
    ]);

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

    const localConfig: TimConfig = {
      modelSettings: {
        temperature: 0.7,
        maxTokens: 4096,
      },
      workspaceCreation: {
        cloneLocation: testDir,
      },
    };

    const localSelector = new WorkspaceAutoSelector(testDir, localConfig);

    const mockWorkspaces: WorkspaceInfo[] = [
      {
        taskId: 'task-1',
        originalPlanFilePath: '/test/plan1.yml',
        repositoryId: repositoryId,
        workspacePath: path.join(testDir, 'workspace-1'),
        branch: 'llmutils-task/task-1',
        createdAt: new Date().toISOString(),
      },
    ];

    findWorkspacesByRepositoryIdSpy.mockResolvedValue(mockWorkspaces);
    updateWorkspaceLockStatusSpy.mockResolvedValue(mockWorkspaces);

    const result = await localSelector.selectWorkspace('task-2', '/test/plan2.yml', {
      interactive: false,
    });

    expect(getRepositoryIdentitySpy).toHaveBeenCalled();
    expect(findWorkspacesByRepositoryIdSpy).toHaveBeenCalledWith(
      repositoryId,
      '/default/tracking/path.json'
    );
    expect(result?.workspace.taskId).toBe('task-1');
  });
});
