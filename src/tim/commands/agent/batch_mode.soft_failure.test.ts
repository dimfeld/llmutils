import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import { ModuleMocker } from '../../../testing.js';

describe('executeBatchMode stops on structured executor failure', () => {
  const moduleMocker = new ModuleMocker(import.meta);

  const logSpy = mock(() => {});
  const errorSpy = mock(() => {});
  const commitAllSpy = mock(async () => 0);
  const executePostApplyCommandSpy = mock(async () => true);

  beforeEach(() => {
    logSpy.mockClear();
    errorSpy.mockClear();
    commitAllSpy.mockClear();
    executePostApplyCommandSpy.mockClear();
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('breaks after first iteration, prints details, records failed step, and throws', async () => {
    // Mock logging to capture formatted output
    await moduleMocker.mock('../../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      boldMarkdownHeaders: (s: string) => s,
    }));

    // Mock plans and helpers used by batch_mode
    let readCount = 0;
    await moduleMocker.mock('../../plans.js', () => ({
      readPlanFile: mock(async () => ({
        id: 1,
        title: 'P',
        status: readCount++ === 0 ? 'pending' : 'in_progress',
        tasks: [{ title: 'T', steps: [{ prompt: 'p', done: false }] }],
      })),
      writePlanFile: mock(async (_p: string, _data: any) => {}),
      setPlanStatus: mock(async () => {}),
    }));

    // First call returns one incomplete task; subsequent calls would normally continue
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
          : [
              {
                taskIndex: 0,
                task: { title: 'T1', description: 'D1', steps: [{ prompt: 'p', done: false }] },
              },
            ];
      }),
    }));

    await moduleMocker.mock('../../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'BATCH PROMPT'),
    }));

    await moduleMocker.mock('../../actions.js', () => ({
      executePostApplyCommand: executePostApplyCommandSpy,
    }));

    await moduleMocker.mock('../../../common/process.js', () => ({
      commitAll: commitAllSpy,
    }));

    const { SummaryCollector } = await import('../../summary/collector.js');
    const { formatExecutionSummaryToLines } = await import('../../summary/display.js');
    const { executeBatchMode } = await import('./batch_mode.js');

    // Executor that returns a structured failure
    const executor = {
      filePathPrefix: '',
      execute: mock(async () => ({
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

    // Ensure post-apply commands were NOT executed
    expect(executePostApplyCommandSpy).not.toHaveBeenCalled();
    // Ensure no commits occurred
    expect(commitAllSpy).not.toHaveBeenCalled();

    // Console output contains FAILED header and sections
    const logged = logSpy.mock.calls.map((c) => String(c[0] ?? ''));
    expect(logged.some((l) => /FAILED\s*\(implementer\)/i.test(l))).toBeTrue();
    expect(logged.some((l) => /Requirements:/i.test(l))).toBeTrue();
    expect(logged.some((l) => /Possible solutions:/i.test(l))).toBeTrue();

    // Summary contains one failed step with details
    const summary = collector.getExecutionSummary();
    expect(summary.steps.length).toBe(1);
    expect(summary.steps[0].success).toBeFalse();
    expect(summary.steps[0].output?.failureDetails?.sourceAgent).toBe('implementer');

    // Rendered summary prominently includes FAILED details
    const lines = formatExecutionSummaryToLines(summary);
    expect(lines.join('\n')).toContain('FAILED (implementer)');
    expect(lines.join('\n')).toContain('Requirements:');
    expect(lines.join('\n')).toContain('Possible solutions:');
  });
});
