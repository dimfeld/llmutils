import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';

describe('rmplanAgent serial captureOutput integration', () => {
  const moduleMocker = new ModuleMocker(import.meta);

  const executorExecuteSpy = mock(async () => 'SERIAL FINAL OUTPUT');

  // Stub SummaryCollector that captures calls
  const summaryCollector = {
    addStepResult: mock(() => {}),
    addError: mock(() => {}),
    recordExecutionStart: mock(() => {}),
    recordExecutionEnd: mock(() => {}),
    trackFileChanges: mock(async () => {}),
    getExecutionSummary: mock(() => ({
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

  beforeEach(() => {
    executorExecuteSpy.mockClear();
    (summaryCollector.addStepResult as any).mockClear();
    (summaryCollector.addError as any).mockClear();
    (summaryCollector.recordExecutionStart as any).mockClear();
    (summaryCollector.recordExecutionEnd as any).mockClear();
    (summaryCollector.trackFileChanges as any).mockClear();
    (summaryCollector.getExecutionSummary as any).mockClear();
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('passes captureOutput: "result" and records output in serial mode', async () => {
    // Mock config loader
    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        executors: { default: 'codex-cli' },
      })),
    }));

    // Mock plans
    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (_p: string) => '/tmp/plan.yml'),
      readPlanFile: mock(async () => ({ id: 1, title: 'P', tasks: [{ title: 'T1', steps: [{ prompt: 'p', done: false }] }] })),
      writePlanFile: mock(async (_p: string, _data: any) => {}),
      findNextPlan: mock(async () => null),
    }));

    await moduleMocker.mock('../../plans/mark_done.js', () => ({
      markTaskDone: mock(async () => ({ planComplete: false })),
      markStepDone: mock(async () => ({ message: 'ok', planComplete: false })),
    }));

    // Mock find_next to return a single pending step once
    let called = false;
    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => {
        if (called) return null;
        called = true;
        return {
          type: 'step',
          taskIndex: 0,
          stepIndex: 0,
          task: { title: 'T1', description: 'D1', steps: [{ prompt: 'p', done: false }] },
        };
      }),
    }));

    // Mock prepare_next_step to avoid rmfilter and supply prompt
    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async () => ({
        prompt: 'CONTEXT',
        promptFilePath: undefined,
        rmfilterArgs: undefined,
        taskIndex: 0,
        stepIndex: 0,
        numStepsSelected: 1,
      })),
    }));

    // Mock executors index to return our spy executor
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: executorExecuteSpy, filePathPrefix: '' })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => undefined),
    }));

    // Mock SummaryCollector to inject our stub and display to avoid terminal noise
    await moduleMocker.mock('../../summary/collector.js', () => ({
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
    
    // Mock display to avoid terminal noise
    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async () => {}),
    }));

    // Mock git root
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
    }));

    // Mock logging open/close to no-op
    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (s: string) => s,
      openLogFile: mock(() => {}),
      closeLogFile: mock(() => {}),
      log: (...args: any[]) => console.log(...args),
      error: (...args: any[]) => console.error(...args),
      warn: (...args: any[]) => console.warn(...args),
    }));

    const { rmplanAgent } = await import('./agent.js');

    await rmplanAgent('/tmp/plan.yml', { summary: true, log: false, serialTasks: true }, {});

    // Verify executor called with captureOutput: 'result'
    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    const planInfoArg = executorExecuteSpy.mock.calls[0][1];
    expect(planInfoArg.captureOutput).toBe('result');

    // Verify the summary received the returned output
    expect(summaryCollector.addStepResult).toHaveBeenCalled();
    const stepArg = (summaryCollector.addStepResult as any).mock.calls[0][0];
    expect(stepArg.success).toBeTrue();
    expect(typeof stepArg.output === 'string' || !!stepArg.output).toBeTrue();
  });
});
