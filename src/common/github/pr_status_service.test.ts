import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { DATABASE_FILENAME, openDatabase } from '../../tim/db/database.js';
import { getPrStatusByUrl, getPrStatusForPlan, upsertPrStatus } from '../../tim/db/pr_status.js';
import { upsertPlan } from '../../tim/db/plan.js';
import { getOrCreateProject } from '../../tim/db/project.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('common/github/pr_status_service', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-pr-status-service-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, 'repo-pr-status-service').id;
    upsertPlan(db, projectId, {
      uuid: 'plan-service',
      planId: 1,
      title: 'Service plan',
      filename: '1.plan.md',
    });
  });

  afterEach(async () => {
    moduleMocker.clear();
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('refreshPrStatus fetches and caches a full PR record', async () => {
    const fetchPrFullStatus = mock(async () => ({
      number: 201,
      title: 'Service PR',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'service-sha',
      baseRefName: 'main',
      headRefName: 'feature/service',
      reviewDecision: 'APPROVED' as const,
      labels: [{ name: 'backend', color: 'ff0000' }],
      reviews: [{ author: 'alice', state: 'APPROVED' as const, submittedAt: null }],
      checks: [
        {
          name: 'test',
          status: 'completed' as const,
          conclusion: 'success' as const,
          detailsUrl: 'https://example.com/check/1',
          startedAt: null,
          completedAt: null,
          source: 'check_run' as const,
        },
      ],
      checkRollupState: 'success' as const,
    }));

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async () => ({ owner: 'example', repo: 'repo', number: 201 })),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
      fetchPrCheckStatus: mock(),
    }));

    const { refreshPrStatus } = await import('./pr_status_service.ts');
    const result = await refreshPrStatus(db, 'https://github.com/example/repo/pull/201');

    expect(fetchPrFullStatus).toHaveBeenCalledWith('example', 'repo', 201);
    expect(result.status.title).toBe('Service PR');
    expect(result.status.check_rollup_state).toBe('success');
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/201')?.checks).toHaveLength(
      1
    );
  });

  test('refreshPrCheckStatus updates only the checks when a cached record exists', async () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/202',
      owner: 'example',
      repo: 'repo',
      prNumber: 202,
      title: 'Cached PR',
      state: 'open',
      draft: false,
      reviewDecision: 'CHANGES_REQUESTED',
      checkRollupState: 'pending',
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [{ name: 'old-check', source: 'check_run', status: 'pending' }],
      reviews: [{ author: 'bob', state: 'CHANGES_REQUESTED' }],
      labels: [{ name: 'bug' }],
    });

    const fetchPrCheckStatus = mock(async () => ({
      checks: [
        {
          name: 'new-check',
          status: 'completed' as const,
          conclusion: 'failure' as const,
          detailsUrl: null,
          startedAt: null,
          completedAt: null,
          source: 'check_run' as const,
        },
      ],
      checkRollupState: 'failure' as const,
    }));

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async () => ({ owner: 'example', repo: 'repo', number: 202 })),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus: mock(),
      fetchPrCheckStatus,
    }));

    const { refreshPrCheckStatus } = await import('./pr_status_service.ts');
    const result = await refreshPrCheckStatus(db, 'https://github.com/example/repo/pull/202');

    expect(fetchPrCheckStatus).toHaveBeenCalledWith('example', 'repo', 202);
    expect(result.checks.map((check) => check.name)).toEqual(['new-check']);
    expect(result.checks.map((check) => check.source)).toEqual(['check_run']);
    expect(result.status.check_rollup_state).toBe('failure');
    expect(result.reviews.map((review) => review.author)).toEqual(['bob']);
    expect(result.labels.map((label) => label.name)).toEqual(['bug']);
  });

  test('ensurePrStatusFresh returns cached data when it is still fresh', async () => {
    const now = new Date();
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/203',
      owner: 'example',
      repo: 'repo',
      prNumber: 203,
      title: 'Fresh PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date(now.getTime() - 30_000).toISOString(),
    });

    const fetchPrFullStatus = mock(async () => {
      throw new Error('should not be called');
    });

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async () => ({ owner: 'example', repo: 'repo', number: 203 })),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
      fetchPrCheckStatus: mock(),
    }));

    const { ensurePrStatusFresh } = await import('./pr_status_service.ts');
    const result = await ensurePrStatusFresh(
      db,
      'https://github.com/example/repo/pull/203',
      60_000
    );

    expect(result.status.title).toBe('Fresh PR');
    expect(fetchPrFullStatus).not.toHaveBeenCalled();
  });

  test('ensurePrStatusFresh refreshes stale data', async () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/204',
      owner: 'example',
      repo: 'repo',
      prNumber: 204,
      title: 'Stale PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const fetchPrFullStatus = mock(async () => ({
      number: 204,
      title: 'Refreshed PR',
      state: 'merged' as const,
      isDraft: false,
      mergeable: 'UNKNOWN' as const,
      mergedAt: '2026-03-20T02:00:00.000Z',
      headSha: 'sha-new',
      baseRefName: 'main',
      headRefName: 'feature/refreshed',
      reviewDecision: 'APPROVED' as const,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'success' as const,
    }));

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async () => ({ owner: 'example', repo: 'repo', number: 204 })),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
      fetchPrCheckStatus: mock(),
    }));

    const { ensurePrStatusFresh } = await import('./pr_status_service.ts');
    const result = await ensurePrStatusFresh(db, 'https://github.com/example/repo/pull/204', 1);

    expect(fetchPrFullStatus).toHaveBeenCalledTimes(1);
    expect(result.status.title).toBe('Refreshed PR');
    expect(result.status.state).toBe('merged');
  });

  test('ensurePrStatusFresh refreshes when cached timestamp is invalid', async () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/208',
      owner: 'example',
      repo: 'repo',
      prNumber: 208,
      title: 'Broken timestamp PR',
      state: 'open',
      draft: false,
      lastFetchedAt: 'not-a-timestamp',
    });

    const fetchPrFullStatus = mock(async () => ({
      number: 208,
      title: 'Recovered PR',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: null,
      baseRefName: 'main',
      headRefName: 'feature/recovered',
      reviewDecision: null,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: null,
    }));

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async () => ({ owner: 'example', repo: 'repo', number: 208 })),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
      fetchPrCheckStatus: mock(),
    }));

    const { ensurePrStatusFresh } = await import('./pr_status_service.ts');
    const result = await ensurePrStatusFresh(
      db,
      'https://github.com/example/repo/pull/208',
      60_000
    );

    expect(fetchPrFullStatus).toHaveBeenCalledTimes(1);
    expect(result.status.title).toBe('Recovered PR');
  });

  test('refreshPrStatus rejects invalid PR identifiers before fetching', async () => {
    const fetchPrFullStatus = mock(async () => {
      throw new Error('should not fetch');
    });

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async () => null),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
      fetchPrCheckStatus: mock(),
    }));

    const { refreshPrStatus } = await import('./pr_status_service.ts');

    await expect(refreshPrStatus(db, 'not-a-pr')).rejects.toThrow(
      'Invalid GitHub pull request identifier: not-a-pr'
    );
    expect(fetchPrFullStatus).not.toHaveBeenCalled();
  });

  test('refreshPrCheckStatus falls back to full refresh when cache is missing', async () => {
    const fetchPrFullStatus = mock(async () => ({
      number: 209,
      title: 'Fetched from full refresh',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'sha-209',
      baseRefName: 'main',
      headRefName: 'feature/209',
      reviewDecision: null,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'pending' as const,
    }));
    const fetchPrCheckStatus = mock(async () => {
      throw new Error('should not fetch lightweight checks');
    });

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async () => ({ owner: 'example', repo: 'repo', number: 209 })),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
      fetchPrCheckStatus,
    }));

    const { refreshPrCheckStatus } = await import('./pr_status_service.ts');
    const result = await refreshPrCheckStatus(db, 'https://github.com/example/repo/pull/209');

    expect(fetchPrFullStatus).toHaveBeenCalledTimes(1);
    expect(fetchPrCheckStatus).not.toHaveBeenCalled();
    expect(result.status.pr_number).toBe(209);
  });

  test('syncPlanPrLinks links new PRs, unlinks removed PRs, and cleans orphans', async () => {
    const oldDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/205',
      owner: 'example',
      repo: 'repo',
      prNumber: 205,
      title: 'Old PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    const retainedDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/206',
      owner: 'example',
      repo: 'repo',
      prNumber: 206,
      title: 'Retained PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });

    const linkPlanToPr = db.prepare('INSERT INTO plan_pr (plan_uuid, pr_status_id) VALUES (?, ?)');
    linkPlanToPr.run('plan-service', oldDetail.status.id);
    linkPlanToPr.run('plan-service', retainedDetail.status.id);

    const fetchPrFullStatus = mock(async () => ({
      number: 207,
      title: 'Fetched PR',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'sha-207',
      baseRefName: 'main',
      headRefName: 'feature/207',
      reviewDecision: 'REVIEW_REQUIRED' as const,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'pending' as const,
    }));

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async (identifier: string) => {
        if (identifier.endsWith('/206')) {
          return { owner: 'example', repo: 'repo', number: 206 };
        }

        if (identifier.endsWith('/207')) {
          return { owner: 'example', repo: 'repo', number: 207 };
        }

        return { owner: 'example', repo: 'repo', number: 205 };
      }),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
      fetchPrCheckStatus: mock(),
    }));

    const { syncPlanPrLinks } = await import('./pr_status_service.ts');
    const result = await syncPlanPrLinks(db, 'plan-service', [
      'https://github.com/example/repo/pull/206',
      'https://github.com/example/repo/pull/207',
    ]);

    expect(result.map((detail) => detail.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/206',
      'https://github.com/example/repo/pull/207',
    ]);
    expect(getPrStatusForPlan(db, 'plan-service').map((detail) => detail.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/206',
      'https://github.com/example/repo/pull/207',
    ]);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/205')).toBeNull();
  });

  test('syncPlanPrLinks preserves shared PR records and reuses cached details', async () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-service-2',
      planId: 2,
      title: 'Second service plan',
      filename: '2.plan.md',
    });

    const sharedDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/210',
      owner: 'example',
      repo: 'repo',
      prNumber: 210,
      title: 'Shared PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });

    const linkPlanToPr = db.prepare('INSERT INTO plan_pr (plan_uuid, pr_status_id) VALUES (?, ?)');
    linkPlanToPr.run('plan-service', sharedDetail.status.id);
    linkPlanToPr.run('plan-service-2', sharedDetail.status.id);

    const fetchPrFullStatus = mock(async () => {
      throw new Error('should not fetch cached PR');
    });

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async () => ({ owner: 'example', repo: 'repo', number: 210 })),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
      fetchPrCheckStatus: mock(),
    }));

    const { syncPlanPrLinks } = await import('./pr_status_service.ts');
    const result = await syncPlanPrLinks(db, 'plan-service', []);

    expect(result).toEqual([]);
    expect(fetchPrFullStatus).not.toHaveBeenCalled();
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/210')).not.toBeNull();
    expect(getPrStatusForPlan(db, 'plan-service')).toEqual([]);
    expect(getPrStatusForPlan(db, 'plan-service-2').map((detail) => detail.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/210',
    ]);
  });

  test('syncPlanPrLinks surfaces parse failures for newly linked PRs', async () => {
    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async () => null),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus: mock(),
      fetchPrCheckStatus: mock(),
    }));

    const { syncPlanPrLinks } = await import('./pr_status_service.ts');

    await expect(syncPlanPrLinks(db, 'plan-service', ['invalid-pr-url'])).rejects.toThrow(
      'Invalid GitHub pull request identifier: invalid-pr-url'
    );
    expect(getPrStatusForPlan(db, 'plan-service')).toEqual([]);
  });

  test('syncPlanPrLinks does not modify links if fetching a new PR fails', async () => {
    const existingDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/211',
      owner: 'example',
      repo: 'repo',
      prNumber: 211,
      title: 'Existing linked PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });
    const otherDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/212',
      owner: 'example',
      repo: 'repo',
      prNumber: 212,
      title: 'Other linked PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });

    const linkPlanToPr = db.prepare('INSERT INTO plan_pr (plan_uuid, pr_status_id) VALUES (?, ?)');
    linkPlanToPr.run('plan-service', existingDetail.status.id);
    linkPlanToPr.run('plan-service', otherDetail.status.id);

    await moduleMocker.mock('./identifiers.ts', () => ({
      parsePrOrIssueNumber: mock(async (identifier: string) => {
        if (identifier.endsWith('/213')) {
          return { owner: 'example', repo: 'repo', number: 213 };
        }

        if (identifier.endsWith('/211')) {
          return { owner: 'example', repo: 'repo', number: 211 };
        }

        return { owner: 'example', repo: 'repo', number: 212 };
      }),
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus: mock(async () => {
        throw new Error('GitHub fetch failed');
      }),
      fetchPrCheckStatus: mock(),
    }));

    const { syncPlanPrLinks } = await import('./pr_status_service.ts');

    await expect(
      syncPlanPrLinks(db, 'plan-service', [
        'https://github.com/example/repo/pull/211',
        'https://github.com/example/repo/pull/213',
      ])
    ).rejects.toThrow('GitHub fetch failed');

    expect(getPrStatusForPlan(db, 'plan-service').map((detail) => detail.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/211',
      'https://github.com/example/repo/pull/212',
    ]);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/213')).toBeNull();
  });
});
