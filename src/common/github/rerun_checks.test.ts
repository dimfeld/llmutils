import { describe, expect, test, vi } from 'vitest';
import type { Octokit } from 'octokit';

import { describeRerunChecksResult, rerunActionsChecks } from './rerun_checks.ts';

/** A fake of the two Actions endpoints. `runStatuses` maps run IDs to their status. */
function createOctokit(
  runStatuses: Record<number, string>,
  rerunError?: Error
): {
  octokit: Octokit;
  getWorkflowRun: ReturnType<typeof vi.fn>;
  reRunWorkflowFailedJobs: ReturnType<typeof vi.fn>;
} {
  const getWorkflowRun = vi.fn(async ({ run_id }: { run_id: number }) => ({
    data: { id: run_id, status: runStatuses[run_id] ?? 'completed' },
  }));
  const reRunWorkflowFailedJobs = vi.fn(async () => {
    if (rerunError) {
      throw rerunError;
    }
    return { status: 201 };
  });
  const octokit = {
    rest: { actions: { getWorkflowRun, reRunWorkflowFailedJobs } },
  } as unknown as Octokit;
  return { octokit, getWorkflowRun, reRunWorkflowFailedJobs };
}

const jobUrl = (runId: number, jobId: number): string =>
  `https://github.com/example/repo/actions/runs/${runId}/job/${jobId}`;

describe('rerunActionsChecks', () => {
  test('reruns each workflow run once, even when it has several cancelled checks', async () => {
    const { octokit, reRunWorkflowFailedJobs } = createOctokit({});

    const result = await rerunActionsChecks(octokit, 'example', 'repo', [
      { name: 'test', detailsUrl: jobUrl(10, 1) },
      { name: 'lint', detailsUrl: jobUrl(10, 2) },
      { name: 'e2e', detailsUrl: jobUrl(20, 3) },
    ]);

    expect(result).toEqual({
      rerun: ['test', 'lint', 'e2e'],
      stillRunning: [],
      unsupported: [],
      errors: [],
    });
    expect(reRunWorkflowFailedJobs.mock.calls.map(([args]) => args)).toEqual([
      { owner: 'example', repo: 'repo', run_id: 10 },
      { owner: 'example', repo: 'repo', run_id: 20 },
    ]);
  });

  test('does not rerun a workflow run that has not finished', async () => {
    const { octokit, reRunWorkflowFailedJobs } = createOctokit({ 10: 'in_progress' });

    const result = await rerunActionsChecks(octokit, 'example', 'repo', [
      { name: 'test', detailsUrl: jobUrl(10, 1) },
    ]);

    expect(result.stillRunning).toEqual(['test']);
    expect(result.rerun).toEqual([]);
    expect(reRunWorkflowFailedJobs).not.toHaveBeenCalled();
  });

  test('skips checks that are not Actions jobs of the repository', async () => {
    const { octokit, getWorkflowRun } = createOctokit({});

    const result = await rerunActionsChecks(octokit, 'example', 'repo', [
      { name: 'vercel', detailsUrl: 'https://vercel.com/example/repo/abc' },
      { name: 'status', detailsUrl: null },
      { name: 'other-repo', detailsUrl: 'https://github.com/other/repo/actions/runs/5/job/6' },
      { name: 'same-repo', detailsUrl: 'https://github.com/Example/Repo/actions/runs/7/job/8' },
    ]);

    expect(result.unsupported).toEqual(['vercel', 'status', 'other-repo']);
    expect(result.rerun).toEqual(['same-repo']);
    expect(getWorkflowRun).toHaveBeenCalledTimes(1);
  });

  test('records the error when GitHub refuses the rerun', async () => {
    const { octokit } = createOctokit({}, new Error('Resource not accessible by integration'));

    const result = await rerunActionsChecks(octokit, 'example', 'repo', [
      { name: 'test', detailsUrl: jobUrl(10, 1) },
    ]);

    expect(result.rerun).toEqual([]);
    expect(result.errors).toEqual([
      { checks: ['test'], message: 'Resource not accessible by integration' },
    ]);
  });
});

describe('describeRerunChecksResult', () => {
  test('names the checks in each group', () => {
    const description = describeRerunChecksResult({
      rerun: ['test'],
      stillRunning: ['lint'],
      unsupported: ['vercel'],
      errors: [{ checks: ['e2e'], message: 'Forbidden' }],
    });
    for (const name of ['test', 'lint', 'vercel', 'e2e', 'Forbidden']) {
      expect(description).toContain(name);
    }
  });

  test('says when there was nothing to rerun', () => {
    expect(
      describeRerunChecksResult({ rerun: [], stillRunning: [], unsupported: [], errors: [] })
    ).toBe('No checks to rerun.');
  });
});
