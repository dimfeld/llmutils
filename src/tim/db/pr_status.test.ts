import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  cleanOrphanedPrStatus,
  getKnownRepoFullNames,
  getLinkedPlansByPrUrl,
  getPrStatusByRepoAndNumber,
  getPrStatusesForRepo,
  getPlansWithPrs,
  getPrStatusByUrl,
  getPrStatusByUrls,
  getPrStatusForPlan,
  linkPlanToPr,
  recomputeCheckRollupState,
  unlinkPlanFromPr,
  updatePrCheckRuns,
  updatePrMergeableAndReviewDecision,
  upsertPrCheckRunByName,
  upsertPrReviewByAuthor,
  upsertPrStatus,
  upsertPrStatusMetadata,
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
      author: 'alice',
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
    expect(created.status.author).toBe('alice');
    expect(created.status.requested_reviewers).toBe('[]');
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
      author: 'bob',
      title: 'Updated title',
      state: 'merged',
      draft: true,
      mergeable: 'UNKNOWN',
      headSha: 'sha-2',
      baseBranch: 'release',
      headBranch: 'feature/b',
      requestedReviewers: ['reviewer-2', 'reviewer-3'],
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
    expect(updated.status.author).toBe('bob');
    expect(updated.status.title).toBe('Updated title');
    expect(updated.status.state).toBe('merged');
    expect(updated.status.draft).toBe(1);
    expect(updated.status.requested_reviewers).toBe('["reviewer-2","reviewer-3"]');
    expect(updated.status.review_decision).toBe('APPROVED');
    expect(updated.status.check_rollup_state).toBe('success');
    expect(updated.checks.map((check) => check.name)).toEqual(['lint']);
    expect(updated.checks.map((check) => check.source)).toEqual(['status_context']);
    expect(updated.reviews.map((review) => review.author)).toEqual(['reviewer-2']);
    expect(updated.labels.map((label) => label.name)).toEqual(['frontend']);
  });

  test('upsertPrStatusMetadata updates PR fields and labels without replacing checks or reviews', () => {
    const created = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/150',
      owner: 'example',
      repo: 'repo',
      prNumber: 150,
      author: 'alice',
      title: 'Initial title',
      state: 'open',
      draft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'REVIEW_REQUIRED',
      checkRollupState: 'pending',
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [{ name: 'test', source: 'check_run', status: 'pending' }],
      reviews: [{ author: 'reviewer', state: 'COMMENTED', submittedAt: '2026-03-20T00:01:00Z' }],
      labels: [{ name: 'old-label', color: '111111' }],
    });

    const updated = upsertPrStatusMetadata(db, {
      prUrl: created.status.pr_url,
      owner: 'example',
      repo: 'repo',
      prNumber: 150,
      author: 'bob',
      title: 'Updated title',
      state: 'closed',
      draft: true,
      mergeable: created.status.mergeable,
      reviewDecision: created.status.review_decision,
      checkRollupState: created.status.check_rollup_state,
      requestedReviewers: ['reviewer-2'],
      mergedAt: null,
      lastFetchedAt: '2026-03-21T00:00:00.000Z',
      labels: [{ name: 'new-label', color: '222222' }],
    });

    expect(updated.status.id).toBe(created.status.id);
    expect(updated.status.author).toBe('bob');
    expect(updated.status.title).toBe('Updated title');
    expect(updated.status.state).toBe('closed');
    expect(updated.status.requested_reviewers).toBe('["reviewer-2"]');
    expect(updated.checks.map((check) => check.name)).toEqual(['test']);
    expect(updated.reviews.map((review) => review.author)).toEqual(['reviewer']);
    expect(updated.labels.map((label) => label.name)).toEqual(['new-label']);
  });

  test('upsertPrStatusMetadata preserves targeted fields when null metadata is provided', () => {
    const created = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/152',
      owner: 'example',
      repo: 'repo',
      prNumber: 152,
      author: 'alice',
      title: 'Existing metadata',
      state: 'open',
      draft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      checkRollupState: 'success',
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      labels: [{ name: 'old-label', color: '111111' }],
    });

    const updated = upsertPrStatusMetadata(db, {
      prUrl: created.status.pr_url,
      owner: 'example',
      repo: 'repo',
      prNumber: 152,
      author: 'bob',
      title: 'Updated metadata',
      state: 'closed',
      draft: true,
      mergeable: null,
      reviewDecision: null,
      checkRollupState: null,
      requestedReviewers: ['reviewer-2'],
      mergedAt: null,
      lastFetchedAt: '2026-03-21T00:00:00.000Z',
      labels: [{ name: 'new-label', color: '222222' }],
    });

    expect(updated.status.mergeable).toBe('MERGEABLE');
    expect(updated.status.review_decision).toBe('APPROVED');
    expect(updated.status.check_rollup_state).toBe('success');
    expect(updated.status.author).toBe('bob');
    expect(updated.labels.map((label) => label.name)).toEqual(['new-label']);
  });

  test('upsertPrStatusMetadata ignores stale PR metadata updates based on prUpdatedAt', () => {
    const created = upsertPrStatusMetadata(db, {
      prUrl: 'https://github.com/example/repo/pull/153',
      owner: 'example',
      repo: 'repo',
      prNumber: 153,
      author: 'alice',
      title: 'Newest metadata',
      state: 'open',
      draft: false,
      headSha: 'sha-new',
      requestedReviewers: ['reviewer-1'],
      mergedAt: null,
      prUpdatedAt: '2026-03-22T00:00:00.000Z',
      lastFetchedAt: '2026-03-22T00:00:00.000Z',
      labels: [{ name: 'new-label', color: '222222' }],
    });

    const staleAttempt = upsertPrStatusMetadata(db, {
      prUrl: created.status.pr_url,
      owner: 'example',
      repo: 'repo',
      prNumber: 153,
      author: 'bob',
      title: 'Stale metadata',
      state: 'closed',
      draft: true,
      headSha: 'sha-old',
      requestedReviewers: ['reviewer-2'],
      mergedAt: '2026-03-20T00:00:00.000Z',
      prUpdatedAt: '2026-03-21T00:00:00.000Z',
      lastFetchedAt: '2026-03-23T00:00:00.000Z',
      labels: [{ name: 'stale-label', color: '333333' }],
    });

    expect(staleAttempt.status.author).toBe('alice');
    expect(staleAttempt.status.title).toBe('Newest metadata');
    expect(staleAttempt.status.state).toBe('open');
    expect(staleAttempt.status.head_sha).toBe('sha-new');
    expect(staleAttempt.status.pr_updated_at).toBe('2026-03-22T00:00:00.000Z');
    expect(staleAttempt.labels.map((label) => label.name)).toEqual(['new-label']);
  });

  test('upsertPrStatus preserves existing pr_updated_at during full GitHub refreshes', () => {
    upsertPrStatusMetadata(db, {
      prUrl: 'https://github.com/example/repo/pull/154',
      owner: 'example',
      repo: 'repo',
      prNumber: 154,
      author: 'alice',
      title: 'Webhook metadata',
      state: 'open',
      draft: false,
      prUpdatedAt: '2026-03-22T00:00:00.000Z',
      lastFetchedAt: '2026-03-22T00:00:00.000Z',
      labels: [{ name: 'webhook', color: '222222' }],
    });

    const refreshed = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/154',
      owner: 'example',
      repo: 'repo',
      prNumber: 154,
      author: 'alice',
      title: 'GitHub refresh',
      state: 'open',
      draft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      checkRollupState: 'success',
      lastFetchedAt: '2026-03-23T00:00:00.000Z',
      labels: [{ name: 'github', color: '333333' }],
    });

    expect(refreshed.status.pr_updated_at).toBe('2026-03-22T00:00:00.000Z');
  });

  test('updatePrMergeableAndReviewDecision updates targeted fields without touching existing child rows', () => {
    const created = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/151',
      owner: 'example',
      repo: 'repo',
      prNumber: 151,
      title: 'Targeted refresh PR',
      state: 'open',
      draft: false,
      mergeable: null,
      reviewDecision: null,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [{ name: 'test', source: 'check_run', status: 'pending' }],
      reviews: [{ author: 'reviewer', state: 'COMMENTED', submittedAt: '2026-03-20T00:01:00Z' }],
      labels: [{ name: 'label', color: 'abcdef' }],
    });

    const updated = updatePrMergeableAndReviewDecision(
      db,
      created.status.id,
      'CONFLICTING',
      'CHANGES_REQUESTED',
      '2026-03-21T00:00:00.000Z'
    );

    expect(updated.status.mergeable).toBe('CONFLICTING');
    expect(updated.status.review_decision).toBe('CHANGES_REQUESTED');
    expect(updated.checks.map((check) => check.name)).toEqual(['test']);
    expect(updated.reviews.map((review) => review.author)).toEqual(['reviewer']);
    expect(updated.labels.map((label) => label.name)).toEqual(['label']);
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

    linkPlanToPr(db, 'plan-1', detail.status.id, 'auto');
    // unlinkPlanFromPr only removes explicit rows; auto-linked row persists
    unlinkPlanFromPr(db, 'plan-1', detail.status.id);
    planStatuses = getPrStatusForPlan(db, 'plan-1');
    expect(planStatuses).toHaveLength(1);
    expect(planStatuses[0]?.status.pr_url).toBe('https://github.com/example/repo/pull/102');
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

  test('getPrStatusForPlan treats an explicit empty URL list as auto-links only', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1024',
      owner: 'example',
      repo: 'repo',
      prNumber: 1024,
      title: 'Webhook auto-linked PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', detail.status.id, 'auto');

    expect(getPrStatusForPlan(db, 'plan-1', []).map((row) => row.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/1024',
    ]);
  });

  test('getPrStatusForPlan includes auto-linked rows alongside explicit plan URLs', () => {
    const explicitDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1025',
      owner: 'example',
      repo: 'repo',
      prNumber: 1025,
      title: 'Explicit PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    const autoDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1026',
      owner: 'example',
      repo: 'repo',
      prNumber: 1026,
      title: 'Auto PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', explicitDetail.status.id);
    linkPlanToPr(db, 'plan-1', autoDetail.status.id, 'auto');

    expect(
      getPrStatusForPlan(db, 'plan-1', ['https://github.com/example/repo/pull/1025']).map(
        (detail) => detail.status.pr_url
      )
    ).toEqual([
      'https://github.com/example/repo/pull/1025',
      'https://github.com/example/repo/pull/1026',
    ]);
  });

  test('getPrStatusForPlan de-duplicates rows when explicit and auto links coexist', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1027',
      owner: 'example',
      repo: 'repo',
      prNumber: 1027,
      title: 'Dual source PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', detail.status.id, 'explicit');
    linkPlanToPr(db, 'plan-1', detail.status.id, 'auto');

    expect(getPrStatusForPlan(db, 'plan-1').map((row) => row.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/1027',
    ]);
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

  test('getPrStatusByRepoAndNumber returns the stored row for a repo and PR number', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1040',
      owner: 'example',
      repo: 'repo',
      prNumber: 1040,
      title: 'Repo lookup PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    expect(getPrStatusByRepoAndNumber(db, 'example', 'repo', 1040)).toMatchObject({
      id: detail.status.id,
      pr_url: 'https://github.com/example/repo/pull/1040',
    });
    expect(getPrStatusByRepoAndNumber(db, 'example', 'repo', 9999)).toBeNull();
  });

  test('upsertPrCheckRunByName replaces an existing check row for the same PR and name', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1041',
      owner: 'example',
      repo: 'repo',
      prNumber: 1041,
      title: 'Check upsert PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'queued',
      conclusion: null,
    });
    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: 'https://example.com/checks/1041',
    });

    const refreshed = getPrStatusByUrl(db, detail.status.pr_url);
    expect(refreshed?.checks).toHaveLength(1);
    expect(refreshed?.checks[0]).toMatchObject({
      name: 'tests',
      status: 'completed',
      conclusion: 'success',
      details_url: 'https://example.com/checks/1041',
    });
  });

  test('upsertPrCheckRunByName is idempotent for repeated payloads', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1141',
      owner: 'example',
      repo: 'repo',
      prNumber: 1141,
      title: 'Check idempotency PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const input = {
      name: 'tests',
      source: 'check_run' as const,
      status: 'completed',
      conclusion: 'success',
      detailsUrl: 'https://example.com/checks/1141',
    };

    upsertPrCheckRunByName(db, detail.status.id, input);
    upsertPrCheckRunByName(db, detail.status.id, input);

    const refreshed = getPrStatusByUrl(db, detail.status.pr_url);
    expect(refreshed?.checks).toHaveLength(1);
    expect(refreshed?.checks[0]).toMatchObject({
      name: 'tests',
      status: 'completed',
      conclusion: 'success',
      details_url: 'https://example.com/checks/1141',
    });
  });

  test('upsertPrCheckRunByName keeps distinct rows for the same name when the sources differ', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1142',
      owner: 'example',
      repo: 'repo',
      prNumber: 1142,
      title: 'Mixed source checks PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: 'https://example.com/check-runs/1142',
    });
    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'status_context',
      status: 'completed',
      conclusion: 'failure',
      detailsUrl: 'https://example.com/status-context/1142',
    });

    const refreshed = getPrStatusByUrl(db, detail.status.pr_url);
    expect(refreshed?.checks).toHaveLength(2);
    expect(refreshed?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'tests',
          source: 'check_run',
          conclusion: 'success',
          details_url: 'https://example.com/check-runs/1142',
        }),
        expect.objectContaining({
          name: 'tests',
          source: 'status_context',
          conclusion: 'failure',
          details_url: 'https://example.com/status-context/1142',
        }),
      ])
    );
  });

  test('upsertPrCheckRunByName does not let a pending payload overwrite a completed check', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1241',
      owner: 'example',
      repo: 'repo',
      prNumber: 1241,
      title: 'Monotonic checks PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: 'https://example.com/checks/final',
      startedAt: '2026-03-20T00:01:00.000Z',
      completedAt: '2026-03-20T00:02:00.000Z',
    });
    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'in_progress',
      conclusion: null,
      detailsUrl: 'https://example.com/checks/stale',
      startedAt: '2026-03-20T00:00:30.000Z',
      completedAt: null,
    });

    const refreshed = getPrStatusByUrl(db, detail.status.pr_url);
    expect(refreshed?.checks).toHaveLength(1);
    expect(refreshed?.checks[0]).toMatchObject({
      name: 'tests',
      status: 'completed',
      conclusion: 'success',
      details_url: 'https://example.com/checks/final',
      started_at: '2026-03-20T00:01:00.000Z',
      completed_at: '2026-03-20T00:02:00.000Z',
    });
  });

  test('upsertPrCheckRunByName allows a genuine re-run to replace a completed check with a new in-progress run', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1243',
      owner: 'example',
      repo: 'repo',
      prNumber: 1243,
      title: 'Rerun checks PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: 'https://example.com/checks/final',
      startedAt: '2026-03-20T00:01:00.000Z',
      completedAt: '2026-03-20T00:02:00.000Z',
    });
    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'queued',
      conclusion: null,
      detailsUrl: 'https://example.com/checks/rerun',
      startedAt: '2026-03-20T00:03:00.000Z',
      completedAt: null,
    });

    const refreshed = getPrStatusByUrl(db, detail.status.pr_url);
    expect(refreshed?.checks).toHaveLength(1);
    expect(refreshed?.checks[0]).toMatchObject({
      name: 'tests',
      status: 'queued',
      conclusion: null,
      details_url: 'https://example.com/checks/rerun',
      started_at: '2026-03-20T00:03:00.000Z',
      completed_at: null,
    });
  });

  test('upsertPrReviewByAuthor replaces an existing review row for the same author', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1042',
      owner: 'example',
      repo: 'repo',
      prNumber: 1042,
      title: 'Review upsert PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    expect(
      upsertPrReviewByAuthor(db, detail.status.id, {
        author: 'reviewer',
        state: 'COMMENTED',
        submittedAt: '2026-03-20T00:01:00.000Z',
      })
    ).toBe(true);
    expect(
      upsertPrReviewByAuthor(db, detail.status.id, {
        author: 'reviewer',
        state: 'APPROVED',
        submittedAt: '2026-03-20T00:02:00.000Z',
      })
    ).toBe(true);

    const refreshed = getPrStatusByUrl(db, detail.status.pr_url);
    expect(refreshed?.reviews).toHaveLength(1);
    expect(refreshed?.reviews[0]).toMatchObject({
      author: 'reviewer',
      state: 'APPROVED',
      submitted_at: '2026-03-20T00:02:00.000Z',
    });
  });

  test('upsertPrReviewByAuthor is idempotent for repeated payloads', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1142',
      owner: 'example',
      repo: 'repo',
      prNumber: 1142,
      title: 'Review idempotency PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const input = {
      author: 'reviewer',
      state: 'APPROVED',
      submittedAt: '2026-03-20T00:02:00.000Z',
    };

    expect(upsertPrReviewByAuthor(db, detail.status.id, input)).toBe(true);
    expect(upsertPrReviewByAuthor(db, detail.status.id, input)).toBe(true);

    const refreshed = getPrStatusByUrl(db, detail.status.pr_url);
    expect(refreshed?.reviews).toHaveLength(1);
    expect(refreshed?.reviews[0]).toMatchObject({
      author: 'reviewer',
      state: 'APPROVED',
      submitted_at: '2026-03-20T00:02:00.000Z',
    });
  });

  test('upsertPrReviewByAuthor does not let an older review overwrite a newer one', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1242',
      owner: 'example',
      repo: 'repo',
      prNumber: 1242,
      title: 'Monotonic reviews PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    expect(
      upsertPrReviewByAuthor(db, detail.status.id, {
        author: 'reviewer',
        state: 'APPROVED',
        submittedAt: '2026-03-20T00:02:00.000Z',
      })
    ).toBe(true);
    expect(
      upsertPrReviewByAuthor(db, detail.status.id, {
        author: 'reviewer',
        state: 'COMMENTED',
        submittedAt: '2026-03-20T00:01:00.000Z',
      })
    ).toBe(false);

    const refreshed = getPrStatusByUrl(db, detail.status.pr_url);
    expect(refreshed?.reviews).toHaveLength(1);
    expect(refreshed?.reviews[0]).toMatchObject({
      author: 'reviewer',
      state: 'APPROVED',
      submitted_at: '2026-03-20T00:02:00.000Z',
    });
  });

  test('recomputeCheckRollupState applies failure, pending, success, and empty rollup rules', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1043',
      owner: 'example',
      repo: 'repo',
      prNumber: 1043,
      title: 'Rollup PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    expect(recomputeCheckRollupState(db, detail.status.id)).toBeNull();

    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'lint',
      source: 'check_run',
      status: 'completed',
      conclusion: 'success',
    });
    expect(recomputeCheckRollupState(db, detail.status.id)).toBe('success');

    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'pending',
      conclusion: null,
    });
    expect(recomputeCheckRollupState(db, detail.status.id)).toBe('pending');

    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'completed',
      conclusion: 'failure',
    });
    expect(recomputeCheckRollupState(db, detail.status.id)).toBe('failure');
    expect(getPrStatusByUrl(db, detail.status.pr_url)?.status.check_rollup_state).toBe('failure');
  });

  test('recomputeCheckRollupState prefers failure over success and pending over success', () => {
    const failureDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1143',
      owner: 'example',
      repo: 'repo',
      prNumber: 1143,
      title: 'Failure precedence PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    upsertPrCheckRunByName(db, failureDetail.status.id, {
      name: 'lint',
      source: 'check_run',
      status: 'completed',
      conclusion: 'success',
    });
    upsertPrCheckRunByName(db, failureDetail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'completed',
      conclusion: 'failure',
    });
    expect(recomputeCheckRollupState(db, failureDetail.status.id)).toBe('failure');

    const pendingDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1243',
      owner: 'example',
      repo: 'repo',
      prNumber: 1243,
      title: 'Pending precedence PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    upsertPrCheckRunByName(db, pendingDetail.status.id, {
      name: 'lint',
      source: 'check_run',
      status: 'completed',
      conclusion: 'success',
    });
    upsertPrCheckRunByName(db, pendingDetail.status.id, {
      name: 'tests',
      source: 'check_run',
      status: 'queued',
      conclusion: null,
    });
    expect(recomputeCheckRollupState(db, pendingDetail.status.id)).toBe('pending');
  });

  test('recomputeCheckRollupState treats neutral, skipped, and cancelled checks as non-blocking success', () => {
    const detail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/1343',
      owner: 'example',
      repo: 'repo',
      prNumber: 1343,
      title: 'Non-blocking checks PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'docs',
      source: 'check_run',
      status: 'completed',
      conclusion: 'neutral',
    });
    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'format',
      source: 'check_run',
      status: 'completed',
      conclusion: 'skipped',
    });
    upsertPrCheckRunByName(db, detail.status.id, {
      name: 'optional-lint',
      source: 'check_run',
      status: 'completed',
      conclusion: 'cancelled',
    });

    expect(recomputeCheckRollupState(db, detail.status.id)).toBe('success');
    expect(getPrStatusByUrl(db, detail.status.pr_url)?.status.check_rollup_state).toBe('success');
  });

  test('getKnownRepoFullNames returns parsed GitHub repository names from project rows', () => {
    getOrCreateProject(db, 'github.com__example__repo');
    getOrCreateProject(db, 'github.com__example__other-repo');
    getOrCreateProject(db, 'gitlab.com__example__ignored-repo');

    expect([...getKnownRepoFullNames(db)].sort()).toEqual(['example/other-repo', 'example/repo']);
  });

  test('getKnownRepoFullNames ignores malformed and non-github repository ids', () => {
    getOrCreateProject(db, '');
    getOrCreateProject(db, 'github.com__example__repo');
    getOrCreateProject(db, 'github.com__missing-repo-segment');
    getOrCreateProject(db, 'gitlab.com__example__repo');

    expect([...getKnownRepoFullNames(db)]).toEqual(['example/repo']);
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

  test('getPrStatusesForRepo returns only open PRs for the requested repository', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/301',
      owner: 'example',
      repo: 'repo',
      prNumber: 301,
      requestedReviewers: ['dimfeld'],
      title: 'Open PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/302',
      owner: 'example',
      repo: 'repo',
      prNumber: 302,
      title: 'Closed PR',
      state: 'closed',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/other/pull/303',
      owner: 'example',
      repo: 'other',
      prNumber: 303,
      title: 'Other repo PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const results = getPrStatusesForRepo(db, 'example', 'repo');
    expect(results.map((detail) => detail.status.pr_number)).toEqual([301]);
    expect(results[0]?.status.requested_reviewers).toBe('["dimfeld"]');
  });

  test('getLinkedPlansByPrUrl returns linked plans keyed by canonical PR url', () => {
    const pr1 = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/401',
      owner: 'example',
      repo: 'repo',
      prNumber: 401,
      title: 'Linked PR 1',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    const pr2 = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/402',
      owner: 'example',
      repo: 'repo',
      prNumber: 402,
      title: 'Linked PR 2',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', pr1.status.id);
    linkPlanToPr(db, 'plan-2', pr1.status.id);
    linkPlanToPr(db, 'plan-2', pr2.status.id);

    const links = getLinkedPlansByPrUrl(db, [
      'https://github.com/example/repo/pulls/401?tab=checks',
      'https://github.com/example/repo/pull/402',
      'https://github.com/example/repo/issues/999',
    ]);

    expect(links.get('https://github.com/example/repo/pull/401')).toEqual([
      { planUuid: 'plan-1', planId: 1, title: 'Plan 1' },
      { planUuid: 'plan-2', planId: 2, title: 'Plan 2' },
    ]);
    expect(links.get('https://github.com/example/repo/pull/402')).toEqual([
      { planUuid: 'plan-2', planId: 2, title: 'Plan 2' },
    ]);
    expect(links.has('https://github.com/example/repo/issues/999')).toBe(false);
  });

  test('getLinkedPlansByPrUrl returns empty arrays for canonical PRs with no linked plans', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/403',
      owner: 'example',
      repo: 'repo',
      prNumber: 403,
      title: 'Unlinked PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const links = getLinkedPlansByPrUrl(db, [
      'https://github.com/example/repo/pull/403',
      'https://github.com/example/repo/pull/403?tab=checks',
    ]);

    expect(links.get('https://github.com/example/repo/pull/403')).toEqual([]);
    expect(links.size).toBe(1);
  });

  test('getLinkedPlansByPrUrl de-duplicates plans when explicit and auto links coexist', () => {
    const pr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/404',
      owner: 'example',
      repo: 'repo',
      prNumber: 404,
      title: 'Dual source plan link',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', pr.status.id, 'explicit');
    linkPlanToPr(db, 'plan-1', pr.status.id, 'auto');

    expect(getLinkedPlansByPrUrl(db, [pr.status.pr_url]).get(pr.status.pr_url)).toEqual([
      { planUuid: 'plan-1', planId: 1, title: 'Plan 1' },
    ]);
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

  test('getPlansWithPrs keeps auto-linked rows when plan has no explicit pull_request values', () => {
    const openPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/208',
      owner: 'example',
      repo: 'repo',
      prNumber: 208,
      title: 'Auto-linked open PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', openPr.status.id, 'auto');

    expect(getPlansWithPrs(db)).toEqual([
      {
        uuid: 'plan-1',
        projectId,
        planId: 1,
        title: 'Plan 1',
        prUrls: ['https://github.com/example/repo/pull/208'],
      },
    ]);
  });

  test('getPlansWithPrs de-duplicates PR URLs when explicit and auto links coexist', () => {
    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      filename: '1.plan.md',
      status: 'in_progress',
      pullRequest: ['https://github.com/example/repo/pull/209'],
    });

    const openPr = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/209',
      owner: 'example',
      repo: 'repo',
      prNumber: 209,
      title: 'Dual source open PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    linkPlanToPr(db, 'plan-1', openPr.status.id, 'explicit');
    linkPlanToPr(db, 'plan-1', openPr.status.id, 'auto');

    expect(getPlansWithPrs(db)).toEqual([
      {
        uuid: 'plan-1',
        projectId,
        planId: 1,
        title: 'Plan 1',
        prUrls: ['https://github.com/example/repo/pull/209'],
      },
    ]);
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
