import { describe, test, expect, mock, afterEach, beforeEach } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

describe('CodexCliExecutor - failure detection across agents', () => {
  let moduleMocker: ModuleMocker;
  let tempDir: string;

  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempDir = '/tmp/codex-failure-test';
    (await import('node:fs/promises')).mkdir(tempDir, { recursive: true }).catch(() => {});
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('implementer failure short-circuits execution and skips auto-mark', async () => {
    // Mock git + plan reading
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async (_p: string) => ({
        id: 1,
        title: 'Plan',
        tasks: [
          { title: 'Task A', done: false },
          { title: 'Task B', done: false },
        ],
      })),
    }));

    // Make spawn succeed and call our provided formatter
    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    // Mock formatter to return a final FAILED message for the current step
    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: (_chunk: string) => {
            final = 'FAILED: Implementer hit impossible requirements\nProblems:\n- conflict';
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => final,
        };
      },
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    // Spy override on private method to ensure not invoked on failure
    let autoMarkCalled = false;
    (exec as any).markCompletedTasksFromImplementer = async () => {
      autoMarkCalled = true;
    };

    const out = (await exec.execute('CTX', {
      planId: '1',
      planTitle: 'P',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBeFalse();
    expect(out.failureDetails?.sourceAgent).toBe('implementer');
    expect(out.failureDetails?.problems).toContain('conflict');
    expect(autoMarkCalled).toBeFalse();
  });

  test('reviewer failure is detected when previous agents succeed', async () => {
    // Mock git + plan reading
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async (_p: string) => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task A', done: false }],
      })),
    }));

    // Provide a queue of final messages: implementer OK, tester OK, reviewer FAILED
    const finals = [
      'Implementer OK',
      'Tester OK',
      'FAILED: Reviewer identified irreconcilable requirements\nProblems:\n- conflict',
    ];

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => (final && final.startsWith('FAILED:') ? final : undefined),
        };
      },
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const out = (await exec.execute('CTX', {
      planId: '1',
      planTitle: 'P',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBeFalse();
    expect(out.failureDetails?.sourceAgent).toBe('reviewer');
    expect(out.failureDetails?.problems).toContain('conflict');
  });

  test('fixer failure short-circuits after NEEDS_FIXES reviewer verdict', async () => {
    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async (_p: string) => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task A', done: false }],
      })),
    }));

    // Reviewer will return NEEDS_FIXES; analyzer says fixes needed
    await moduleMocker.mock('./codex_cli/review_analysis.ts', () => ({
      analyzeReviewFeedback: mock(async () => ({
        needs_fixes: true,
        fix_instructions: 'Please fix X',
      })),
    }));

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: mock(async (_args: string[], opts: any) => {
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    // Sequence: implementer OK, tester OK, reviewer NEEDS_FIXES, fixer FAILED
    const finals = [
      'Implementer OK',
      'Tester OK',
      'Some review text\nVERDICT: NEEDS_FIXES',
      'FAILED: Fixer unable to proceed\nProblems:\n- conflict',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => (final && final.startsWith('FAILED:') ? final : undefined),
        };
      },
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const out = (await exec.execute('CTX', {
      planId: '1',
      planTitle: 'P',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBeFalse();
    expect(out.failureDetails?.sourceAgent).toBe('fixer');
    expect(out.failureDetails?.problems).toContain('conflict');
  });
});
