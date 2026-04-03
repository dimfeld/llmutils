import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Executor } from './executors/types.js';
import { buildExecutorAndLog } from './executors/index.js';
import { getGitRoot } from '../common/git.js';
import { mkdir, unlink } from 'node:fs/promises';

vi.mock('./executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'codex-cli',
}));

vi.mock('../common/git.js', () => ({
  getGitRoot: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
}));

describe('review_runner', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getGitRoot).mockResolvedValue('/tmp/review-runner-tests');
  });

  test('prepareReviewExecutors always enables subagents in review prompts', async () => {
    const claudeExecutor: Executor = {
      execute: vi.fn(async () => undefined),
      supportsSubagents: true,
      executeAnalysisPhase: vi.fn(async () => ({ sessionId: 'session-1' })),
      executeReviewModeWithResume: vi.fn(async () => ({
        content: '',
        structuredOutput: { issues: [], recommendations: [], actionItems: [] },
      })),
    };

    const codexExecutor: Executor = {
      execute: vi.fn(async () => undefined),
      executeAnalysisPhase: vi.fn(async () => undefined),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) =>
      name === 'claude-code' ? claudeExecutor : codexExecutor
    );

    const buildPrompt = vi.fn(
      ({ executorName, includeDiff, useSubagents }) =>
        `${executorName}-${includeDiff}-${useSubagents}`
    );

    const { prepareReviewExecutors } = await import('./review_runner.js');
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
      includeDiff: false,
      useSubagents: true,
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
      execute: vi.fn(async () => JSON.stringify(claudeOutput)),
      executeAnalysisPhase: vi.fn(async () => ({ sessionId: 'session-1' })),
      executeReviewModeWithResume: vi.fn(async () => JSON.stringify(claudeOutput)),
    };

    const codexExecutor: Executor = {
      execute: vi.fn(async () => JSON.stringify(codexOutput)),
      executeAnalysisPhase: vi.fn(async () => undefined),
    };

    const buildPrompt = vi.fn(() => 'prompt');
    const buildAnalysisPrompt = vi.fn(async () => 'analysis-prompt');

    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) =>
      name === 'claude-code' ? claudeExecutor : codexExecutor
    );

    const { runReview } = await import('./review_runner.js');
    const result = await runReview({
      executorSelection: 'both',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt,
      buildAnalysisPrompt,
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
    expect(buildAnalysisPrompt).toHaveBeenCalledTimes(1);
    expect(claudeExecutor.executeAnalysisPhase).toHaveBeenCalledTimes(1);
    expect(claudeExecutor.executeReviewModeWithResume).toHaveBeenCalledTimes(1);
    expect(claudeExecutor.executeReviewModeWithResume).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'session-1'
    );
    expect(codexExecutor.execute).toHaveBeenCalledTimes(1);
    expect(buildPrompt).toHaveBeenCalledWith({
      executorName: 'claude-code',
      includeDiff: false,
      useSubagents: true,
      reviewGuidePath: '.tim/tmp/review-guide-1.md',
    });
    expect(buildPrompt).toHaveBeenCalledWith({
      executorName: 'codex-cli',
      includeDiff: false,
      useSubagents: true,
      reviewGuidePath: '.tim/tmp/review-guide-1.md',
    });
    expect(mkdir).toHaveBeenCalledWith('/tmp/review-runner-tests/.tim/tmp', { recursive: true });
    expect(unlink).toHaveBeenCalledWith('/tmp/review-runner-tests/.tim/tmp/review-guide-1.md');
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
      execute: vi.fn(async () => ({
        content: 'ignored',
        structuredOutput,
      })),
      executeAnalysisPhase: vi.fn(async () => undefined),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) => executor);

    const { runReview } = await import('./review_runner.js');
    const result = await runReview({
      executorSelection: 'codex-cli',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: vi.fn(() => 'prompt'),
      buildAnalysisPrompt: vi.fn(async () => 'analysis'),
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
      execute: vi.fn(async () => {
        throw new Error('boom');
      }),
      executeAnalysisPhase: vi.fn(async () => ({ sessionId: 'session-1' })),
      executeReviewModeWithResume: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    const goodExecutor: Executor = {
      execute: vi.fn(async () => JSON.stringify(goodOutput)),
      executeAnalysisPhase: vi.fn(async () => undefined),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) =>
      name === 'claude-code' ? failingExecutor : goodExecutor
    );

    const { runReview } = await import('./review_runner.js');
    const result = await runReview({
      executorSelection: 'both',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: vi.fn(() => 'prompt'),
      buildAnalysisPrompt: vi.fn(async () => 'analysis'),
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
      execute: vi.fn(async () => {
        throw new Error('boom');
      }),
      executeAnalysisPhase: vi.fn(async () => ({ sessionId: 'session-1' })),
      executeReviewModeWithResume: vi.fn(async () => {
        throw new Error('boom');
      }),
    };

    const goodExecutor: Executor = {
      execute: vi.fn(async () =>
        JSON.stringify({ issues: [], recommendations: [], actionItems: [] })
      ),
      executeAnalysisPhase: vi.fn(async () => undefined),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) =>
      name === 'claude-code' ? failingExecutor : goodExecutor
    );

    const { runReview } = await import('./review_runner.js');
    await expect(
      runReview({
        executorSelection: 'both',
        config: { defaultExecutor: 'codex-cli' } as any,
        sharedExecutorOptions: { baseDir: '/tmp' },
        buildPrompt: vi.fn(() => 'prompt'),
        buildAnalysisPrompt: vi.fn(async () => 'analysis'),
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
    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) => {
      throw new Error(`unexpected`);
    });

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
      execute: vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Claude review timed out after 30 minutes');
        }
        return JSON.stringify(goodOutput);
      }),
      executeAnalysisPhase: vi.fn(async () => undefined),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) => executor);

    const { runReview } = await import('./review_runner.js');

    const result = await runReview({
      executorSelection: 'codex-cli',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: vi.fn(() => 'prompt'),
      buildAnalysisPrompt: vi.fn(async () => 'analysis'),
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
      execute: vi.fn(async () => {
        attempts++;
        throw new Error('Claude review timed out after 30 minutes');
      }),
      executeAnalysisPhase: vi.fn(async () => undefined),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) => executor);

    const { runReview } = await import('./review_runner.js');

    await expect(
      runReview({
        executorSelection: 'codex-cli',
        config: { defaultExecutor: 'codex-cli' } as any,
        sharedExecutorOptions: { baseDir: '/tmp' },
        buildPrompt: vi.fn(() => 'prompt'),
        buildAnalysisPrompt: vi.fn(async () => 'analysis'),
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
      execute: vi.fn(async () => {
        attempts++;
        throw new Error('Some other error');
      }),
      executeAnalysisPhase: vi.fn(async () => undefined),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) => executor);

    const { runReview } = await import('./review_runner.js');

    await expect(
      runReview({
        executorSelection: 'codex-cli',
        config: { defaultExecutor: 'codex-cli' } as any,
        sharedExecutorOptions: { baseDir: '/tmp' },
        buildPrompt: vi.fn(() => 'prompt'),
        buildAnalysisPrompt: vi.fn(async () => 'analysis'),
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
      execute: vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          // Codex uses "terminated after inactivity" in its error message
          throw new Error('codex failed after 3 attempts (was terminated after inactivity).');
        }
        return JSON.stringify(goodOutput);
      }),
      executeAnalysisPhase: vi.fn(async () => undefined),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation((name: string) => executor);

    const { runReview } = await import('./review_runner.js');
    const result = await runReview({
      executorSelection: 'codex-cli',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: vi.fn(() => 'prompt'),
      buildAnalysisPrompt: vi.fn(async () => 'analysis'),
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

  test('runReview fails when analysis phase fails before review execution', async () => {
    const executor: Executor = {
      execute: vi.fn(async () =>
        JSON.stringify({ issues: [], recommendations: [], actionItems: [] })
      ),
      executeAnalysisPhase: vi.fn(async () => {
        throw new Error('analysis failed');
      }),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation(() => executor);

    const { runReview } = await import('./review_runner.js');

    await expect(
      runReview({
        executorSelection: 'codex-cli',
        config: { defaultExecutor: 'codex-cli' } as any,
        sharedExecutorOptions: { baseDir: '/tmp' },
        buildPrompt: vi.fn(() => 'prompt'),
        buildAnalysisPrompt: vi.fn(async () => 'analysis'),
        planInfo: {
          planId: '9',
          planTitle: 'Analysis Failure Plan',
          planFilePath: '/tmp/plan.yml',
          baseBranch: 'main',
          changedFiles: [],
        },
      })
    ).rejects.toThrow(/analysis failed/);

    expect(executor.execute).not.toHaveBeenCalled();
  });

  test('runReview uses Claude analysis and resume for claude-only execution', async () => {
    const executor: Executor = {
      execute: vi.fn(async () => {
        throw new Error('should not use plain execute');
      }),
      executeAnalysisPhase: vi.fn(async () => ({ sessionId: 'session-claude' })),
      executeReviewModeWithResume: vi.fn(async () =>
        JSON.stringify({ issues: [], recommendations: ['claude-only'], actionItems: [] })
      ),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation(() => executor);

    const { runReview } = await import('./review_runner.js');
    const result = await runReview({
      executorSelection: 'claude-code',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: vi.fn(() => 'prompt'),
      buildAnalysisPrompt: vi.fn(async () => 'analysis'),
      planInfo: {
        planId: '10',
        planTitle: 'Claude Only Plan',
        planFilePath: '/tmp/plan.yml',
        baseBranch: 'main',
        changedFiles: [],
      },
    });

    expect(executor.executeAnalysisPhase).toHaveBeenCalledTimes(1);
    expect(executor.executeReviewModeWithResume).toHaveBeenCalledTimes(1);
    expect(executor.executeReviewModeWithResume).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'session-claude'
    );
    expect(result.usedExecutors).toEqual(['claude-code']);
    expect(result.reviewResult.recommendations).toEqual(['claude-only']);
  });

  test('runReview retries Claude resume review once on timeout and succeeds', async () => {
    let attempts = 0;

    const executor: Executor = {
      execute: vi.fn(async () => {
        throw new Error('should not use plain execute');
      }),
      executeAnalysisPhase: vi.fn(async () => ({ sessionId: 'session-claude' })),
      executeReviewModeWithResume: vi.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Claude review timed out after 30 minutes');
        }
        return JSON.stringify({
          issues: [],
          recommendations: ['claude resume retry success'],
          actionItems: [],
        });
      }),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation(() => executor);

    const { runReview } = await import('./review_runner.js');
    const result = await runReview({
      executorSelection: 'claude-code',
      config: { defaultExecutor: 'codex-cli' } as any,
      sharedExecutorOptions: { baseDir: '/tmp' },
      buildPrompt: vi.fn(() => 'prompt'),
      buildAnalysisPrompt: vi.fn(async () => 'analysis'),
      planInfo: {
        planId: '11',
        planTitle: 'Claude Resume Retry Plan',
        planFilePath: '/tmp/plan.yml',
        baseBranch: 'main',
        changedFiles: [],
      },
    });

    expect(attempts).toBe(2);
    expect(executor.executeAnalysisPhase).toHaveBeenCalledTimes(1);
    expect(executor.executeReviewModeWithResume).toHaveBeenCalledTimes(2);
    expect(result.usedExecutors).toEqual(['claude-code']);
    expect(result.reviewResult.recommendations).toEqual(['claude resume retry success']);
    expect(unlink).toHaveBeenLastCalledWith('/tmp/review-runner-tests/.tim/tmp/review-guide-11.md');
  });

  test('runReview cleans up review guide when review execution fails after analysis', async () => {
    const executor: Executor = {
      execute: vi.fn(async () => {
        throw new Error('should not use plain execute');
      }),
      executeAnalysisPhase: vi.fn(async () => ({ sessionId: 'session-claude' })),
      executeReviewModeWithResume: vi.fn(async () => {
        throw new Error('resume review failed');
      }),
    };

    vi.mocked(buildExecutorAndLog).mockImplementation(() => executor);

    const { runReview } = await import('./review_runner.js');

    await expect(
      runReview({
        executorSelection: 'claude-code',
        config: { defaultExecutor: 'codex-cli' } as any,
        sharedExecutorOptions: { baseDir: '/tmp' },
        buildPrompt: vi.fn(() => 'prompt'),
        buildAnalysisPrompt: vi.fn(async () => 'analysis'),
        planInfo: {
          planId: '12',
          planTitle: 'Cleanup Failure Plan',
          planFilePath: '/tmp/plan.yml',
          baseBranch: 'main',
          changedFiles: [],
        },
      })
    ).rejects.toThrow(/resume review failed/);

    expect(executor.executeAnalysisPhase).toHaveBeenCalledTimes(1);
    expect(executor.executeReviewModeWithResume).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith('/tmp/review-runner-tests/.tim/tmp/review-guide-12.md');
    expect(unlink).toHaveBeenCalledTimes(2);
  });
});
