import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { ModuleMocker } from '../../../testing.js';

// We import rmplanAgent dynamically in tests after mocks are applied
// to ensure it sees the mocked modules.

const moduleMocker = new ModuleMocker(import.meta);

// Common spies used across tests
const logSpy = mock(() => {});
const errorSpy = mock(() => {});
const warnSpy = mock(() => {});
const openLogFileSpy = mock(() => {});
const closeLogFileSpy = mock(async () => {});

// writeOrDisplaySummary spy to capture the resulting summary
const writeOrDisplaySummarySpy = mock(async () => {});

// Git + VCS mocks used by SummaryCollector and mark_* helpers
const mockGetGitRoot = mock(async (_?: string) => tempDirGlobal || '/tmp/test');
const mockGetCurrentCommitHash = mock(async (_?: string) => 'rev-0');
const mockGetChangedFilesBetween = mock(async (_?: string, __?: string) => [
  'src/changed1.ts',
  'src/feature/changed2.ts',
]);
const mockGetChangedFilesOnBranch = mock(async () => ['src/fallback.ts']);

// Will be set per test
let tempDirGlobal: string | undefined;

async function createPlanFile(filePath: string, planData: any) {
  const schemaComment =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
  await fs.writeFile(filePath, schemaComment + yaml.stringify(planData));
}

