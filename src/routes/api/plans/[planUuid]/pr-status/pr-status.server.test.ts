import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { getOrCreateProject } from '$tim/db/project.js';

let currentDb: Database;
const syncPlanPrLinks = vi.fn();
const ensurePrStatusFresh = vi.fn();

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

vi.mock('$common/github/pr_status_service.js', () => ({
  syncPlanPrLinks,
  ensurePrStatusFresh,
}));

describe('/api/plans/[planUuid]/pr-status', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-pr-status-route-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    const project = getOrCreateProject(currentDb, 'repo-plan-pr-status-route');

    upsertPlan(currentDb, project.id, {
      uuid: 'plan-with-prs',
      planId: 1,
      title: 'Plan with PRs',
      filename: '1.plan.md',
      pullRequest: [
        'https://github.com/example/repo/pull/1',
        'https://github.com/example/repo/pull/2',
      ],
    });
    upsertPlan(currentDb, project.id, {
      uuid: 'plan-without-prs',
      planId: 2,
      title: 'Plan without PRs',
      filename: '2.plan.md',
    });
    upsertPlan(currentDb, project.id, {
      uuid: 'plan-with-only-invalid-prs',
      planId: 3,
      title: 'Plan with only invalid PRs',
      filename: '3.plan.md',
      pullRequest: ['https://github.com/example/repo/issues/3'],
    });

    const cachedPr = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/1',
      owner: 'example',
      repo: 'repo',
      prNumber: 1,
      title: 'Cached PR',
      state: 'open',
      draft: false,
      checkRollupState: 'success',
      lastFetchedAt: new Date().toISOString(),
    });
    linkPlanToPr(currentDb, 'plan-with-prs', cachedPr.status.id);

    syncPlanPrLinks.mockReset();
    ensurePrStatusFresh.mockReset();
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('GET returns cached PR status for a plan', async () => {
    const { GET } = await import('./+server.js');

    const response = await GET({
      params: { planUuid: 'plan-with-prs' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      prUrls: ['https://github.com/example/repo/pull/1', 'https://github.com/example/repo/pull/2'],
      invalidPrUrls: [],
    });
    expect(payload.prStatuses).toHaveLength(1);
    expect(payload.prStatuses[0]).toMatchObject({
      status: {
        pr_url: 'https://github.com/example/repo/pull/1',
        title: 'Cached PR',
      },
    });
  });

  test('GET returns cached PR status matched directly from plan URLs when plan_pr is missing', async () => {
    upsertPlan(currentDb, getOrCreateProject(currentDb, 'repo-plan-pr-status-route').id, {
      uuid: 'plan-with-cached-pr-no-junction',
      planId: 4,
      title: 'Plan with cached PR but no junction',
      filename: '4.plan.md',
      pullRequest: ['https://github.com/example/repo/pulls/1?tab=checks'],
    });

    const { GET } = await import('./+server.js');
    const response = await GET({
      params: { planUuid: 'plan-with-cached-pr-no-junction' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.prUrls).toEqual(['https://github.com/example/repo/pull/1']);
    expect(payload.invalidPrUrls).toEqual([]);
    expect(payload.prStatuses).toHaveLength(1);
    expect(payload.prStatuses[0]).toMatchObject({
      status: {
        pr_url: 'https://github.com/example/repo/pull/1',
        title: 'Cached PR',
      },
    });
  });

  test('GET returns 404 for an unknown plan', async () => {
    const { GET } = await import('./+server.js');

    const response = await GET({
      params: { planUuid: 'missing-plan' },
    } as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Plan not found' });
  });

  test('GET returns invalid PR entries separately when a plan has only invalid pull_request values', async () => {
    const { GET } = await import('./+server.js');

    const response = await GET({
      params: { planUuid: 'plan-with-only-invalid-prs' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({
      prUrls: [],
      invalidPrUrls: ['https://github.com/example/repo/issues/3'],
      prStatuses: [],
    });
  });

  test('POST returns 404 for an unknown plan', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const { POST } = await import('./+server.js');

    const response = await POST({
      params: { planUuid: 'missing-plan' },
    } as never);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Plan not found' });
    expect(syncPlanPrLinks).not.toHaveBeenCalled();
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
  });

  test('POST returns cached data and an error when GITHUB_TOKEN is not configured', async () => {
    const { POST } = await import('./+server.js');

    const response = await POST({
      params: { planUuid: 'plan-with-prs' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    // Without GITHUB_TOKEN, only already-cached PR URLs are synced
    expect(syncPlanPrLinks).toHaveBeenCalledWith(expect.anything(), 'plan-with-prs', [
      'https://github.com/example/repo/pull/1',
    ]);
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
    expect(payload.error).toBe('GITHUB_TOKEN not configured');
    expect(payload.prUrls).toEqual([
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/pull/2',
    ]);
    expect(payload.invalidPrUrls).toEqual([]);
    expect(payload.prStatuses).toHaveLength(1);
  });

  test('POST without GITHUB_TOKEN ignores cached-link sync races and still returns cached data', async () => {
    syncPlanPrLinks.mockRejectedValueOnce(new Error('cache entry disappeared'));
    const { POST } = await import('./+server.js');

    const response = await POST({
      params: { planUuid: 'plan-with-prs' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.error).toBe('GITHUB_TOKEN not configured');
    expect(payload.prStatuses).toHaveLength(1);
  });

  test('POST syncs links and refreshes each PR when GITHUB_TOKEN is configured', async () => {
    process.env.GITHUB_TOKEN = 'token';
    syncPlanPrLinks.mockResolvedValue([]);
    ensurePrStatusFresh
      .mockResolvedValueOnce({
        status: {
          id: 1,
          pr_url: 'https://github.com/example/repo/pull/1',
          title: 'PR One',
        },
      })
      .mockResolvedValueOnce({
        status: {
          id: 2,
          pr_url: 'https://github.com/example/repo/pull/2',
          title: 'PR Two',
        },
      });

    const { POST } = await import('./+server.js');
    const response = await POST({
      params: { planUuid: 'plan-with-prs' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(syncPlanPrLinks).toHaveBeenCalledWith(currentDb, 'plan-with-prs', [
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/pull/2',
    ]);
    expect(ensurePrStatusFresh).toHaveBeenCalledTimes(2);
    expect(payload.prStatuses).toEqual([
      {
        status: {
          id: 1,
          pr_url: 'https://github.com/example/repo/pull/1',
          title: 'PR One',
        },
      },
      {
        status: {
          id: 2,
          pr_url: 'https://github.com/example/repo/pull/2',
          title: 'PR Two',
        },
      },
    ]);
  });

  test('POST returns fresh results where available and cached data for failed refreshes', async () => {
    process.env.GITHUB_TOKEN = 'token';
    syncPlanPrLinks.mockResolvedValue([]);
    const cachedPrTwo = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/2',
      owner: 'example',
      repo: 'repo',
      prNumber: 2,
      title: 'Cached PR Two',
      state: 'open',
      draft: false,
      checkRollupState: 'pending',
      lastFetchedAt: new Date().toISOString(),
    });
    linkPlanToPr(currentDb, 'plan-with-prs', cachedPrTwo.status.id);
    ensurePrStatusFresh
      .mockResolvedValueOnce({
        status: {
          id: 1,
          pr_url: 'https://github.com/example/repo/pull/1',
          title: 'Fresh PR One',
        },
      })
      .mockRejectedValueOnce(new Error('second PR refresh failed'));

    const { POST } = await import('./+server.js');
    const response = await POST({
      params: { planUuid: 'plan-with-prs' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.prStatuses).toHaveLength(2);
    expect(payload.prStatuses[0]).toEqual({
      status: {
        id: 1,
        pr_url: 'https://github.com/example/repo/pull/1',
        title: 'Fresh PR One',
      },
    });
    expect(payload.prStatuses[1]).toMatchObject({
      status: {
        id: cachedPrTwo.status.id,
        pr_url: 'https://github.com/example/repo/pull/2',
        title: 'Cached PR Two',
      },
      checks: [],
      reviews: [],
      labels: [],
    });
    expect(payload.error).toContain('Some pull request entries had issues');
    expect(payload.error).toContain('https://github.com/example/repo/pull/2');
    expect(payload.error).toContain('second PR refresh failed');
  });

  test('POST falls back to cached data when all refresh calls fail', async () => {
    process.env.GITHUB_TOKEN = 'token';
    syncPlanPrLinks.mockResolvedValue([]);
    ensurePrStatusFresh.mockRejectedValue(new Error('API rate limit exceeded'));

    const { POST } = await import('./+server.js');
    const response = await POST({
      params: { planUuid: 'plan-with-prs' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.error).toContain('Some pull request entries had issues');
    expect(payload.error).toContain('API rate limit exceeded');
    expect(payload.prUrls).toEqual([
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/pull/2',
    ]);
    expect(payload.invalidPrUrls).toEqual([]);
    // PR 1 has cached data, PR 2 does not
    expect(payload.prStatuses).toHaveLength(1);
    expect(payload.prStatuses[0]).toMatchObject({
      status: { pr_url: 'https://github.com/example/repo/pull/1' },
    });
  });

  test('POST continues refresh when syncPlanPrLinks fails for uncached URLs', async () => {
    process.env.GITHUB_TOKEN = 'token';
    syncPlanPrLinks.mockRejectedValue(new Error('sync failed'));
    const freshDetail = {
      status: { pr_url: 'https://github.com/example/repo/pull/1', title: 'Fresh' },
      checks: [],
      reviews: [],
      labels: [],
    };
    ensurePrStatusFresh.mockResolvedValue(freshDetail);

    const { POST } = await import('./+server.js');
    const response = await POST({
      params: { planUuid: 'plan-with-prs' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    // Sync failed but refresh succeeded — no error
    expect(payload.error).toBeUndefined();
    expect(payload.prStatuses).toHaveLength(2);
  });

  test('POST returns an empty result when the plan has no linked PR URLs', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const { POST } = await import('./+server.js');

    const response = await POST({
      params: { planUuid: 'plan-without-prs' },
    } as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      prUrls: [],
      invalidPrUrls: [],
      prStatuses: [],
    });
    expect(syncPlanPrLinks).toHaveBeenCalledWith(expect.anything(), 'plan-without-prs', []);
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
  });

  test('POST returns normalized valid URLs and invalid PR entries separately', async () => {
    process.env.GITHUB_TOKEN = 'token';
    syncPlanPrLinks.mockResolvedValue([]);
    ensurePrStatusFresh.mockResolvedValue({
      status: {
        id: 1,
        pr_url: 'https://github.com/example/repo/pull/1',
        title: 'PR One',
      },
      checks: [],
      reviews: [],
      labels: [],
    });

    upsertPlan(currentDb, getOrCreateProject(currentDb, 'repo-plan-pr-status-route').id, {
      uuid: 'plan-with-mixed-pr-values',
      planId: 5,
      title: 'Plan with mixed PR values',
      filename: '5.plan.md',
      pullRequest: [
        'https://github.com/example/repo/pulls/1?tab=checks',
        'https://github.com/example/repo/issues/5',
      ],
    });

    const { POST } = await import('./+server.js');
    const response = await POST({
      params: { planUuid: 'plan-with-mixed-pr-values' },
    } as never);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.prUrls).toEqual(['https://github.com/example/repo/pull/1']);
    expect(payload.invalidPrUrls).toEqual(['https://github.com/example/repo/issues/5']);
    expect(payload.error).toContain('https://github.com/example/repo/issues/5: not a valid PR URL');
  });
});
