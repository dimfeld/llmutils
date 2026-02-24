import { describe, test, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import type { TimConfig } from '../configSchema.js';
import * as git from '../../common/git.js';
import { WorkspaceAutoSelector } from './workspace_auto_selector.js';
import { WorkspaceLock } from './workspace_lock.js';
import * as workspaceManager from './workspace_manager.js';
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

  test('preserves relative plan path when copying plan into selected workspace', async () => {
    const autoWorkspacePath = path.join(tempDir, 'workspace-auto-nested-plan');
    await fs.mkdir(autoWorkspacePath, { recursive: true });

    const nestedPlanFile = path.join(baseDir, 'tasks', 'nested', 'task.plan.md');
    await fs.mkdir(path.dirname(nestedPlanFile), { recursive: true });
    await fs.writeFile(nestedPlanFile, '---\nid: 11\n---\n\nNested plan details\n');

    spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace').mockResolvedValue({
      workspace: {
        taskId: 'task-auto-nested-plan',
        workspacePath: autoWorkspacePath,
        originalPlanFilePath: nestedPlanFile,
        createdAt: new Date().toISOString(),
      },
      isNew: true,
      clearedStaleLock: false,
    });

    const result = await setupWorkspace(
      {
        autoWorkspace: true,
        workspace: 'task-auto-nested-plan',
        nonInteractive: true,
      },
      baseDir,
      nestedPlanFile,
      config,
      'tim generate'
    );

    const copiedPlanFile = path.join(autoWorkspacePath, 'tasks', 'nested', 'task.plan.md');
    expect(result.planFile).toBe(copiedPlanFile);
    expect(await fs.readFile(result.planFile, 'utf8')).toContain('Nested plan details');
  });

  test('preserves relative plan path when reusing an existing manual workspace', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-nested-plan');
    await fs.mkdir(existingWorkspacePath, { recursive: true });

    const nestedPlanFile = path.join(baseDir, 'tasks', 'manual', 'task.plan.md');
    await fs.mkdir(path.dirname(nestedPlanFile), { recursive: true });
    await fs.writeFile(nestedPlanFile, '---\nid: 12\n---\n\nManual nested plan details\n');
    planFile = nestedPlanFile;

    await seedWorkspace(existingWorkspacePath, 'task-existing-nested-plan');
    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });
    const updateSpy = spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-existing-nested-plan',
      },
      baseDir,
      nestedPlanFile,
      config,
      'tim generate'
    );

    const copiedPlanFile = path.join(existingWorkspacePath, 'tasks', 'manual', 'task.plan.md');
    expect(result.planFile).toBe(copiedPlanFile);
    expect(await fs.readFile(result.planFile, 'utf8')).toContain('Manual nested plan details');
    expect(updateSpy).toHaveBeenCalledWith(
      existingWorkspacePath,
      config,
      'task-existing-nested-plan',
      copiedPlanFile
    );
  });

  test('passes plan UUID to auto-workspace selector when provided', async () => {
    const autoWorkspacePath = path.join(tempDir, 'workspace-auto-plan-uuid');
    await fs.mkdir(autoWorkspacePath, { recursive: true });

    const selectWorkspaceSpy = spyOn(
      WorkspaceAutoSelector.prototype,
      'selectWorkspace'
    ).mockResolvedValue({
      workspace: {
        taskId: 'task-auto-plan-uuid',
        workspacePath: autoWorkspacePath,
        originalPlanFilePath: planFile,
        createdAt: new Date().toISOString(),
      },
      isNew: false,
      clearedStaleLock: false,
    });
    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

    await setupWorkspace(
      {
        autoWorkspace: true,
        workspace: 'task-auto-plan-uuid',
        planUuid: '11111111-1111-4111-8111-111111111111',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(selectWorkspaceSpy).toHaveBeenCalledWith('task-auto-plan-uuid', planFile, {
      interactive: true,
      preferNewWorkspace: undefined,
      preferredPlanUuid: '11111111-1111-4111-8111-111111111111',
    });
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
    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

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

  test('prepares existing workspace, copies plan, and runs workspace update commands in order', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-prep');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-prep');
    const copiedPlanFile = path.join(existingWorkspacePath, path.basename(planFile));

    const callOrder: string[] = [];
    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = spyOn(workspaceManager, 'prepareExistingWorkspace').mockImplementation(
      async () => {
        expect(await WorkspaceLock.getLockInfo(existingWorkspacePath)).not.toBeNull();
        callOrder.push('prepare');
        return { success: true };
      }
    );
    const updateSpy = spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockImplementation(
      async (_workspacePath, _config, _taskId, planFilePath) => {
        expect(planFilePath).toBe(copiedPlanFile);
        expect(await fs.readFile(copiedPlanFile, 'utf8')).toContain('Plan details');
        callOrder.push('update');
        return true;
      }
    );

    const result = await setupWorkspace(
      {
        workspace: 'task-existing-prep',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenCalledWith(existingWorkspacePath, {
      baseBranch: undefined,
      branchName: 'task-existing-prep',
      createBranch: true,
    });
    expect(updateSpy).toHaveBeenCalledWith(
      existingWorkspacePath,
      config,
      'task-existing-prep',
      copiedPlanFile
    );
    expect(callOrder).toEqual(['prepare', 'update']);
    expect(result.baseDir).toBe(existingWorkspacePath);
  });

  test('uses branch command plan naming when plan file is valid', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-plan-branch-name');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-plan-branch-name');

    const validPlanFile = path.join(baseDir, 'valid.plan.md');
    await fs.writeFile(
      validPlanFile,
      [
        '---',
        'id: 42',
        'title: Add workspace branch naming',
        'tasks: []',
        '---',
        '',
        'Plan details',
        '',
      ].join('\n')
    );

    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await setupWorkspace(
      {
        workspace: 'task-existing-plan-branch-name',
      },
      baseDir,
      validPlanFile,
      config,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenCalledWith(existingWorkspacePath, {
      baseBranch: undefined,
      branchName: '42-add-workspace-branch-naming',
      createBranch: true,
    });
  });

  test('omits plan file path for update commands when plan copy into existing workspace fails', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-copy-fails');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-copy-fails');

    const missingPlanFile = path.join(baseDir, 'tasks', 'missing', 'task.plan.md');
    const updateSpy = spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);
    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

    await setupWorkspace(
      {
        workspace: 'task-existing-copy-fails',
      },
      baseDir,
      missingPlanFile,
      config,
      'tim generate'
    );

    expect(updateSpy).toHaveBeenCalledWith(
      existingWorkspacePath,
      config,
      'task-existing-copy-fails',
      undefined
    );
  });

  test('acquires lock before checking working copy status for existing workspace', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-lock-before-dirty-check');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-lock-before-dirty-check');

    const callOrder: string[] = [];
    spyOn(git, 'getWorkingCopyStatus').mockImplementation(async (workspacePath) => {
      expect(workspacePath).toBe(existingWorkspacePath);
      expect(await WorkspaceLock.getLockInfo(existingWorkspacePath)).not.toBeNull();
      callOrder.push('dirty-check');
      return { hasChanges: false, checkFailed: false };
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockImplementation(async () => {
      callOrder.push('prepare');
      return { success: true };
    });
    spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await setupWorkspace(
      {
        workspace: 'task-lock-before-dirty-check',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(callOrder).toEqual(['dirty-check', 'prepare']);
  });

  test('does not prepare existing workspace for newly created workspace', async () => {
    const createdWorkspacePath = path.join(tempDir, 'workspace-new-no-prepare');
    await fs.mkdir(createdWorkspacePath, { recursive: true });

    const createWorkspaceSpy = spyOn(workspaceManager, 'createWorkspace').mockResolvedValue({
      path: createdWorkspacePath,
      taskId: 'task-new-no-prepare',
      originalPlanFilePath: planFile,
      planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
    });
    const getWorkingCopyStatusSpy = spyOn(git, 'getWorkingCopyStatus');
    const prepareSpy = spyOn(workspaceManager, 'prepareExistingWorkspace');
    const updateSpy = spyOn(workspaceManager, 'runWorkspaceUpdateCommands');

    const result = await setupWorkspace(
      {
        workspace: 'task-new-no-prepare',
        newWorkspace: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalled();
    expect(getWorkingCopyStatusSpy).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(result.baseDir).toBe(createdWorkspacePath);
    expect(result.isNewWorkspace).toBe(true);
  });

  test('throws hard failure when existing workspace has uncommitted changes', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-dirty');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-dirty');

    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: true,
      checkFailed: false,
      output: ' M file.ts',
    });
    const prepareSpy = spyOn(workspaceManager, 'prepareExistingWorkspace');
    const updateSpy = spyOn(workspaceManager, 'runWorkspaceUpdateCommands');

    await expect(
      setupWorkspace(
        {
          workspace: 'task-existing-dirty',
        },
        baseDir,
        planFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('has uncommitted changes');

    expect(prepareSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(await WorkspaceLock.getLockInfo(existingWorkspacePath)).toBeNull();
  });

  test('aborts setup when workspace update command fails with allowFailure false', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-update-fail-hard');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-update-fail-hard');

    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

    const configWithHardFailingUpdate: TimConfig = {
      workspaceCreation: {
        repositoryId: 'github.com/test/repo',
        cloneLocation: '/tmp',
        workspaceUpdateCommands: [
          {
            title: 'Fail update command',
            command: 'exit 1',
            allowFailure: false,
          },
        ],
      },
    };

    await expect(
      setupWorkspace(
        {
          workspace: 'task-update-fail-hard',
        },
        baseDir,
        planFile,
        configWithHardFailingUpdate,
        'tim generate'
      )
    ).rejects.toThrow('Failed to run workspace update commands');

    expect(await WorkspaceLock.getLockInfo(existingWorkspacePath)).toBeNull();
  });

  test('continues setup when workspace update command fails with allowFailure true', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-update-fail-soft');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-update-fail-soft');

    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

    const configWithSoftFailingUpdate: TimConfig = {
      workspaceCreation: {
        repositoryId: 'github.com/test/repo',
        cloneLocation: '/tmp',
        workspaceUpdateCommands: [
          {
            title: 'Fail update command softly',
            command: 'exit 1',
            allowFailure: true,
          },
        ],
      },
    };

    const result = await setupWorkspace(
      {
        workspace: 'task-update-fail-soft',
      },
      baseDir,
      planFile,
      configWithSoftFailingUpdate,
      'tim generate'
    );

    expect(result.baseDir).toBe(existingWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-update-fail-soft');
  });

  test('passes --base through as baseBranch for existing workspace preparation', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-base-explicit');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-base-explicit');

    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await setupWorkspace(
      {
        workspace: 'task-existing-base-explicit',
        base: 'feature/base-branch',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenCalledWith(existingWorkspacePath, {
      baseBranch: 'feature/base-branch',
      branchName: 'task-existing-base-explicit',
      createBranch: true,
    });
  });

  test('defaults baseBranch to undefined when --base is not provided', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-base-default');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-base-default');

    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await setupWorkspace(
      {
        workspace: 'task-existing-base-default',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenCalledWith(existingWorkspacePath, {
      baseBranch: undefined,
      branchName: 'task-existing-base-default',
      createBranch: true,
    });
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
    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

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
    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

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
    spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

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
