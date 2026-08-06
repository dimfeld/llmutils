import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Octokit } from 'octokit';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  collectFailingCheckLogs,
  downloadJobLog,
  listRunJobs,
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

  test('rejects a response that is not plaintext', async () => {
    const downloadJobLogsForWorkflowRun = vi.fn(async () => ({
      data: new Uint8Array([108, 111, 103]),
    }));
    const octokit = createOctokit({ downloadJobLogsForWorkflowRun });

    await expect(downloadJobLog(octokit, 'example', 'repo', 456)).rejects.toThrow(
      'Expected plaintext logs for GitHub Actions job 456'
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

  test('falls back to paginated workflow runs and matches a job by name', async () => {
    const detailsUrl = 'https://ci.example.test/build/123';
    const listWorkflowRunsForRepo = vi.fn();
    const listJobsForWorkflowRun = vi.fn();
    const paginate = vi.fn(
      async (endpoint: unknown, params: Record<string, unknown>): Promise<unknown[]> => {
        if (endpoint === listWorkflowRunsForRepo) {
          expect(params).toEqual({
            owner: 'example',
            repo: 'repo',
            head_sha: 'head-sha',
          });
          return [{ id: 10 }, { id: 11 }];
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

    expect(listWorkflowRunsForRepo).not.toHaveBeenCalled();
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
      error: expect.stringContaining('logs may have expired'),
    });
    expect(manifest[2]).toMatchObject({
      checkName: 'unavailable',
      logPath: null,
      error: 'GitHub is unavailable',
    });
    expect(downloadJobLogsForWorkflowRun).toHaveBeenCalledTimes(3);
  });

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

  test('rejects invalid concurrency values', async () => {
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
        concurrency: 0,
      })
    ).rejects.toThrow('positive safe integer');
    await expect(
      collectFailingCheckLogs({
        octokit,
        owner: 'example',
        repo: 'repo',
        headSha: 'head-sha',
        failingChecks: [check],
        destDir: tempDir,
        concurrency: Number.POSITIVE_INFINITY,
      })
    ).rejects.toThrow('positive safe integer');
  });
});
