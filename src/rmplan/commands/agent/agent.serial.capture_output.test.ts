import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';

describe('rmplanAgent serial captureOutput integration', () => {
  const moduleMocker = new ModuleMocker(import.meta);

  const executorExecuteSpy = mock(async () => 'SERIAL EXEC OUT');

  // Spies for SummaryCollector
  const addStepResultSpy = mock(() => {});
  const recordExecutionStartSpy = mock(() => {});
  const trackFileChangesSpy = mock(async () => {});

  beforeEach(() => {
    executorExecuteSpy.mockClear();
    addStepResultSpy.mockClear();
    recordExecutionStartSpy.mockClear();
    trackFileChangesSpy.mockClear();
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('passes captureOutput: "result" and records output for serial mode', async () => {
    // Mock config loader
    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({
        defaultExecutor: 'codex-cli',
        models: {},
      })),
    }));

    // Mock executors factory
    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({
        execute: executorExecuteSpy,
        prepareStepOptions: () => ({}),
        filePathPrefix: '',
      })),
      DEFAULT_EXECUTOR: 'codex-cli',
      defaultModelForExecutor: mock(() => 'dummy-model'),
    }));

    // Mock plan file resolution and reading
    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (_p: string) => '/tmp/plan.yml'),
      readPlanFile: mock(async (_p: string) => ({
        id: 42,
        title: 'Serial Plan',
        tasks: [
          {
            title: 'T1',
            steps: [{ prompt: 'Do X', done: false }],
          },
        ],
      })),
      writePlanFile: mock(async () => {}),
    }));

    // Mock prepareNextStep to return a single selected step with direct prompt
    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async () => ({
        stepIndex: 0,
        stepCount: 1,
        numStepsSelected: 1,
        prompt: 'SERIAL PROMPT',
      })),
    }));

    // Mock markStepDone
    await moduleMocker.mock('../../plans/mark_done.js', () => ({
      markStepDone: mock(async () => ({ message: 'ok', planComplete: true })),
      markTaskDone: mock(async () => ({ message: 'ok', planComplete: true })),
    }));

    // Mock workspace helpers to no-op
    await moduleMocker.mock('../../workspace/workspace_manager.js', () => ({
      createWorkspace: mock(async () => ({ success: false })),
    }));

    // Mock logging to avoid noisy output
    await moduleMocker.mock('../../../logging.js', () => ({
      boldMarkdownHeaders: (s: string) => s,
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      openLogFile: mock(() => {}),
      closeLogFile: mock(() => {}),
    }));

    // Mock summary writer
    await moduleMocker.mock('../../summary/display.js', () => ({
      writeOrDisplaySummary: mock(async () => {}),
    }));

    // Mock SummaryCollector to capture addStepResult calls
    await moduleMocker.mock('../../summary/collector.js', () => ({
      SummaryCollector: class {
        constructor(_init: any) {
          return {
            recordExecutionStart: recordExecutionStartSpy,
            addStepResult: addStepResultSpy,
            addError: mock(() => {}),
            trackFileChanges: trackFileChangesSpy,
            recordExecutionEnd: mock(() => {}),
            getExecutionSummary: () => ({ steps: [], changedFiles: [], errors: [], metadata: { totalSteps: 0, failedSteps: 0 } }),
          } as any;
        }
      },
    }));

    const { rmplanAgent } = await import('./agent.js');

    await rmplanAgent('/tmp/plan.yml', { serialTasks: true, nonInteractive: true }, {});

    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    const planInfoArg = executorExecuteSpy.mock.calls[0][1];
    expect(planInfoArg.captureOutput).toBe('result');

    expect(addStepResultSpy).toHaveBeenCalled();
    const stepArg = addStepResultSpy.mock.calls[0][0];
    expect(stepArg.success).toBeTrue();
    expect(stepArg.output).toContain('SERIAL EXEC OUT');
  });
});

