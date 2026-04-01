import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { runWithLogger, type LoggerAdapter } from '../../../logging/adapter.js';
import type { StructuredMessage } from '../../../logging/structured_messages.js';
import { resetShutdownState, setShuttingDown } from '../../shutdown_state.js';

let readCount = 0;
let incompleteCalls = 0;
let workingCopyCallCount = 0;
let runUpdateDocsShutdown = false;

const commitAllSpy = vi.fn(async () => 0);
const executePostApplyCommandSpy = vi.fn(async () => true);

vi.mock('../../plans.js', () => {
  class PlanNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PlanNotFoundError';
    }
  }
  class NoFrontmatterError extends Error {
    constructor(filePath: string) {
      super(`File lacks frontmatter: ${filePath}`);
      this.name = 'NoFrontmatterError';
    }
  }
  return {
    PlanNotFoundError,
    NoFrontmatterError,
    readPlanFile: vi.fn(async () => ({
      id: 1,
      title: 'P',
      status: readCount++ === 0 ? 'pending' : 'in_progress',
      tasks: [{ title: 'T', steps: [{ prompt: 'p', done: false }] }],
    })),
    writePlanFile: vi.fn(async (_p: string, _data: any) => {}),
    setPlanStatus: vi.fn(async () => {}),
    generatePlanFileContent: vi.fn(() => ''),
    resolvePlanFromDb: vi.fn(async () => ({
      plan: { id: 1, title: 'P', status: 'pending', tasks: [] },
      planPath: '',
    })),
    writePlanToDb: vi.fn(async () => {}),
    setPlanStatusById: vi.fn(async () => {}),
    isTaskDone: vi.fn(() => false),
  };
});

vi.mock('../../plans/find_next.js', () => ({
  getAllIncompleteTasks: vi.fn(() => {
    incompleteCalls += 1;
    return [
      {
        taskIndex: 0,
        task: { title: 'T1', description: 'D1', steps: [{ prompt: 'p', done: false }] },
      },
    ];
  }),
  findPendingTask: vi.fn(() => null),
  findNextActionableItem: vi.fn(() => null),
}));

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: vi.fn(async () => 'BATCH PROMPT'),
}));

vi.mock('../../actions.js', () => ({
  executePostApplyCommand: executePostApplyCommandSpy,
}));

vi.mock('../update-docs.js', () => ({
  runUpdateDocs: vi.fn(async () => {
    if (runUpdateDocsShutdown) {
      setShuttingDown(130);
    }
  }),
}));

vi.mock('../../../common/process.js', () => ({
  commitAll: commitAllSpy,
}));

vi.mock('../../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../common/git.js')>();
  return {
    ...actual,
    getWorkingCopyStatus: vi.fn(async () => ({
      hasChanges: true,
      checkFailed: false,
      diffHash: `hash-${workingCopyCallCount++}`,
    })),
  };
});

vi.mock('../../plan_materialize.js', () => ({
  materializePlan: vi.fn(async () => {}),
  syncMaterializedPlan: vi.fn(async () => {}),
  getMaterializedPlanPath: vi.fn(() => '/tmp/plan.md'),
  getShadowPlanPath: vi.fn(() => '/tmp/.plan.md.shadow'),
  materializeRelatedPlans: vi.fn(async () => {}),
  withPlanAutoSync: vi.fn(async (_id: any, _root: any, fn: () => any) => fn()),
  resolveProjectContext: vi.fn(async () => ({
    projectId: 1,
    planRowsByPlanId: new Map(),
    planRowsByUuid: new Map(),
    maxNumericId: 0,
  })),
  readMaterializedPlanRole: vi.fn(async () => null),
  MATERIALIZED_DIR: '.tim/plans',
}));

function createCaptureAdapter(structuredMessages: StructuredMessage[]): LoggerAdapter {
  return {
    log: () => {},
    error: () => {},
    warn: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    debugLog: () => {},
    sendStructured: (message: StructuredMessage) => {
      structuredMessages.push(message);
    },
  };
}

