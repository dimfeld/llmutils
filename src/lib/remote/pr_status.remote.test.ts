import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { clearGitHubTokenCache } from '$common/github/token.js';

import { upsertBranchMergeRequirements } from '$tim/db/branch_merge_requirements.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPlan } from '$tim/db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '$tim/db/pr_status.js';
import { getOrCreateProject } from '$tim/db/project.js';
import { invokeCommand, invokeQuery } from '$lib/test-utils/invoke_command.js';

let currentDb: Database;
let currentWebhookServerUrl: string | null = null;
const syncPlanPrLinks = vi.fn();
const ensurePrStatusFresh = vi.fn();
const refreshPrStatusFromApi = vi.fn();
const ingestWebhookEvents = vi.fn();
const mockEmitPrUpdatesForIngestResult = vi.fn();
const mockSessionManager = { emitPrUpdate: vi.fn() };
const { setPullRequestDraftState } = vi.hoisted(() => ({
  setPullRequestDraftState: vi.fn(),
}));

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: {} as never,
    db: currentDb,
  }),
}));

vi.mock('$common/github/pr_status_service.js', () => ({
  syncPlanPrLinks,
  ensurePrStatusFresh,
  refreshPrStatus: refreshPrStatusFromApi,
}));

vi.mock('$common/github/pull_requests.js', async () => {
  const actual = await vi.importActual<typeof import('$common/github/pull_requests.js')>(
    '$common/github/pull_requests.js'
  );

  return {
    ...actual,
    setPullRequestDraftState,
  };
});

vi.mock('$common/github/webhook_client.js', () => ({
  getWebhookServerUrl: () => currentWebhookServerUrl,
}));

vi.mock('$common/github/webhook_ingest.js', () => ({
  ingestWebhookEvents,
  formatWebhookIngestErrors: (errors: string[]) =>
    errors.length > 0 ? `Webhook ingestion had issues: ${errors.join('; ')}` : undefined,
}));

vi.mock('$lib/server/pr_event_utils.js', () => ({
  emitPrUpdatesForIngestResult: mockEmitPrUpdatesForIngestResult,
}));

