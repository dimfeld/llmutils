import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearGitHubTokenCache } from '$common/github/token.js';

import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { invokeCommand, invokeQuery } from '$lib/test-utils/invoke_command.js';

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

describe('pr_status remote functions', () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-plan-pr-status-remote-test-'));
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
    clearGitHubTokenCache();
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    clearGitHubTokenCache();
    currentDb.close(false);
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('getPrStatus returns cached PR status for a plan', async () => {
    const { getPrStatus } = await import('./pr_status.remote.js');

    const payload = await invokeQuery(getPrStatus, { planUuid: 'plan-with-prs' });

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

  test('getPrStatus returns cached PR status matched directly from plan URLs when plan_pr is missing', async () => {
    upsertPlan(currentDb, getOrCreateProject(currentDb, 'repo-plan-pr-status-route').id, {
      uuid: 'plan-with-cached-pr-no-junction',
      planId: 4,
      title: 'Plan with cached PR but no junction',
      filename: '4.plan.md',
      pullRequest: ['https://github.com/example/repo/pulls/1?tab=checks'],
    });

    const { getPrStatus } = await import('./pr_status.remote.js');
    const payload = await invokeQuery(getPrStatus, {
      planUuid: 'plan-with-cached-pr-no-junction',
    });

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

  test('getPrStatus throws 404 for an unknown plan', async () => {
    const { getPrStatus } = await import('./pr_status.remote.js');

    await expect(invokeQuery(getPrStatus, { planUuid: 'missing-plan' })).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
  });

  test('getPrStatus returns invalid PR entries separately when a plan has only invalid pull_request values', async () => {
    const { getPrStatus } = await import('./pr_status.remote.js');

    const payload = await invokeQuery(getPrStatus, { planUuid: 'plan-with-only-invalid-prs' });

    expect(payload).toEqual({
      prUrls: [],
      invalidPrUrls: ['https://github.com/example/repo/issues/3'],
      prStatuses: [],
    });
  });

  test('refreshPrStatus throws 404 for an unknown plan', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const { refreshPrStatus } = await import('./pr_status.remote.js');

    await expect(
      invokeCommand(refreshPrStatus, { planUuid: 'missing-plan' })
    ).rejects.toMatchObject({
      status: 404,
      body: { message: 'Plan not found' },
    });
    expect(syncPlanPrLinks).not.toHaveBeenCalled();
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
  });

  test('refreshPrStatus returns error when GITHUB_TOKEN is not configured', async () => {
    const { refreshPrStatus } = await import('./pr_status.remote.js');

    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    // Without GITHUB_TOKEN, only already-cached PR URLs are synced
    expect(syncPlanPrLinks).toHaveBeenCalledWith(expect.anything(), 'plan-with-prs', [
      'https://github.com/example/repo/pull/1',
    ]);
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
    expect(result.error).toBe('GITHUB_TOKEN not configured');
  });

  test('refreshPrStatus without GITHUB_TOKEN ignores cached-link sync races', async () => {
    syncPlanPrLinks.mockRejectedValueOnce(new Error('cache entry disappeared'));
    const { refreshPrStatus } = await import('./pr_status.remote.js');

    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(result.error).toBe('GITHUB_TOKEN not configured');
  });

  test('refreshPrStatus syncs links and refreshes each PR when GITHUB_TOKEN is configured', async () => {
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

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(syncPlanPrLinks).toHaveBeenCalledWith(currentDb, 'plan-with-prs', [
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/pull/2',
    ]);
    expect(ensurePrStatusFresh).toHaveBeenCalledTimes(2);
    expect(result.error).toBeUndefined();
  });

  test('refreshPrStatus reports errors for failed refreshes', async () => {
    process.env.GITHUB_TOKEN = 'token';
    syncPlanPrLinks.mockResolvedValue([]);
    ensurePrStatusFresh
      .mockResolvedValueOnce({
        status: {
          id: 1,
          pr_url: 'https://github.com/example/repo/pull/1',
          title: 'Fresh PR One',
        },
      })
      .mockRejectedValueOnce(new Error('second PR refresh failed'));

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(result.error).toContain('Some pull request entries had issues');
    expect(result.error).toContain('https://github.com/example/repo/pull/2');
    expect(result.error).toContain('second PR refresh failed');
  });

  test('refreshPrStatus reports error when all refresh calls fail', async () => {
    process.env.GITHUB_TOKEN = 'token';
    syncPlanPrLinks.mockResolvedValue([]);
    ensurePrStatusFresh.mockRejectedValue(new Error('API rate limit exceeded'));

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(result.error).toContain('Some pull request entries had issues');
    expect(result.error).toContain('API rate limit exceeded');
  });

  test('refreshPrStatus continues refresh when syncPlanPrLinks fails for uncached URLs', async () => {
    process.env.GITHUB_TOKEN = 'token';
    syncPlanPrLinks.mockRejectedValue(new Error('sync failed'));
    const freshDetail = {
      status: { pr_url: 'https://github.com/example/repo/pull/1', title: 'Fresh' },
      checks: [],
      reviews: [],
      labels: [],
    };
    ensurePrStatusFresh.mockResolvedValue(freshDetail);

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    // Sync failed but refresh succeeded — no error
    expect(result.error).toBeUndefined();
  });

  test('refreshPrStatus handles plan with no linked PR URLs', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const { refreshPrStatus } = await import('./pr_status.remote.js');

    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-without-prs' });

    expect(result.error).toBeUndefined();
    expect(syncPlanPrLinks).toHaveBeenCalledWith(expect.anything(), 'plan-without-prs', []);
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
  });

  test('refreshPrStatus reports invalid PR entries as errors', async () => {
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

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(refreshPrStatus, {
      planUuid: 'plan-with-mixed-pr-values',
    });

    expect(result.error).toContain('https://github.com/example/repo/issues/5: not a valid PR URL');
  });
});
