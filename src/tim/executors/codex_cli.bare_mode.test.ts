import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

describe('Codex CLI bare mode', () => {
  let moduleMocker: ModuleMocker;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('runs single prompt and returns output when captureOutput is "result"', async () => {
    const logMessages: string[] = [];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map(String).join(' '))),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-bare'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async () => 'BARE MODE OUTPUT'),
    }));

    const { executeBareMode } = await import('./codex_cli/bare_mode.ts');

    const planInfo = {
      planId: 'bare-plan',
      planTitle: 'Bare Plan',
      planFilePath: '/tmp/repo-bare/plan.yml',
      executionMode: 'bare' as const,
      captureOutput: 'result' as const,
    };

    const result = await executeBareMode(
      'BARE PROMPT CONTENT',
      planInfo,
      '/tmp/repo-bare',
      undefined,
      {}
    );

    expect(result?.content).toBe('BARE MODE OUTPUT');
    expect(result?.metadata?.phase).toBe('bare');
  });

  test('runs single prompt and returns output when captureOutput is "all"', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-bare'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async () => 'BARE MODE OUTPUT'),
    }));

    const { executeBareMode } = await import('./codex_cli/bare_mode.ts');

    const planInfo = {
      planId: 'bare-plan',
      planTitle: 'Bare Plan',
      planFilePath: '/tmp/repo-bare/plan.yml',
      executionMode: 'bare' as const,
      captureOutput: 'all' as const,
    };

    const result = await executeBareMode(
      'BARE PROMPT CONTENT',
      planInfo,
      '/tmp/repo-bare',
      undefined,
      {}
    );

    expect(result?.content).toBe('BARE MODE OUTPUT');
    expect(result?.metadata?.phase).toBe('bare');
  });

  test('returns void when captureOutput is "none"', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-bare'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async () => 'BARE MODE OUTPUT'),
    }));

    const { executeBareMode } = await import('./codex_cli/bare_mode.ts');

    const planInfo = {
      planId: 'bare-plan',
      planTitle: 'Bare Plan',
      planFilePath: '/tmp/repo-bare/plan.yml',
      executionMode: 'bare' as const,
      captureOutput: 'none' as const,
    };

    const result = await executeBareMode(
      'BARE PROMPT CONTENT',
      planInfo,
      '/tmp/repo-bare',
      undefined,
      {}
    );

    expect(result).toBeUndefined();
  });

  test('detects and reports failures in bare mode', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-bare'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({
        failed: true,
        summary: 'failed',
        details: { requirements: '', problems: 'execution failed' },
      })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async () => 'FAILED OUTPUT'),
    }));

    const { executeBareMode } = await import('./codex_cli/bare_mode.ts');

    const planInfo = {
      planId: 'bare-plan',
      planTitle: 'Bare Plan',
      planFilePath: '/tmp/repo-bare/plan.yml',
      executionMode: 'bare' as const,
      captureOutput: 'result' as const,
    };

    const result = await executeBareMode(
      'BARE PROMPT CONTENT',
      planInfo,
      '/tmp/repo-bare',
      undefined,
      {}
    );

    expect(result?.success).toBeFalse();
    expect(result?.failureDetails?.problems).toBe('execution failed');
    expect(result?.failureDetails?.sourceAgent).toBe('bare');
  });

  test('handles failure with minimal details', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-bare'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({
        failed: true,
        summary: 'generic failure',
        details: undefined,
      })),
    }));

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: mock(async () => 'FAILED OUTPUT'),
    }));

    const { executeBareMode } = await import('./codex_cli/bare_mode.ts');

    const planInfo = {
      planId: 'bare-plan',
      planTitle: 'Bare Plan',
      planFilePath: '/tmp/repo-bare/plan.yml',
      executionMode: 'bare' as const,
      captureOutput: 'result' as const,
    };

    const result = await executeBareMode(
      'BARE PROMPT CONTENT',
      planInfo,
      '/tmp/repo-bare',
      undefined,
      {}
    );

    expect(result?.success).toBeFalse();
    expect(result?.failureDetails?.problems).toBe('generic failure');
    expect(result?.failureDetails?.sourceAgent).toBe('bare');
  });

  test('uses correct git root directory', async () => {
    const getGitRootSpy = mock(async () => '/custom/git/root');

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: getGitRootSpy,
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    const executeCodexStepSpy = mock(async () => 'OUTPUT');

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepSpy,
    }));

    const { executeBareMode } = await import('./codex_cli/bare_mode.ts');

    await executeBareMode(
      'PROMPT',
      {
        planId: 'bare-plan',
        planTitle: 'Bare Plan',
        planFilePath: '/tmp/plan.yml',
        executionMode: 'bare',
        captureOutput: 'none',
      },
      '/tmp/base-dir',
      undefined,
      {}
    );

    expect(getGitRootSpy).toHaveBeenCalledWith('/tmp/base-dir');
    expect(executeCodexStepSpy).toHaveBeenCalledWith(
      'PROMPT',
      '/custom/git/root',
      {},
      {
        reasoningLevel: 'medium',
      }
    );
  });

  test('passes config to executeCodexStep', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    const executeCodexStepSpy = mock(async () => 'OUTPUT');

    await moduleMocker.mock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepSpy,
    }));

    const { executeBareMode } = await import('./codex_cli/bare_mode.ts');

    const testConfig = { someOption: 'test-value' };

    await executeBareMode(
      'PROMPT',
      {
        planId: 'bare-plan',
        planTitle: 'Bare Plan',
        planFilePath: '/tmp/plan.yml',
        executionMode: 'bare',
        captureOutput: 'none',
      },
      '/tmp/repo',
      undefined,
      testConfig as any
    );

    expect(executeCodexStepSpy).toHaveBeenCalledWith('PROMPT', '/tmp/repo', testConfig, {
      reasoningLevel: 'medium',
    });
  });
});
