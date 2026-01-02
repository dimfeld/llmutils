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
});
