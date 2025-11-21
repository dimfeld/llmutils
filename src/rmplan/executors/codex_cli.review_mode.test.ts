import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

describe('Codex CLI review mode', () => {
  let moduleMocker: ModuleMocker;

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  test('runs reviewer once and returns aggregated output', async () => {
    const logMessages: string[] = [];

    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock((...args: any[]) => logMessages.push(args.map(String).join(' '))),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({ failed: false })),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

    const codexStep = mock(async () => 'REVIEW OUTPUT');

    const planInfo = {
      planId: 'review-plan',
      planTitle: 'Review Plan',
      planFilePath: '/tmp/repo-review/plan.yml',
      executionMode: 'review' as const,
      captureOutput: 'result' as const,
    };

    const result = await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      planInfo,
      '/tmp/repo-review',
      undefined,
      {},
      codexStep
    );

    expect(codexStep).toHaveBeenCalledWith('REVIEW PROMPT CONTENT', '/tmp/repo-review', {});
    expect(result?.content).toBe('REVIEW OUTPUT');
    expect(result?.steps?.[0].title).toBe('Codex Reviewer');
    expect(result?.steps?.[0].body).toBe('REVIEW OUTPUT');
    expect(logMessages.some((msg) => msg.includes('review-only mode'))).toBeTrue();
  });

  test('marks review run as failed when the reviewer reports failure', async () => {
    await moduleMocker.mock('../../logging.ts', () => ({
      log: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => '/tmp/repo-review'),
    }));

    await moduleMocker.mock('./failure_detection.ts', () => ({
      parseFailedReport: mock(() => ({
        failed: true,
        summary: 'failed',
        details: { requirements: '', problems: 'bad news' },
      })),
    }));

    const { executeReviewMode } = await import('./codex_cli/review_mode.ts');

    const codexStep = mock(async () => 'FAILED OUTPUT');

    const result = await executeReviewMode(
      'REVIEW PROMPT CONTENT',
      {
        planId: 'review-plan',
        planTitle: 'Review Plan',
        planFilePath: '/tmp/repo-review/plan.yml',
        executionMode: 'review',
        captureOutput: 'result',
      },
      '/tmp/repo-review',
      undefined,
      {},
      codexStep
    );

    expect(result?.success).toBeFalse();
    expect(result?.failureDetails?.sourceAgent).toBe('reviewer');
    expect(result?.failureDetails?.problems).toBe('bad news');
    expect(result?.content).toBe('FAILED OUTPUT');
  });
});
