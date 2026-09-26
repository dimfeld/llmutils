import { describe, expect, test, vi } from 'vitest';
import {
  buildSquashRebasePrompt,
  runPlanDevelopmentMode,
  type PlanDevelopmentModeOptions,
} from './development_mode.js';
import type { Executor } from '../../executors/types.js';

function options(executor: Executor, useJj: boolean): PlanDevelopmentModeOptions {
  return {
    executor,
    planId: '42',
    planTitle: 'Test plan',
    planFilePath: '/tmp/plan.yml',
    branch: 'feature/plan',
    useJj,
  };
}

describe('squash-rebase development mode', () => {
  test.each([false, true])('builds %s VCS instructions with a moving-main retry', (useJj) => {
    const executor = { execute: vi.fn() } as unknown as Executor;
    const prompt = buildSquashRebasePrompt(options(executor, useJj));
    expect(prompt).toContain('Fetch the latest `main` state from `origin` before rewriting');
    expect(prompt).toContain("Squash the plan's commits into one commit");
    expect(prompt).toContain('resolve each conflict');
    expect(prompt).toContain('Push the rebased commit directly to `origin/main` as a fast-forward');
    expect(prompt).toContain('Do not create a pull request or leave the plan branch behind');
    expect(prompt).toContain(useJj ? '`main@origin`' : '`origin/main`');
  });

  test('runs a bare finalization turn and rejects a reported failure', async () => {
    const execute = vi.fn(async () => ({
      success: false,
      content: 'FAILED: conflict requires a decision',
      failureDetails: { requirements: '', problems: 'conflict requires a decision' },
    }));
    const executor = { execute } as unknown as Executor;
    await expect(runPlanDevelopmentMode(options(executor, false))).rejects.toThrow(
      'conflict requires a decision'
    );
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('feature/plan'),
      expect.objectContaining({ executionMode: 'bare', planId: '42' })
    );
  });

  test('rejects a finalization turn without a result', async () => {
    const executor = { execute: vi.fn(async () => undefined) } as unknown as Executor;
    await expect(runPlanDevelopmentMode(options(executor, false))).rejects.toThrow(
      'Plan branch finalization failed'
    );
  });
});
