import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Octokit } from 'octokit';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  collectFailingCheckLogs,
  DEFAULT_LOG_DOWNLOAD_CONCURRENCY,
  downloadJobLog,
  listRunJobs,
  MAX_LOG_DOWNLOAD_CONCURRENCY,
  parseActionsDetailsUrl,
  type FailingCheckLogInput,
  type WorkflowJob,
} from './workflow_logs.ts';

function createOctokit(actions: {
  listJobsForWorkflowRun?: unknown;
  listWorkflowRunsForRepo?: unknown;
  downloadJobLogsForWorkflowRun?: unknown;
  paginate?: unknown;
}): Octokit {
  return {
    paginate: actions.paginate,
    rest: {
      actions: {
        listJobsForWorkflowRun: actions.listJobsForWorkflowRun,
        listWorkflowRunsForRepo: actions.listWorkflowRunsForRepo,
        downloadJobLogsForWorkflowRun: actions.downloadJobLogsForWorkflowRun,
      },
    },
  } as unknown as Octokit;
}

function makeFailingCheck(
  name: string,
  detailsUrl: string | null,
  overrides: Partial<FailingCheckLogInput> = {}
): FailingCheckLogInput {
  return {
    name,
    source: 'check_run',
    conclusion: 'failure',
    detailsUrl,
    required: true,
    ...overrides,
  };
}

