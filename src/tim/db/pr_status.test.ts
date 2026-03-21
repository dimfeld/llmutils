import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  cleanOrphanedPrStatus,
  getPlansWithPrs,
  getPrStatusByUrl,
  getPrStatusByUrls,
  getPrStatusForPlan,
  linkPlanToPr,
  unlinkPlanFromPr,
  updatePrCheckRuns,
  upsertPrStatus,
} from './pr_status.js';
import { upsertPlan } from './plan.js';
import { getOrCreateProject } from './project.js';

describe('tim db/pr_status', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;
  let otherProjectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-pr-status-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, 'repo-pr-status-1').id;
    otherProjectId = getOrCreateProject(db, 'repo-pr-status-2').id;

    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      filename: '1.plan.md',
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-2',
      planId: 2,
      title: 'Plan 2',
      filename: '2.plan.md',
    });
    upsertPlan(db, otherProjectId, {
      uuid: 'plan-3',
      planId: 3,
      title: 'Plan 3',
      filename: '3.plan.md',
    });
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('upsertPrStatus inserts, updates, and replaces child rows', () => {
    const created = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/101',
      owner: 'example',
      repo: 'repo',
      prNumber: 101,
      title: 'Initial title',
      state: 'open',
      draft: false,
      mergeable: 'MERGEABLE',
      headSha: 'sha-1',
      baseBranch: 'main',
      headBranch: 'feature/a',
      reviewDecision: 'REVIEW_REQUIRED',
      checkRollupState: 'pending',
      mergedAt: null,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [
        {
          name: 'test',
          source: 'check_run',
          status: 'completed',
          conclusion: 'success',
          detailsUrl: 'https://example.com/check/1',
        },
      ],
      reviews: [
        {
          author: 'reviewer',
          state: 'COMMENTED',
          submittedAt: '2026-03-20T00:10:00.000Z',
        },
      ],
      labels: [{ name: 'backend', color: 'ff0000' }],
    });

    expect(created.status.pr_number).toBe(101);
    expect(created.status.created_at).toBeTruthy();
    expect(created.status.check_rollup_state).toBe('pending');
    expect(created.checks.map((check) => check.name)).toEqual(['test']);
    expect(created.checks.map((check) => check.source)).toEqual(['check_run']);
    expect(created.reviews.map((review) => review.author)).toEqual(['reviewer']);
    expect(created.labels.map((label) => label.name)).toEqual(['backend']);

    const updated = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/101',
      owner: 'example',
      repo: 'repo',
      prNumber: 101,
      title: 'Updated title',
      state: 'merged',
      draft: true,
      mergeable: 'UNKNOWN',
      headSha: 'sha-2',
      baseBranch: 'release',
      headBranch: 'feature/b',
      reviewDecision: 'APPROVED',
      checkRollupState: 'success',
      mergedAt: '2026-03-20T00:15:00.000Z',
      lastFetchedAt: '2026-03-20T00:16:00.000Z',
      checks: [
        {
          name: 'lint',
          source: 'status_context',
          status: 'pending',
          conclusion: null,
        },
      ],
      reviews: [
        {
          author: 'reviewer-2',
          state: 'APPROVED',
          submittedAt: '2026-03-20T00:12:00.000Z',
        },
      ],
      labels: [{ name: 'frontend', color: '00ff00' }],
    });

    expect(updated.status.id).toBe(created.status.id);
    expect(updated.status.title).toBe('Updated title');
    expect(updated.status.state).toBe('merged');
    expect(updated.status.draft).toBe(1);
    expect(updated.status.review_decision).toBe('APPROVED');
    expect(updated.status.check_rollup_state).toBe('success');
    expect(updated.checks.map((check) => check.name)).toEqual(['lint']);
    expect(updated.checks.map((check) => check.source)).toEqual(['status_context']);
    expect(updated.reviews.map((review) => review.author)).toEqual(['reviewer-2']);
    expect(updated.labels.map((label) => label.name)).toEqual(['frontend']);
  });

  test('getPrStatusForPlan, linkPlanToPr, and unlinkPlanFromPr manage plan links', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/102',
      owner: 'example',
      repo: 'repo',
      prNumber: 102,
      title: 'PR 102',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', detail.status.id);
    linkPlanToPr(db, 'plan-1', detail.status.id);

    let planStatuses = getPrStatusForPlan(db, 'plan-1');
    expect(planStatuses).toHaveLength(1);
    expect(planStatuses[0]?.status.pr_url).toBe('https://github.com/example/repo/pull/102');

    unlinkPlanFromPr(db, 'plan-1', detail.status.id);
    planStatuses = getPrStatusForPlan(db, 'plan-1');
    expect(planStatuses).toHaveLength(0);
  });

  test('getPrStatusByUrls and getPrStatusForPlan fall back to cached rows by URL when plan_pr is missing', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/102',
      owner: 'example',
      repo: 'repo',
      prNumber: 102,
      title: 'PR 102',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    expect(
      getPrStatusByUrls(db, ['https://github.com/example/repo/pulls/102?tab=checks']).map(
        (detail) => detail.status.pr_url
      )
    ).toEqual(['https://github.com/example/repo/pull/102']);

    expect(
      getPrStatusForPlan(db, 'plan-1', ['https://github.com/example/repo/pulls/102']).map(
        (detail) => detail.status.pr_url
      )
    ).toEqual(['https://github.com/example/repo/pull/102']);
  });

  test('getPrStatusByUrl and getPrStatusByUrls ignore non-PR URLs instead of throwing', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1022',
      owner: 'example',
      repo: 'repo',
      prNumber: 1022,
      title: 'PR 1022',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/issues/1022')).toBeNull();
    expect(
      getPrStatusByUrls(db, [
        'https://github.com/example/repo/issues/1022',
        'https://github.com/example/repo/pull/1022',
      ]).map((detail) => detail.status.pr_url)
    ).toEqual(['https://github.com/example/repo/pull/1022']);
  });

  test('getPrStatusForPlan ignores stale plan_pr rows when explicit plan URLs are provided', () => {
    const staleDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1023',
      owner: 'example',
      repo: 'repo',
      prNumber: 1023,
      title: 'Stale PR 1023',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', staleDetail.status.id);

    expect(getPrStatusForPlan(db, 'plan-1')).toHaveLength(1);
    expect(getPrStatusForPlan(db, 'plan-1')[0]?.status.pr_url).toBe(
      'https://github.com/example/repo/pull/1023'
    );
    expect(
      getPrStatusForPlan(db, 'plan-1', ['https://github.com/example/repo/issues/1023'])
    ).toEqual([]);
  });

  test('getPrStatusByUrl returns stored check rollup state and check source fields', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1021',
      owner: 'example',
      repo: 'repo',
      prNumber: 1021,
      title: 'Stored fields PR',
      state: 'open',
      draft: false,
      checkRollupState: 'failure',
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [
        {
          name: 'legacy-status',
          source: 'status_context',
          status: 'completed',
          conclusion: 'error',
        },
      ],
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/1021');

    expect(detail).not.toBeNull();
    expect(detail?.status.check_rollup_state).toBe('failure');
    expect(detail?.checks).toEqual([
      expect.objectContaining({
        name: 'legacy-status',
        source: 'status_context',
        status: 'completed',
        conclusion: 'error',
      }),
    ]);
  });

  test('updatePrCheckRuns replaces only check rows and updates fetch timestamp', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/103',
      owner: 'example',
      repo: 'repo',
      prNumber: 103,
      title: 'PR 103',
      state: 'open',
      draft: false,
      reviewDecision: 'CHANGES_REQUESTED',
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [{ name: 'old', source: 'check_run', status: 'pending' }],
      reviews: [{ author: 'alice', state: 'CHANGES_REQUESTED' }],
      labels: [{ name: 'needs-work' }],
    });

    const updated = updatePrCheckRuns(
      db,
      detail.status.id,
      [{ name: 'new', source: 'status_context', status: 'completed', conclusion: 'success' }],
      'success',
      '2026-03-20T01:00:00.000Z'
    );

    expect(updated.status.last_fetched_at).toBe('2026-03-20T01:00:00.000Z');
    expect(updated.status.check_rollup_state).toBe('success');
    expect(updated.checks.map((check) => check.name)).toEqual(['new']);
    expect(updated.checks.map((check) => check.source)).toEqual(['status_context']);
    expect(updated.reviews.map((review) => review.author)).toEqual(['alice']);
    expect(updated.labels.map((label) => label.name)).toEqual(['needs-work']);
  });

  test('getPlansWithPrs returns open PR links and respects project filter', () => {
    // Set pull_request on plans so junction rows are not filtered as stale
    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      filename: '1.plan.md',
      pullRequest: ['https://github.com/example/repo/pull/104'],
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-2',
      planId: 2,
      title: 'Plan 2',
      filename: '2.plan.md',
      pullRequest: ['https://github.com/example/repo/pull/105'],
    });
    upsertPlan(db, otherProjectId, {
      uuid: 'plan-3',
      planId: 3,
      title: 'Plan 3',
      filename: '3.plan.md',
      pullRequest: ['https://github.com/example/repo/pull/104'],
    });

    const openPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/104',
      owner: 'example',
      repo: 'repo',
      prNumber: 104,
      title: 'PR 104',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    const closedPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/105',
      owner: 'example',
      repo: 'repo',
      prNumber: 105,
      title: 'PR 105',
      state: 'closed',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', openPr.status.id);
    linkPlanToPr(db, 'plan-2', closedPr.status.id);
    linkPlanToPr(db, 'plan-3', openPr.status.id);

    expect(getPlansWithPrs(db)).toEqual([
      {
        uuid: 'plan-1',
        projectId,
        planId: 1,
        title: 'Plan 1',
        prUrls: ['https://github.com/example/repo/pull/104'],
      },
      {
        uuid: 'plan-3',
        projectId: otherProjectId,
        planId: 3,
        title: 'Plan 3',
        prUrls: ['https://github.com/example/repo/pull/104'],
      },
    ]);

    expect(getPlansWithPrs(db, projectId)).toEqual([
      {
        uuid: 'plan-1',
        projectId,
        planId: 1,
        title: 'Plan 1',
        prUrls: ['https://github.com/example/repo/pull/104'],
      },
    ]);
  });

  test('getPlansWithPrs returns plans with pull_request URLs even without plan_pr junction rows', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      filename: '1.plan.md',
      status: 'in_progress',
      pullRequest: ['https://github.com/example/repo/pull/204'],
    });

    expect(getPlansWithPrs(db)).toEqual([
      {
        uuid: 'plan-1',
        projectId,
        planId: 1,
        title: 'Plan 1',
        prUrls: ['https://github.com/example/repo/pull/204'],
      },
    ]);
  });

  test('getPlansWithPrs excludes cached closed PRs from the pull_request fallback branch', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/205',
      owner: 'example',
      repo: 'repo',
      prNumber: 205,
      title: 'Closed PR 205',
      state: 'closed',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      filename: '1.plan.md',
      status: 'in_progress',
      pullRequest: ['https://github.com/example/repo/pull/205'],
    });

    expect(getPlansWithPrs(db)).toEqual([]);
  });

  test('getPlansWithPrs excludes stale plan_pr rows when the current plan pull_request is empty', () => {
    const openPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/206',
      owner: 'example',
      repo: 'repo',
      prNumber: 206,
      title: 'PR 206',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      filename: '1.plan.md',
      status: 'in_progress',
      pullRequest: [],
    });
    linkPlanToPr(db, 'plan-1', openPr.status.id);

    expect(getPlansWithPrs(db)).toEqual([]);
  });

  test('getPlansWithPrs excludes stale plan_pr rows when plan has no pull_request field (NULL)', () => {
    const openPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/207',
      owner: 'example',
      repo: 'repo',
      prNumber: 207,
      title: 'PR 207',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    // plan-1 was created in beforeEach without pullRequest field (NULL in DB)
    linkPlanToPr(db, 'plan-1', openPr.status.id);

    expect(getPlansWithPrs(db)).toEqual([]);
  });

  test('cleanOrphanedPrStatus removes unlinked PR status rows', () => {
    const kept = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/106',
      owner: 'example',
      repo: 'repo',
      prNumber: 106,
      title: 'PR 106',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/107',
      owner: 'example',
      repo: 'repo',
      prNumber: 107,
      title: 'PR 107',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', kept.status.id);

    expect(cleanOrphanedPrStatus(db)).toBe(1);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/106')).not.toBeNull();
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/107')).toBeNull();
  });

  test('cleanOrphanedPrStatus keeps rows linked from any plan and removes them after final unlink', () => {
    const shared = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/108',
      owner: 'example',
      repo: 'repo',
      prNumber: 108,
      title: 'Shared PR 108',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [{ name: 'ci', source: 'check_run', status: 'completed', conclusion: 'success' }],
      reviews: [{ author: 'alice', state: 'APPROVED' }],
      labels: [{ name: 'shared' }],
    });

    linkPlanToPr(db, 'plan-1', shared.status.id);
    linkPlanToPr(db, 'plan-2', shared.status.id);

    expect(cleanOrphanedPrStatus(db)).toBe(0);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/108')?.checks).toHaveLength(
      1
    );

    unlinkPlanFromPr(db, 'plan-1', shared.status.id);
    expect(cleanOrphanedPrStatus(db)).toBe(0);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/108')?.reviews).toHaveLength(
      1
    );

    unlinkPlanFromPr(db, 'plan-2', shared.status.id);
    expect(cleanOrphanedPrStatus(db)).toBeGreaterThanOrEqual(1);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/108')).toBeNull();
  });

  test('cleanOrphanedPrStatus keeps rows referenced by plan pull_request without plan_pr links', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      filename: '1.plan.md',
      pullRequest: ['https://github.com/example/repo/pull/109'],
    });

    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/109',
      owner: 'example',
      repo: 'repo',
      prNumber: 109,
      title: 'Referenced by plan JSON',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    expect(cleanOrphanedPrStatus(db)).toBe(0);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/109')).not.toBeNull();
  });

  test('cleanOrphanedPrStatus keeps canonical cache rows referenced by equivalent non-canonical plan URLs', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      filename: '1.plan.md',
      pullRequest: ['https://github.com/example/repo/pulls/123?tab=checks'],
    });

    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/123',
      owner: 'example',
      repo: 'repo',
      prNumber: 123,
      title: 'Canonical PR 123',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    expect(cleanOrphanedPrStatus(db)).toBe(0);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/123')).not.toBeNull();
  });
});
