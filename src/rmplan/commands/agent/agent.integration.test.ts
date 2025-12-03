import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import yaml from 'yaml';
import { ModuleMocker } from '../../../testing.js';

// We'll import rmplanAgent dynamically after setting up mocks in tests
let rmplanAgent: any;

describe('rmplan agent integration (execution summaries)', () => {
  let tempDir: string;
  let tasksDir: string;
  let configPath: string;
  let moduleMocker: ModuleMocker;

  const mockLog = mock(() => {});
  const mockWarn = mock(() => {});

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-agent-integration-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    configPath = path.join(tempDir, '.rmfilter', 'rmplan.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: { tasks: 'tasks' },
      })
    );

    moduleMocker = new ModuleMocker(import.meta);

    // Mock logging and summary display writing
    mockLog.mockClear();
    mockWarn.mockClear();
    await moduleMocker.mock('../../../logging.js', () => ({
      log: mockLog,
      warn: mockWarn,
      error: mockLog,
      boldMarkdownHeaders: (s: string) => s,
      openLogFile: mock(() => {}),
      closeLogFile: mock(async () => {}),
    }));

    // Mock git root + change tracking to avoid real VCS
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
      getCurrentCommitHash: mock(async () => 'baseline-commit'),
      getChangedFilesBetween: mock(async () => ['tasks/123-test-plan.yml', 'src/example.ts']),
      getChangedFilesOnBranch: mock(async () => ['tasks/123-test-plan.yml']),
    }));

    // Avoid actually committing in batch mode
    await moduleMocker.mock('../../../common/process.js', () => ({
      commitAll: mock(async () => 0),
      logSpawn: mock(() => ({
        exited: Promise.resolve(0),
      })),
    }));

    // Prevent interactive prompts and workspace handling from interfering
    await moduleMocker.mock('../../workspace/workspace_lock.js', () => ({
      WorkspaceLock: { acquireLock: mock(async () => {}), setupCleanupHandlers: mock(() => {}) },
    }));

    // Mock prepareNextStep to return a direct prompt (no rmfilter)
    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async (_config: any, _planFile: string, _opts: any) => ({
        prompt: 'Prepared prompt content',
        promptFilePath: null,
        taskIndex: 0,
        stepIndex: 0,
        numStepsSelected: 1,
        rmfilterArgs: undefined,
      })),
    }));

    // Mock step/task marking to avoid complex file mutations
    await moduleMocker.mock('../../plans/mark_done.js', () => ({
      markStepDone: mock(async () => ({ message: 'Step marked', planComplete: false })),
      markTaskDone: mock(async () => ({ message: 'Task marked', planComplete: false })),
    }));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    moduleMocker.clear();
  });

  async function writePlan(fileName: string, plan: any) {
    const fp = path.join(tasksDir, fileName);
    await fs.writeFile(fp, yaml.stringify(plan));
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

    // Mock executor factory to return a Claude-like executor that returns a final assistant message
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock((_name: string, _opts: any, _config: any) => ({
        filePathPrefix: '@/',
        execute: mock(async () => ({ content: 'This is the final orchestrator message.' })),
        prepareStepOptions: mock(() => ({})),
      })),
      defaultModelForExecutor: mock(() => 'mock-model'),
    }));

    // Now import the agent handler with mocks applied
    ({ rmplanAgent } = await import('./agent.js'));

    const summaryFile = path.join(tempDir, 'out', 'summary.txt');

    await rmplanAgent(
      planPath,
      {
        serialTasks: true,
        nonInteractive: true,
        log: false,
        executor: 'claude_code',
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
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock((_name: string, _opts: any, _config: any) => ({
        filePathPrefix: '@/',
        execute: mock(async () => {
          throw new Error('executor boom');
        }),
        prepareStepOptions: mock(() => ({})),
      })),
      defaultModelForExecutor: mock(() => 'mock-model'),
    }));

    ({ rmplanAgent } = await import('./agent.js'));
    const summaryFile = path.join(tempDir, 'out', 'summary2.txt');

    await expect(
      rmplanAgent(
        planPath,
        {
          serialTasks: true,
          nonInteractive: true,
          log: false,
          executor: 'codex_cli',
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
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock((_name: string, _opts: any, _config: any) => ({
        filePathPrefix: '@/',
        execute: mock(async () => ({
          content: [
            '=== Codex Implementer ===',
            'Implementation details here',
            '',
            '=== Codex Reviewer ===',
            'ACCEPTABLE',
          ].join('\n'),
        })),
        prepareStepOptions: mock(() => ({})),
      })),
      defaultModelForExecutor: mock(() => 'mock-model'),
    }));

    // Re-import to ensure the latest mocks are used
    ({ rmplanAgent } = await import('./agent.js'));
    const summaryFile2 = path.join(tempDir, 'out', 'summary3.txt');

    await rmplanAgent(
      planPath,
      {
        serialTasks: true,
        nonInteractive: true,
        log: false,
        executor: 'codex_cli',
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

    // Toggle getAllIncompleteTasks to return tasks then an empty list (to finish after one iteration)
    let callCount = 0;
    await moduleMocker.mock('../../plans/find_next.js', () => ({
      getAllIncompleteTasks: mock((_p: any) => {
        callCount += 1;
        if (callCount === 1) {
          return [
            { taskIndex: 0, task: { title: 'Simple Task A', done: false } },
            { taskIndex: 1, task: { title: 'Simple Task B', done: false } },
          ];
        }
        return [];
      }),
    }));

    // Executor returns any string; parser handles it generically for Claude name too
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock((_name: string, _opts: any, _config: any) => ({
        filePathPrefix: '@/',
        execute: mock(async () => ({ content: 'Batch output here' })),
        prepareStepOptions: mock(() => ({})),
      })),
      defaultModelForExecutor: mock(() => 'mock-model'),
    }));

    ({ rmplanAgent } = await import('./agent.js'));
    const summaryFile = path.join(tempDir, 'out', 'batch-summary.txt');

    await rmplanAgent(
      planPath,
      {
        serialTasks: false,
        nonInteractive: true,
        log: false,
        executor: 'claude_code',
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
});