function makeJob(id: number, name: string, overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  return {
    id,
    name,
    status: 'completed',
    conclusion: 'failure',
    started_at: '2026-08-06T20:00:00Z',
    completed_at: '2026-08-06T20:05:00Z',
    run_attempt: 2,
    html_url: `https://github.com/example/repo/actions/runs/123/job/${id}`,
    steps: [
      {
        name: 'Run tests',
        number: 1,
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-08-06T20:04:00Z',
        completed_at: '2026-08-06T20:05:00Z',
      },
    ],
    ...overrides,
  } as WorkflowJob;
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
    'https://www.github.com/example/repo/actions/runs/123',
    'https://api.github.com/example/repo/actions/runs/123',
    'https://github.com:444/example/repo/actions/runs/123',
    'https://user:password@github.com/example/repo/actions/runs/123',
    'https://github.com@example.com/example/repo/actions/runs/123',
    'https://github.com./example/repo/actions/runs/123',
    ' https://github.com/example/repo/actions/runs/123',
    'https://github.com/example/repo/actions/runs/123 ',
    'https://github.com/example/repo/actions/runs/not-a-run',
    'https://github.com/example/repo/actions/runs/0',
    'https://github.com/example/repo/actions/runs/-1',
    'https://github.com/example/repo/actions/runs/1.5',
    'https://github.com/example/repo/actions/runs/9007199254740992',
    'https://github.com/example/repo/actions/runs/123/job/not-a-job',
    'https://github.com/example/repo/actions/runs/123/job/0',
    'https://github.com/example/repo/actions/runs/123/job/1.5',
    'https://github.com/example/repo/actions/runs/123/jobs/456',
    'https://github.com/example/repo/actions/runs/123/attempts',
    'https://github.com/example/repo/actions/runs/123/attempts/0',
    'https://github.com/example/repo/actions/runs/123/attempts/1.5',
    'https://github.com/example/repo/actions/runs/123/attempts/1/job/0',
    'https://github.com//repo/actions/runs/123',
    'https://github.com/example//actions/runs/123',
    'https://github.com/example/repo/actions/runs/123/unrelated/456',
    'https://github.com/example/repo/actions/runs/123/job/456/extra',
    'https://github.com/example/repo/actions/runs/123/attempts/2/extra',
    'https://github.com/example/repo/actions/runs/123/attempts/2/job/456/extra',
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
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-08-06T20:00:00Z',
          completed_at: '2026-08-06T20:05:00Z',
          run_attempt: 2,
          html_url: 'https://github.com/example/repo/actions/runs/123/job/101',
          steps: [
            {
              name: 'test',
              number: 1,
              status: 'completed',
              conclusion: 'failure',
              started_at: '2026-08-06T20:04:00Z',
              completed_at: '2026-08-06T20:05:00Z',
            },
          ],
        } as WorkflowJob,
      ],
      [
        {
          id: 102,
          name: 'lint',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-08-06T20:00:00Z',
          completed_at: '2026-08-06T20:01:00Z',
          run_attempt: 2,
          html_url: 'https://github.com/example/repo/actions/runs/123/job/102',
          steps: [
            {
              name: 'check',
              number: 1,
              status: 'completed',
              conclusion: 'success',
              started_at: '2026-08-06T20:00:00Z',
              completed_at: '2026-08-06T20:01:00Z',
            },
          ],
        } as WorkflowJob,
      ],
    ];
    const listJobsForWorkflowRun = vi.fn(
      async (params: {
        owner?: string;
        repo?: string;
        run_id?: number;
        filter?: string;
        page?: number;
      }): Promise<{ data: { jobs: WorkflowJob[] } }> => {
        expect(params).toMatchObject({
          owner: 'example',
          repo: 'repo',
          run_id: 123,
          filter: 'latest',
        });
        return { data: { jobs: pages[(params.page ?? 1) - 1] ?? [] } };
      }
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
          const response = await endpoint({ ...params, page });
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
        steps: null,
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

  test('recognizes a 404 nested in the response error', async () => {
    const notFound = Object.assign(new Error('Not Found'), {
      response: { status: 404 },
    });
    const downloadJobLogsForWorkflowRun = vi.fn(async () => {
      throw notFound;
    });
    const octokit = createOctokit({ downloadJobLogsForWorkflowRun });

    await expect(downloadJobLog(octokit, 'example', 'repo', 456)).resolves.toEqual({
      content: null,
      error: expect.stringContaining('job 456'),
    });
  });

  test('decodes an ArrayBuffer response body as UTF-8', async () => {
    const downloadJobLogsForWorkflowRun = vi.fn(async () => ({
      data: new TextEncoder().encode('binary log\n').buffer,
    }));
    const octokit = createOctokit({ downloadJobLogsForWorkflowRun });

    await expect(downloadJobLog(octokit, 'example', 'repo', 456)).resolves.toEqual({
      content: 'binary log\n',
    });
  });

  test.each([
    ['Uint8Array', new TextEncoder().encode('typed array log\n'), 'typed array log\n'],
    ['Buffer', Buffer.from('buffer log\n', 'utf8'), 'buffer log\n'],
  ])('decodes an %s response body as UTF-8', async (_description, data, expectedContent) => {
    const downloadJobLogsForWorkflowRun = vi.fn(async () => ({ data }));
    const octokit = createOctokit({ downloadJobLogsForWorkflowRun });

    await expect(downloadJobLog(octokit, 'example', 'repo', 456)).resolves.toEqual({
      content: expectedContent,
    });
  });

  test('rejects a response with an unexpected body shape', async () => {
    const downloadJobLogsForWorkflowRun = vi.fn(async () => ({ data: { logs: 'not plaintext' } }));
    const octokit = createOctokit({ downloadJobLogsForWorkflowRun });

    await expect(downloadJobLog(octokit, 'example', 'repo', 456)).rejects.toThrow(
      'Expected plaintext or binary logs for GitHub Actions job 456'
    );
  });

  test('propagates errors other than 404', async () => {
    const error = Object.assign(new Error('GitHub is unavailable'), { status: 500 });
    const downloadJobLogsForWorkflowRun = vi.fn(async () => {
      throw error;
    });
    const octokit = createOctokit({ downloadJobLogsForWorkflowRun });

    await expect(downloadJobLog(octokit, 'example', 'repo', 456)).rejects.toBe(error);
  });
});

