import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../../../testing.js';
import {
  readTrackingData,
  writeTrackingData,
  type WorkspaceInfo,
} from '../../workspace/workspace_tracker.js';
import { clearPlanCache } from '../../plans.js';

describe('Agent workspace description auto-update', () => {
  let moduleMocker: ModuleMocker;
  let tempDir: string;
  let tasksDir: string;
  let trackingFile: string;
  let planFile: string;
  let workspaceDir: string;

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
    trackingFile = path.join(tempDir, 'workspaces.json');
    planFile = path.join(tasksDir, '123-test-plan.yml');

    await fs.mkdir(tasksDir, { recursive: true });
    await fs.mkdir(workspaceDir, { recursive: true });

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

    // Create workspace entry in tracking file
    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-123',
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
      repositoryId: 'github.com/example/repo',
    };
    await fs.writeFile(trackingFile, JSON.stringify({ [workspaceDir]: workspaceEntry }, null, 2));

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
          trackingFile,
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
        acquireLock: mock(async () => {}),
        setupCleanupHandlers: mock(() => {}),
        releaseLock: mock(async () => {}),
      },
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
  });

  test('updates workspace description when running in a tracked workspace', async () => {
    const { timAgent } = await import('./agent.js');

    await timAgent(planFile, { log: false } as any, {});

    // Verify workspace metadata was updated
    const trackingData = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    const workspaceMetadata = trackingData[workspaceDir];

    // Description should be in format "#issueNumber planTitle"
    expect(workspaceMetadata.description).toBe('#456 Implement Feature X');
    expect(workspaceMetadata.planId).toBe('123');
    expect(workspaceMetadata.planTitle).toBe('Implement Feature X');
    expect(workspaceMetadata.issueUrls).toEqual(['https://github.com/example/repo/issues/456']);
    expect(workspaceMetadata.updatedAt).toBeDefined();
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

    // Verify workspace metadata was updated
    const trackingData = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    const workspaceMetadata = trackingData[workspaceDir];

    // Description should be just the title (no issue number)
    expect(workspaceMetadata.description).toBe('Refactor Module');
    expect(workspaceMetadata.planId).toBe('789');
    expect(workspaceMetadata.planTitle).toBe('Refactor Module');
    expect(workspaceMetadata.issueUrls).toBeUndefined();
  });

  test('clears stale plan metadata when plan omits id and issue', async () => {
    const planContent = {
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

    const trackingData = await readTrackingData(trackingFile);
    trackingData[workspaceDir] = {
      ...trackingData[workspaceDir],
      planId: '999',
      planTitle: 'Old Title',
      issueUrls: ['https://github.com/example/repo/issues/999'],
    };
    await writeTrackingData(trackingData, trackingFile);

    const { timAgent } = await import('./agent.js');

    await timAgent(planFile, { log: false } as any, {});

    const updatedTracking = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    const workspaceMetadata = updatedTracking[workspaceDir];

    expect(workspaceMetadata.description).toBe('Maintenance');
    expect(workspaceMetadata.planTitle).toBe('Maintenance');
    expect(workspaceMetadata.planId).toBeUndefined();
    expect(workspaceMetadata.issueUrls).toBeUndefined();
  });

  test('does not error when workspace is not tracked', async () => {
    // Remove the workspace from tracking
    await fs.writeFile(trackingFile, '{}');

    const { timAgent } = await import('./agent.js');

    // Should not throw
    await timAgent(planFile, { log: false } as any, {});

    // Verify no workspace entry was created (since it's not tracked)
    const trackingData = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    expect(trackingData[workspaceDir]).toBeUndefined();

    // Verify no warning was issued (silent skip)
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('workspace'));
  });

  test('warns but does not fail when workspace update fails', async () => {
    // Mock patchWorkspaceMetadata to throw an error
    await moduleMocker.mock('../../workspace/workspace_tracker.js', () => ({
      findWorkspacesByTaskId: mock(async () => []),
      getWorkspaceMetadata: mock(async () => ({
        taskId: 'task-123',
        workspacePath: workspaceDir,
        createdAt: new Date().toISOString(),
      })),
      patchWorkspaceMetadata: mock(async () => {
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
    const trackingData = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    const workspaceMetadata = trackingData[workspaceDir];

    // Description should include project title
    expect(workspaceMetadata.description).toBe('#111 Project X - Phase 1');
    expect(workspaceMetadata.planTitle).toBe('Project X - Phase 1');
  });
});
