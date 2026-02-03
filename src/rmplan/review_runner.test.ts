import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ModuleMocker } from '../testing.js';
import type { Executor } from './executors/types.js';

describe('review_runner', () => {
  let moduleMocker: ModuleMocker;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('prepareReviewExecutors uses executor metadata for prompt building', async () => {
    const claudeExecutor: Executor = {
      execute: mock(async () => undefined),
      prepareStepOptions: () => ({ rmfilter: false }),
      supportsSubagents: true,
    };

    const codexExecutor: Executor = {
      execute: mock(async () => undefined),
    };

    const buildExecutorAndLog = mock((name: string) =>
      name === 'claude-code' ? claudeExecutor : codexExecutor
    );

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { prepareReviewExecutors } = await import('./review_runner.js');

    const buildPrompt = mock(
      ({ executorName, includeDiff, useSubagents }) =>
        `${executorName}-${includeDiff}-${useSubagents}`
    );

    const prepared = await prepareReviewExecutors({
      executorSelection: 'both',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt,
    });

    expect(prepared.map((entry) => entry.name)).toEqual(['claude-code', 'codex-cli']);
    expect(buildExecutorAndLog).toHaveBeenCalledTimes(2);
    expect(buildPrompt).toHaveBeenCalledWith({
      executorName: 'claude-code',
      includeDiff: false,
      useSubagents: true,
    });
    expect(buildPrompt).toHaveBeenCalledWith({
      executorName: 'codex-cli',
      includeDiff: true,
      useSubagents: false,
    });
  });

  test('runReview merges outputs and sorts issues by file and line', async () => {
    const claudeOutput = {
      issues: [
        {
          severity: 'major',
          category: 'bug',
          content: 'Issue B',
          file: 'b.ts',
          line: '20',
          suggestion: 'Fix B',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Issue C',
          file: '',
          line: '',
          suggestion: 'Fix C',
        },
      ],
      recommendations: ['Claude rec'],
      actionItems: ['Claude action'],
    };

    const codexOutput = {
      issues: [
        {
          severity: 'critical',
          category: 'bug',
          content: 'Issue A',
          file: 'a.ts',
          line: '5',
          suggestion: 'Fix A',
        },
      ],
      recommendations: ['Codex rec'],
      actionItems: ['Codex action'],
    };

    const claudeExecutor: Executor = {
      execute: mock(async () => JSON.stringify(claudeOutput)),
    };

    const codexExecutor: Executor = {
      execute: mock(async () => JSON.stringify(codexOutput)),
    };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock((name: string) =>
        name === 'claude-code' ? claudeExecutor : codexExecutor
      ),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    const result = await runReview({
      executorSelection: 'both',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: mock(() => 'prompt'),
      planInfo: {
        planId: '1',
        planTitle: 'Plan',
        planFilePath: '/tmp/plan.yml',
        baseBranch: 'main',
        changedFiles: ['a.ts'],
      },
    });

    const issueContents = result.reviewResult.issues.map((issue) => issue.content);
    expect(issueContents).toEqual(['Issue A', 'Issue B', 'Issue C']);
    expect(result.reviewResult.recommendations).toEqual(['Claude rec', 'Codex rec']);
    expect(result.reviewResult.actionItems).toEqual(['Claude action', 'Codex action']);
  });

  test('runReview serializes both executors and skips codex on blocking Claude issues', async () => {
    const claudeOutput = {
      issues: [
        {
          severity: 'major',
          category: 'bug',
          content: 'Blocking issue',
          file: 'a.ts',
          line: '1',
          suggestion: 'Fix it',
        },
      ],
      recommendations: [],
      actionItems: [],
    };

    const claudeExecute = mock(async () => JSON.stringify(claudeOutput));
    const codexExecute = mock(async () =>
      JSON.stringify({ issues: [], recommendations: ['unused'], actionItems: [] })
    );

    const claudeExecutor: Executor = { execute: claudeExecute };
    const codexExecutor: Executor = { execute: codexExecute };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock((name: string) =>
        name === 'claude-code' ? claudeExecutor : codexExecutor
      ),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    const result = await runReview({
      executorSelection: 'both',
      serialBoth: true,
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: mock(() => 'prompt'),
      planInfo: {
        planId: '9',
        planTitle: 'Serial Plan',
        planFilePath: '/tmp/plan.yml',
        baseBranch: 'main',
        changedFiles: [],
      },
    });

    expect(result.usedExecutors).toEqual(['claude-code']);
    expect(claudeExecute).toHaveBeenCalledTimes(1);
    expect(codexExecute).toHaveBeenCalledTimes(0);
  });

  test('runReview serializes both executors and runs codex on info-only Claude issues', async () => {
    const claudeOutput = {
      issues: [
        {
          severity: 'info',
          category: 'other',
          content: 'Info only',
          file: 'a.ts',
          line: '1',
          suggestion: 'Optional',
        },
      ],
      recommendations: [],
      actionItems: [],
    };

    const claudeExecute = mock(async () => JSON.stringify(claudeOutput));
    const codexExecute = mock(async () =>
      JSON.stringify({ issues: [], recommendations: ['ok'], actionItems: [] })
    );

    const claudeExecutor: Executor = { execute: claudeExecute };
    const codexExecutor: Executor = { execute: codexExecute };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock((name: string) =>
        name === 'claude-code' ? claudeExecutor : codexExecutor
      ),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    const result = await runReview({
      executorSelection: 'both',
      serialBoth: true,
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: mock(() => 'prompt'),
      planInfo: {
        planId: '10',
        planTitle: 'Serial Plan Info',
        planFilePath: '/tmp/plan.yml',
        baseBranch: 'main',
        changedFiles: [],
      },
    });

    expect(result.usedExecutors).toEqual(['claude-code', 'codex-cli']);
    expect(claudeExecute).toHaveBeenCalledTimes(1);
    expect(codexExecute).toHaveBeenCalledTimes(1);
  });

  test('runReview preserves structured output from executor', async () => {
    const structuredOutput = {
      issues: [
        {
          severity: 'info',
          category: 'other',
          content: 'Structured issue',
          file: 'structured.ts',
          line: '1',
          suggestion: 'None',
        },
      ],
      recommendations: [],
      actionItems: [],
    };

    const executor: Executor = {
      execute: mock(async () => ({
        content: 'ignored',
        structuredOutput,
      })),
    };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock(() => executor),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    const result = await runReview({
      executorSelection: 'codex-cli',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: mock(() => 'prompt'),
      planInfo: {
        planId: '2',
        planTitle: 'Structured Plan',
        planFilePath: '/tmp/plan.yml',
        baseBranch: 'main',
        changedFiles: ['structured.ts'],
      },
    });

    expect(result.reviewResult.issues[0]?.content).toBe('Structured issue');
  });

  test('runReview warns and returns partial results when one executor fails', async () => {
    const goodOutput = {
      issues: [],
      recommendations: ['ok'],
      actionItems: [],
    };

    const failingExecutor: Executor = {
      execute: mock(async () => {
        throw new Error('boom');
      }),
    };

    const goodExecutor: Executor = {
      execute: mock(async () => JSON.stringify(goodOutput)),
    };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock((name: string) =>
        name === 'claude-code' ? failingExecutor : goodExecutor
      ),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    const result = await runReview({
      executorSelection: 'both',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: mock(() => 'prompt'),
      planInfo: {
        planId: '3',
        planTitle: 'Partial Plan',
        planFilePath: '/tmp/plan.yml',
        baseBranch: 'main',
        changedFiles: [],
      },
      allowPartialFailures: true,
    });

    expect(result.usedExecutors).toEqual(['codex-cli']);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Review executor 'claude-code' failed");
  });

  test('runReview throws when partial failures are disallowed', async () => {
    const failingExecutor: Executor = {
      execute: mock(async () => {
        throw new Error('boom');
      }),
    };

    const goodExecutor: Executor = {
      execute: mock(async () =>
        JSON.stringify({ issues: [], recommendations: [], actionItems: [] })
      ),
    };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock((name: string) =>
        name === 'claude-code' ? failingExecutor : goodExecutor
      ),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    await expect(
      runReview({
        executorSelection: 'both',
        config: { defaultExecutor: 'codex-cli' } as any,
        sharedExecutorOptions: { baseDir: '/tmp' },
        buildPrompt: mock(() => 'prompt'),
        planInfo: {
          planId: '4',
          planTitle: 'Strict Plan',
          planFilePath: '/tmp/plan.yml',
          baseBranch: 'main',
          changedFiles: [],
        },
        allowPartialFailures: false,
      })
    ).rejects.toThrow(/Review failed due to executor errors/);
  });

  test('resolveReviewExecutorSelection uses review defaults and rejects unsupported', async () => {
    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock(() => {
        throw new Error('unexpected');
      }),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { resolveReviewExecutorSelection } = await import('./review_runner.js');

    const selection = resolveReviewExecutorSelection(undefined, {
      review: { defaultExecutor: 'claude-code' },
    } as any);
    expect(selection).toBe('claude-code');

    const bothSelection = resolveReviewExecutorSelection(undefined, {
      review: { defaultExecutor: 'both' },
    } as any);
    expect(bothSelection).toBe('both');

    expect(() =>
      resolveReviewExecutorSelection('unsupported-executor', {
        defaultExecutor: 'codex-cli',
      } as any)
    ).toThrow(/Unsupported review executor/);
  });

  test('runReview retries once on timeout and succeeds on second attempt', async () => {
    let attempts = 0;
    const goodOutput = {
      issues: [],
      recommendations: ['success after retry'],
      actionItems: [],
    };

    const executor: Executor = {
      execute: mock(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Claude review timed out after 30 minutes');
        }
        return JSON.stringify(goodOutput);
      }),
    };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock(() => executor),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    const result = await runReview({
      executorSelection: 'codex-cli',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: mock(() => 'prompt'),
      planInfo: {
        planId: '5',
        planTitle: 'Retry Plan',
        planFilePath: '/tmp/plan.yml',
        baseBranch: 'main',
        changedFiles: [],
      },
    });

    expect(attempts).toBe(2);
    expect(result.usedExecutors).toEqual(['codex-cli']);
    expect(result.reviewResult.recommendations).toEqual(['success after retry']);
    expect(result.warnings).toHaveLength(0);
  });

  test('runReview gives up after max retries on persistent timeout', async () => {
    let attempts = 0;

    const executor: Executor = {
      execute: mock(async () => {
        attempts++;
        throw new Error('Claude review timed out after 30 minutes');
      }),
    };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock(() => executor),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    await expect(
      runReview({
        executorSelection: 'codex-cli',
        config: { defaultExecutor: 'codex-cli' } as any,
        sharedExecutorOptions: { baseDir: '/tmp' },
        buildPrompt: mock(() => 'prompt'),
        planInfo: {
          planId: '6',
          planTitle: 'Max Retry Plan',
          planFilePath: '/tmp/plan.yml',
          baseBranch: 'main',
          changedFiles: [],
        },
      })
    ).rejects.toThrow(/timed out/);

    // Should have tried 2 times (initial + 1 retry)
    expect(attempts).toBe(2);
  });

  test('runReview does not retry on non-timeout errors', async () => {
    let attempts = 0;

    const executor: Executor = {
      execute: mock(async () => {
        attempts++;
        throw new Error('Some other error');
      }),
    };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock(() => executor),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    await expect(
      runReview({
        executorSelection: 'codex-cli',
        config: { defaultExecutor: 'codex-cli' } as any,
        sharedExecutorOptions: { baseDir: '/tmp' },
        buildPrompt: mock(() => 'prompt'),
        planInfo: {
          planId: '7',
          planTitle: 'No Retry Plan',
          planFilePath: '/tmp/plan.yml',
          baseBranch: 'main',
          changedFiles: [],
        },
      })
    ).rejects.toThrow(/Some other error/);

    // Should have only tried once (no retry for non-timeout errors)
    expect(attempts).toBe(1);
  });

  test('runReview retries on Codex inactivity termination message', async () => {
    let attempts = 0;
    const goodOutput = {
      issues: [],
      recommendations: ['codex retry success'],
      actionItems: [],
    };

    const executor: Executor = {
      execute: mock(async () => {
        attempts++;
        if (attempts === 1) {
          // Codex uses "terminated after inactivity" in its error message
          throw new Error('codex failed after 3 attempts (was terminated after inactivity).');
        }
        return JSON.stringify(goodOutput);
      }),
    };

    await moduleMocker.mock('./executors/index.js', () => ({
      buildExecutorAndLog: mock(() => executor),
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    const { runReview } = await import('./review_runner.js');

    const result = await runReview({
      executorSelection: 'codex-cli',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: mock(() => 'prompt'),
      planInfo: {
        planId: '8',
        planTitle: 'Codex Retry Plan',
        planFilePath: '/tmp/plan.yml',
        baseBranch: 'main',
        changedFiles: [],
      },
    });

    expect(attempts).toBe(2);
    expect(result.usedExecutors).toEqual(['codex-cli']);
    expect(result.reviewResult.recommendations).toEqual(['codex retry success']);
  });
});
