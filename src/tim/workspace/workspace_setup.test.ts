import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { recordWorkspace } from '../db/workspace.js';
import type { TimConfig } from '../configSchema.js';
import * as git from '../../common/git.js';
import { resolvePlanFromDb } from '../plans.js';
import { WorkspaceAutoSelector } from './workspace_auto_selector.js';
import { WorkspaceAlreadyLocked, WorkspaceLock } from './workspace_lock.js';
import * as workspaceManager from './workspace_manager.js';
import { setupWorkspace } from './workspace_setup.js';
import { writePlanFile } from '../plans.js';
import { setPlanBaseTracking } from '../db/plan.js';

// Partially mock db/plan.js: replace only setPlanBaseTracking so we can verify tracking calls
// while leaving all other DB functions (upsertPlan, getPlanByPlanId, etc.) as real implementations.
vi.mock('../db/plan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/plan.js')>();
  return {
    ...actual,
    setPlanBaseTracking: vi.fn(),
  };
});

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

    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('uses auto-workspace selector and points new workspaces at the workspace plan path', async () => {
    const autoWorkspacePath = path.join(tempDir, 'workspace-auto');
    await fs.mkdir(autoWorkspacePath, { recursive: true });

    const selectWorkspaceSpy = vi
      .spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace')
      .mockResolvedValue({
        workspace: {
          taskId: 'task-auto',
          workspacePath: autoWorkspacePath,
          originalPlanFilePath: planFile,
          createdAt: new Date().toISOString(),
        },
        isNew: true,
        clearedStaleLock: false,
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

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
      createBranch: undefined,
      base: undefined,
      branchName: undefined,
      planData: undefined,
    });
    expect(result.baseDir).toBe(autoWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-auto');
    expect(result.isNewWorkspace).toBe(true);

    const copiedPlanFile = path.join(autoWorkspacePath, path.basename(planFile));
    expect(result.planFile).toBe(copiedPlanFile);
    expect(
      await fs
        .access(result.planFile)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test('preserves relative plan path for new selected workspaces', async () => {
    const autoWorkspacePath = path.join(tempDir, 'workspace-auto-nested-plan');
    await fs.mkdir(autoWorkspacePath, { recursive: true });

    const nestedPlanFile = path.join(baseDir, 'tasks', 'nested', 'task.plan.md');
    await fs.mkdir(path.dirname(nestedPlanFile), { recursive: true });
    await fs.writeFile(nestedPlanFile, '---\nid: 11\n---\n\nNested plan details\n');

    vi.spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace').mockResolvedValue({
      workspace: {
        taskId: 'task-auto-nested-plan',
        workspacePath: autoWorkspacePath,
        originalPlanFilePath: nestedPlanFile,
        createdAt: new Date().toISOString(),
      },
      isNew: true,
      clearedStaleLock: false,
    });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

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
    expect(
      await fs
        .access(result.planFile)
        .then(() => true)
        .catch(() => false)
    ).toBe(true);
  });

  test('preserves relative plan path when reusing an existing manual workspace', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-nested-plan');
    await fs.mkdir(existingWorkspacePath, { recursive: true });

    const nestedPlanFile = path.join(baseDir, 'tasks', 'manual', 'task.plan.md');
    await fs.mkdir(path.dirname(nestedPlanFile), { recursive: true });
    await fs.writeFile(nestedPlanFile, '---\nid: 12\n---\n\nManual nested plan details\n');
    planFile = nestedPlanFile;

    await seedWorkspace(existingWorkspacePath, 'task-existing-nested-plan');
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });
    const updateSpy = vi
      .spyOn(workspaceManager, 'runWorkspaceUpdateCommands')
      .mockResolvedValue(true);

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

    const selectWorkspaceSpy = vi
      .spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace')
      .mockResolvedValue({
        workspace: {
          taskId: 'task-auto-plan-uuid',
          workspacePath: autoWorkspacePath,
          originalPlanFilePath: planFile,
          createdAt: new Date().toISOString(),
        },
        isNew: false,
        clearedStaleLock: false,
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

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
      createBranch: undefined,
      base: undefined,
      branchName: undefined,
      planData: undefined,
      preferredPlanUuid: '11111111-1111-4111-8111-111111111111',
    });
  });

  test('materializes DB-backed plans when a plan ID is provided without a source file', async () => {
    await Bun.$`git init`.cwd(baseDir).quiet();
    await Bun.$`git remote add origin https://example.com/test/repo.git`.cwd(baseDir).quiet();

    await writePlanFile(
      null,
      {
        id: 44,
        uuid: '44444444-4444-4444-8444-444444444444',
        title: 'DB-backed workspace plan',
        goal: 'Exercise workspace materialization',
        details: 'Materialize from DB into the current workspace.',
        status: 'pending',
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );

    const result = await setupWorkspace(
      {
        planId: 44,
      },
      baseDir,
      undefined,
      config,
      'tim generate'
    );

    expect(result.baseDir).toBe(baseDir);
    expect(result.planFile).toBe(path.join(baseDir, '.tim', 'plans', '44.plan.md'));
    expect(await fs.readFile(result.planFile, 'utf8')).toContain('DB-backed workspace plan');
  });

  test('materializes DB-backed plans into reused workspaces with existing branches', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-db-plan');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await Bun.$`git init`.cwd(baseDir).quiet();
    await Bun.$`git remote add origin https://example.com/test/repo.git`.cwd(baseDir).quiet();
    await Bun.$`git init`.cwd(existingWorkspacePath).quiet();
    await Bun.$`git remote add origin https://example.com/test/repo.git`
      .cwd(existingWorkspacePath)
      .quiet();
    await seedWorkspace(existingWorkspacePath, 'task-existing-db-plan');

    await writePlanFile(
      null,
      {
        id: 45,
        uuid: '55555555-5555-4555-8555-555555555555',
        title: 'DB-only reused workspace plan',
        goal: 'Ensure reused workspaces still materialize the plan',
        details:
          'The workspace should receive a materialized file even without a source task file.',
        status: 'pending',
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
      reusedExistingBranch: true,
    });
    const updateSpy = vi
      .spyOn(workspaceManager, 'runWorkspaceUpdateCommands')
      .mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-existing-db-plan',
        planId: 45,
      },
      baseDir,
      undefined,
      config,
      'tim generate'
    );

    expect(result.baseDir).toBe(existingWorkspacePath);
    expect(result.planFile).toBe(path.join(existingWorkspacePath, '.tim', 'plans', '45.plan.md'));
    expect(await fs.readFile(result.planFile, 'utf8')).toContain('DB-only reused workspace plan');
    expect(updateSpy).toHaveBeenCalledWith(
      existingWorkspacePath,
      config,
      'task-existing-db-plan',
      result.planFile
    );
  });

  test('re-materializes plan from DB even when workspace has edits on reused branches', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-db-plan-with-edits');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await Bun.$`git init`.cwd(baseDir).quiet();
    await Bun.$`git remote add origin https://example.com/test/repo.git`.cwd(baseDir).quiet();
    await Bun.$`git init`.cwd(existingWorkspacePath).quiet();
    await Bun.$`git remote add origin https://example.com/test/repo.git`
      .cwd(existingWorkspacePath)
      .quiet();
    await seedWorkspace(existingWorkspacePath, 'task-existing-db-plan-with-edits');

    await writePlanFile(
      null,
      {
        id: 46,
        uuid: '66666666-6666-4666-8666-666666666666',
        title: 'DB copy',
        goal: 'DB version should win',
        details: 'DB content is authoritative',
        status: 'pending',
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );

    const workspaceMaterializedPath = path.join(
      existingWorkspacePath,
      '.tim',
      'plans',
      '46.plan.md'
    );
    await writePlanFile(
      workspaceMaterializedPath,
      {
        id: 46,
        uuid: '66666666-6666-4666-8666-666666666666',
        title: 'Workspace edited copy',
        goal: 'Old workspace edits',
        details: 'Workspace version should be overwritten by DB',
        status: 'in_progress',
        tasks: [],
      },
      { cwdForIdentity: existingWorkspacePath, skipDb: true }
    );

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
      reusedExistingBranch: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-existing-db-plan-with-edits',
        planId: 46,
      },
      baseDir,
      undefined,
      config,
      'tim generate'
    );

    // DB version should overwrite workspace edits during setup
    expect(await fs.readFile(result.planFile, 'utf8')).toContain('DB copy');
    const resolved = await resolvePlanFromDb('46', baseDir);
    expect(resolved.plan.title).toBe('DB copy');
    expect(resolved.plan.details).toContain('DB content is authoritative');
    expect(resolved.plan.status).toBe('pending');
  });

  test('passes createBranch and base to auto-workspace selector', async () => {
    const selectWorkspaceSpy = vi
      .spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace')
      .mockResolvedValue(null);

    await expect(
      setupWorkspace(
        {
          autoWorkspace: true,
          createBranch: true,
          base: 'develop',
          requireWorkspace: true,
        },
        baseDir,
        planFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('Workspace creation was required but failed. Exiting.');

    expect(selectWorkspaceSpy).toHaveBeenCalledWith(
      expect.any(String),
      planFile,
      expect.objectContaining({
        createBranch: true,
        base: 'develop',
      })
    );
  });

  test('passes plan-derived branch context to the auto-workspace selector', async () => {
    const selectWorkspaceSpy = vi
      .spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace')
      .mockResolvedValue(null);
    const planWithBranchFile = path.join(baseDir, 'auto-plan-branch.plan.md');
    await fs.writeFile(
      planWithBranchFile,
      [
        '---',
        'id: 52',
        'title: Auto workspace branch settings',
        'branch: feature/auto-plan',
        'baseBranch: release/auto-base',
        'tasks: []',
        '---',
        '',
      ].join('\n')
    );

    await expect(
      setupWorkspace(
        {
          autoWorkspace: true,
          workspace: 'task-auto-plan-branch',
          createBranch: true,
          requireWorkspace: true,
        },
        baseDir,
        planWithBranchFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('Workspace creation was required but failed. Exiting.');

    expect(selectWorkspaceSpy).toHaveBeenCalledWith(
      'task-auto-plan-branch',
      planWithBranchFile,
      expect.objectContaining({
        createBranch: true,
        base: 'release/auto-base',
        branchName: 'feature/auto-plan',
        planData: expect.objectContaining({
          id: 52,
          branch: 'feature/auto-plan',
          baseBranch: 'release/auto-base',
        }),
      })
    );
  });

  test('falls back to current directory when auto-workspace selector returns null and requireWorkspace is false', async () => {
    const selectWorkspaceSpy = vi
      .spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace')
      .mockResolvedValue(null);

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
      createBranch: undefined,
      base: undefined,
      branchName: undefined,
      planData: undefined,
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
    vi.spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace').mockResolvedValue(null);

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

    vi.spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace').mockResolvedValue({
      workspace: {
        taskId: 'task-auto-existing',
        workspacePath: autoWorkspacePath,
        originalPlanFilePath: planFile,
        createdAt: new Date().toISOString(),
      },
      isNew: false,
      clearedStaleLock: false,
    });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

    const acquireLockSpy = vi.spyOn(WorkspaceLock, 'acquireLock');
    const setupCleanupHandlersSpy = vi.spyOn(WorkspaceLock, 'setupCleanupHandlers');

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

  test('auto-workspace creates branch directly in workspace', async () => {
    const autoWorkspacePath = path.join(tempDir, 'workspace-auto-existing-plan-branch');
    await fs.mkdir(autoWorkspacePath, { recursive: true });
    await seedWorkspace(autoWorkspacePath, 'task-auto-existing-plan-branch');

    const validPlanFile = path.join(baseDir, 'valid.plan.md');
    await fs.writeFile(
      validPlanFile,
      ['---', 'id: 42', 'title: Sync base before plan branch reuse', 'tasks: []', '---', ''].join(
        '\n'
      )
    );

    vi.spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace').mockResolvedValue({
      workspace: {
        taskId: 'task-auto-existing-plan-branch',
        workspacePath: autoWorkspacePath,
        originalPlanFilePath: validPlanFile,
        createdAt: new Date().toISOString(),
      },
      isNew: false,
      clearedStaleLock: false,
    });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });

    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
      actualBranchName: '42-sync-base-before-plan-branch-reuse',
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await setupWorkspace(
      {
        autoWorkspace: true,
        workspace: 'task-auto-existing-plan-branch',
      },
      baseDir,
      validPlanFile,
      config,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(prepareSpy).toHaveBeenCalledWith(autoWorkspacePath, {
      baseBranch: undefined,
      branchName: '42-sync-base-before-plan-branch-reuse',
      planFilePath: validPlanFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
    });
  });

  test('auto-workspace skips branch creation when createBranch is false', async () => {
    const autoWorkspacePath = path.join(tempDir, 'workspace-auto-existing-no-branch');
    await fs.mkdir(autoWorkspacePath, { recursive: true });
    await seedWorkspace(autoWorkspacePath, 'task-auto-existing-no-branch');

    vi.spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace').mockResolvedValue({
      workspace: {
        taskId: 'task-auto-existing-no-branch',
        workspacePath: autoWorkspacePath,
        originalPlanFilePath: planFile,
        createdAt: new Date().toISOString(),
      },
      isNew: false,
      clearedStaleLock: false,
    });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await setupWorkspace(
      {
        autoWorkspace: true,
        workspace: 'task-auto-existing-no-branch',
        createBranch: false,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenCalledWith(autoWorkspacePath, {
      baseBranch: undefined,
      branchName: 'task-auto-existing-no-branch',
      planFilePath: planFile,
      createBranch: false,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
    });
  });

  test('prepares existing workspace, copies plan, and runs workspace update commands in order', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-prep');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-prep');
    const copiedPlanFile = path.join(existingWorkspacePath, path.basename(planFile));

    const callOrder: string[] = [];
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi
      .spyOn(workspaceManager, 'prepareExistingWorkspace')
      .mockImplementation(async () => {
        expect(await WorkspaceLock.getLockInfo(existingWorkspacePath)).not.toBeNull();
        callOrder.push('prepare');
        return { success: true };
      });
    const updateSpy = vi
      .spyOn(workspaceManager, 'runWorkspaceUpdateCommands')
      .mockImplementation(async (_workspacePath, _config, _taskId, planFilePath) => {
        expect(planFilePath).toBe(copiedPlanFile);
        expect(await fs.readFile(copiedPlanFile, 'utf8')).toContain('Plan details');
        callOrder.push('update');
        return true;
      });

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
      planFilePath: planFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
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

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

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
      planFilePath: validPlanFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
    });
  });

  test('omits plan file path for update commands when plan copy into existing workspace fails', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-copy-fails');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-copy-fails');

    const missingPlanFile = path.join(baseDir, 'tasks', 'missing', 'task.plan.md');
    const updateSpy = vi
      .spyOn(workspaceManager, 'runWorkspaceUpdateCommands')
      .mockResolvedValue(true);
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

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
    vi.spyOn(git, 'getWorkingCopyStatus').mockImplementation(async (workspacePath) => {
      expect(workspacePath).toBe(existingWorkspacePath);
      expect(await WorkspaceLock.getLockInfo(existingWorkspacePath)).not.toBeNull();
      callOrder.push('dirty-check');
      return { hasChanges: false, checkFailed: false };
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockImplementation(async () => {
      callOrder.push('prepare');
      return { success: true };
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

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

  test('prepares newly created workspace the same as existing workspaces', async () => {
    const createdWorkspacePath = path.join(tempDir, 'workspace-new-no-prepare');
    await fs.mkdir(createdWorkspacePath, { recursive: true });

    const createWorkspaceSpy = vi.spyOn(workspaceManager, 'createWorkspace').mockResolvedValue({
      path: createdWorkspacePath,
      taskId: 'task-new-prepare',
      originalPlanFilePath: planFile,
      planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
    });
    const getWorkingCopyStatusSpy = vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    const updateSpy = vi
      .spyOn(workspaceManager, 'runWorkspaceUpdateCommands')
      .mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-new-prepare',
        newWorkspace: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalled();
    expect(getWorkingCopyStatusSpy).toHaveBeenCalled();
    expect(prepareSpy).toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalled();
    expect(result.baseDir).toBe(createdWorkspacePath);
    expect(result.isNewWorkspace).toBe(true);
  });

  test('marks newly created workspace branches as created during setup when createWorkspace made a local branch', async () => {
    const createdWorkspacePath = path.join(tempDir, 'workspace-new-branch-created');
    await fs.mkdir(createdWorkspacePath, { recursive: true });

    vi.spyOn(workspaceManager, 'createWorkspace').mockResolvedValue({
      path: createdWorkspacePath,
      taskId: 'task-new-branch-created',
      originalPlanFilePath: planFile,
      planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
      checkedOutRemoteBranch: false,
    });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-new-branch-created',
        newWorkspace: true,
        createBranch: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(result.branchCreatedDuringSetup).toBe(true);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  test('throws hard failure when existing workspace has uncommitted changes', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-dirty');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-dirty');

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: true,
      checkFailed: false,
      output: ' M file.ts',
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace');
    const updateSpy = vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands');

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

  test('does not fail on dirty existing workspace when using jj', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-dirty-jj');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-dirty-jj');

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: true,
      checkFailed: false,
      output: 'diff output',
    });
    vi.spyOn(git, 'getUsingJj').mockResolvedValue(true);
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    const updateSpy = vi
      .spyOn(workspaceManager, 'runWorkspaceUpdateCommands')
      .mockResolvedValue(true);

    await expect(
      setupWorkspace(
        {
          workspace: 'task-existing-dirty-jj',
        },
        baseDir,
        planFile,
        config,
        'tim generate'
      )
    ).resolves.toMatchObject({
      baseDir: existingWorkspacePath,
      workspaceTaskId: 'task-existing-dirty-jj',
    });

    expect(prepareSpy).toHaveBeenCalled();
    expect(updateSpy).toHaveBeenCalled();
  });

  test('aborts setup when workspace update command fails with allowFailure false', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-update-fail-hard');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-update-fail-hard');

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

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

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

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

  test('does not update plan branch metadata to the allocated workspace branch', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-branch-metadata');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-branch-metadata');

    const validPlanFile = path.join(baseDir, 'branch-metadata.plan.md');
    await fs.writeFile(
      validPlanFile,
      ['---', 'id: 88', 'title: Keep branch metadata in sync', 'tasks: []', '---', ''].join('\n')
    );

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
      actualBranchName: '88-keep-branch-metadata-in-sync-2',
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await setupWorkspace(
      {
        workspace: 'task-existing-branch-metadata',
      },
      baseDir,
      validPlanFile,
      config,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenCalledWith(existingWorkspacePath, {
      baseBranch: undefined,
      branchName: '88-keep-branch-metadata-in-sync',
      planFilePath: validPlanFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
    });
    expect(await fs.readFile(validPlanFile, 'utf8')).not.toContain('branch:');
  });

  test('uses parent plan branch as base when available on the parent plan', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-parent-base');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-parent-base');

    const parentPlanFile = path.join(baseDir, 'parent.plan.md');
    const childPlanFile = path.join(baseDir, 'child.plan.md');
    await writePlanFile(
      parentPlanFile,
      {
        id: 20,
        title: 'Parent plan',
        goal: 'Provide base branch metadata',
        branch: 'feature/parent-plan',
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );
    await writePlanFile(
      childPlanFile,
      {
        id: 21,
        title: 'Child plan',
        goal: 'Inherit parent base branch',
        parent: 20,
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });

    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await setupWorkspace(
      {
        workspace: 'task-existing-parent-base',
      },
      baseDir,
      childPlanFile,
      config,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenCalledWith(existingWorkspacePath, {
      baseBranch: 'feature/parent-plan',
      branchName: '21-child-plan',
      planFilePath: childPlanFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
    });
  });

  test('resolves parent plan branch from the tasks root when parent is in a sibling folder', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-parent-sibling');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-parent-sibling');

    const childDir = path.join(baseDir, 'tasks', 'a');
    const parentDir = path.join(baseDir, 'tasks', 'b');
    await fs.mkdir(childDir, { recursive: true });
    await fs.mkdir(parentDir, { recursive: true });

    const parentPlanFile = path.join(parentDir, '20-parent.plan.md');
    const childPlanFile = path.join(childDir, '21-child.plan.md');
    await writePlanFile(
      parentPlanFile,
      {
        id: 20,
        title: 'Parent plan',
        goal: 'Provide base branch metadata',
        branch: 'feature/parent-plan',
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );
    await writePlanFile(
      childPlanFile,
      {
        id: 21,
        title: 'Child plan',
        goal: 'Inherit parent base branch',
        parent: 20,
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );

    const configWithTasksDir: TimConfig = {
      ...config,
      paths: {
        tasks: 'tasks',
      },
    };

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await setupWorkspace(
      {
        workspace: 'task-existing-parent-sibling',
      },
      baseDir,
      childPlanFile,
      configWithTasksDir,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenCalledWith(existingWorkspacePath, {
      baseBranch: 'feature/parent-plan',
      branchName: '21-child-plan',
      planFilePath: childPlanFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
    });
  });

  test('propagates parent plan DB lookup failures instead of falling back to file scans', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-parent-db-error');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-parent-db-error');

    const childPlanFile = path.join(baseDir, '21-child.plan.md');
    await writePlanFile(
      childPlanFile,
      {
        id: 21,
        title: 'Child plan',
        goal: 'Attempt to inherit a missing parent branch',
        parent: 20,
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await expect(
      setupWorkspace(
        {
          workspace: 'task-existing-parent-db-error',
        },
        baseDir,
        childPlanFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('No plan found in the database for identifier: 20');

    expect(prepareSpy).not.toHaveBeenCalled();
  });

  test('falls back from an inferred parent base when that base branch cannot be prepared', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-parent-fallback');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-parent-fallback');

    const parentPlanFile = path.join(baseDir, '20-parent.plan.md');
    const childPlanFile = path.join(baseDir, '21-child.plan.md');
    await writePlanFile(
      parentPlanFile,
      {
        id: 20,
        title: 'Parent plan',
        goal: 'Provide a missing base branch',
        branch: 'feature/missing-parent',
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );
    await writePlanFile(
      childPlanFile,
      {
        id: 21,
        title: 'Child plan',
        goal: 'Inherit a missing base branch',
        parent: 20,
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi
      .spyOn(workspaceManager, 'prepareExistingWorkspace')
      .mockResolvedValueOnce({
        success: false,
        error: 'Failed to checkout base branch "feature/missing-parent"',
      })
      .mockResolvedValueOnce({
        success: true,
      });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-existing-parent-fallback',
      },
      baseDir,
      childPlanFile,
      config,
      'tim generate'
    );

    expect(prepareSpy).toHaveBeenNthCalledWith(1, existingWorkspacePath, {
      baseBranch: 'feature/missing-parent',
      branchName: '21-child-plan',
      planFilePath: childPlanFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
    });
    expect(prepareSpy).toHaveBeenNthCalledWith(2, existingWorkspacePath, {
      branchName: '21-child-plan',
      planFilePath: childPlanFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
    });
  });

  test('does not fall back when the plan explicitly sets baseBranch and preparation fails', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-plan-base-explicit');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-plan-base-explicit');

    const explicitBasePlanFile = path.join(baseDir, 'explicit-base.plan.md');
    await fs.writeFile(
      explicitBasePlanFile,
      [
        '---',
        'id: 22',
        'title: Explicit base plan',
        'baseBranch: feature/deleted-base',
        'tasks: []',
        '---',
        '',
      ].join('\n')
    );

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: false,
      error: 'Failed to checkout base branch "feature/deleted-base"',
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    await expect(
      setupWorkspace(
        {
          workspace: 'task-existing-plan-base-explicit',
        },
        baseDir,
        explicitBasePlanFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('feature/deleted-base');

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    expect(prepareSpy).toHaveBeenCalledWith(existingWorkspacePath, {
      baseBranch: 'feature/deleted-base',
      branchName: '22-explicit-base-plan',
      planFilePath: explicitBasePlanFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
    });
  });

  test('passes --base through as baseBranch for existing workspace preparation', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-base-explicit');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-base-explicit');

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

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
      planFilePath: planFile,
      createBranch: true,
      reuseExistingBranch: false,
      primaryWorkspacePath: baseDir,
    });
  });

  test('defaults baseBranch to undefined when --base is not provided', async () => {
    const existingWorkspacePath = path.join(tempDir, 'workspace-existing-base-default');
    await fs.mkdir(existingWorkspacePath, { recursive: true });
    await seedWorkspace(existingWorkspacePath, 'task-existing-base-default');

    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

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
      planFilePath: planFile,
      createBranch: true,
      reuseExistingBranch: true,
      primaryWorkspacePath: baseDir,
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
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

    const acquireLockSpy = vi.spyOn(WorkspaceLock, 'acquireLock');

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

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue({
        path: createdWorkspacePath,
        taskId: 'task-new',
        originalPlanFilePath: planFile,
        planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const acquireLockSpy = vi.spyOn(WorkspaceLock, 'acquireLock');
    const releaseLockSpy = vi.spyOn(WorkspaceLock, 'releaseLock');
    const setupCleanupHandlersSpy = vi.spyOn(WorkspaceLock, 'setupCleanupHandlers');

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

    expect(createWorkspaceSpy).toHaveBeenCalledWith(baseDir, 'task-new', planFile, config, {});
    expect(result.baseDir).toBe(createdWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-new');
    expect(result.isNewWorkspace).toBe(true);

    expect(releaseLockSpy).toHaveBeenCalledWith(createdWorkspacePath, { force: true });
    expect(acquireLockSpy).toHaveBeenCalledWith(
      createdWorkspacePath,
      'tim generate --workspace task-new',
      { type: 'pid' }
    );
    expect(setupCleanupHandlersSpy).toHaveBeenCalledWith(createdWorkspacePath, 'pid');
    expect((await WorkspaceLock.getLockInfo(createdWorkspacePath))?.type).toBe('pid');
  });

  test('passes createBranch and base when creating a new manual workspace', async () => {
    const createdWorkspacePath = path.join(tempDir, 'workspace-new-forwarded-options');
    await fs.mkdir(createdWorkspacePath, { recursive: true });

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue({
        path: createdWorkspacePath,
        taskId: 'task-options',
        originalPlanFilePath: planFile,
        planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-options',
        newWorkspace: true,
        createBranch: true,
        base: 'develop',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalledWith(baseDir, 'task-options', planFile, config, {
      createBranch: true,
      fromBranch: 'develop',
    });
  });

  test('passes plan-defined branch and base to new workspaces before creation', async () => {
    const createdWorkspacePath = path.join(tempDir, 'workspace-new-plan-branch');
    await fs.mkdir(createdWorkspacePath, { recursive: true });

    const planWithBranchFile = path.join(baseDir, 'task-plan-branch.plan.md');
    await fs.writeFile(
      planWithBranchFile,
      [
        '---',
        'id: 24',
        'title: Use explicit branch settings',
        'branch: feature/plan-branch',
        'baseBranch: release/base',
        'tasks: []',
        '---',
        '',
      ].join('\n')
    );

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue({
        path: createdWorkspacePath,
        taskId: 'task-plan-branch',
        originalPlanFilePath: planWithBranchFile,
        planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planWithBranchFile)),
        checkedOutRemoteBranch: false,
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-plan-branch',
        newWorkspace: true,
        createBranch: true,
      },
      baseDir,
      planWithBranchFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      baseDir,
      'task-plan-branch',
      planWithBranchFile,
      config,
      {
        createBranch: true,
        branchName: 'feature/plan-branch',
        fromBranch: 'release/base',
        planData: expect.objectContaining({
          id: 24,
          branch: 'feature/plan-branch',
          baseBranch: 'release/base',
        }),
      }
    );
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  test('passes parent-derived base branch to new workspaces before creation', async () => {
    const createdWorkspacePath = path.join(tempDir, 'workspace-new-parent-base');
    await fs.mkdir(createdWorkspacePath, { recursive: true });

    const parentPlanFile = path.join(baseDir, 'parent.plan.md');
    const childPlanFile = path.join(baseDir, 'child.plan.md');
    await writePlanFile(
      parentPlanFile,
      {
        id: 30,
        title: 'Parent branch holder',
        branch: 'feature/parent-base',
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );
    await writePlanFile(
      childPlanFile,
      {
        id: 31,
        title: 'Child branch holder',
        parent: 30,
        tasks: [],
      },
      { cwdForIdentity: baseDir }
    );

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue({
        path: createdWorkspacePath,
        taskId: 'task-parent-base',
        originalPlanFilePath: childPlanFile,
        planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(childPlanFile)),
        checkedOutRemoteBranch: true,
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-parent-base',
        newWorkspace: true,
        createBranch: true,
      },
      baseDir,
      childPlanFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      baseDir,
      'task-parent-base',
      childPlanFile,
      config,
      {
        createBranch: true,
        branchName: '31-child-branch-holder',
        fromBranch: 'feature/parent-base',
        planData: expect.objectContaining({
          id: 31,
          parent: 30,
        }),
      }
    );
  });

  test('marks branchCreatedDuringSetup false when a new workspace checks out an existing remote branch', async () => {
    const createdWorkspacePath = path.join(tempDir, 'workspace-new-remote-branch');
    await fs.mkdir(createdWorkspacePath, { recursive: true });

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue({
        path: createdWorkspacePath,
        taskId: 'task-new-remote-branch',
        originalPlanFilePath: planFile,
        planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
        checkedOutRemoteBranch: true,
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-new-remote-branch',
        newWorkspace: true,
        createBranch: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalled();
    expect(result.branchCreatedDuringSetup).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  test('marks branchCreatedDuringSetup false for auto-created workspaces that reuse a remote branch', async () => {
    const autoWorkspacePath = path.join(tempDir, 'workspace-auto-remote-branch');
    await fs.mkdir(autoWorkspacePath, { recursive: true });

    vi.spyOn(WorkspaceAutoSelector.prototype, 'selectWorkspace').mockResolvedValue({
      workspace: {
        taskId: 'task-auto-remote-branch',
        workspacePath: autoWorkspacePath,
        originalPlanFilePath: planFile,
        createdAt: new Date().toISOString(),
        workspaceType: 'auto',
        checkedOutRemoteBranch: true,
      },
      isNew: true,
      clearedStaleLock: false,
    });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
      success: true,
    });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        autoWorkspace: true,
        workspace: 'task-auto-remote-branch',
        createBranch: true,
        nonInteractive: true,
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(result.branchCreatedDuringSetup).toBe(false);
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  test('falls back to current directory when workspace creation fails and requireWorkspace is false', async () => {
    vi.spyOn(await import('./workspace_manager.js'), 'createWorkspace').mockResolvedValue(null);

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

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue({
        path: createdWorkspacePath,
        taskId: 'task-all-locked-new',
        originalPlanFilePath: planFile,
        planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

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
      config,
      {}
    );
    expect(result.baseDir).toBe(createdWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-all-locked-new');
    expect(result.isNewWorkspace).toBe(true);
    expect((await WorkspaceLock.getLockInfo(createdWorkspacePath))?.type).toBe('pid');

    await WorkspaceLock.releaseLock(lockedWorkspacePath1, { force: true });
    await WorkspaceLock.releaseLock(lockedWorkspacePath2, { force: true });
  });

  test('throws when workspace creation fails and requireWorkspace is true', async () => {
    vi.spyOn(await import('./workspace_manager.js'), 'createWorkspace').mockResolvedValue(null);

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

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue({
        path: createdWorkspacePath,
        taskId: 'task-missing',
        originalPlanFilePath: planFile,
        planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

    const result = await setupWorkspace(
      {
        workspace: 'task-missing',
      },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(createWorkspaceSpy).toHaveBeenCalledWith(baseDir, 'task-missing', planFile, config, {});
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

    const createWorkspaceSpy = vi
      .spyOn(await import('./workspace_manager.js'), 'createWorkspace')
      .mockResolvedValue({
        path: createdWorkspacePath,
        taskId: 'task-force-new',
        originalPlanFilePath: planFile,
        planFilePathInWorkspace: path.join(createdWorkspacePath, path.basename(planFile)),
      });
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });
    vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);

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

    expect(createWorkspaceSpy).toHaveBeenCalledWith(
      baseDir,
      'task-force-new',
      planFile,
      config,
      {}
    );
    expect(result.baseDir).toBe(createdWorkspacePath);
    expect(result.workspaceTaskId).toBe('task-force-new');
    expect(result.isNewWorkspace).toBe(true);
    expect(result.baseDir).not.toBe(existingWorkspacePath);
  });

  test('clears stale lock before reusing manual workspace', async () => {
    const staleWorkspacePath = path.join(tempDir, 'workspace-manual-stale');
    await fs.mkdir(staleWorkspacePath, { recursive: true });
    await seedWorkspace(staleWorkspacePath, 'task-manual-stale');

    const getLockInfoSpy = vi.spyOn(WorkspaceLock, 'getLockInfo').mockResolvedValue({
      type: 'pid',
      pid: 999999,
      command: 'stale-command',
      startedAt: new Date().toISOString(),
      hostname: 'test-host',
      version: 2,
    });
    const isLockStaleSpy = vi.spyOn(WorkspaceLock, 'isLockStale').mockResolvedValue(true);
    const clearStaleLockSpy = vi
      .spyOn(WorkspaceLock, 'clearStaleLock')
      .mockResolvedValue(undefined);
    const acquireLockSpy = vi.spyOn(WorkspaceLock, 'acquireLock');
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

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
    vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
      hasChanges: false,
      checkFailed: false,
    });
    vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({ success: true });

    const acquireLockSpy = vi
      .spyOn(WorkspaceLock, 'acquireLock')
      .mockRejectedValue(new Error('failed to acquire workspace lock'));

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
    const acquireLockSpy = vi
      .spyOn(WorkspaceLock, 'acquireLock')
      .mockRejectedValue(new Error('failed to acquire cwd lock'));

    await expect(setupWorkspace({}, baseDir, planFile, config, 'tim generate')).rejects.toThrow(
      'failed to acquire cwd lock'
    );

    expect(acquireLockSpy).toHaveBeenCalledWith(baseDir, 'tim generate', { type: 'pid' });
  });

  test('allows generate to continue in primary workspace when already locked and override is enabled', async () => {
    const acquireLockSpy = vi
      .spyOn(WorkspaceLock, 'acquireLock')
      .mockRejectedValue(new WorkspaceAlreadyLocked(baseDir, 'pid'));

    const result = await setupWorkspace(
      { allowPrimaryWorkspaceWhenLocked: true },
      baseDir,
      planFile,
      config,
      'tim generate'
    );

    expect(result.baseDir).toBe(baseDir);
    expect(result.planFile).toBe(planFile);
    expect(acquireLockSpy).toHaveBeenCalledWith(baseDir, 'tim generate', { type: 'pid' });
  });

  test('still throws for non-lock errors when primary workspace override is enabled', async () => {
    vi.spyOn(WorkspaceLock, 'acquireLock').mockRejectedValue(
      new Error('failed to acquire cwd lock')
    );

    await expect(
      setupWorkspace(
        { allowPrimaryWorkspaceWhenLocked: true },
        baseDir,
        planFile,
        config,
        'tim generate'
      )
    ).rejects.toThrow('failed to acquire cwd lock');
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

  describe('base commit tracking in setupWorkspace', () => {
    // These tests exercise the updateBaseCommitTracking logic through setupWorkspace.
    // They use a plan file with a UUID and baseBranch to trigger the tracking code path.

    beforeEach(() => {
      // Mock getTrunkBranch to avoid needing a real git repo with commits
      vi.spyOn(git, 'getTrunkBranch').mockResolvedValue('main');
      // Reset the setPlanBaseTracking mock before each test
      vi.mocked(setPlanBaseTracking).mockClear();
    });

    test('skips base tracking when baseBranch equals the trunk branch', async () => {
      const planWithTrunkBase = path.join(baseDir, 'trunk-base.plan.md');
      await fs.writeFile(
        planWithTrunkBase,
        [
          '---',
          'id: 200',
          'uuid: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          'title: Plan with trunk as baseBranch',
          'branch: feature/my-branch',
          'baseBranch: main',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      const fetchRemoteBranchSpy = vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);

      await setupWorkspace({}, baseDir, planWithTrunkBase, config, 'tim generate');

      // When baseBranch === trunk, tracking is skipped entirely
      expect(fetchRemoteBranchSpy).not.toHaveBeenCalled();
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('checkout-only checkoutBranch does not override tracking baseBranch from plan', async () => {
      const planWithTrackedBase = path.join(baseDir, 'checkout-only-base.plan.md');
      await fs.writeFile(
        planWithTrackedBase,
        [
          '---',
          'id: 201',
          'uuid: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'title: Plan with checkout-only branch override',
          'branch: feature/self-branch',
          'baseBranch: feature/parent-branch',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      const fakeCommitHash = '1111111111111111111111111111111111111111';
      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(true);
      const mergeBaseSpy = vi.spyOn(git, 'getMergeBase').mockResolvedValue(fakeCommitHash);
      vi.spyOn(git, 'getUsingJj').mockResolvedValue(false);

      await setupWorkspace(
        { checkoutBranch: 'feature/self-branch' },
        baseDir,
        planWithTrackedBase,
        config,
        'tim generate'
      );

      expect(mergeBaseSpy).toHaveBeenCalledWith(
        baseDir,
        'feature/parent-branch',
        'feature/self-branch'
      );
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        expect.objectContaining({ baseCommit: fakeCommitHash })
      );

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('tracking failure does not block the command (warning only)', async () => {
      const planWithBase = path.join(baseDir, 'tracking-failure.plan.md');
      await fs.writeFile(
        planWithBase,
        [
          '---',
          'id: 202',
          'uuid: cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          'title: Plan where tracking will fail',
          'branch: feature/child-branch',
          'baseBranch: feature/parent-branch',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      // Simulate a network failure during fetchRemoteBranch
      vi.spyOn(git, 'fetchRemoteBranch').mockRejectedValue(
        new Error('Network error: could not reach remote')
      );

      // setupWorkspace should succeed despite the tracking failure
      const result = await setupWorkspace({}, baseDir, planWithBase, config, 'tim generate');

      expect(result.baseDir).toBe(baseDir);
      // setPlanBaseTracking should NOT have been called because fetch failed
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('successful tracking: calls setPlanBaseTracking with baseCommit when base branch exists', async () => {
      const planWithBase = path.join(baseDir, 'happy-path-tracking.plan.md');
      await fs.writeFile(
        planWithBase,
        [
          '---',
          'id: 203',
          'uuid: dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          'title: Plan with non-trunk baseBranch',
          'branch: feature/child-branch',
          'baseBranch: feature/parent-branch',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      const fakeCommitHash = 'abc123def456abc123def456abc123def456abc1';
      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(true);
      vi.spyOn(git, 'getMergeBase').mockResolvedValue(fakeCommitHash);
      vi.spyOn(git, 'getUsingJj').mockResolvedValue(false);

      const result = await setupWorkspace({}, baseDir, planWithBase, config, 'tim generate');

      expect(result.baseDir).toBe(baseDir);
      // setPlanBaseTracking should have been called with the computed merge-base commit
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        expect.objectContaining({ baseCommit: fakeCommitHash })
      );
      // baseBranch was sourced from plan field (not parent), so baseBranch should NOT be in the update
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ baseBranch: expect.any(String) })
      );

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('deleted remote base branch: setPlanBaseTracking is NOT called when remoteBranchExists returns false', async () => {
      const planWithBase = path.join(baseDir, 'deleted-remote.plan.md');
      await fs.writeFile(
        planWithBase,
        [
          '---',
          'id: 204',
          'uuid: eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          'title: Plan with deleted remote base',
          'branch: feature/child-branch',
          'baseBranch: feature/parent-branch',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(false);

      const result = await setupWorkspace({}, baseDir, planWithBase, config, 'tim generate');

      expect(result.baseDir).toBe(baseDir);
      // Base branch doesn't exist on remote → no tracking update
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('null merge-base does not call setPlanBaseTracking with baseCommit for plan-sourced baseBranch', async () => {
      const planWithBase = path.join(baseDir, 'null-merge-base.plan.md');
      await fs.writeFile(
        planWithBase,
        [
          '---',
          'id: 205',
          'uuid: ffffffff-ffff-4fff-8fff-ffffffffffff',
          'title: Plan where getMergeBase returns null',
          'branch: feature/child-branch',
          'baseBranch: feature/parent-branch',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(true);
      // getMergeBase returns null (transient failure)
      vi.spyOn(git, 'getMergeBase').mockResolvedValue(null);

      const result = await setupWorkspace({}, baseDir, planWithBase, config, 'tim generate');

      expect(result.baseDir).toBe(baseDir);
      // For plan-sourced baseBranch with null merge-base, no tracking call should be made
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('parent-derived baseBranch: setPlanBaseTracking called with baseBranch and baseCommit when remote exists', async () => {
      // Initialize a git repo so resolvePlanFromDb can locate the project
      await Bun.$`git init`.cwd(baseDir).quiet();
      await Bun.$`git remote add origin https://example.com/test/repo.git`.cwd(baseDir).quiet();

      // Create parent plan in DB with a branch
      await writePlanFile(
        null,
        {
          id: 206,
          uuid: '20620620-2062-4062-8062-206206206206',
          title: 'Parent plan with branch',
          branch: 'feature/parent-branch',
          status: 'pending',
          tasks: [],
        },
        { cwdForIdentity: baseDir }
      );

      // Child plan file that has parent set but no baseBranch
      const childPlanFile = path.join(baseDir, 'child-plan.plan.md');
      await fs.writeFile(
        childPlanFile,
        [
          '---',
          'id: 207',
          'uuid: 20720720-2072-4072-8072-207207207207',
          'title: Child plan with parent-derived baseBranch',
          'branch: feature/child-branch',
          'parent: 206',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      const fakeCommitHash = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(true);
      vi.spyOn(git, 'getMergeBase').mockResolvedValue(fakeCommitHash);
      vi.spyOn(git, 'getUsingJj').mockResolvedValue(false);

      const result = await setupWorkspace({}, baseDir, childPlanFile, config, 'tim generate');

      expect(result.baseDir).toBe(baseDir);
      // For parent-derived baseBranch, both baseBranch and baseCommit should be persisted
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        '20720720-2072-4072-8072-207207207207',
        expect.objectContaining({
          baseBranch: 'feature/parent-branch',
          baseCommit: fakeCommitHash,
        })
      );

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('parent-derived baseBranch with null merge-base: persists baseBranch only', async () => {
      // Initialize a git repo so resolvePlanFromDb can locate the project
      await Bun.$`git init`.cwd(baseDir).quiet();
      await Bun.$`git remote add origin https://example.com/test/repo.git`.cwd(baseDir).quiet();

      // Create parent plan in DB with a branch
      await writePlanFile(
        null,
        {
          id: 208,
          uuid: '20820820-2082-4082-8082-208208208208',
          title: 'Parent plan for null merge-base test',
          branch: 'feature/parent-branch-2',
          status: 'pending',
          tasks: [],
        },
        { cwdForIdentity: baseDir }
      );

      // Child plan file with parent set but no baseBranch
      const childPlanFile = path.join(baseDir, 'child-plan-null-merge.plan.md');
      await fs.writeFile(
        childPlanFile,
        [
          '---',
          'id: 209',
          'uuid: 20920920-2092-4092-8092-209209209209',
          'title: Child plan with null merge-base',
          'branch: feature/child-branch-2',
          'parent: 208',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(true);
      // getMergeBase returns null
      vi.spyOn(git, 'getMergeBase').mockResolvedValue(null);

      const result = await setupWorkspace({}, baseDir, childPlanFile, config, 'tim generate');

      expect(result.baseDir).toBe(baseDir);
      // For parent-derived baseBranch with null merge-base, only baseBranch should be persisted
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        '20920920-2092-4092-8092-209209209209',
        expect.objectContaining({ baseBranch: 'feature/parent-branch-2' })
      );
      // baseCommit should NOT be in the call (null merge-base means we can't compute it)
      const calls = vi.mocked(setPlanBaseTracking).mock.calls;
      const update = calls[0]?.[2] as Record<string, unknown>;
      expect(update).not.toHaveProperty('baseCommit');

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('parent-derived baseBranch uses generated branch name when parent has no explicit branch', async () => {
      // This tests the Task 11 fix: getParentPlanBranch() should return
      // parentPlan.plan.branch ?? generateBranchNameFromPlan(parentPlan.plan)
      // when the parent plan has no explicit branch field set.
      await Bun.$`git init`.cwd(baseDir).quiet();
      await Bun.$`git remote add origin https://example.com/test/repo.git`.cwd(baseDir).quiet();

      // Create parent plan in DB WITHOUT an explicit branch — only id and title
      // generateBranchNameFromPlan({ id: 214, title: 'Parent without explicit branch' })
      // => slugify('Parent without explicit branch') = 'parent-without-explicit-branch'
      // => '214-parent-without-explicit-branch'
      await writePlanFile(
        null,
        {
          id: 214,
          uuid: '21421421-2142-4142-8142-214214214214',
          title: 'Parent without explicit branch',
          status: 'pending',
          tasks: [],
          // NOTE: no 'branch' field — forces fallback to generateBranchNameFromPlan
        },
        { cwdForIdentity: baseDir }
      );

      // Child plan that references the parent but has no baseBranch itself
      const childPlanFile = path.join(baseDir, 'child-no-parent-branch.plan.md');
      await fs.writeFile(
        childPlanFile,
        [
          '---',
          'id: 215',
          'uuid: 21521521-2152-4152-8152-215215215215',
          'title: Child plan referencing branchless parent',
          'branch: feature/child-branchless-parent',
          'parent: 214',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      const fakeCommitHash = 'aabbccddaabbccddaabbccddaabbccddaabbccdd';
      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(true);
      vi.spyOn(git, 'getMergeBase').mockResolvedValue(fakeCommitHash);
      vi.spyOn(git, 'getUsingJj').mockResolvedValue(false);

      const result = await setupWorkspace({}, baseDir, childPlanFile, config, 'tim generate');

      expect(result.baseDir).toBe(baseDir);
      // The base branch should be the GENERATED name from the parent plan, not undefined
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        '21521521-2152-4152-8152-215215215215',
        expect.objectContaining({
          baseBranch: '214-parent-without-explicit-branch',
          baseCommit: fakeCommitHash,
        })
      );

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('checkoutBranch alone (no plan baseBranch, no options.base) does not trigger tracking', async () => {
      // This verifies that checkoutBranch is checkout-only and never becomes the stacking base.
      const planNoBase = path.join(baseDir, 'checkout-only-no-base.plan.md');
      await fs.writeFile(
        planNoBase,
        [
          '---',
          'id: 211',
          'uuid: 21121121-2112-4112-8112-211211211211',
          'title: Plan without any baseBranch',
          'branch: feature/self-branch',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      const fetchRemoteBranchSpy = vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);

      await setupWorkspace(
        { checkoutBranch: 'feature/self-branch' },
        baseDir,
        planNoBase,
        config,
        'tim generate'
      );

      // checkoutBranch must not become the stacking base — tracking should be skipped entirely
      expect(fetchRemoteBranchSpy).not.toHaveBeenCalled();
      expect(vi.mocked(setPlanBaseTracking)).not.toHaveBeenCalled();

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('JJ repos include baseChangeId in tracking update', async () => {
      const planWithBase = path.join(baseDir, 'jj-tracking.plan.md');
      await fs.writeFile(
        planWithBase,
        [
          '---',
          'id: 212',
          'uuid: 21221221-2122-4122-8122-212212212212',
          'title: Plan for JJ tracking',
          'branch: feature/child-jj',
          'baseBranch: feature/parent-jj',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      const fakeCommitHash = 'cafebabecafebabecafebabecafebabecafebabe';
      const fakeChangeId = 'kwrqmzxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(true);
      vi.spyOn(git, 'getMergeBase').mockResolvedValue(fakeCommitHash);
      vi.spyOn(git, 'getUsingJj').mockResolvedValue(true);
      const getJjChangeIdSpy = vi.spyOn(git, 'getJjChangeId').mockResolvedValue(fakeChangeId);

      const result = await setupWorkspace({}, baseDir, planWithBase, config, 'tim generate');

      expect(result.baseDir).toBe(baseDir);
      // JJ path should call getJjChangeId with the computed merge-base commit
      expect(getJjChangeIdSpy).toHaveBeenCalledWith(baseDir, fakeCommitHash);
      // Tracking update should include both baseCommit and baseChangeId
      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        '21221221-2122-4122-8122-212212212212',
        expect.objectContaining({
          baseCommit: fakeCommitHash,
          baseChangeId: fakeChangeId,
        })
      );

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('options.base as stacking source saves both baseCommit and baseBranch in update', async () => {
      // When options.base is used (baseBranchSource === 'option'), the explicit stacking
      // base should be persisted to the plan so later commands know which branch the
      // tracking data belongs to.
      const planNoBaseBranch = path.join(baseDir, 'option-base-tracking.plan.md');
      await fs.writeFile(
        planNoBaseBranch,
        [
          '---',
          'id: 213',
          'uuid: 21321321-2132-4132-8132-213213213213',
          'title: Plan without baseBranch in file',
          'branch: feature/child-option',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      const fakeCommitHash = 'beefbeefbeefbeefbeefbeefbeefbeefbeefbeef';
      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(true);
      vi.spyOn(git, 'getMergeBase').mockResolvedValue(fakeCommitHash);
      vi.spyOn(git, 'getUsingJj').mockResolvedValue(false);

      await setupWorkspace(
        { base: 'feature/option-base' },
        baseDir,
        planNoBaseBranch,
        config,
        'tim generate'
      );

      expect(vi.mocked(setPlanBaseTracking)).toHaveBeenCalledWith(
        expect.anything(),
        '21321321-2132-4132-8132-213213213213',
        expect.objectContaining({
          baseCommit: fakeCommitHash,
          baseBranch: 'feature/option-base',
        })
      );

      await WorkspaceLock.releaseLock(baseDir, { force: true });
    });

    test('workspace checkout uses checkoutBranch while tracking still uses plan baseBranch', async () => {
      const existingWorkspacePath = path.join(tempDir, 'workspace-existing-checkout-vs-tracking');
      await fs.mkdir(existingWorkspacePath, { recursive: true });
      await seedWorkspace(existingWorkspacePath, 'task-existing-checkout-vs-tracking');

      const planWithTrackedBase = path.join(baseDir, 'checkout-vs-tracking.plan.md');
      await fs.writeFile(
        planWithTrackedBase,
        [
          '---',
          'id: 210',
          'uuid: 21021021-0210-4210-8210-210210210210',
          'title: Checkout branch separate from stacking base',
          'branch: feature/child-branch',
          'baseBranch: feature/stack-base',
          'tasks: []',
          '---',
          '',
        ].join('\n')
      );

      const prepareSpy = vi.spyOn(workspaceManager, 'prepareExistingWorkspace').mockResolvedValue({
        success: true,
      });
      vi.spyOn(git, 'getWorkingCopyStatus').mockResolvedValue({
        hasChanges: false,
        checkFailed: false,
      });
      vi.spyOn(workspaceManager, 'runWorkspaceUpdateCommands').mockResolvedValue(true);
      vi.spyOn(git, 'fetchRemoteBranch').mockResolvedValue(true);
      vi.spyOn(git, 'remoteBranchExists').mockResolvedValue(true);
      const mergeBaseSpy = vi
        .spyOn(git, 'getMergeBase')
        .mockResolvedValue('2222222222222222222222222222222222222222');
      vi.spyOn(git, 'getUsingJj').mockResolvedValue(false);

      await setupWorkspace(
        {
          workspace: 'task-existing-checkout-vs-tracking',
          checkoutBranch: 'feature/checkout-only',
        },
        baseDir,
        planWithTrackedBase,
        config,
        'tim generate'
      );

      expect(prepareSpy).toHaveBeenCalledWith(existingWorkspacePath, {
        baseBranch: 'feature/checkout-only',
        branchName: 'feature/child-branch',
        planFilePath: planWithTrackedBase,
        createBranch: true,
        reuseExistingBranch: false,
        primaryWorkspacePath: baseDir,
      });
      expect(mergeBaseSpy).toHaveBeenCalledWith(
        existingWorkspacePath,
        'feature/stack-base',
        'feature/child-branch'
      );
    });
  });
});
