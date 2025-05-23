import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceAutoSelector } from './workspace_auto_selector';
import { WorkspaceManager } from './workspace_manager';
import { WorkspaceLock } from './workspace_lock';
import * as workspaceTracker from './workspace_tracker';
import type { RmplanConfig, WorkspaceInfo } from './configSchema';

// Mock @inquirer/prompts for non-interactive tests
mock.module('@inquirer/prompts', () => ({
  confirm: mock(() => true),
}));

describe('WorkspaceAutoSelector', () => {
  let testDir: string;
  let workspaceManager: WorkspaceManager;
  let selector: WorkspaceAutoSelector;
  let config: RmplanConfig;
  let findWorkspacesByRepoUrlSpy: any;
  let updateWorkspaceLockStatusSpy: any;
  let findWorkspacesByTaskIdSpy: any;
  let recordWorkspaceSpy: any;
  let getDefaultTrackingFilePathSpy: any;

  beforeEach(async () => {
    testDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'workspace-auto-selector-test-'));

    // Setup spies for workspace tracker functions
    findWorkspacesByRepoUrlSpy = spyOn(
      workspaceTracker,
      'findWorkspacesByRepoUrl'
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

    // Setup test config
    config = {
      modelSettings: {
        temperature: 0.7,
        maxTokens: 4096,
      },
      workspaceCreation: {
        repositoryUrl: 'https://github.com/test/repo.git',
        cloneLocation: testDir,
      },
    };

    workspaceManager = new WorkspaceManager(testDir);
    selector = new WorkspaceAutoSelector(workspaceManager, config);
  });

  afterEach(async () => {
    await fs.promises.rm(testDir, { recursive: true, force: true });
    mock.restore();
  });

  test('selectWorkspace returns unlocked workspace when available', async () => {
    const mockWorkspaces: WorkspaceInfo[] = [
      {
        taskId: 'task-1',
        originalPlanFilePath: '/test/plan1.yml',
        repositoryUrl: 'https://github.com/test/repo.git',
        workspacePath: path.join(testDir, 'workspace-1'),
        branch: 'llmutils-task/task-1',
        createdAt: new Date().toISOString(),
      },
      {
        taskId: 'task-2',
        originalPlanFilePath: '/test/plan2.yml',
        repositoryUrl: 'https://github.com/test/repo.git',
        workspacePath: path.join(testDir, 'workspace-2'),
        branch: 'llmutils-task/task-2',
        createdAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        lockedBy: {
          pid: 99999,
          startedAt: new Date().toISOString(),
          hostname: 'other-host',
        },
      },
    ];

    findWorkspacesByRepoUrlSpy.mockResolvedValue(mockWorkspaces);
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
      pid: 99999,
      command: 'rmplan agent',
      startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25 hours ago
      hostname: os.hostname(),
      version: 1,
    };
    await fs.promises.writeFile(
      path.join(workspacePath, '.rmplan.lock'),
      JSON.stringify(staleLock)
    );

    const mockWorkspaces: WorkspaceInfo[] = [
      {
        taskId: 'task-stale',
        originalPlanFilePath: '/test/plan-stale.yml',
        repositoryUrl: 'https://github.com/test/repo.git',
        workspacePath,
        branch: 'llmutils-task/task-stale',
        createdAt: new Date().toISOString(),
        lockedBy: {
          pid: staleLock.pid,
          startedAt: staleLock.startedAt,
          hostname: staleLock.hostname,
        },
      },
    ];

    findWorkspacesByRepoUrlSpy.mockResolvedValue(mockWorkspaces);
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
      .access(path.join(workspacePath, '.rmplan.lock'))
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  test('selectWorkspace creates new workspace when all are locked', async () => {
    const mockWorkspaces: WorkspaceInfo[] = [
      {
        taskId: 'task-locked',
        originalPlanFilePath: '/test/plan-locked.yml',
        repositoryUrl: 'https://github.com/test/repo.git',
        workspacePath: path.join(testDir, 'workspace-locked'),
        branch: 'llmutils-task/task-locked',
        createdAt: new Date().toISOString(),
        lockedBy: {
          pid: process.pid, // Current process, so not stale
          startedAt: new Date().toISOString(),
          hostname: os.hostname(),
        },
      },
    ];

    findWorkspacesByRepoUrlSpy.mockResolvedValue(mockWorkspaces);
    updateWorkspaceLockStatusSpy.mockResolvedValue(mockWorkspaces);

    // Mock workspace creation
    const createWorkspaceMock = mock(() => null);
    workspaceManager.createWorkspace = createWorkspaceMock;

    const result = await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
    });

    expect(createWorkspaceMock).toHaveBeenCalledWith('task-new', '/test/plan-new.yml', config);
  });

  test('preferNewWorkspace option creates new workspace first', async () => {
    const mockWorkspaces: WorkspaceInfo[] = [
      {
        taskId: 'task-existing',
        originalPlanFilePath: '/test/plan-existing.yml',
        repositoryUrl: 'https://github.com/test/repo.git',
        workspacePath: path.join(testDir, 'workspace-existing'),
        branch: 'llmutils-task/task-existing',
        createdAt: new Date().toISOString(),
      },
    ];

    findWorkspacesByRepoUrlSpy.mockResolvedValue(mockWorkspaces);

    // Mock workspace creation
    const newWorkspace = {
      path: path.join(testDir, 'workspace-new'),
      originalPlanFilePath: '/test/plan-new.yml',
      taskId: 'task-new',
    };

    const createWorkspaceMock = mock(() => newWorkspace);
    workspaceManager.createWorkspace = createWorkspaceMock;

    findWorkspacesByTaskIdSpy.mockResolvedValue([
      {
        ...newWorkspace,
        workspacePath: newWorkspace.path,
        repositoryUrl: 'https://github.com/test/repo.git',
        branch: 'llmutils-task/task-new',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await selector.selectWorkspace('task-new', '/test/plan-new.yml', {
      interactive: false,
      preferNewWorkspace: true,
    });

    expect(createWorkspaceMock).toHaveBeenCalled();
    expect(result?.isNew).toBe(true);
    expect(result?.workspace.taskId).toBe('task-new');
  });
});
