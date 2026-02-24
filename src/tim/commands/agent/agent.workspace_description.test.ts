import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../../../testing.js';
import { clearPlanCache } from '../../plans.js';
import { closeDatabaseForTesting, getDatabase } from '../../db/database.js';
import { getOrCreateProject } from '../../db/project.js';
import {
  deleteWorkspace,
  getWorkspaceByPath,
  getWorkspaceIssues,
  patchWorkspace,
  recordWorkspace,
  setWorkspaceIssues,
} from '../../db/workspace.js';

describe('Agent workspace description auto-update', () => {
  let moduleMocker: ModuleMocker;
  let tempDir: string;
  let tasksDir: string;
  let planFile: string;
  let workspaceDir: string;
  let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };

  const logSpy = mock(() => {});
  const warnSpy = mock(() => {});
  const errorSpy = mock(() => {});

  // Create a test executor that completes all tasks in one shot
  class TestExecutor {
    async execute(prompt: string, options: any) {
      // Read and modify the plan file to mark all tasks done
      const { readPlanFile, writePlanFile } = await import('../../plans.js');
      const plan = await readPlanFile(options.planFilePath);
      plan.tasks.forEach((task) => {
        task.done = true;
      });
      await writePlanFile(options.planFilePath, plan);
    }
  }

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    clearPlanCache();

    // Create temp directories
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-ws-desc-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    workspaceDir = path.join(tempDir, 'workspace');
    planFile = path.join(tasksDir, '123-test-plan.yml');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();

    // Create a plan file
    const planContent = {
      id: 123,
      title: 'Implement Feature X',
      goal: 'Add new functionality',
      status: 'pending',
      issue: ['https://github.com/example/repo/issues/456'],
      tasks: [
        {
          title: 'Task 1',
          description: 'First task',
          done: false,
          steps: [{ prompt: 'Do step 1', done: false }],
        },
      ],
    };
    await fs.writeFile(planFile, `---\n${yaml.stringify(planContent)}---\n`);

    const db = getDatabase();
    const project = getOrCreateProject(db, 'github.com/example/repo');
    recordWorkspace(db, {
      projectId: project.id,
      taskId: 'task-123',
      workspacePath: workspaceDir,
    });

    // Mock dependencies
    await moduleMocker.mock('../../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
      openLogFile: mock(() => {}),
      closeLogFile: mock(async () => {}),
      boldMarkdownHeaders: (text: string) => text,
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {},
        postApplyCommands: [],
      })),
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      resolveTasksDir: mock(async () => tasksDir),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => workspaceDir),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      logSpawn: mock(() => ({ exitCode: 0, exited: Promise.resolve(0) })),
      commitAll: mock(async () => 0),
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => new TestExecutor()),
      DEFAULT_EXECUTOR: 'test-executor',
      defaultModelForExecutor: () => 'test-model',
    }));

    await moduleMocker.mock('./batch_mode.js', () => ({
      executeBatchMode: mock(async () => undefined),
    }));

    await moduleMocker.mock('../../summary/collector.js', () => ({
      SummaryCollector: class {
        recordExecutionStart() {}
        addError() {}
        addStepResult() {}
        setBatchIterations() {}
        recordExecutionEnd() {}
        async trackFileChanges() {}
        getExecutionSummary() {
          return {};
        }
      },
    }));

    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async () => {}),
    }));

    // Mock workspace dependencies (not used when not using workspace options)
    await moduleMocker.mock('../../workspace/workspace_manager.js', () => ({
      createWorkspace: mock(async () => null),
    }));

    await moduleMocker.mock('../../workspace/workspace_auto_selector.js', () => ({
      WorkspaceAutoSelector: mock(() => ({
        selectWorkspace: mock(async () => null),
      })),
    }));

    await moduleMocker.mock('../../workspace/workspace_lock.js', () => ({
      WorkspaceLock: {
        getLockInfo: mock(async () => null),
        isLockStale: mock(async () => false),
        acquireLock: mock(async () => ({ type: 'pid' })),
        setupCleanupHandlers: mock(() => {}),
        releaseLock: mock(async () => {}),
      },
    }));
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
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  test('updates workspace description when running in a tracked workspace', async () => {
    const { timAgent } = await import('./agent.js');

    await timAgent(planFile, { log: false } as any, {});

    const db = getDatabase();
    const workspaceMetadata = getWorkspaceByPath(db, workspaceDir);
    expect(workspaceMetadata).toBeDefined();

    // Description should be in format "#issueNumber planTitle"
    expect(workspaceMetadata!.description).toBe('123 - #456 Implement Feature X');
    expect(workspaceMetadata!.plan_id).toBe('123');
    expect(workspaceMetadata!.plan_title).toBe('Implement Feature X');
    expect(getWorkspaceIssues(db, workspaceMetadata!.id)).toEqual([
      'https://github.com/example/repo/issues/456',
    ]);
    expect(workspaceMetadata!.updated_at).toBeDefined();
  });

  test('updates workspace description without issue URL in plan', async () => {
    // Update plan to not have issue URL
    const planContent = {
      id: 789,
      title: 'Refactor Module',
      goal: 'Improve code structure',
      status: 'pending',
      issue: [],
      tasks: [
        {
          title: 'Task 1',
          description: 'Refactoring task',
          done: false,
          steps: [{ prompt: 'Refactor', done: false }],
        },
      ],
    };
    await fs.writeFile(planFile, `---\n${yaml.stringify(planContent)}---\n`);
    clearPlanCache();

    const { timAgent } = await import('./agent.js');

    await timAgent(planFile, { log: false } as any, {});

    const db = getDatabase();
    const workspaceMetadata = getWorkspaceByPath(db, workspaceDir);
    expect(workspaceMetadata).toBeDefined();

    // Description should be just the title (no issue number)
    expect(workspaceMetadata!.description).toBe('789 - Refactor Module');
    expect(workspaceMetadata!.plan_id).toBe('789');
    expect(workspaceMetadata!.plan_title).toBe('Refactor Module');
    expect(getWorkspaceIssues(db, workspaceMetadata!.id)).toEqual([]);
  });

  test('clears stale issue metadata when plan omits issue', async () => {
    const planContent = {
      id: 321,
      title: 'Maintenance',
      goal: 'Routine cleanup',
      status: 'pending',
      issue: [],
      tasks: [
        {
          title: 'Task 1',
          description: 'Cleanup task',
          done: false,
          steps: [{ prompt: 'Clean up', done: false }],
        },
      ],
    };
    await fs.writeFile(planFile, `---\n${yaml.stringify(planContent)}---\n`);
    clearPlanCache();

    const db = getDatabase();
    patchWorkspace(db, workspaceDir, {
      planId: '999',
      planTitle: 'Old Title',
      description: 'Old Description',
    });
    const workspace = getWorkspaceByPath(db, workspaceDir);
    expect(workspace).toBeDefined();
    if (workspace) {
      setWorkspaceIssues(db, workspace.id, ['https://github.com/example/repo/issues/999']);
    }

    const { timAgent } = await import('./agent.js');

    await timAgent(planFile, { log: false } as any, {});

    const updatedWorkspace = getWorkspaceByPath(db, workspaceDir);
    expect(updatedWorkspace).toBeDefined();

    expect(updatedWorkspace!.description).toBe('321 - Maintenance');
    expect(updatedWorkspace!.plan_title).toBe('Maintenance');
    expect(updatedWorkspace!.plan_id).toBe('321');
    expect(getWorkspaceIssues(db, updatedWorkspace!.id)).toEqual([]);
  });

  test('does not error when workspace is not tracked', async () => {
    const db = getDatabase();
    const existing = getWorkspaceByPath(db, workspaceDir);
    expect(existing).toBeDefined();
    if (existing) deleteWorkspace(db, workspaceDir);

    const { timAgent } = await import('./agent.js');

    // Should not throw
    await timAgent(planFile, { log: false } as any, {});

    // Verify no workspace description warning was issued (silent skip)
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('workspace description'));
  });

  test('warns but does not fail when workspace update fails', async () => {
    await moduleMocker.mock('../../db/workspace.js', () => ({
      patchWorkspace: mock(() => {
        throw new Error('Simulated write failure');
      }),
    }));

    const { timAgent } = await import('./agent.js');

    // Should not throw even though workspace update will fail
    await timAgent(planFile, { log: false } as any, {});

    // Verify warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update workspace description')
    );
  });

  test('updates workspace description with project title', async () => {
    // Update plan to have project context
    const planContent = {
      id: 999,
      title: 'Phase 1',
      goal: 'First phase',
      project: {
        title: 'Project X',
        goal: 'Main project goal',
      },
      status: 'pending',
      issue: ['https://github.com/example/repo/issues/111'],
      tasks: [
        {
          title: 'Task 1',
          description: 'Project task',
          done: false,
          steps: [{ prompt: 'Work', done: false }],
        },
      ],
    };
    await fs.writeFile(planFile, `---\n${yaml.stringify(planContent)}---\n`);

    const { timAgent } = await import('./agent.js');

    await timAgent(planFile, { log: false } as any, {});

    // Verify workspace metadata includes combined title
    const db = getDatabase();
    const workspaceMetadata = getWorkspaceByPath(db, workspaceDir);
    expect(workspaceMetadata).toBeDefined();

    // Description should include project title
    expect(workspaceMetadata!.description).toBe('999 - #111 Project X - Phase 1');
    expect(workspaceMetadata!.plan_title).toBe('Project X - Phase 1');
  });
});
