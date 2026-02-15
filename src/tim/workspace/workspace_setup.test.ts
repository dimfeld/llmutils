import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import type { TimConfig } from '../configSchema.js';
import { WorkspaceAutoSelector } from './workspace_auto_selector.js';
import { WorkspaceLock } from './workspace_lock.js';
import { setupWorkspace } from './workspace_setup.js';

describe('setupWorkspace', () => {
  let tempDir: string;
  let baseDir: string;
  let planFile: string;
  let configDir: string;
  let originalXdgConfigHome: string | undefined;

  const config: TimConfig = {
    workspaceCreation: {
      repositoryId: 'github.com/test/repo',
      cloneLocation: '/tmp',
    },
  };

  async function seedWorkspace(workspacePath: string, taskId: string): Promise<void> {
    const db = getDatabase();
    const project = getOrCreateProject(db, 'github.com/test/repo');
    recordWorkspace(db, {
      projectId: project.id,
      workspacePath,
      taskId,
      originalPlanFilePath: planFile,
    });
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-setup-test-'));
    baseDir = path.join(tempDir, 'repo');
    await fs.mkdir(baseDir, { recursive: true });

    planFile = path.join(baseDir, 'task.plan.md');
    await fs.writeFile(planFile, '---\nid: 10\n---\n\nPlan details\n');

    configDir = path.join(tempDir, 'xdg-config');
    await fs.mkdir(configDir, { recursive: true });

    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = configDir;

    closeDatabaseForTesting();
    WorkspaceLock.setTestPid(undefined);
  });

  afterEach(async () => {
    await WorkspaceLock.releaseLock(baseDir, { force: true });

    closeDatabaseForTesting();
    WorkspaceLock.setTestPid(undefined);

    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }

    mock.restore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('uses auto-workspace selector and copies plan into selected workspace', async () => {
    const autoWorkspacePath = path.join(tempDir, 'workspace-auto');
    await fs.mkdir(autoWorkspacePath, { recursive: true });

    const selectWorkspaceSpy = spyOn(
      WorkspaceAutoSelector.prototype,
      'selectWorkspace'
    ).mockResolvedValue({
      workspace: {
        taskId: 'task-auto',
        workspacePath: autoWorkspacePath,
        originalPlanFilePath: planFile,
        createdAt: new Date().toISOString(),
      },
      isNew: true,
      clearedStaleLock: false,
    });

    const result = await setupWorkspace(
      {
        autoWorkspace: true,
        workspace: 'task-auto',
        nonInteractive: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(selectWorkspaceSpy).toHaveBeenCalledWith('task-auto', planFile, {
      interactive: false,
      preferNewWorkspace: undefined,
    });
    expect(result.baseDir).toBe(autoWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-auto');
    expect(result.isNewWorkspace).toBe(true);

    const copiedPlanFile = path.join(autoWorkspacePath, path.basename(planFile));
    expect(result.planFile).toBe(copiedPlanFile);
    expect(await fs.readFile(result.planFile, 'utf8')).toContain('Plan details');
  });

  test('falls back to current directory when auto-workspace selector returns null and requireWorkspace is false', async () => {
    const selectWorkspaceSpy = spyOn(
      WorkspaceAutoSelector.prototype,
      'selectWorkspace'
    ).mockResolvedValue(null);

    const result = await setupWorkspace(
      {
        autoWorkspace: true,
        workspace: 'task-auto-null',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(selectWorkspaceSpy).toHaveBeenCalledWith('task-auto-null', planFile, {
      interactive: true,
      preferNewWorkspace: undefined,
    });
    expect(result.baseDir).toBe(baseDir);
    expect(result.planFile).toBe(planFile);
    expect(result.workspaceTaskId).toBeUndefined();
    expect(result.isNewWorkspace).toBeUndefined();
    const lock = await WorkspaceLock.getLockInfo(baseDir);
    expect(lock?.type).toBe('pid');
    expect(lock?.command).toBe('tim generate');
  });

  test('throws when auto-workspace selector returns null and requireWorkspace is true', async () => {
    spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace').mockResolvedValue(null);

    await expect(
      setupWorkspace(
        {
          autoWorkspace: true,
          workspace: 'task-auto-required',
          requireWorkspace: true,
        },
        baseDir,
        planFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('Workspace creation was required but failed');

    expect(await WorkspaceLock.getLockInfo(baseDir)).toBeNull();
  });

  test('auto-workspace selection of existing workspace acquires lock and sets cleanup handlers', async () => {
    const autoWorkspacePath = path.join(tempDir, 'workspace-auto-existing');
    await fs.mkdir(autoWorkspacePath, { recursive: true });

    spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace').mockResolvedValue({
      workspace: {
        taskId: 'task-auto-existing',
        workspacePath: autoWorkspacePath,
        originalPlanFilePath: planFile,
        createdAt: new Date().toISOString(),
      },
      isNew: false,
      clearedStaleLock: false,
    });

    const acquireLockSpy = spyOn(WorkspaceLock, 'acquireLock');
    const setupCleanupHandlersSpy = spyOn(WorkspaceLock, 'setupCleanupHandlers');

    const result = await setupWorkspace(
      {
        autoWorkspace: true,
        workspace: 'task-auto-existing',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(result.baseDir).toBe(autoWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-auto-existing');
    expect(result.isNewWorkspace).toBe(false);
    expect(acquireLockSpy).toHaveBeenCalledWith(
      autoWorkspacePath,
      'tim generate --workspace task-auto-existing',
      { type: 'pid' }
    );
    expect(setupCleanupHandlersSpy).toHaveBeenCalledWith(autoWorkspacePath, 'pid');
  });

  test('reuses unlocked workspace from manual workspace selection and acquires lock', async () => {
    const unlockedWorkspacePath = path.join(tempDir, 'workspace-unlocked');
    const lockedWorkspacePath = path.join(tempDir, 'workspace-locked');
    await fs.mkdir(unlockedWorkspacePath, { recursive: true });
    await fs.mkdir(lockedWorkspacePath, { recursive: true });

    // Insert unlocked first and locked second so locked is evaluated first (DESC id ordering).
    await seedWorkspace(unlockedWorkspacePath, 'task-123');
    await seedWorkspace(lockedWorkspacePath, 'task-123');
    await WorkspaceLock.acquireLock(lockedWorkspacePath, 'already-running', { type: 'pid' });

    const acquireLockSpy = spyOn(WorkspaceLock, 'acquireLock');

    const result = await setupWorkspace(
      {
        workspace: 'task-123',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(result.baseDir).toBe(unlockedWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-123');

    const copiedPlanFile = path.join(unlockedWorkspacePath, path.basename(planFile));
    expect(result.planFile).toBe(copiedPlanFile);
    expect(await fs.readFile(copiedPlanFile, 'utf8')).toContain('Plan details');

    expect(acquireLockSpy).toHaveBeenCalledWith(
      unlockedWorkspacePath,
      'tim generate --workspace task-123',
      { type: 'pid' }
    );

    const lock = await WorkspaceLock.getLockInfo(unlockedWorkspacePath);
    expect(lock?.type).toBe('pid');

    await WorkspaceLock.releaseLock(lockedWorkspacePath, { force: true });
    await WorkspaceLock.releaseLock(unlockedWorkspacePath, { force: true });
  });

  test('creates new manual workspace with --new-workspace and upgrades workspace lock to pid', async () => {
    const createdWorkspacePath = path.join(tempDir, 'workspace-new');
    await fs.mkdir(createdWorkspacePath, { recursive: true });

    const createWorkspaceSpy = spyOn(
      await import('./workspace_manager.js'),
      'createWorkspace'
    ).mockResolvedValue({
      path: createdWorkspacePath,
      taskId: 'task-new',
      originalPlanFilePath: planFile,
      planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
    });

    const acquireLockSpy = spyOn(WorkspaceLock, 'acquireLock');
    const releaseLockSpy = spyOn(WorkspaceLock, 'releaseLock');
    const setupCleanupHandlersSpy = spyOn(WorkspaceLock, 'setupCleanupHandlers');

    const result = await setupWorkspace(
      {
        workspace: 'task-new',
        newWorkspace: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalledWith(baseDir, 'task-new', planFile, config);
    expect(result.baseDir).toBe(createdWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-new');
    expect(result.isNewWorkspace).toBe(true);

    const copiedPlanFile = path.join(createdWorkspacePath, path.basename(planFile));
    expect(result.planFile).toBe(copiedPlanFile);
    expect(await fs.readFile(copiedPlanFile, 'utf8')).toContain('Plan details');

    expect(releaseLockSpy).toHaveBeenCalledWith(createdWorkspacePath, { force: true });
    expect(acquireLockSpy).toHaveBeenCalledWith(
      createdWorkspacePath,
      'tim generate --workspace task-new',
      { type: 'pid' }
    );
    expect(setupCleanupHandlersSpy).toHaveBeenCalledWith(createdWorkspacePath, 'pid');
    expect((await WorkspaceLock.getLockInfo(createdWorkspacePath))?.type).toBe('pid');
  });

  test('falls back to current directory when workspace creation fails and requireWorkspace is false', async () => {
    spyOn(await import('./workspace_manager.js'), 'createWorkspace').mockResolvedValue(null);

    const result = await setupWorkspace(
      {
        workspace: 'task-fallback',
        newWorkspace: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(result.baseDir).toBe(baseDir);
    expect(result.planFile).toBe(planFile);
    expect(result.workspaceTaskId).toBeUndefined();
    const lock = await WorkspaceLock.getLockInfo(baseDir);
    expect(lock?.type).toBe('pid');
    expect(lock?.command).toBe('tim generate');
  });

  test('creates a new manual workspace when --new-workspace is set and all matching workspaces are locked', async () => {
    const lockedWorkspacePath1 = path.join(tempDir, 'workspace-locked-new-1');
    const lockedWorkspacePath2 = path.join(tempDir, 'workspace-locked-new-2');
    const createdWorkspacePath = path.join(tempDir, 'workspace-created-for-locked');
    await fs.mkdir(lockedWorkspacePath1, { recursive: true });
    await fs.mkdir(lockedWorkspacePath2, { recursive: true });
    await fs.mkdir(createdWorkspacePath, { recursive: true });
    await seedWorkspace(lockedWorkspacePath1, 'task-all-locked-new');
    await seedWorkspace(lockedWorkspacePath2, 'task-all-locked-new');
    await WorkspaceLock.acquireLock(lockedWorkspacePath1, 'already-running-1', { type: 'pid' });
    await WorkspaceLock.acquireLock(lockedWorkspacePath2, 'already-running-2', { type: 'pid' });

    const createWorkspaceSpy = spyOn(
      await import('./workspace_manager.js'),
      'createWorkspace'
    ).mockResolvedValue({
      path: createdWorkspacePath,
      taskId: 'task-all-locked-new',
      originalPlanFilePath: planFile,
      planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
    });

    const result = await setupWorkspace(
      {
        workspace: 'task-all-locked-new',
        newWorkspace: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      baseDir,
      'task-all-locked-new',
      planFile,
      config
    );
    expect(result.baseDir).toBe(createdWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-all-locked-new');
    expect(result.isNewWorkspace).toBe(true);
    expect((await WorkspaceLock.getLockInfo(createdWorkspacePath))?.type).toBe('pid');

    await WorkspaceLock.releaseLock(lockedWorkspacePath1, { force: true });
    await WorkspaceLock.releaseLock(lockedWorkspacePath2, { force: true });
  });

  test('throws when workspace creation fails and requireWorkspace is true', async () => {
    spyOn(await import('./workspace_manager.js'), 'createWorkspace').mockResolvedValue(null);

    await expect(
      setupWorkspace(
        {
          workspace: 'task-required',
          newWorkspace: true,
          requireWorkspace: true,
        },
        baseDir,
        planFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('Workspace creation was required but failed');

    expect(await WorkspaceLock.getLockInfo(baseDir)).toBeNull();
  });

  test('creates a manual workspace when workspace ID is not found and --new-workspace is not specified', async () => {
    const createdWorkspacePath = path.join(tempDir, 'workspace-created-missing');
    await fs.mkdir(createdWorkspacePath, { recursive: true });

    const createWorkspaceSpy = spyOn(
      await import('./workspace_manager.js'),
      'createWorkspace'
    ).mockResolvedValue({
      path: createdWorkspacePath,
      taskId: 'task-missing',
      originalPlanFilePath: planFile,
      planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
    });

    const result = await setupWorkspace(
      {
        workspace: 'task-missing',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalledWith(baseDir, 'task-missing', planFile, config);
    expect(result.baseDir).toBe(createdWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-missing');
    expect(result.isNewWorkspace).toBe(true);
  });

  test('throws when all matching manual workspaces are locked', async () => {
    const lockedWorkspacePath1 = path.join(tempDir, 'workspace-locked-1');
    const lockedWorkspacePath2 = path.join(tempDir, 'workspace-locked-2');
    await fs.mkdir(lockedWorkspacePath1, { recursive: true });
    await fs.mkdir(lockedWorkspacePath2, { recursive: true });
    await seedWorkspace(lockedWorkspacePath1, 'task-all-locked');
    await seedWorkspace(lockedWorkspacePath2, 'task-all-locked');
    await WorkspaceLock.acquireLock(lockedWorkspacePath1, 'already-running-1', { type: 'pid' });
    await WorkspaceLock.acquireLock(lockedWorkspacePath2, 'already-running-2', { type: 'pid' });

    await expect(
      setupWorkspace(
        {
          workspace: 'task-all-locked',
        },
        baseDir,
        planFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('exists but is locked');

    await WorkspaceLock.releaseLock(lockedWorkspacePath1, { force: true });
    await WorkspaceLock.releaseLock(lockedWorkspacePath2, { force: true });
    expect(await WorkspaceLock.getLockInfo(baseDir)).toBeNull();
  });

  test('throws for explicit selection errors instead of silently falling back', async () => {
    const lockedWorkspacePath = path.join(tempDir, 'workspace-locked-only');
    await fs.mkdir(lockedWorkspacePath, { recursive: true });
    await seedWorkspace(lockedWorkspacePath, 'task-locked');
    await WorkspaceLock.acquireLock(lockedWorkspacePath, 'already-running', { type: 'pid' });

    await expect(
      setupWorkspace(
        {
          workspace: 'task-locked',
        },
        baseDir,
        planFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('exists but is locked');

    await WorkspaceLock.releaseLock(lockedWorkspacePath, { force: true });
    expect(await WorkspaceLock.getLockInfo(baseDir)).toBeNull();
  });

  test('forces new workspace creation with --new-workspace even when unlocked workspace exists', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-unlocked');
    const createdWorkspacePath = path.join(tempDir, 'workspace-created-forced');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await fs.mkdir(createdWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-force-new');

    const createWorkspaceSpy = spyOn(
      await import('./workspace_manager.js'),
      'createWorkspace'
    ).mockResolvedValue({
      path: createdWorkspacePath,
      taskId: 'task-force-new',
      originalPlanFilePath: planFile,
      planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
    });

    const result = await setupWorkspace(
      {
        workspace: 'task-force-new',
        newWorkspace: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalledWith(baseDir, 'task-force-new', planFile, config);
    expect(result.baseDir).toBe(createdWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-force-new');
    expect(result.isNewWorkspace).toBe(true);
    expect(result.baseDir).not.toBe(existingWorkspacePath);
  });

  test('clears stale lock before reusing manual workspace', async () => {
    const staleWorkspacePath = path.join(tempDir, 'workspace-manual-stale');
    await fs.mkdir(staleWorkspacePath, { recursive: true });
    await seedWorkspace(staleWorkspacePath, 'task-manual-stale');

    const getLockInfoSpy = spyOn(WorkspaceLock, 'getLockInfo').mockResolvedValue({
      type: 'pid',
      pid: 999999,
      command: 'stale-command',
      startedAt: new Date().toISOString(),
      hostname: 'test-host',
      version: 2,
    });
    const isLockStaleSpy = spyOn(WorkspaceLock, 'isLockStale').mockResolvedValue(true);
    const clearStaleLockSpy = spyOn(WorkspaceLock, 'clearStaleLock').mockResolvedValue(undefined);
    const acquireLockSpy = spyOn(WorkspaceLock, 'acquireLock');

    const result = await setupWorkspace(
      {
        workspace: 'task-manual-stale',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(getLockInfoSpy).toHaveBeenCalledWith(staleWorkspacePath);
    expect(isLockStaleSpy).toHaveBeenCalled();
    expect(clearStaleLockSpy).toHaveBeenCalledWith(staleWorkspacePath);
    expect(acquireLockSpy).toHaveBeenCalledWith(
      staleWorkspacePath,
      'tim generate --workspace task-manual-stale',
      { type: 'pid' }
    );
    expect(result.baseDir).toBe(staleWorkspacePath);
  });

  test('throws when lock acquisition fails for selected workspace', async () => {
    const unlockedWorkspacePath = path.join(tempDir, 'workspace-unlocked-lock-fail');
    await fs.mkdir(unlockedWorkspacePath, { recursive: true });
    await seedWorkspace(unlockedWorkspacePath, 'task-lock-fail');

    const acquireLockSpy = spyOn(WorkspaceLock, 'acquireLock').mockRejectedValue(
      new Error('failed to acquire workspace lock')
    );

    await expect(
      setupWorkspace(
        {
          workspace: 'task-lock-fail',
        },
        baseDir,
        planFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('failed to acquire workspace lock');

    expect(acquireLockSpy).toHaveBeenCalledWith(
      unlockedWorkspacePath,
      'tim generate --workspace task-lock-fail',
      { type: 'pid' }
    );
  });

  test('throws when lock acquisition fails for current directory fallback', async () => {
    const acquireLockSpy = spyOn(WorkspaceLock, 'acquireLock').mockRejectedValue(
      new Error('failed to acquire cwd lock')
    );

    await expect(setupWorkspace({}, baseDir, planFile, config, 'tim generate')).rejects.toThrow(
      'failed to acquire cwd lock'
    );

    expect(acquireLockSpy).toHaveBeenCalledWith(baseDir, 'tim generate', { type: 'pid' });
  });

  test('locks current working directory when no workspace options are provided', async () => {
    const result = await setupWorkspace({}, baseDir, planFile, config, 'tim generate');

    expect(result.baseDir).toBe(baseDir);
    expect(result.planFile).toBe(planFile);

    const lock = await WorkspaceLock.getLockInfo(baseDir);
    expect(lock).not.toBeNull();
    expect(lock?.type).toBe('pid');
    expect(lock?.command).toBe('tim generate');

    await WorkspaceLock.releaseLock(baseDir, { force: true });
  });
});
