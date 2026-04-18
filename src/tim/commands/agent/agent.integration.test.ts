import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { closeDatabaseForTesting } from '../../db/database.js';
import { writePlanFile } from '../../plans.js';

let tempDir = '';
let tasksDir = '';
let configPath = '';
let originalEnv: Partial<Record<string, string>> = {};

const { mockLog, mockWarn } = vi.hoisted(() => ({
  mockLog: vi.fn(() => {}),
  mockWarn: vi.fn(() => {}),
}));

// Per-test controlled executor
let executorExecuteImpl: () => Promise<any> = async () => ({ content: 'default output' });

vi.mock('../../../logging.js', () => ({
  log: mockLog,
  warn: mockWarn,
  error: mockLog,
  boldMarkdownHeaders: (s: string) => s,
  openLogFile: vi.fn(() => {}),
  closeLogFile: vi.fn(async () => {}),
  debugLog: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
}));

vi.mock('../../../common/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../common/git.js')>()),
  getGitRoot: vi.fn(async () => tempDir),
  getCurrentCommitHash: vi.fn(async () => 'baseline-commit'),
  getChangedFilesBetween: vi.fn(async () => ['tasks/123-test-plan.yml', 'src/example.ts']),
  getChangedFilesOnBranch: vi.fn(async () => ['tasks/123-test-plan.yml']),
  getWorkingCopyStatus: vi.fn(async () => ({
    hasChanges: true,
    checkFailed: false,
    diffHash: 'hash-unique',
  })),
}));

vi.mock('../../../common/process.js', () => ({
  commitAll: vi.fn(async () => 0),
  logSpawn: vi.fn(() => ({
    exited: Promise.resolve(0),
  })),
  spawnAndLogOutput: vi.fn(async () => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    signal: null,
    killedByInactivity: false,
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
      acquireLock: vi.fn(async () => ({ type: 'pid' })),
      setupCleanupHandlers: vi.fn(() => {}),
      releaseLock: vi.fn(async () => {}),
      getLockInfo: vi.fn(async () => null),
      isLockStale: vi.fn(async () => false),
    },
  };
});

vi.mock('../../plans/prepare_step.js', () => ({
  prepareNextStep: vi.fn(async (_config: any, _planFile: string, _opts: any) => ({
    prompt: 'Prepared prompt content',
    promptFilePath: null,
    taskIndex: 0,
    stepIndex: 0,
    numStepsSelected: 1,
    rmfilterArgs: undefined,
  })),
}));

vi.mock('../../plans/mark_done.js', () => ({
  markStepDone: vi.fn(async () => ({ message: 'Step marked', planComplete: false })),
  markTaskDone: vi.fn(async () => ({ message: 'Task marked', planComplete: false })),
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn((_name: string, _opts: any, _config: any) => ({
    filePathPrefix: '@/',
    execute: vi.fn(async (...args: any[]) => executorExecuteImpl()),
    prepareStepOptions: vi.fn(() => ({})),
  })),
  DEFAULT_EXECUTOR: 'codex-cli',
  defaultModelForExecutor: vi.fn(() => 'mock-model'),
}));

vi.mock('../../plan_materialize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plan_materialize.js')>();
  return {
    ...actual,
    materializePlan: vi.fn(async (planId: number, repoRoot: string) =>
      actual.materializePlan(planId, repoRoot)
    ),
    syncMaterializedPlan: vi.fn(async () => {}),
    materializeRelatedPlans: vi.fn(async () => []),
    materializeAndPruneRelatedPlans: vi.fn(async () => []),
    withPlanAutoSync: vi.fn(async (_id: any, _root: any, fn: () => any) => fn()),
    resolveProjectContext: vi.fn(async (repoRoot: string) =>
      actual.resolveProjectContext(repoRoot)
    ),
    readMaterializedPlanRole: vi.fn(async () => null),
    diffPlanFields: vi.fn(() => ({})),
    mergePlanWithShadow: vi.fn((base: any) => base),
    cleanupMaterializedPlans: vi.fn(async () => {}),
  };
});

