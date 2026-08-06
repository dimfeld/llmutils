import { beforeEach, describe, expect, test, vi } from 'vitest';

const { getServerContextMock, listRecentJobsMock } = vi.hoisted(() => ({
  getServerContextMock: vi.fn(),
  listRecentJobsMock: vi.fn(),
}));

vi.mock('$lib/server/init.js', () => ({
  getServerContext: getServerContextMock,
}));

vi.mock('$tim/db/job.js', () => ({
  listRecentJobs: listRecentJobsMock,
}));

vi.mock('$tim/db/review.js', () => ({
  getLatestReviewByPlanUuid: vi.fn(),
  getLatestReviewByPrUrl: vi.fn(),
}));

import { load } from './+page.server';

describe('activity page server output for CI fix jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getServerContextMock.mockResolvedValue({ db: {} });
  });

  test('routes ci-fix output to the pull request', async () => {
    listRecentJobsMock.mockReturnValue([
      {
        id: 1,
        project_id: 7,
        job_type: 'ci-fix',
        plan_id: 42,
        plan_uuid: 'plan-42',
        plan_title: 'Repair CI',
        pr_url: 'https://github.com/owner/repo/pull/42',
        pr_number: 42,
        workspace_path: '/tmp/workspace',
        git_remote: null,
        status: 'completed',
        started_at: '2026-08-06T10:00:00.000Z',
        finished_at: '2026-08-06T10:05:00.000Z',
        created_at: '2026-08-06T10:00:00.000Z',
        updated_at: '2026-08-06T10:05:00.000Z',
        build_sha: null,
        build_time: null,
        binary_path: null,
      },
    ]);

    const result = await load({
      parent: async () => ({ projectId: '7' }),
    } as never);

    expect(listRecentJobsMock).toHaveBeenCalledWith({}, { projectId: 7 });
    expect(result.activity).toEqual([
      expect.objectContaining({
        job_type: 'ci-fix',
        outputHref: '/projects/7/prs/42',
        outputExternal: false,
      }),
    ]);
  });
});
