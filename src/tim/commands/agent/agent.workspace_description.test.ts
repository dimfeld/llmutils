import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
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

let tempDir = '';
let workspaceDir = '';

const logSpy = vi.fn(() => {});
const warnSpy = vi.fn(() => {});
const errorSpy = vi.fn(() => {});

vi.mock('../../../logging.js', () => ({
  log: logSpy,
  error: errorSpy,
  warn: warnSpy,
  openLogFile: vi.fn(() => {}),
  closeLogFile: vi.fn(async () => {}),
  boldMarkdownHeaders: (text: string) => text,
  debugLog: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => ({
    models: {},
    postApplyCommands: [],
  })),
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: vi.fn(async () => workspaceDir),
}));

vi.mock('../../../common/process.js', () => ({
  logSpawn: vi.fn(() => ({ exitCode: 0, exited: Promise.resolve(0) })),
  commitAll: vi.fn(async () => 0),
  spawnAndLogOutput: vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    signal: null,
    killedByInactivity: false,
  })),
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({
    execute: vi.fn(async (_prompt: string, options: any) => {
      // TestExecutor behavior inline - read and modify the plan file to mark all tasks done
      const { readPlanFile, writePlanFile } = await import('../../plans.js');
      const plan = await readPlanFile(options.planFilePath);
      plan.tasks.forEach((task: any) => {
        task.done = true;
      });
      await writePlanFile(options.planFilePath, plan);
    }),
    filePathPrefix: '',
  })),
  DEFAULT_EXECUTOR: 'test-executor',
  defaultModelForExecutor: vi.fn(() => 'test-model'),
}));

vi.mock('./batch_mode.js', () => ({
  executeBatchMode: vi.fn(async () => undefined),
}));

vi.mock('../../summary/collector.js', () => ({
  SummaryCollector: class {
    recordExecutionStart = vi.fn(() => {});
    addError = vi.fn(() => {});
    addStepResult = vi.fn(() => {});
    setBatchIterations = vi.fn(() => {});
    recordExecutionEnd = vi.fn(() => {});
    trackFileChanges = vi.fn(async () => {});
    getExecutionSummary = vi.fn(() => ({}));
  },
}));

vi.mock('../../summary/display.js', () => ({
  writeOrDisplaySummary: vi.fn(async () => {}),
  formatExecutionSummaryToLines: vi.fn(() => []),
  displayExecutionSummary: vi.fn(() => {}),
}));

vi.mock('../../workspace/workspace_manager.js', () => ({
  createWorkspace: vi.fn(async () => null),
  runWorkspaceUpdateCommands: vi.fn(async () => {}),
  prepareExistingWorkspace: vi.fn(async () => ({})),
  findUniqueBranchName: vi.fn(async (base: string) => base),
  findUniqueRemoteBranchName: vi.fn(async (base: string) => base),
  deleteLocalBranch: vi.fn(async () => {}),
  ensureJjRevisionHasDescription: vi.fn(async () => {}),
}));

vi.mock('../../workspace/workspace_auto_selector.js', () => ({
  WorkspaceAutoSelector: vi.fn(() => ({
    selectWorkspace: vi.fn(async () => null),
  })),
}));

vi.mock('../../workspace/workspace_lock.js', () => {
  class WorkspaceAlreadyLocked extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WorkspaceAlreadyLocked';
    }
  }
  return {
    WorkspaceAlreadyLocked,
    WorkspaceLock: {
      getLockInfo: vi.fn(async () => null),
      isLockStale: vi.fn(async () => false),
      acquireLock: vi.fn(async () => ({ type: 'pid' })),
      setupCleanupHandlers: vi.fn(() => {}),
      releaseLock: vi.fn(async () => {}),
    },
  };
});

describe('Agent workspace description auto-update', () => {
  let tasksDir: string;
  let planFile: string;
  let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };

  beforeEach(async () => {
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

    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
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
    await fs.rm(tempDir, { recursive: true, force: true });
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
    // Make patchWorkspaceInfo throw for this test using spyOn
    const workspaceInfo = await import('../../workspace/workspace_info.js');
    const spy = vi.spyOn(workspaceInfo, 'patchWorkspaceInfo').mockImplementationOnce(() => {
      throw new Error('Simulated write failure');
    });

    const { timAgent } = await import('./agent.js');

    // Should not throw even though workspace update will fail
    await timAgent(planFile, { log: false } as any, {});
    spy.mockRestore();

    // Verify warning was logged
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update workspace description')
    );
  });

  test('updates workspace description using the DB-backed plan title', async () => {
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

    expect(workspaceMetadata!.description).toBe('999 - #111 Phase 1');
    expect(workspaceMetadata!.plan_title).toBe('Phase 1');
  });
});