describe('tim agent integration (execution summaries)', () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-integration-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(tempDir).quiet();
    await Bun.$`git remote add origin https://example.com/acme/agent-integration.git`
      .cwd(tempDir)
      .quiet();
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();

    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'paths:\n  tasks: tasks\n');

    mockLog.mockClear();
    mockWarn.mockClear();

    // Reset per-test implementations
    executorExecuteImpl = async () => ({ content: 'default output' });
  });

  afterEach(async () => {
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
    vi.clearAllMocks();
  });

  async function writePlan(fileName: string, plan: any) {
    const fp = path.join(tasksDir, fileName);
    await writePlanFile(fp, plan, { cwdForIdentity: tempDir });
    return fp;
  }

  test('serial mode: captures final message from Claude executor and writes summary file', async () => {
    const plan = {
      id: 123,
      title: 'Test Plan (Serial Claude)',
      goal: 'Verify serial execution summary',
      details: 'Ensure collector records step + output',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1',
          description: 'Basic task description',
          done: false,
          steps: [{ prompt: 'Do a thing', done: false }],
        },
      ],
    };
    const planPath = await writePlan('123-test-plan.yml', plan);

    executorExecuteImpl = async () => ({ content: 'This is the final orchestrator message.' });

    const { timAgent } = await import('./agent.js');

    const summaryFile = path.join(tempDir, 'out', 'summary.txt');

    await timAgent(
      123,
      {
        serialTasks: true,
        nonInteractive: true,
        log: false,
        orchestrator: 'claude_code',
        summaryFile,
        steps: '1',
      },
      { config: configPath }
    );

    const content = await fs.readFile(summaryFile, 'utf8');
    expect(content).toContain('Execution Summary: Test Plan (Serial Claude)');
    expect(content).toContain('Steps Executed');
    expect(content).toContain('Step Results');
    expect(content).toContain('This is the final orchestrator message.');
    expect(content).toContain('File Changes');
    expect(content).toContain('tasks/123-test-plan.yml');
    expect(content).toContain('✓ Completed plan 123');
  });

  test('serial mode: captures Codex labeled output and records failure on error', async () => {
    const plan = {
      id: 321,
      title: 'Test Plan (Serial Codex)',
      goal: 'Verify codex output parsing + failure',
      details: 'Ensure labeled sections are parsed',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1',
          description: 'Implement and test task',
          done: false,
          steps: [{ prompt: 'Implement and test', done: false }],
        },
      ],
    };
    const planPath = await writePlan('321-test-plan.yml', plan);

    // First, have executor throw to simulate failure and ensure summary records it
    executorExecuteImpl = async () => {
      throw new Error('executor boom');
    };

    const { timAgent } = await import('./agent.js');
    const summaryFile = path.join(tempDir, 'out', 'summary2.txt');

    await expect(
      timAgent(
        321,
        {
          serialTasks: true,
          nonInteractive: true,
          log: false,
          orchestrator: 'codex_cli',
          summaryFile,
          steps: '1',
        },
        { config: configPath }
      )
    ).rejects.toThrow('Agent stopped due to error.');

    const content = await fs.readFile(summaryFile, 'utf8');
    expect(content).toContain('Execution Summary: Test Plan (Serial Codex)');
    expect(content).toContain('Failed Steps');
    // Error line appears under Step Results; overall Errors section may be empty
    expect(content).toContain('Error: executor boom');
    expect(content).toContain('executor boom');

    // Now, run again with a Codex-like combined output to validate parsing
    executorExecuteImpl = async () => ({
      content: [
        '=== Codex Implementer ===',
        'Implementation details here',
        '',
        '=== Codex Reviewer ===',
        'ACCEPTABLE',
      ].join('\n'),
    });

    const summaryFile2 = path.join(tempDir, 'out', 'summary3.txt');

    await timAgent(
      321,
      {
        serialTasks: true,
        nonInteractive: true,
        log: false,
        orchestrator: 'codex_cli',
        summaryFile: summaryFile2,
        steps: '1',
      },
      { config: configPath }
    );

    const content2 = await fs.readFile(summaryFile2, 'utf8');
    expect(content2).toContain('Implementer');
    expect(content2).toContain('Implementation details here');
    expect(content2).toContain('Reviewer');
    expect(content2).toContain('ACCEPTABLE');
  });

  test('batch mode: aggregates iterations and writes a summary', async () => {
    const plan = {
      id: 999,
      title: 'Batch Mode Plan',
      goal: 'Batch mode summary',
      details: 'Capture batch iterations',
      status: 'pending',
      tasks: [
        { title: 'Simple Task A', description: 'A', done: false },
        { title: 'Simple Task B', description: 'B', done: false },
      ],
    };
    const planPath = await writePlan('999-batch-plan.yml', plan);

    // Executor marks all tasks done after first call so batch loop terminates.
    // Must write to the materialized plan path since batch_mode reads from there.
    executorExecuteImpl = async () => {
      const { writePlanFile } = await import('../../plans.js');
      const materializedPlanPath = path.join(tempDir, '.tim', 'plans', '999.plan.md');
      await writePlanFile(materializedPlanPath, {
        id: 999,
        title: 'Batch Mode Plan',
        goal: 'Batch mode summary',
        details: 'Capture batch iterations',
        status: 'in_progress',
        tasks: [
          { title: 'Simple Task A', description: 'A', done: true, steps: [] },
          { title: 'Simple Task B', description: 'B', done: true, steps: [] },
        ],
        updatedAt: new Date().toISOString(),
      });
      return { content: 'Batch output here' };
    };

    const { timAgent } = await import('./agent.js');
    const summaryFile = path.join(tempDir, 'out', 'batch-summary.txt');

    await timAgent(
      999,
      {
        serialTasks: false,
        nonInteractive: true,
        log: false,
        orchestrator: 'claude_code',
        summaryFile,
      },
      { config: configPath }
    );

    const content = await fs.readFile(summaryFile, 'utf8');
    expect(content).toContain('Execution Summary: Batch Mode Plan');
    expect(content).toContain('Mode');
    expect(content).toContain('batch');
    expect(content).toContain('Step Results');
    expect(content).toContain('Batch Iteration 1');
  });

  test('reviewThreadContext is prepended to the executor prompt', async () => {
    const plan = {
      id: 789,
      title: 'Test Plan (Review Thread Context)',
      goal: 'Verify review thread context injection',
      details: 'Context should be prepended',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1',
          description: 'Fix review feedback',
          done: false,
          steps: [{ prompt: 'Fix the code', done: false }],
        },
      ],
    };
    const planPath = await writePlan('789-test-plan.yml', plan);

    executorExecuteImpl = async () => ({ content: 'done' });

    const { timAgent } = await import('./agent.js');
    const { buildExecutorAndLog } = await import('../../executors/index.js');
    const mockedBuild = vi.mocked(buildExecutorAndLog);
    mockedBuild.mockClear();

    const reviewContext = '## Review Thread Context\nFix the bug in auth.ts:42';

    await timAgent(
      789,
      {
        serialTasks: true,
        nonInteractive: true,
        log: false,
        orchestrator: 'claude_code',
        steps: '1',
        reviewThreadContext: reviewContext,
      },
      { config: configPath }
    );

    // buildExecutorAndLog was called, get the executor mock it returned
    expect(mockedBuild).toHaveBeenCalled();
    const executor = mockedBuild.mock.results[0].value;
    const executeMock = vi.mocked(executor.execute);

    // The first argument to execute() should start with the review thread context
    expect(executeMock).toHaveBeenCalled();
    const passedContext = executeMock.mock.calls[0][0];
    expect(passedContext).toContain(reviewContext);
    // The review context should come before the plan's goal in the prompt
    expect(passedContext).toContain('Verify review thread context injection');
    expect(passedContext.indexOf(reviewContext)).toBeLessThan(
      passedContext.indexOf('Verify review thread context injection')
    );
  });
});
