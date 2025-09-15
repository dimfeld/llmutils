import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';
import { executeBatchMode } from './batch_mode.js';

describe('executeBatchMode captureOutput integration', () => {
  const moduleMocker = new ModuleMocker(import.meta);

  const executorExecuteSpy = mock(async () => 'FINAL OUTPUT');

  // Simple stub SummaryCollector that captures calls without importing real code
  const summaryCollector = {
    addStepResult: mock(() => {}),
    addError: mock(() => {}),
    setBatchIterations: mock(() => {}),
    trackFileChanges: mock(async () => {}),
  } as any;

  beforeEach(() => {
    executorExecuteSpy.mockClear();
    (summaryCollector.addStepResult as any).mockClear();
    (summaryCollector.setBatchIterations as any).mockClear();
    (summaryCollector.addError as any).mockClear?.();
    (summaryCollector.trackFileChanges as any).mockClear();
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('passes captureOutput: "result" and records output when summaryCollector provided', async () => {
    // Mock plans and helpers used by batch_mode
    await moduleMocker.mock('../../plans.js', () => ({
      readPlanFile: mock(async () => ({ id: 1, title: 'P', status: 'pending', tasks: [] })),
      writePlanFile: mock(async (_p: string, _data: any) => {}),
      setPlanStatus: mock(async () => {}),
    }));

    // First call returns one incomplete task, second call returns none
    let incompleteCalls = 0;
    await moduleMocker.mock('../../plans/find_next.js', () => ({
      getAllIncompleteTasks: mock(() => {
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
    }));

    await moduleMocker.mock('../../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'BATCH PROMPT'),
    }));

    await moduleMocker.mock('../../actions.js', () => ({
      executePostApplyCommand: mock(async () => true),
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      commitAll: mock(async () => 0),
    }));

    const { executeBatchMode } = await import('./batch_mode.js');

    await executeBatchMode(
      {
        currentPlanFile: '/tmp/plan.yml',
        config: {} as any,
        executor: { execute: executorExecuteSpy, filePathPrefix: '' } as any,
        baseDir: '/tmp/repo',
        dryRun: false,
        executorName: 'codex-cli',
      },
      summaryCollector
    );

    expect(executorExecuteSpy).toHaveBeenCalledTimes(1);
    const planInfoArg = executorExecuteSpy.mock.calls[0][1];
    expect(planInfoArg.captureOutput).toBe('result');

    // Verify the summary received the returned output
    expect(summaryCollector.addStepResult).toHaveBeenCalled();
    const stepArg = (summaryCollector.addStepResult as any).mock.calls[0][0];
    expect(stepArg.success).toBeTrue();
    // Accept either legacy string or new normalized object
    const out = typeof stepArg.output === 'string' ? stepArg.output : stepArg.output?.content;
    expect(String(out)).toContain('FINAL OUTPUT');
  });
});