describe('collectFailingCheckLogs', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-workflow-logs-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('does no API or filesystem work when there are no failing checks', async () => {
    const listWorkflowRunsForRepo = vi.fn();
    const listJobsForWorkflowRun = vi.fn();
    const downloadJobLogsForWorkflowRun = vi.fn();
    const paginate = vi.fn();
    const octokit = createOctokit({
      listWorkflowRunsForRepo,
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });
    const emptyDestDir = path.join(tempDir, 'empty-destination');

    await expect(
      collectFailingCheckLogs({
        octokit,
        owner: 'example',
        repo: 'repo',
        headSha: 'head-sha',
        failingChecks: [],
        destDir: emptyDestDir,
      })
    ).resolves.toEqual([]);

    expect(listWorkflowRunsForRepo).not.toHaveBeenCalled();
    expect(listJobsForWorkflowRun).not.toHaveBeenCalled();
    expect(downloadJobLogsForWorkflowRun).not.toHaveBeenCalled();
    expect(paginate).not.toHaveBeenCalled();
    await expect(fs.stat(emptyDestDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('writes logs and matches a stale rerun job id by name in the latest attempt', async () => {
    const staleJobUrl = 'https://github.com/example/repo/actions/runs/123/job/456';
    const latestAttemptJob = makeJob(789, 'build');
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        expect(params).toEqual({
          owner: 'example',
          repo: 'repo',
          run_id: 123,
          filter: 'latest',
        });
        return [latestAttemptJob];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => ({
      data: `log for ${params.job_id}\n`,
    }));
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: [makeFailingCheck('build', staleJobUrl)],
      destDir: tempDir,
    });

    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      job_id: 789,
    });
    expect(manifest).toEqual([
      {
        checkName: 'build',
        source: 'check_run',
        conclusion: 'failure',
        detailsUrl: staleJobUrl,
        logPath: path.join(tempDir, 'build.log'),
        failedSteps: ['Run tests'],
        required: true,
      },
    ]);
    await expect(fs.readFile(path.join(tempDir, 'build.log'), 'utf8')).resolves.toBe(
      'log for 789\n'
    );
  });

  test('accepts a present job ID when its display name differs from the check name', async () => {
    const detailsUrl = 'https://github.com/example/repo/actions/runs/124/job/457';
    const latestAttemptJob = makeJob(457, 'reusable-workflow / build');
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        expect(params).toMatchObject({
          owner: 'example',
          repo: 'repo',
          run_id: 124,
          filter: 'latest',
        });
        return [latestAttemptJob];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => ({
      data: `log for ${params.job_id}\n`,
    }));
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: [makeFailingCheck('build', detailsUrl)],
      destDir: tempDir,
    });

    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      job_id: 457,
    });
    expect(manifest[0]).toMatchObject({
      checkName: 'build',
      logPath: path.join(tempDir, 'build.log'),
      failedSteps: ['Run tests'],
    });
  });

  test('keeps a matched non-failing job unresolved without downloading it', async () => {
    const detailsUrl = 'https://github.com/example/repo/actions/runs/125/job/458';
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        expect(params.run_id).toBe(125);
        return [makeJob(458, 'build', { conclusion: 'success' })];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn();
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: [makeFailingCheck('build', detailsUrl)],
      destDir: tempDir,
    });

    expect(manifest).toEqual([
      {
        checkName: 'build',
        source: 'check_run',
        conclusion: 'failure',
        detailsUrl,
        logPath: null,
        failedSteps: [],
        required: true,
        error: expect.stringContaining('success'),
      },
    ]);
    expect(downloadJobLogsForWorkflowRun).not.toHaveBeenCalled();
    await expect(fs.readdir(tempDir)).resolves.toEqual([]);
  });

  test('isolates an ordinary job-list resolution failure to its check', async () => {
    const firstDetailsUrl = 'https://github.com/example/repo/actions/runs/126/job/459';
    const secondDetailsUrl = 'https://github.com/example/repo/actions/runs/127/job/460';
    const jobListError = Object.assign(new Error('job listing failed'), { status: 500 });
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        if (params.run_id === 126) {
          throw jobListError;
        }
        return [makeJob(460, 'build-two')];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => ({
      data: `log for ${params.job_id}\n`,
    }));
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: [
        makeFailingCheck('build-one', firstDetailsUrl),
        makeFailingCheck('build-two', secondDetailsUrl),
      ],
      destDir: tempDir,
    });

    expect(manifest[0]).toMatchObject({
      checkName: 'build-one',
      logPath: null,
      error: 'job listing failed',
    });
    expect(manifest[1]).toMatchObject({
      checkName: 'build-two',
      logPath: path.join(tempDir, 'build-two.log'),
    });
    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledTimes(1);
  });

  test('uses the head-SHA fallback instead of accessing a different repository', async () => {
    const detailsUrl = 'https://github.com/other/repo/actions/runs/128/job/461';
    const listWorkflowRunsForRepo = vi.fn();
    const listJobsForWorkflowRun = vi.fn();
    const jobListParams: Record<string, unknown>[] = [];
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<unknown[]> => {
        if (endpoint === listWorkflowRunsForRepo) {
          expect(params).toEqual({
            owner: 'example',
            repo: 'repo',
            head_sha: 'head-sha',
          });
          return [{ id: 12 }];
        }

        expect(endpoint).toBe(listJobsForWorkflowRun);
        jobListParams.push(params);
        return [makeJob(511, 'build')];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn(async () => ({ data: 'fallback log\n' }));
    const octokit = createOctokit({
      listWorkflowRunsForRepo,
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: [makeFailingCheck('build', detailsUrl)],
      destDir: tempDir,
    });

    expect(jobListParams).toEqual([
      {
        owner: 'example',
        repo: 'repo',
        run_id: 12,
        filter: 'latest',
      },
    ]);
    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      job_id: 511,
    });
    expect(manifest[0]).toMatchObject({
      checkName: 'build',
      detailsUrl,
      logPath: path.join(tempDir, 'build.log'),
    });
  });

  test('falls back to paginated workflow runs and matches a job by name', async () => {
    const detailsUrl = 'https://ci.example.test/build/123';
    const listWorkflowRunsForRepo = vi.fn(
      async (params: {
        page?: number;
      }): Promise<{ data: { workflow_runs: Array<{ id: number }> } }> => {
        return params.page === 1
          ? { data: { workflow_runs: [{ id: 10 }] } }
          : { data: { workflow_runs: [{ id: 11 }] } };
      }
    );
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<unknown[]> => {
        if (endpoint === listWorkflowRunsForRepo) {
          expect(params).toEqual({
            owner: 'example',
            repo: 'repo',
            head_sha: 'head-sha',
          });

          const firstPage = await listWorkflowRunsForRepo({ ...params, page: 1 });
          const secondPage = await listWorkflowRunsForRepo({ ...params, page: 2 });
          return [...firstPage.data.workflow_runs, ...secondPage.data.workflow_runs];
        }

        expect(endpoint).toBe(listJobsForWorkflowRun);
        expect(params).toMatchObject({
          owner: 'example',
          repo: 'repo',
          filter: 'latest',
        });
        return params.run_id === 10 ? [makeJob(501, 'other')] : [makeJob(502, 'build')];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn(async () => ({ data: 'fallback log\n' }));
    const octokit = createOctokit({
      listWorkflowRunsForRepo,
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: [makeFailingCheck('build', detailsUrl, { required: false })],
      destDir: tempDir,
    });

    expect(listWorkflowRunsForRepo).toHaveBeenCalledTimes(2);
    expect(listWorkflowRunsForRepo).toHaveBeenNthCalledWith(1, {
      owner: 'example',
      repo: 'repo',
      head_sha: 'head-sha',
      page: 1,
    });
    expect(listWorkflowRunsForRepo).toHaveBeenNthCalledWith(2, {
      owner: 'example',
      repo: 'repo',
      head_sha: 'head-sha',
      page: 2,
    });
    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledWith({
      owner: 'example',
      repo: 'repo',
      job_id: 502,
    });
    expect(manifest[0]).toMatchObject({
      checkName: 'build',
      detailsUrl,
      logPath: path.join(tempDir, 'build.log'),
      failedSteps: ['Run tests'],
      required: false,
    });
  });

  test('preserves the underlying error when every fallback job listing fails', async () => {
    const detailsUrl = 'https://ci.example.test/build/124';
    const jobListError = Object.assign(new Error('fallback job listing failed'), { status: 500 });
    const listWorkflowRunsForRepo = vi.fn();
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, _params: Record<string, unknown>): Promise<unknown[]> => {
        if (endpoint === listWorkflowRunsForRepo) {
          return [{ id: 13 }, { id: 14 }];
        }

        expect(endpoint).toBe(listJobsForWorkflowRun);
        throw jobListError;
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn();
    const octokit = createOctokit({
      listWorkflowRunsForRepo,
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: [makeFailingCheck('build', detailsUrl)],
      destDir: tempDir,
    });

    expect(manifest[0]).toMatchObject({
      checkName: 'build',
      logPath: null,
      error: 'fallback job listing failed',
    });
    expect(manifest[0].error).not.toContain('No GitHub Actions job matched head SHA');
    expect(downloadJobLogsForWorkflowRun).not.toHaveBeenCalled();
  });

  test('keeps unresolved non-Actions checks with a link and no log', async () => {
    const detailsUrl = 'https://ci.example.test/build/123';
    const listWorkflowRunsForRepo = vi.fn();
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<unknown[]> => {
        if (endpoint === listWorkflowRunsForRepo) {
          return [{ id: 10 }];
        }

        expect(endpoint).toBe(listJobsForWorkflowRun);
        expect(params.run_id).toBe(10);
        return [makeJob(501, 'unrelated')];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn();
    const octokit = createOctokit({
      listWorkflowRunsForRepo,
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: [makeFailingCheck('external-build', detailsUrl, { source: 'status_context' })],
      destDir: tempDir,
    });

    expect(manifest).toEqual([
      {
        checkName: 'external-build',
        source: 'status_context',
        conclusion: 'failure',
        detailsUrl,
        logPath: null,
        failedSteps: [],
        required: true,
        error: expect.stringContaining(detailsUrl),
      },
    ]);
    expect(downloadJobLogsForWorkflowRun).not.toHaveBeenCalled();
    await expect(fs.readdir(tempDir)).resolves.toEqual([]);
  });

  test('preserves unresolved status-context and third-party check entries', async () => {
    const checks = [
      makeFailingCheck('external-status', 'https://ci.example.test/status/1', {
        source: 'status_context',
        required: false,
      }),
      makeFailingCheck('third-party-check', 'https://vercel.com/example/deployments/2', {
        required: true,
      }),
    ];
    const listWorkflowRunsForRepo = vi.fn();
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<unknown[]> => {
        expect(endpoint).toBe(listWorkflowRunsForRepo);
        expect(params).toEqual({
          owner: 'example',
          repo: 'repo',
          head_sha: 'head-sha',
        });
        return [];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn();
    const octokit = createOctokit({
      listWorkflowRunsForRepo,
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: checks,
      destDir: tempDir,
    });

    expect(manifest).toEqual([
      {
        checkName: 'external-status',
        source: 'status_context',
        conclusion: 'failure',
        detailsUrl: 'https://ci.example.test/status/1',
        logPath: null,
        failedSteps: [],
        required: false,
        error: expect.stringContaining('https://ci.example.test/status/1'),
      },
      {
        checkName: 'third-party-check',
        source: 'check_run',
        conclusion: 'failure',
        detailsUrl: 'https://vercel.com/example/deployments/2',
        logPath: null,
        failedSteps: [],
        required: true,
        error: expect.stringContaining('https://vercel.com/example/deployments/2'),
      },
    ]);
    expect(paginate).toHaveBeenCalledTimes(1);
    expect(listJobsForWorkflowRun).not.toHaveBeenCalled();
    expect(downloadJobLogsForWorkflowRun).not.toHaveBeenCalled();
  });

  test('limits concurrent log downloads to the requested bound', async () => {
    const checks = Array.from({ length: 6 }, (_, index) =>
      makeFailingCheck(
        `build-${index + 1}`,
        `https://github.com/example/repo/actions/runs/${index + 1}/job/${index + 101}`
      )
    );
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        const index = Number(params.run_id) - 1;
        return [makeJob(index + 101, `build-${index + 1}`)];
      }
    );
    let activeDownloads = 0;
    let maximumActiveDownloads = 0;
    const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => {
      activeDownloads += 1;
      maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      activeDownloads -= 1;
      return { data: `log for ${params.job_id}\n` };
    });
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: checks,
      destDir: tempDir,
      concurrency: 2,
    });

    expect(maximumActiveDownloads).toBe(2);
    expect(manifest.every((entry) => entry.logPath !== null)).toBe(true);
    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledTimes(checks.length);
  });

  test('caps concurrent log downloads at the maximum', async () => {
    const checks = Array.from({ length: 6 }, (_, index) =>
      makeFailingCheck(
        `build-${index + 1}`,
        `https://github.com/example/repo/actions/runs/${index + 1}/job/${index + 101}`
      )
    );
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        const index = Number(params.run_id) - 1;
        return [makeJob(index + 101, `build-${index + 1}`)];
      }
    );
    let activeDownloads = 0;
    let maximumActiveDownloads = 0;
    const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => {
      activeDownloads += 1;
      maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      activeDownloads -= 1;
      return { data: `log for ${params.job_id}\n` };
    });
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: checks,
      destDir: tempDir,
      concurrency: MAX_LOG_DOWNLOAD_CONCURRENCY + 2,
    });

    expect(maximumActiveDownloads).toBe(MAX_LOG_DOWNLOAD_CONCURRENCY);
  });

  test('uses the default concurrent download bound', async () => {
    const checks = Array.from({ length: 6 }, (_, index) =>
      makeFailingCheck(
        `build-${index + 1}`,
        `https://github.com/example/repo/actions/runs/${index + 1}/job/${index + 101}`
      )
    );
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        const index = Number(params.run_id) - 1;
        return [makeJob(index + 101, `build-${index + 1}`)];
      }
    );
    let activeDownloads = 0;
    let maximumActiveDownloads = 0;
    const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => {
      activeDownloads += 1;
      maximumActiveDownloads = Math.max(maximumActiveDownloads, activeDownloads);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      activeDownloads -= 1;
      return { data: `log for ${params.job_id}\n` };
    });
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: checks,
      destDir: tempDir,
    });

    expect(maximumActiveDownloads).toBe(DEFAULT_LOG_DOWNLOAD_CONCURRENCY);
  });

  test('captures expired and non-404 errors per check without aborting the batch', async () => {
    const checks = [
      makeFailingCheck('success', 'https://github.com/example/repo/actions/runs/1/job/101'),
      makeFailingCheck('expired', 'https://github.com/example/repo/actions/runs/2/job/102'),
      makeFailingCheck('unavailable', 'https://github.com/example/repo/actions/runs/3/job/103'),
    ];
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        const runId = Number(params.run_id);
        return [makeJob(100 + runId, checks[runId - 1].name)];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => {
      if (params.job_id === 102) {
        throw Object.assign(new Error('Not Found'), { status: 404 });
      }
      if (params.job_id === 103) {
        throw Object.assign(new Error('GitHub is unavailable'), { status: 503 });
      }
      return { data: 'successful log\n' };
    });
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: checks,
      destDir: tempDir,
    });

    expect(manifest[0]).toMatchObject({
      checkName: 'success',
      logPath: path.join(tempDir, 'success.log'),
    });
    expect(manifest[1]).toMatchObject({
      checkName: 'expired',
      logPath: null,
      failedSteps: ['Run tests'],
      error: expect.stringContaining('logs may have expired'),
    });
    expect(manifest[2]).toMatchObject({
      checkName: 'unavailable',
      logPath: null,
      failedSteps: ['Run tests'],
      error: 'GitHub is unavailable',
    });
    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledTimes(3);
  });

  test.each([401, 403, 429])(
    'propagates systemic HTTP %s errors during job resolution',
    async (status) => {
      const systemicError = Object.assign(new Error(`GitHub returned ${status}`), { status });
      const listJobsForWorkflowRun = vi.fn();
      const paginate = vi.fn(async () => {
        throw systemicError;
      });
      const octokit = createOctokit({ listJobsForWorkflowRun, paginate });

      await expect(
        collectFailingCheckLogs({
          octokit,
          owner: 'example',
          repo: 'repo',
          headSha: 'head-sha',
          failingChecks: [
            makeFailingCheck('build', 'https://github.com/example/repo/actions/runs/1/job/101'),
          ],
          destDir: tempDir,
        })
      ).rejects.toBe(systemicError);
    }
  );

  test.each([401, 403, 429])(
    'propagates systemic HTTP %s errors during log download',
    async (status) => {
      const systemicError = Object.assign(new Error(`GitHub returned ${status}`), { status });
      const listJobsForWorkflowRun = vi.fn();
      const paginate = vi.fn(async () => [makeJob(101, 'build')]);
      const downloadJobLogsForWorkflowRun = vi.fn(async () => {
        throw systemicError;
      });
      const octokit = createOctokit({
        listJobsForWorkflowRun,
        downloadJobLogsForWorkflowRun,
        paginate,
      });

      await expect(
        collectFailingCheckLogs({
          octokit,
          owner: 'example',
          repo: 'repo',
          headSha: 'head-sha',
          failingChecks: [
            makeFailingCheck('build', 'https://github.com/example/repo/actions/runs/1/job/101'),
          ],
          destDir: tempDir,
        })
      ).rejects.toBe(systemicError);
    }
  );

  test.each([403, 429])(
    'stops queued downloads and drains in-flight workers after systemic HTTP %s errors',
    async (status) => {
      const checks = Array.from({ length: MAX_LOG_DOWNLOAD_CONCURRENCY + 2 }, (_, index) =>
        makeFailingCheck(
          `build-${index + 1}`,
          `https://github.com/example/repo/actions/runs/${index + 1}/job/${index + 101}`
        )
      );
      const systemicError = Object.assign(new Error(`GitHub returned ${status}`), { status });
      const listJobsForWorkflowRun = vi.fn();
      const paginate = vi.fn(
        async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
          expect(endpoint).toBe(listJobsForWorkflowRun);
          const runId = Number(params.run_id);
          return [makeJob(runId + 100, `build-${runId}`)];
        }
      );
      const startedJobIds: number[] = [];
      const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => {
        startedJobIds.push(params.job_id);
        if (params.job_id === 101) {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          throw systemicError;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        return { data: `log for ${params.job_id}\n` };
      });
      const octokit = createOctokit({
        listJobsForWorkflowRun,
        downloadJobLogsForWorkflowRun,
        paginate,
      });
      const destDir = path.join(tempDir, 'logs');

      await expect(
        collectFailingCheckLogs({
          octokit,
          owner: 'example',
          repo: 'repo',
          headSha: 'head-sha',
          failingChecks: checks,
          destDir,
        })
      ).rejects.toBe(systemicError);

      expect(startedJobIds).toEqual([101, 102, 103, 104]);
      expect(startedJobIds).not.toContain(105);
      expect(startedJobIds).not.toContain(106);

      await fs.rm(destDir, { recursive: true, force: true });
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      await expect(fs.stat(destDir)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  test('uses safe deterministic filenames and disambiguates collisions', async () => {
    const checks = [
      makeFailingCheck(
        '../../unsafe/name',
        'https://github.com/example/repo/actions/runs/1/job/101'
      ),
      makeFailingCheck('unsafe name', 'https://github.com/example/repo/actions/runs/2/job/102'),
    ];
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        const runId = Number(params.run_id);
        return [makeJob(100 + runId, checks[runId - 1].name)];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => ({
      data: `log for ${params.job_id}\n`,
    }));
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: checks,
      destDir: tempDir,
    });

    expect(manifest.map((entry) => entry.logPath)).toEqual([
      path.join(tempDir, 'unsafe-name.log'),
      path.join(tempDir, 'unsafe-name-2.log'),
    ]);
    expect(manifest.every((entry) => entry.logPath?.startsWith(`${tempDir}${path.sep}`))).toBe(
      true
    );
    await expect(fs.readFile(path.join(tempDir, 'unsafe-name.log'), 'utf8')).resolves.toBe(
      'log for 101\n'
    );
    await expect(fs.readFile(path.join(tempDir, 'unsafe-name-2.log'), 'utf8')).resolves.toBe(
      'log for 102\n'
    );
  });

  test('keeps empty and Windows-reserved names contained and unique', async () => {
    const checks = ['', '.', '..', 'CON', 'con', 'PRN', 'COM1', 'LPT9'].map((name, index) =>
      makeFailingCheck(
        name,
        `https://github.com/example/repo/actions/runs/${index + 1}/job/${index + 101}`
      )
    );
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<WorkflowJob[]> => {
        expect(endpoint).toBe(listJobsForWorkflowRun);
        const index = Number(params.run_id) - 1;
        return [makeJob(index + 101, checks[index].name)];
      }
    );
    const downloadJobLogsForWorkflowRun = vi.fn(async (params: { job_id: number }) => ({
      data: `log for ${params.job_id}\n`,
    }));
    const octokit = createOctokit({
      listJobsForWorkflowRun,
      downloadJobLogsForWorkflowRun,
      paginate,
    });

    const manifest = await collectFailingCheckLogs({
      octokit,
      owner: 'example',
      repo: 'repo',
      headSha: 'head-sha',
      failingChecks: checks,
      destDir: tempDir,
    });

    const logPaths = manifest.map((entry) => entry.logPath);
    const resolvedLogPaths = logPaths.filter((logPath): logPath is string => logPath !== null);
    expect(resolvedLogPaths).toHaveLength(checks.length);
    expect(
      new Set(resolvedLogPaths.map((logPath) => logPath.toLocaleLowerCase('en-US'))).size
    ).toBe(checks.length);

    const windowsReservedBases = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9']);
    for (const logPath of resolvedLogPaths) {
      const relativePath = path.relative(tempDir, logPath);
      expect(relativePath).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(path.isAbsolute(relativePath)).toBe(false);
      expect(relativePath).toMatch(/^[A-Za-z0-9_-]+\.log$/);
      expect(windowsReservedBases.has(path.basename(relativePath, '.log').toUpperCase())).toBe(
        false
      );
      await expect(fs.readFile(logPath, 'utf8')).resolves.toMatch(/^log for \d+\n$/);
    }

    expect(manifest.slice(0, 3).map((entry) => path.basename(entry.logPath ?? ''))).toEqual([
      'check.log',
      'check-2.log',
      'check-3.log',
    ]);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid concurrency value %s',
    async (concurrency) => {
      const octokit = createOctokit({});
      const check = makeFailingCheck('build', null);

      await expect(
        collectFailingCheckLogs({
          octokit,
          owner: 'example',
          repo: 'repo',
          headSha: 'head-sha',
          failingChecks: [check],
          destDir: tempDir,
          concurrency,
        })
      ).rejects.toThrow('positive safe integer');
    }
  );
});
