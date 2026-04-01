import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { timAgent } from './agent.js';

let findNextActionableItemCalled = false;

const executorExecuteSpy = vi.fn(async () => 'SERIAL FINAL OUTPUT');

// Stub SummaryCollector that captures calls
const summaryCollector = {
  addStepResult: vi.fn(() => {}),
  addError: vi.fn(() => {}),
  recordExecutionStart: vi.fn(() => {}),
  recordExecutionEnd: vi.fn(() => {}),
  trackFileChanges: vi.fn(async () => {}),
  getExecutionSummary: vi.fn(() => ({
    planId: '1',
    planTitle: 'P',
    planFilePath: '/tmp/plan.yml',
    mode: 'serial',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    steps: [],
    changedFiles: [],
    errors: [],
    metadata: { totalSteps: 1, failedSteps: 0 },
  })),
} as any;

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => ({
    executors: { default: 'codex-cli' },
  })),
}));

vi.mock('../../ensure_plan_in_db.js', () => ({
  resolvePlanFromDbOrSyncFile: vi.fn(async (_p: string) => ({
    plan: {
      id: 1,
      title: 'P',
      tasks: [{ title: 'T1', steps: [{ prompt: 'p', done: false }] }],
    },
    planPath: '/tmp/plan.yml',
  })),
}));

vi.mock('../../plans.js', () => ({
  readPlanFile: vi.fn(async () => ({
    id: 1,
    title: 'P',
    tasks: [{ title: 'T1', steps: [{ prompt: 'p', done: false }] }],
  })),
  writePlanFile: vi.fn(async (_p: string, _data: any) => {}),
  generatePlanFileContent: vi.fn(() => ''),
  resolvePlanFromDb: vi.fn(async () => ({
    plan: { id: 1, title: 'P', status: 'pending', tasks: [] },
    planPath: '/tmp/plan.yml',
  })),
}));

vi.mock('../../plans/mark_done.js', () => ({
  markTaskDone: vi.fn(async () => ({ planComplete: false })),
  markStepDone: vi.fn(async () => ({ message: 'ok', planComplete: false })),
}));

vi.mock('../../plans/find_next.js', () => ({
  findNextActionableItem: vi.fn(() => {
    if (findNextActionableItemCalled) return null;
    findNextActionableItemCalled = true;
    return {
      type: 'step',
      taskIndex: 0,
      stepIndex: 0,
      task: { title: 'T1', description: 'D1', steps: [{ prompt: 'p', done: false }] },
    };
  }),
  getAllIncompleteTasks: vi.fn(() => []),
  findPendingTask: vi.fn(() => null),
}));

vi.mock('../../plans/prepare_step.js', () => ({
  prepareNextStep: vi.fn(async () => ({
    prompt: 'CONTEXT',
    promptFilePath: undefined,
    rmfilterArgs: undefined,
    taskIndex: 0,
    stepIndex: 0,
    numStepsSelected: 1,
  })),
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({ execute: executorExecuteSpy, filePathPrefix: '' })),
  DEFAULT_EXECUTOR: 'codex-cli',
  defaultModelForExecutor: vi.fn(() => undefined),
}));

vi.mock('../../summary/collector.js', () => ({
  SummaryCollector: class {
    recordExecutionStart = summaryCollector.recordExecutionStart;
    recordExecutionEnd = summaryCollector.recordExecutionEnd;
    addStepResult = summaryCollector.addStepResult;
    addError = summaryCollector.addError;
    trackFileChanges = summaryCollector.trackFileChanges;
    getExecutionSummary = summaryCollector.getExecutionSummary;
    constructor(_init: any) {}
  },
}));

vi.mock('../../summary/display.js', () => ({
  writeOrDisplaySummary: vi.fn(async () => {}),
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: vi.fn(async () => '/tmp/repo'),
}));

vi.mock('../../../logging.js', () => ({
  boldMarkdownHeaders: (s: string) => s,
  openLogFile: vi.fn(() => {}),
  closeLogFile: vi.fn(() => {}),
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debugLog: vi.fn(),
  sendStructured: vi.fn(),
}));

describe('timAgent serial captureOutput integration', () => {
  beforeEach(() => {
    findNextActionableItemCalled = false;
    executorExecuteSpy.mockClear();
    summaryCollector.addStepResult.mockClear();
    summaryCollector.addError.mockClear();
    summaryCollector.recordExecutionStart.mockClear();
    summaryCollector.recordExecutionEnd.mockClear();
    summaryCollector.trackFileChanges.mockClear();
    summaryCollector.getExecutionSummary.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('passes captureOutput: "result" and records output in serial mode', async () => {
    await timAgent('/tmp/plan.yml', { summary: true, log: false, serialTasks: true }, {});

    // Verify executor called with captureOutput: 'result'
    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    const planInfoArg = executorExecuteSpy.mock.calls[0][1];
    expect(planInfoArg.captureOutput).toBe('result');

    // Verify the summary received the returned output
    expect(summaryCollector.addStepResult).toHaveBeenCalled();
    const stepArg = summaryCollector.addStepResult.mock.calls[0][0];
    expect(stepArg.success).toBe(true);
    expect(typeof stepArg.output === 'string' || !!stepArg.output).toBe(true);
  });
});