describe('rmplanAgent - Execution Summary Integration', () => {
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    // Reset spies
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    openLogFileSpy.mockClear();
    closeLogFileSpy.mockClear();
    writeOrDisplaySummarySpy.mockClear();

    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-integration-'));
    tempDirGlobal = tempDir;
    planFile = path.join(tempDir, 'plan.yml');

    // Ensure any interactive prompts are auto-answered in tests
    await moduleMocker.mock('@inquirer/prompts', () => ({
      select: mock(async () => 'generate'),
    }));

    // Mock logging (including markdown helpers)
    await moduleMocker.mock('../../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
      openLogFile: openLogFileSpy,
      closeLogFile: closeLogFileSpy,
      boldMarkdownHeaders: mock((s: string) => s),
    }));

    // Mock config loader (keep defaults small and deterministic)
    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        models: { execution: 'test-model' },
        postApplyCommands: [],
      })),
    }));

    // Mock git utilities used by collector and plan updaters
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mockGetGitRoot,
      getChangedFilesOnBranch: mockGetChangedFilesOnBranch,
      getCurrentCommitHash: mockGetCurrentCommitHash,
      getChangedFilesBetween: mockGetChangedFilesBetween,
      // A couple of helpers used elsewhere in code paths; keep simple defaults
      getUsingJj: mock(async () => true),
      hasUncommittedChanges: mock(async () => true),
    }));

    // Avoid running real commit commands
    await moduleMocker.mock('../../../common/process.js', () => ({
      commitAll: mock(async () => 0),
      // Minimal stub for logSpawn when imported but unused
      logSpawn: mock(() => ({ exited: 0 })),
    }));

    // Plans I/O uses real file operations in temp dir
    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (p: string) => p),
      readPlanFile: mock(async (filePath: string) => {
        const content = await fs.readFile(filePath, 'utf8');
        return yaml.parse(content.replace(/^#.*\n/, ''));
      }),
      writePlanFile: mock(async (filePath: string, data: any) => {
        await createPlanFile(filePath, data);
      }),
      findNextPlan: mock(async () => null),
      clearPlanCache: mock(() => {}),
    }));

    // Keep next/mark/prep lightweight; we rely on the simple-task path for serial tests
    await moduleMocker.mock('../../plans/prepare_phase.js', () => ({
      preparePhase: mock(async () => {}),
    }));
    await moduleMocker.mock('../../plans/mark_done.js', () => {
      const original = require('../../plans/mark_done.js');
      // Use the real implementation, which we configured through common mocks
      return original;
    });

    // Prompt builder for simple task / batch prompts
    await moduleMocker.mock('../../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'PROMPT'),
    }));

    // Summary display writer
    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: writeOrDisplaySummarySpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    tempDirGlobal = undefined;
  });

  test('serial mode: captures Claude Code final assistant message and writes summary', async () => {
    // Plan with a single simple task (no steps) to exercise the simple task branch
    await createPlanFile(planFile, {
      id: 101,
      title: 'Serial Claude Plan',
      goal: 'Do something',
      details: 'High-level task',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [{ title: 'Simple Task', description: 'No steps here' }],
    });

    // Executor returns a final assistant message
    const executorExecute = mock(async () => 'Final orchestrator message');
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: executorExecute, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'claude-code',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    const { rmplanAgent } = await import('./agent.js');
    const options: any = { serialTasks: true, log: false, executor: 'claude-code' };
    await rmplanAgent(planFile, options, {});

    // Summary should be written once at the end
    expect(writeOrDisplaySummarySpy).toHaveBeenCalledTimes(1);
    const summaryArg = writeOrDisplaySummarySpy.mock.calls[0][0];
    expect(summaryArg.planId).toBe('101');
    expect(summaryArg.planTitle).toBe('Serial Claude Plan');
    expect(summaryArg.steps.length).toBe(1);
    expect(summaryArg.steps[0].executor).toBe('claude-code');
    expect(summaryArg.steps[0].success).toBeTrue();
    expect(summaryArg.steps[0].output?.content).toContain('Final orchestrator message');
    // Changed files come from our mocked git functions
    expect(Array.isArray(summaryArg.changedFiles)).toBeTrue();
  });

  test('serial mode: captures Codex CLI combined sections and metadata', async () => {
    await createPlanFile(planFile, {
      id: 102,
      title: 'Serial Codex Plan',
      goal: 'Implement stuff',
      details: 'Do it',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [{ title: 'Simple Task', description: 'No steps' }],
    });

    const combined = [
      '=== Codex Implementer ===',
      'Implemented feature X',
      '=== Codex Reviewer ===',
      'Looks good to me',
    ].join('\n');

    const executorExecute = mock(async () => combined);
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: executorExecute, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    const { rmplanAgent } = await import('./agent.js');
    const options: any = { serialTasks: true, log: false, executor: 'codex-cli' };
    await rmplanAgent(planFile, options, {});

    expect(writeOrDisplaySummarySpy).toHaveBeenCalledTimes(1);
    const summaryArg = writeOrDisplaySummarySpy.mock.calls[0][0];
    expect(summaryArg.planId).toBe('102');
    expect(summaryArg.steps.length).toBe(1);
    const out = summaryArg.steps[0].output?.content ?? '';
    expect(out).toContain('Implementer:');
    expect(out).toContain('Implemented feature X');
    expect(out).toContain('Reviewer:');
    expect(out).toContain('Looks good to me');
  });

  test('does not write summary when summary is disabled via option', async () => {
    await createPlanFile(planFile, {
      id: 150,
      title: 'No Summary Plan',
      goal: 'Ensure no summary',
      details: 'Disable summary flag',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [{ title: 'Simple Task', description: 'No steps' }],
    });

    const executorExecute = mock(async () => 'ok');
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: executorExecute, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    const { rmplanAgent } = await import('./agent.js');
    const options: any = { serialTasks: true, log: false, executor: 'codex-cli', summary: false };
    await rmplanAgent(planFile, options, {});

    expect(writeOrDisplaySummarySpy).not.toHaveBeenCalled();
  });

  test('batch mode: aggregates iterations and tracks batchIterations metadata', async () => {
    await createPlanFile(planFile, {
      id: 201,
      title: 'Batch Plan',
      goal: 'Multiple tasks',
      details: 'Batch execution',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [
        { title: 'Task A', description: 'A', steps: [{ prompt: 'Do A', done: false }] },
        { title: 'Task B', description: 'B', steps: [{ prompt: 'Do B', done: false }] },
      ],
    });

    let call = 0;
    const executorExecute = mock(async () => {
      call++;
      // Simulate the agent marking tasks/steps done between iterations
      if (call === 1) {
        await createPlanFile(planFile, {
          id: 201,
          title: 'Batch Plan',
          goal: 'Multiple tasks',
          details: 'Batch execution',
          status: 'in_progress',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [
            {
              title: 'Task A',
              description: 'A',
              steps: [{ prompt: 'Do A', done: true }],
              done: true,
            },
            { title: 'Task B', description: 'B', steps: [{ prompt: 'Do B', done: false }] },
          ],
        });
        return 'Batch iteration 1 complete';
      } else {
        await createPlanFile(planFile, {
          id: 201,
          title: 'Batch Plan',
          goal: 'Multiple tasks',
          details: 'Batch execution',
          status: 'in_progress',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [
            {
              title: 'Task A',
              description: 'A',
              steps: [{ prompt: 'Do A', done: true }],
              done: true,
            },
            {
              title: 'Task B',
              description: 'B',
              steps: [{ prompt: 'Do B', done: true }],
              done: true,
            },
          ],
        });
        return 'Batch iteration 2 complete';
      }
    });

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: executorExecute, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    const { rmplanAgent } = await import('./agent.js');
    // Default is batch mode (serialTasks not true)
    const options: any = { log: false, executor: 'codex-cli' };
    await rmplanAgent(planFile, options, {});

    expect(writeOrDisplaySummarySpy).toHaveBeenCalledTimes(1);
    const summaryArg = writeOrDisplaySummarySpy.mock.calls[0][0];
    expect(summaryArg.mode).toBe('batch');
    expect(summaryArg.steps.length).toBe(2);
    expect(summaryArg.steps[0].title).toContain('Batch Iteration 1');
    expect(summaryArg.steps[1].title).toContain('Batch Iteration 2');
    expect(summaryArg.metadata.batchIterations).toBe(2);
  });

  test('serial mode error: failed step appears in summary with error message', async () => {
    await createPlanFile(planFile, {
      id: 301,
      title: 'Error Plan',
      goal: 'Fails',
      details: 'Expect error',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [{ title: 'Simple Task', description: 'No steps' }],
    });

    const executorExecute = mock(async () => {
      throw new Error('executor boom');
    });
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: executorExecute, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'claude-code',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    const { rmplanAgent } = await import('./agent.js');
    const options: any = { serialTasks: true, log: false, executor: 'claude-code' };
    await expect(rmplanAgent(planFile, options, {})).rejects.toThrow();

    // Summary still produced in finally block
    expect(writeOrDisplaySummarySpy).toHaveBeenCalledTimes(1);
    const summaryArg = writeOrDisplaySummarySpy.mock.calls[0][0];
    expect(summaryArg.metadata.failedSteps).toBe(1);
    expect(summaryArg.steps.length).toBe(1);
    expect(summaryArg.steps[0].success).toBeFalse();
    expect(summaryArg.steps[0].errorMessage).toContain('executor boom');
  });
});