vi.mock('$lib/server/session_context.js', () => ({
  getSessionManager: () => mockSessionManager,
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
    refreshPrStatusFromApi.mockReset();
    setPullRequestDraftState.mockReset();
    ingestWebhookEvents.mockReset();
    mockEmitPrUpdatesForIngestResult.mockReset();
    mockSessionManager.emitPrUpdate.mockReset();
    currentWebhookServerUrl = null;
    ingestWebhookEvents.mockResolvedValue({
      eventsIngested: 0,
      prsUpdated: [],
      errors: [],
    });
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
      tokenConfigured: false,
    });
    expect(payload.prStatuses).toHaveLength(1);
    expect(payload.prStatuses[0]).toMatchObject({
      status: {
        pr_url: 'https://github.com/example/repo/pull/1',
        title: 'Cached PR',
      },
    });
  });

  test('getPrStatus uses required checks when computing the displayed rollup state', async () => {
    upsertBranchMergeRequirements(currentDb, {
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      lastFetchedAt: new Date().toISOString(),
      requirements: [
        {
          sourceKind: 'legacy_branch_protection',
          sourceId: 0,
          sourceName: null,
          strict: true,
          checks: [{ context: 'required-check' }],
        },
      ],
    });

    const status = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/2',
      owner: 'example',
      repo: 'repo',
      prNumber: 2,
      title: 'Required check PR',
      state: 'open',
      draft: false,
      baseBranch: 'main',
      checkRollupState: 'failure',
      lastFetchedAt: new Date().toISOString(),
      checks: [
        {
          name: 'required-check',
          source: 'check_run',
          status: 'completed',
          conclusion: 'success',
        },
        {
          name: 'optional-check',
          source: 'check_run',
          status: 'completed',
          conclusion: 'failure',
        },
      ],
    });
    linkPlanToPr(currentDb, 'plan-with-prs', status.status.id);

    const { getPrStatus } = await import('./pr_status.remote.js');
    const payload = await invokeQuery(getPrStatus, { planUuid: 'plan-with-prs' });

    const pr = payload.prStatuses.find((entry) => entry.status.pr_number === 2);
    expect(pr?.status.check_rollup_state).toBe('success');
    expect(pr?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'required-check',
          conclusion: 'success',
        }),
        expect.objectContaining({
          name: 'optional-check',
          conclusion: 'failure',
        }),
      ])
    );
  });

  test('refreshPrStatus emits PR update events after webhook ingestion', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    ingestWebhookEvents.mockResolvedValueOnce({
      eventsIngested: 1,
      prsUpdated: ['https://github.com/example/repo/pull/1'],
      errors: [],
    });

    const { refreshPrStatus } = await import('./pr_status.remote.js');

    await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(mockEmitPrUpdatesForIngestResult).toHaveBeenCalledWith(
      currentDb,
      expect.objectContaining({
        prsUpdated: ['https://github.com/example/repo/pull/1'],
      }),
      mockSessionManager
    );
  });

  test('togglePrDraftStatus updates the PR draft state and refreshes the cache', async () => {
    process.env.GITHUB_TOKEN = 'token';
    setPullRequestDraftState.mockResolvedValueOnce(true);
    refreshPrStatusFromApi.mockResolvedValueOnce(undefined);

    const { togglePrDraftStatus } = await import('./pr_status.remote.js');

    const result = await invokeCommand(togglePrDraftStatus, {
      owner: 'example',
      repo: 'repo',
      prNumber: 1,
      prUrl: 'https://github.com/example/repo/pull/1',
      draft: true,
    });

    expect(result).toEqual({ success: true });
    expect(setPullRequestDraftState).toHaveBeenCalledWith('example', 'repo', 1, true);
    expect(refreshPrStatusFromApi).toHaveBeenCalledWith(
      currentDb,
      'https://github.com/example/repo/pull/1'
    );
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
      tokenConfigured: false,
    });
  });

  test('getPrStatus falls back to webhook auto-linked junction rows when the plan has no pull_request values', async () => {
    const junctionOnlyPr = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/9',
      owner: 'example',
      repo: 'repo',
      prNumber: 9,
      title: 'Webhook-linked PR',
      state: 'open',
      draft: false,
      checkRollupState: 'success',
      lastFetchedAt: new Date().toISOString(),
    });
    linkPlanToPr(currentDb, 'plan-without-prs', junctionOnlyPr.status.id, 'auto');

    const { getPrStatus } = await import('./pr_status.remote.js');
    const payload = await invokeQuery(getPrStatus, { planUuid: 'plan-without-prs' });

    expect(payload.prUrls).toEqual([]);
    expect(payload.invalidPrUrls).toEqual([]);
    expect(payload.prStatuses).toHaveLength(1);
    expect(payload.prStatuses[0]?.status.pr_url).toBe('https://github.com/example/repo/pull/9');
  });

  test('getPrStatus includes webhook auto-linked rows alongside explicit plan URLs', async () => {
    const autoLinkedPr = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/10',
      owner: 'example',
      repo: 'repo',
      prNumber: 10,
      title: 'Webhook-linked PR',
      state: 'open',
      draft: false,
      checkRollupState: 'success',
      lastFetchedAt: new Date().toISOString(),
    });
    linkPlanToPr(currentDb, 'plan-with-prs', autoLinkedPr.status.id, 'auto');

    const { getPrStatus } = await import('./pr_status.remote.js');
    const payload = await invokeQuery(getPrStatus, { planUuid: 'plan-with-prs' });

    expect(payload.prUrls).toEqual([
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/pull/2',
    ]);
    expect(payload.prStatuses.map((detail) => detail.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/pull/10',
    ]);
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

  test('refreshPrStatus returns error when GITHUB_TOKEN is not configured and webhook mode is disabled', async () => {
    const { refreshPrStatus } = await import('./pr_status.remote.js');

    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    // Without GITHUB_TOKEN, only already-cached PR URLs are synced
    expect(syncPlanPrLinks).toHaveBeenCalledWith(expect.anything(), 'plan-with-prs', [
      'https://github.com/example/repo/pull/1',
    ]);
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
    expect(result.error).toBe('GITHUB_TOKEN not configured');
  });

  test('refreshPrStatus without GITHUB_TOKEN ignores cached-link sync races when webhook mode is disabled', async () => {
    syncPlanPrLinks.mockRejectedValueOnce(new Error('cache entry disappeared'));
    const { refreshPrStatus } = await import('./pr_status.remote.js');

    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(result.error).toBe('GITHUB_TOKEN not configured');
  });

  test('refreshPrStatus does not report token error when webhook mode is enabled', async () => {
    currentWebhookServerUrl = 'https://webhooks.example.com';
    // Cache PR 2 so there are no uncached URLs
    upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/2',
      owner: 'example',
      repo: 'repo',
      prNumber: 2,
      title: 'Cached PR 2',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });
    const { refreshPrStatus } = await import('./pr_status.remote.js');

    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(ingestWebhookEvents).toHaveBeenCalledWith(currentDb);
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
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

  test('refreshPrStatus ingests webhook events and uses cached data when configured', async () => {
    process.env.GITHUB_TOKEN = 'token';
    currentWebhookServerUrl = 'https://webhooks.example.com';

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(ingestWebhookEvents).toHaveBeenCalledWith(currentDb);
    // In webhook mode, should NOT call ensurePrStatusFresh (that's for the GitHub API path)
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
    // PR 2 is not cached, so should report it as not yet available
    expect(result.error).toContain('Not yet available from webhooks');
  });

  test('refreshPrStatus in webhook mode syncs only cached explicit URLs and reports uncached mixed-source PRs', async () => {
    process.env.GITHUB_TOKEN = 'token';
    currentWebhookServerUrl = 'https://webhooks.example.com';

    const autoLinkedPr = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/10',
      owner: 'example',
      repo: 'repo',
      prNumber: 10,
      title: 'Webhook-linked PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });
    linkPlanToPr(currentDb, 'plan-with-prs', autoLinkedPr.status.id, 'auto');

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(syncPlanPrLinks).toHaveBeenCalledWith(currentDb, 'plan-with-prs', [
      'https://github.com/example/repo/pull/1',
    ]);
    expect(result.error).toContain(
      'Not yet available from webhooks: https://github.com/example/repo/pull/2'
    );
    expect(result.error).not.toContain('https://github.com/example/repo/pull/10');
  });

  test('refreshPrStatus in webhook mode only syncs cached explicit URLs', async () => {
    process.env.GITHUB_TOKEN = 'token';
    currentWebhookServerUrl = 'https://webhooks.example.com';

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(syncPlanPrLinks).toHaveBeenCalledTimes(1);
    expect(syncPlanPrLinks).toHaveBeenCalledWith(currentDb, 'plan-with-prs', [
      'https://github.com/example/repo/pull/1',
    ]);
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
  });

  test('refreshPrStatus surfaces non-throwing webhook ingestion errors', async () => {
    process.env.GITHUB_TOKEN = 'token';
    currentWebhookServerUrl = 'https://webhooks.example.com';
    ingestWebhookEvents.mockResolvedValueOnce({
      eventsIngested: 1,
      prsUpdated: [],
      errors: ['missed review refresh'],
    });

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(result.error).toContain('Webhook ingestion had issues');
    expect(result.error).toContain('missed review refresh');
    expect(result.error).toContain('Not yet available from webhooks');
  });

  test('refreshPrStatus returns error when webhook ingestion fails', async () => {
    process.env.GITHUB_TOKEN = 'token';
    currentWebhookServerUrl = 'https://webhooks.example.com';
    ingestWebhookEvents.mockRejectedValueOnce(new Error('webhook offline'));

    const { refreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(result.error).toContain('Webhook ingestion failed');
    expect(result.error).toContain('webhook offline');
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
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

  test('refreshPrStatus preserves webhook-linked plan_pr rows when the plan has no pull_request values in webhook mode', async () => {
    process.env.GITHUB_TOKEN = 'token';
    currentWebhookServerUrl = 'https://webhooks.example.com';
    const webhookOnlyPr = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/77',
      owner: 'example',
      repo: 'repo',
      prNumber: 77,
      title: 'Webhook-linked PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });
    linkPlanToPr(currentDb, 'plan-without-prs', webhookOnlyPr.status.id, 'auto');
    const { refreshPrStatus } = await import('./pr_status.remote.js');

    const result = await invokeCommand(refreshPrStatus, { planUuid: 'plan-without-prs' });

    expect(result.error).toBeUndefined();
    expect(syncPlanPrLinks).toHaveBeenCalledWith(expect.anything(), 'plan-without-prs', []);
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
    const payload = await invokeQuery((await import('./pr_status.remote.js')).getPrStatus, {
      planUuid: 'plan-without-prs',
    });
    expect(payload.prStatuses).toHaveLength(1);
    expect(payload.prStatuses[0]?.status.pr_url).toBe('https://github.com/example/repo/pull/77');
  });

  test('fullRefreshPrStatus refreshes webhook-linked plan_pr rows through the GitHub API path when there are no explicit pull_request URLs', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const webhookOnlyPr = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/88',
      owner: 'example',
      repo: 'repo',
      prNumber: 88,
      title: 'Webhook-linked PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });
    linkPlanToPr(currentDb, 'plan-without-prs', webhookOnlyPr.status.id, 'auto');
    syncPlanPrLinks.mockResolvedValue([]);
    refreshPrStatusFromApi.mockResolvedValue({
      status: {
        id: webhookOnlyPr.status.id,
        pr_url: 'https://github.com/example/repo/pull/88',
        title: 'Webhook-linked PR',
      },
      checks: [],
      reviews: [],
      labels: [],
    });

    const { fullRefreshPrStatus, getPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(fullRefreshPrStatus, { planUuid: 'plan-without-prs' });

    expect(result.error).toBeUndefined();
    expect(syncPlanPrLinks).toHaveBeenCalledWith(expect.anything(), 'plan-without-prs', []);
    expect(refreshPrStatusFromApi).toHaveBeenCalledWith(
      expect.anything(),
      'https://github.com/example/repo/pull/88'
    );
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();

    const payload = await invokeQuery(getPrStatus, { planUuid: 'plan-without-prs' });
    expect(payload.prStatuses).toHaveLength(1);
    expect(payload.prStatuses[0]?.status.pr_url).toBe('https://github.com/example/repo/pull/88');
  });

  test('fullRefreshPrStatus refreshes explicit and auto-linked PRs together but only syncs explicit links', async () => {
    process.env.GITHUB_TOKEN = 'token';
    const autoLinkedPr = upsertPrStatus(currentDb, {
      prUrl: 'https://github.com/example/repo/pull/10',
      owner: 'example',
      repo: 'repo',
      prNumber: 10,
      title: 'Webhook-linked PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });
    linkPlanToPr(currentDb, 'plan-with-prs', autoLinkedPr.status.id, 'auto');
    syncPlanPrLinks.mockResolvedValue([]);
    refreshPrStatusFromApi
      .mockResolvedValueOnce({
        status: {
          id: 1,
          pr_url: 'https://github.com/example/repo/pull/1',
          title: 'PR One',
        },
        checks: [],
        reviews: [],
        labels: [],
      })
      .mockResolvedValueOnce({
        status: {
          id: 2,
          pr_url: 'https://github.com/example/repo/pull/2',
          title: 'PR Two',
        },
        checks: [],
        reviews: [],
        labels: [],
      })
      .mockResolvedValueOnce({
        status: {
          id: autoLinkedPr.status.id,
          pr_url: 'https://github.com/example/repo/pull/10',
          title: 'Webhook-linked PR',
        },
        checks: [],
        reviews: [],
        labels: [],
      });

    const { fullRefreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(fullRefreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(result.error).toBeUndefined();
    expect(syncPlanPrLinks).toHaveBeenCalledWith(currentDb, 'plan-with-prs', [
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/pull/2',
    ]);
    expect(refreshPrStatusFromApi).toHaveBeenCalledTimes(3);
    expect(refreshPrStatusFromApi).toHaveBeenNthCalledWith(
      1,
      currentDb,
      'https://github.com/example/repo/pull/1'
    );
    expect(refreshPrStatusFromApi).toHaveBeenNthCalledWith(
      2,
      currentDb,
      'https://github.com/example/repo/pull/2'
    );
    expect(refreshPrStatusFromApi).toHaveBeenNthCalledWith(
      3,
      currentDb,
      'https://github.com/example/repo/pull/10'
    );
  });

  test('fullRefreshPrStatus bypasses webhook ingestion and calls the GitHub API path', async () => {
    process.env.GITHUB_TOKEN = 'token';
    currentWebhookServerUrl = 'https://webhooks.example.com';
    syncPlanPrLinks.mockResolvedValue([]);
    refreshPrStatusFromApi
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

    const { fullRefreshPrStatus } = await import('./pr_status.remote.js');
    const result = await invokeCommand(fullRefreshPrStatus, { planUuid: 'plan-with-prs' });

    expect(ingestWebhookEvents).not.toHaveBeenCalled();
    expect(syncPlanPrLinks).toHaveBeenCalledWith(expect.anything(), 'plan-with-prs', [
      'https://github.com/example/repo/pull/1',
      'https://github.com/example/repo/pull/2',
    ]);
    expect(refreshPrStatusFromApi).toHaveBeenCalledTimes(2);
    expect(ensurePrStatusFresh).not.toHaveBeenCalled();
    expect(result.error).toBeUndefined();
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
