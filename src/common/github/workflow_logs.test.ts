import { describe, expect, test, vi } from 'vitest';
import type { Octokit } from 'octokit';

import {
  downloadJobLog,
  listRunJobs,
  parseActionsDetailsUrl,
  type WorkflowJob,
} from './workflow_logs.ts';

function createOctokit(actions: {
  listJobsForWorkflowRun?: unknown;
  downloadJobLogsForWorkflowRun?: unknown;
  paginate?: unknown;
}): Octokit {
  return {
    paginate: actions.paginate,
    rest: {
      actions: {
        listJobsForWorkflowRun: actions.listJobsForWorkflowRun,
        downloadJobLogsForWorkflowRun: actions.downloadJobLogsForWorkflowRun,
      },
    },
  } as unknown as Octokit;
}

describe('parseActionsDetailsUrl', () => {
  test.each([
    [
      'run-only URL',
      'https://github.com/example/repo/actions/runs/123',
      { owner: 'example', repo: 'repo', runId: 123 },
    ],
    [
      'run and job URL',
      'https://github.com/example/repo/actions/runs/123/job/456',
      { owner: 'example', repo: 'repo', runId: 123, jobId: 456 },
    ],
    [
      'run attempt URL',
      'https://github.com/example/repo/actions/runs/123/attempts/2',
      { owner: 'example', repo: 'repo', runId: 123 },
    ],
    [
      'attempt and job URL',
      'https://github.com/example/repo/actions/runs/123/attempts/2/job/456',
      { owner: 'example', repo: 'repo', runId: 123, jobId: 456 },
    ],
    [
      'job and attempt URL',
      'https://github.com/example/repo/actions/runs/123/job/456/attempts/2',
      { owner: 'example', repo: 'repo', runId: 123, jobId: 456 },
    ],
  ])('parses the %s', (_description, url, expected) => {
    expect(parseActionsDetailsUrl(url)).toEqual(expected);
  });

  test.each([
    'not a URL',
    'http://github.com/example/repo/actions/runs/123',
    'https://gitlab.com/example/repo/actions/runs/123',
    'https://github.com.evil.example/example/repo/actions/runs/123',
    'https://github.com/example/repo/actions/runs/not-a-run',
    'https://github.com/example/repo/actions/runs/123/job/not-a-job',
    'https://github.com/example/repo/actions/runs/123/jobs/456',
    'https://github.com/example/repo/actions/runs/123/attempts',
    'https://github.com//repo/actions/runs/123',
    'https://github.com/example//actions/runs/123',
    'https://github.com/example/repo/actions/runs/123/unrelated/456',
  ])('returns null for %s', (url) => {
    expect(parseActionsDetailsUrl(url)).toBeNull();
  });
});

describe('listRunJobs', () => {
  test('uses the latest filter and returns jobs from every paginated page', async () => {
    const pages: WorkflowJob[][] = [
      [
        {
          id: 101,
          name: 'build',
          conclusion: 'failure',
          html_url: 'https://github.com/example/repo/actions/runs/123/job/101',
          steps: [{ name: 'test', conclusion: 'failure' }],
        } as WorkflowJob,
      ],
      [
        {
          id: 102,
          name: 'lint',
          conclusion: 'success',
          html_url: 'https://github.com/example/repo/actions/runs/123/job/102',
          steps: [{ name: 'check', conclusion: 'success' }],
        } as WorkflowJob,
      ],
    ];
    const listJobsForWorkflowRun = vi.fn(
      async (params: { page?: number }): Promise<{ data: { jobs: WorkflowJob[] } }> => ({
        data: { jobs: pages[(params.page ?? 1) - 1] ?? [] },
      })
    );
    const paginate = vi.fn(
      async (
        endpoint: typeof listJobsForWorkflowRun,
        params: Record<string, unknown>
      ): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        expect(params).toEqual({
          owner: 'example',
          repo: 'repo',
          run_id: 123,
          filter: 'latest',
        });

        const results: WorkflowJob[] = [];
        for (let page = 1; page <= pages.length; page += 1) {
          const response = await endpoint({ page });
          results.push(...response.data.jobs);
        }
        return results;
      }
    );
    const octokit = createOctokit({ listJobsForWorkflowRun, paginate });

    await expect(listRunJobs(octokit, 'example', 'repo', 123)).resolves.toEqual(pages.flat());
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(listJobsForWorkflowRun).toHaveBeenCalledTimes(2);
  });

  test('normalizes a missing steps array', async () => {
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(async () => [
      {
        id: 103,
        name: 'no-steps',
        conclusion: null,
        html_url: null,
        steps: undefined,
      },
    ]);
    const octokit = createOctokit({ listJobsForWorkflowRun, paginate });

    await expect(listRunJobs(octokit, 'example', 'repo', 123)).resolves.toEqual([
      {
        id: 103,
        name: 'no-steps',
        conclusion: null,
        html_url: null,
        steps: [],
      },
    ]);
  });
});

describe('downloadJobLog', () => {
  test('returns the plaintext response body unchanged', async () => {
    const downloadJobLogsForWorkflowRun = vi.fn(async () => ({
      data: 'line one\nline two\n',
    }));
    const octokit = createOctokit({ downloadJobLogsForWorkflowRun });

    await expect(downloadJobLog(octokit, 'example', 'repo', 456)).resolves.toEqual({
      content: 'line one\nline two\n',
    });
    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      job_id: 456,
    });
  });

  test('returns an error result for expired logs', async () => {
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    const downloadJobLogsForWorkflowRun = vi.fn(async () => {
      throw notFound;
    });
    const octokit = createOctokit({ downloadJobLogsForWorkflowRun });

    await expect(downloadJobLog(octokit, 'example', 'repo', 456)).resolves.toEqual({
      content: null,
      error: expect.stringContaining('logs may have expired'),
    });
  });

  test('propagates errors other than 404', async () => {
    const error = new Error('GitHub is unavailable');
    const downloadJobLogsForWorkflowRun = vi.fn(async () => {
      throw error;
    });
    const octokit = createOctokit({ downloadJobLogsForWorkflowRun });

    await expect(downloadJobLog(octokit, 'example', 'repo', 456)).rejects.toBe(error);
  });
});
