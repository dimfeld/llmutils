import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';

let incompleteCalls = 0;

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
    readPlanFile: vi.fn(async () => ({ id: 1, title: 'P', status: 'pending', tasks: [] })),
    writePlanFile: vi.fn(async (_p: string, _data: any) => {}),
    setPlanStatusById: vi.fn(async () => {}),
    generatePlanFileContent: vi.fn(() => ''),
    resolvePlanByNumericId: vi.fn(async () => ({
      plan: { id: 1, title: 'P', status: 'pending', tasks: [] },
      planPath: '/tmp/plan.yml',
    })),
    writePlanToDb: vi.fn(async () => {}),
    getBlockedPlans: vi.fn(() => []),
    getChildPlans: vi.fn(() => []),
    getDiscoveredPlans: vi.fn(() => []),
    getMaxNumericPlanId: vi.fn(async () => 0),
    parsePlanIdentifier: vi.fn(() => ({})),
    isPlanReady: vi.fn(() => true),
    collectDependenciesInOrder: vi.fn(async () => []),
    setPlanStatus: vi.fn(async () => {}),
    generateSuggestedFilename: vi.fn(async () => 'plan.yml'),
    isTaskDone: vi.fn(() => false),
  };
});

vi.mock('../../plans/find_next.js', () => ({
  getAllIncompleteTasks: vi.fn(() => {
    incompleteCalls += 1;
    return incompleteCalls === 1
      ? [
          {
            taskIndex: 0,
            task: { title: 'T1', description: 'D1', steps: [{ prompt: 'p', done: false }] },
          },
        ]
      : [];
  }),
  findPendingTask: vi.fn(() => null),
  findNextActionableItem: vi.fn(() => null),
}));

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: vi.fn(async () => 'BATCH PROMPT'),
}));

vi.mock('../../actions.js', () => ({
  executePostApplyCommand: vi.fn(async () => true),
}));

vi.mock('../../../common/process.js', () => ({
  commitAll: vi.fn(async () => 0),
}));

vi.mock('../../plan_materialize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plan_materialize.js')>()),
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

describe('executeBatchMode captureOutput integration', () => {
  const executorExecuteSpy = vi.fn(async () => 'FINAL OUTPUT');

  // Simple stub SummaryCollector that captures calls without importing real code
  const summaryCollector = {
    addStepResult: vi.fn(() => {}),
    addError: vi.fn(() => {}),
    setBatchIterations: vi.fn(() => {}),
    trackFileChanges: vi.fn(async () => {}),
  } as any;

  beforeEach(() => {
    incompleteCalls = 0;
    executorExecuteSpy.mockClear();
    summaryCollector.addStepResult.mockClear();
    summaryCollector.setBatchIterations.mockClear();
    summaryCollector.addError.mockClear();
    summaryCollector.trackFileChanges.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('passes captureOutput: "result" and records output when summaryCollector provided', async () => {
    const { executeBatchMode } = await import('./batch_mode.js');

    await executeBatchMode(
      {
        currentPlanFile: '/tmp/plan.yml',
        config: {} as any,
        executor: { execute: executorExecuteSpy, filePathPrefix: '' } as any,
        baseDir: '/tmp/repo',
        dryRun: false,
        executorName: 'codex-cli',
        executionMode: 'normal',
      },
      summaryCollector
    );

    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    const planInfoArg = executorExecuteSpy.mock.calls[0][1];
    expect(planInfoArg.captureOutput).toBe('result');

    // Verify the summary received the returned output
    expect(summaryCollector.addStepResult).toHaveBeenCalled();
    const stepArg = summaryCollector.addStepResult.mock.calls[0][0];
    expect(stepArg.success).toBe(true);
    // Accept either legacy string or new normalized object
    const out = typeof stepArg.output === 'string' ? stepArg.output : stepArg.output?.content;
    expect(String(out)).toContain('FINAL OUTPUT');
  });
});