describe('executeBatchMode stops on structured executor failure', () => {
  beforeEach(() => {
    readCount = 0;
    incompleteCalls = 0;
    workingCopyCallCount = 0;
    runUpdateDocsShutdown = false;
    commitAllSpy.mockClear();
    executePostApplyCommandSpy.mockClear();
    resetShutdownState();
  });

  afterEach(() => {
    vi.clearAllMocks();
    resetShutdownState();
  });

  test('breaks after first iteration, prints details, records failed step, and throws', async () => {
    const { SummaryCollector } = await import('../../summary/collector.js');
    const { formatExecutionSummaryToLines } = await import('../../summary/display.js');
    const { executeBatchMode } = await import('./batch_mode.js');

    // Executor that returns a structured failure
    const executor = {
      filePathPrefix: '',
      execute: vi.fn(async () => ({
        content:
          'FAILED: Implementer reported a failure — Cannot proceed with changes' +
          '\n\nRequirements:\n- A' +
          '\nProblems:\n- B' +
          '\nPossible solutions:\n- C',
        success: false,
        failureDetails: {
          requirements: '- A',
          problems: '- B',
          solutions: '- C',
          sourceAgent: 'implementer',
        },
      })),
    } as any;

    const collector = new SummaryCollector({
      planId: '1',
      planTitle: 'P',
      planFilePath: '/tmp/plan.yml',
      mode: 'batch',
    });
    const structuredMessages: StructuredMessage[] = [];

    await runWithLogger(createCaptureAdapter(structuredMessages), async () => {
      await expect(
        executeBatchMode(
          {
            currentPlanFile: '/tmp/plan.yml',
            config: { postApplyCommands: [{ title: 'Should not run', command: 'echo x' }] } as any,
            executor,
            baseDir: '/tmp/repo',
            dryRun: false,
            executorName: 'codex-cli',
            executionMode: 'normal',
          },
          collector as any
        )
      ).rejects.toThrow('Batch mode stopped due to error.');
    });

    // Ensure post-apply commands were NOT executed
    expect(executePostApplyCommandSpy).not.toHaveBeenCalled();
    // Ensure no commits occurred
    expect(commitAllSpy).not.toHaveBeenCalled();

    // Structured failure details were emitted
    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'failure_report',
        summary: '- B',
        requirements: '- A',
        problems: '- B',
        solutions: '- C',
        sourceAgent: 'implementer',
      })
    );
    expect(structuredMessages).toContainEqual(
      expect.objectContaining({
        type: 'agent_step_end',
        phase: 'execution',
        success: false,
      })
    );

    // Summary contains one failed step with details
    const summary = collector.getExecutionSummary();
    expect(summary.steps.length).toBe(1);
    expect(summary.steps[0].success).toBe(false);
    expect(summary.steps[0].output?.failureDetails?.sourceAgent).toBe('implementer');

    // Rendered summary prominently includes FAILED details
    const lines = formatExecutionSummaryToLines(summary);
    expect(lines.join('\n')).toContain('FAILED (implementer)');
    expect(lines.join('\n')).toContain('Requirements:');
    expect(lines.join('\n')).toContain('Possible solutions:');
  });

  test('does not run post-apply commands or commit after shutdown is requested during docs update', async () => {
    runUpdateDocsShutdown = true;

    const { SummaryCollector } = await import('../../summary/collector.js');
    const { executeBatchMode } = await import('./batch_mode.js');

    const executor = {
      filePathPrefix: '',
      execute: vi.fn(async () => ({
        content: 'ok',
        success: true,
      })),
    } as any;

    const collector = new SummaryCollector({
      planId: '1',
      planTitle: 'P',
      planFilePath: '/tmp/plan.yml',
      mode: 'batch',
    });

    const { runUpdateDocs } = await import('../update-docs.js');

    await runWithLogger(createCaptureAdapter([]), async () => {
      await executeBatchMode(
        {
          currentPlanFile: '/tmp/plan.yml',
          config: {
            postApplyCommands: [{ title: 'Should not run', command: 'echo x' }],
            updateDocs: { mode: 'after-iteration' },
          } as any,
          executor,
          baseDir: '/tmp/repo',
          dryRun: false,
          executorName: 'codex-cli',
          executionMode: 'normal',
          updateDocsMode: 'after-iteration',
        },
        collector as any
      );
    });

    expect(runUpdateDocs).toHaveBeenCalledTimes(1);
    expect(executePostApplyCommandSpy).not.toHaveBeenCalled();
    expect(commitAllSpy).not.toHaveBeenCalled();
  });
});
