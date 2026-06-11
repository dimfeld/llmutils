import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../../tim/db/database.js';
import { nonSyncedUpsertPlan } from '../../tim/db/plan.js';
import { getOrCreateProject } from '../../tim/db/project.js';
import {
  getPrStatusByUrl,
  recomputeCheckRollupState,
  upsertPrCheckRunByName,
  upsertPrReviewRequestByReviewer,
  upsertPrStatus,
  upsertPrStatusMetadata,
} from '../../tim/db/pr_status.js';
import {
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  handleCheckRunEvent,
  handlePullRequestReviewThreadEvent,
} from './webhook_event_handlers.js';

describe('common/github/webhook_event_handlers', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-webhook-handlers-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));

    const projectId = getOrCreateProject(db, 'github.com__example__repo').id;
    nonSyncedUpsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      branch: 'feature/webhook',
      filename: '1.plan.md',
    });
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('handlePullRequestEvent creates PR metadata, links matching plans, and schedules targeted refresh', async () => {
    const result = handlePullRequestEvent(db, {
      action: 'opened',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 41,
        title: 'Webhook PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-41', ref: 'feature/webhook' },
        base: { ref: 'main' },
        labels: [{ name: 'backend', color: '00ff00' }],
        requested_reviewers: [{ login: 'bob' }],
        updated_at: '2026-03-30T12:00:00.000Z',
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/41');
    expect(result.updated).toBe(true);
    expect(result.prUrl).toBe('https://github.com/example/repo/pull/41');
    expect(result.apiRefreshTargets).toEqual([
      {
        owner: 'example',
        repo: 'repo',
        prNumber: 41,
        operation: 'mergeable/review_decision refresh',
        type: 'mergeable',
      },
    ]);
    expect(detail?.status.author).toBe('alice');
    expect(detail?.status.requested_reviewers).toBe('["bob"]');
    expect(detail?.labels.map((label) => label.name)).toEqual(['backend']);
    expect(
      db
        .prepare('SELECT plan_uuid, source FROM plan_pr WHERE pr_status_id = ?')
        .all(detail!.status.id)
    ).toEqual([{ plan_uuid: 'plan-1', source: 'auto' }]);
  });

  test('handlePullRequestEvent records review request history for requested reviewers', () => {
    handlePullRequestEvent(db, {
      action: 'review_requested',
      repository: { full_name: 'example/repo' },
      requested_reviewer: { login: 'bob' },
      pull_request: {
        number: 49,
        title: 'Webhook PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-49', ref: 'feature/webhook' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [{ login: 'bob' }],
        updated_at: '2026-03-30T12:00:00.000Z',
      },
    });

    handlePullRequestEvent(db, {
      action: 'review_request_removed',
      repository: { full_name: 'example/repo' },
      requested_reviewer: { login: 'bob' },
      pull_request: {
        number: 49,
        title: 'Webhook PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-49', ref: 'feature/webhook' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T13:00:00.000Z',
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/49');
    expect(detail?.status.requested_reviewers).toBe('[]');
    expect(detail?.reviewRequests).toEqual([
      expect.objectContaining({
        reviewer: 'bob',
        requested_at: '2026-03-30T12:00:00.000Z',
        removed_at: '2026-03-30T13:00:00.000Z',
        last_event_at: '2026-03-30T13:00:00.000Z',
        request_version: 1,
      }),
    ]);
  });

  test('handlePullRequestEvent still supports nested requested_reviewer payloads', () => {
    handlePullRequestEvent(db, {
      action: 'review_requested',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 50,
        title: 'Webhook PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-50', ref: 'feature/webhook' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [{ login: 'carol' }],
        requested_reviewer: { login: 'carol' },
        updated_at: '2026-03-30T12:00:00.000Z',
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/50');
    expect(detail?.reviewRequests).toEqual([
      expect.objectContaining({
        reviewer: 'carol',
        requested_at: '2026-03-30T12:00:00.000Z',
        removed_at: null,
      }),
    ]);
  });

  test('handlePullRequestEvent returns refresh target for opened PRs', () => {
    const result = handlePullRequestEvent(db, {
      action: 'opened',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 411,
        title: 'Webhook PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-411', ref: 'feature/webhook' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:00:00.000Z',
      },
    });

    expect(result.apiRefreshTargets).toEqual([
      {
        owner: 'example',
        repo: 'repo',
        prNumber: 411,
        operation: 'mergeable/review_decision refresh',
        type: 'mergeable',
      },
    ]);
  });

  test('handlePullRequestEvent auto-links on later pull_request events when the plan is created after the PR', () => {
    handlePullRequestEvent(db, {
      action: 'opened',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 47,
        title: 'Webhook PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-47', ref: 'feature/later-link' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:00:00.000Z',
      },
    });

    const projectId = getOrCreateProject(db, 'github.com__example__repo').id;
    nonSyncedUpsertPlan(db, projectId, {
      uuid: 'plan-2',
      planId: 2,
      title: 'Plan 2',
      branch: 'feature/later-link',
      filename: '2.plan.md',
    });

    const followupResult = handlePullRequestEvent(db, {
      action: 'labeled',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 47,
        title: 'Webhook PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-47', ref: 'feature/later-link' },
        base: { ref: 'main' },
        labels: [{ name: 'needs-review', color: 'cccccc' }],
        requested_reviewers: [],
        updated_at: '2026-03-30T13:00:00.000Z',
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/47');
    expect(followupResult.updated).toBe(true);
    expect(
      db
        .prepare('SELECT plan_uuid FROM plan_pr WHERE pr_status_id = ? ORDER BY plan_uuid')
        .all(detail!.status.id)
        .map((row) => (row as { plan_uuid: string }).plan_uuid)
    ).toEqual(['plan-2']);
  });

  test('handlePullRequestReviewEvent upserts the latest review state in uppercase', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/42',
      owner: 'example',
      repo: 'repo',
      prNumber: 42,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const result = handlePullRequestReviewEvent(db, {
      repository: { full_name: 'example/repo' },
      pull_request: { number: 42 },
      review: {
        state: 'changes_requested',
        body: 'Needs work\r\nin this area.',
        submitted_at: '2026-03-30T10:00:00.000Z',
        user: { login: 'reviewer-1' },
      },
    });

    // Handlers now return apiRefreshTargets instead of executing API calls directly

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/42');
    expect(result.updated).toBe(true);
    expect(detail?.reviews).toEqual([
      expect.objectContaining({
        author: 'reviewer-1',
        state: 'CHANGES_REQUESTED',
        body: 'Needs work\nin this area.',
        submitted_at: '2026-03-30T10:00:00.000Z',
      }),
    ]);
    expect(result.apiRefreshTargets).toEqual([
      {
        owner: 'example',
        repo: 'repo',
        prNumber: 42,
        operation: 'review_decision refresh',
        type: 'mergeable',
      },
    ]);
  });

  test('handlePullRequestReviewEvent surfaces submitted reviews with the author account type', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/42',
      owner: 'example',
      repo: 'repo',
      prNumber: 42,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const result = handlePullRequestReviewEvent(db, {
      action: 'submitted',
      repository: { full_name: 'example/repo' },
      pull_request: { number: 42 },
      review: {
        state: 'approved',
        body: 'Looks good',
        submitted_at: '2026-03-30T10:00:00.000Z',
        user: { login: 'reviewer-1', type: 'User' },
      },
    });

    expect(result.reviewSubmission).toEqual({
      owner: 'example',
      repo: 'repo',
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
      author: 'reviewer-1',
      authorType: 'User',
      state: 'APPROVED',
      submittedAt: '2026-03-30T10:00:00.000Z',
    });
  });

  test('handlePullRequestReviewEvent reports a null author type when the payload omits it', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/42',
      owner: 'example',
      repo: 'repo',
      prNumber: 42,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const result = handlePullRequestReviewEvent(db, {
      action: 'submitted',
      repository: { full_name: 'example/repo' },
      pull_request: { number: 42 },
      review: {
        state: 'commented',
        submitted_at: '2026-03-30T10:00:00.000Z',
        user: { login: 'reviewer-1' },
      },
    });

    expect(result.reviewSubmission).toEqual(
      expect.objectContaining({ author: 'reviewer-1', authorType: null, state: 'COMMENTED' })
    );
  });

  test('handlePullRequestReviewEvent does not surface non-submitted or dismissed review events', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/42',
      owner: 'example',
      repo: 'repo',
      prNumber: 42,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const editedResult = handlePullRequestReviewEvent(db, {
      action: 'edited',
      repository: { full_name: 'example/repo' },
      pull_request: { number: 42 },
      review: {
        state: 'approved',
        submitted_at: '2026-03-30T10:00:00.000Z',
        user: { login: 'reviewer-1', type: 'User' },
      },
    });
    expect(editedResult.reviewSubmission).toBeUndefined();

    const dismissedResult = handlePullRequestReviewEvent(db, {
      action: 'dismissed',
      repository: { full_name: 'example/repo' },
      pull_request: { number: 42 },
      review: {
        state: 'dismissed',
        submitted_at: '2026-03-30T11:00:00.000Z',
        user: { login: 'reviewer-1', type: 'User' },
      },
    });
    expect(dismissedResult.reviewSubmission).toBeUndefined();
  });

  test('handlePullRequestReviewThreadEvent parses thread node_id and numeric comment id for targeted refresh', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/44',
      owner: 'example',
      repo: 'repo',
      prNumber: 44,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const result = handlePullRequestReviewThreadEvent(db, {
      action: 'resolved',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 44,
        title: 'Existing PR',
        state: 'open',
        draft: false,
      },
      thread: {
        node_id: 'PRRT_thread_44',
        is_resolved: true,
      },
      comment: {
        id: 3056044198,
        body: 'Needs a fix.',
        created_at: '2026-03-30T10:00:00.000Z',
        user: { login: 'reviewer-1' },
      },
    });

    expect(result).toEqual({
      updated: true,
      prUrl: 'https://github.com/example/repo/pull/44',
      apiRefreshTargets: [
        {
          owner: 'example',
          repo: 'repo',
          prNumber: 44,
          operation: 'review thread resolved',
          type: 'review_threads',
          threadId: 'PRRT_thread_44',
        },
      ],
    });
  });

  test('handlePullRequestReviewThreadEvent updates resolved state locally when the thread is already cached', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/46',
      owner: 'example',
      repo: 'repo',
      prNumber: 46,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      reviewThreads: [
        {
          threadId: 'PRRT_thread_46',
          path: 'src/example.ts',
          line: 12,
          isResolved: false,
          isOutdated: false,
          comments: [{ commentId: 'comment-46', body: 'Existing thread.' }],
        },
      ],
    });

    const result = handlePullRequestReviewThreadEvent(db, {
      action: 'resolved',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 46,
        title: 'Existing PR',
        state: 'open',
        draft: false,
      },
      thread: {
        node_id: 'PRRT_thread_46',
        is_resolved: true,
      },
    });

    expect(result).toEqual({
      updated: true,
      prUrl: 'https://github.com/example/repo/pull/46',
      apiRefreshTargets: [],
    });
    expect(
      db
        .prepare(
          `SELECT is_resolved FROM pr_review_thread WHERE pr_status_id = (SELECT id FROM pr_status WHERE pr_url = ?) AND thread_id = ?`
        )
        .get('https://github.com/example/repo/pull/46', 'PRRT_thread_46')
    ).toEqual({ is_resolved: 1 });
  });

  test('handlePullRequestReviewEvent returns refresh target for approved reviews', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/422',
      owner: 'example',
      repo: 'repo',
      prNumber: 422,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const result = handlePullRequestReviewEvent(db, {
      repository: { full_name: 'example/repo' },
      pull_request: { number: 422 },
      review: {
        state: 'approved',
        submitted_at: '2026-03-30T10:00:00.000Z',
        user: { login: 'reviewer-1' },
      },
    });

    expect(result.apiRefreshTargets).toEqual([
      {
        owner: 'example',
        repo: 'repo',
        prNumber: 422,
        operation: 'review_decision refresh',
        type: 'mergeable',
      },
    ]);
  });

  test('handlePullRequestReviewEvent skips targeted refresh for commented reviews', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/142',
      owner: 'example',
      repo: 'repo',
      prNumber: 142,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const result = handlePullRequestReviewEvent(db, {
      repository: { full_name: 'example/repo' },
      pull_request: { number: 142 },
      review: {
        state: 'commented',
        submitted_at: '2026-03-30T10:00:00.000Z',
        user: { login: 'reviewer-2' },
      },
    });

    expect(result).toEqual({
      updated: true,
      prUrl: 'https://github.com/example/repo/pull/142',
      apiRefreshTargets: [],
    });
  });

  test('handlePullRequestReviewEvent only fires targeted refresh for decision-affecting review states', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/143',
      owner: 'example',
      repo: 'repo',
      prNumber: 143,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const pendingResult = handlePullRequestReviewEvent(db, {
      repository: { full_name: 'example/repo' },
      pull_request: { number: 143 },
      review: {
        state: 'pending',
        submitted_at: '2026-03-30T10:00:00.000Z',
        user: { login: 'reviewer-3' },
      },
    });
    const dismissedResult = handlePullRequestReviewEvent(db, {
      repository: { full_name: 'example/repo' },
      pull_request: { number: 143 },
      review: {
        state: 'dismissed',
        submitted_at: '2026-03-30T11:00:00.000Z',
        user: { login: 'reviewer-3' },
      },
    });

    expect(pendingResult).toEqual({
      updated: true,
      prUrl: 'https://github.com/example/repo/pull/143',
      apiRefreshTargets: [],
    });
    expect(dismissedResult.updated).toBe(true);
    expect(dismissedResult.prUrl).toBe('https://github.com/example/repo/pull/143');
    expect(dismissedResult.apiRefreshTargets).toEqual([
      {
        owner: 'example',
        repo: 'repo',
        prNumber: 143,
        operation: 'review_decision refresh',
        type: 'mergeable',
      },
    ]);

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/143');
    expect(detail?.reviews).toEqual([
      expect.objectContaining({
        author: 'reviewer-3',
        state: 'DISMISSED',
        submitted_at: '2026-03-30T11:00:00.000Z',
      }),
    ]);
  });

  test('handlePullRequestReviewEvent preserves review request history when reviews arrive later', () => {
    const created = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/50',
      owner: 'example',
      repo: 'repo',
      prNumber: 50,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });
    upsertPrReviewRequestByReviewer(db, created.status.id, {
      reviewer: 'reviewer-5',
      action: 'requested',
      eventAt: '2026-03-30T10:00:00.000Z',
    });

    const result = handlePullRequestReviewEvent(db, {
      repository: { full_name: 'example/repo' },
      pull_request: { number: 50 },
      review: {
        state: 'approved',
        submitted_at: '2026-03-30T11:00:00.000Z',
        user: { login: 'reviewer-5' },
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/50');
    expect(result.updated).toBe(true);
    expect(detail?.reviewRequests).toEqual([
      expect.objectContaining({
        reviewer: 'reviewer-5',
        requested_at: '2026-03-30T10:00:00.000Z',
        removed_at: null,
        last_event_at: '2026-03-30T10:00:00.000Z',
        request_version: 0,
      }),
    ]);
    expect(detail?.reviews).toEqual([
      expect.objectContaining({
        author: 'reviewer-5',
        state: 'APPROVED',
        submitted_at: '2026-03-30T11:00:00.000Z',
      }),
    ]);
  });

  test('handlePullRequestReviewEvent treats stale reviews as no-op updates', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/144',
      owner: 'example',
      repo: 'repo',
      prNumber: 144,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      reviews: [
        { author: 'reviewer-4', state: 'APPROVED', submittedAt: '2026-03-30T11:00:00.000Z' },
      ],
    });

    const result = handlePullRequestReviewEvent(db, {
      repository: { full_name: 'example/repo' },
      pull_request: { number: 144 },
      review: {
        state: 'changes_requested',
        submitted_at: '2026-03-30T10:00:00.000Z',
        user: { login: 'reviewer-4' },
      },
    });

    expect(result).toEqual({
      updated: false,
      prUrl: 'https://github.com/example/repo/pull/144',
      apiRefreshTargets: [],
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/144');
    expect(detail?.reviews).toEqual([
      expect.objectContaining({
        author: 'reviewer-4',
        state: 'APPROVED',
        submitted_at: '2026-03-30T11:00:00.000Z',
      }),
    ]);
  });

  test('handlePullRequestEvent detects merged PRs, preserves existing targeted fields, and skips targeted refresh for non-refresh actions', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/44',
      owner: 'example',
      repo: 'repo',
      prNumber: 44,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      checkRollupState: 'success',
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [
        { name: 'existing-check', source: 'check_run', status: 'completed', conclusion: 'success' },
      ],
      reviews: [
        { author: 'reviewer-1', state: 'APPROVED', submittedAt: '2026-03-20T00:05:00.000Z' },
      ],
      labels: [{ name: 'old-label', color: 'ff0000' }],
    });

    const result = handlePullRequestEvent(db, {
      action: 'labeled',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 44,
        title: 'Merged PR',
        state: 'closed',
        draft: false,
        merged_at: '2026-03-30T10:10:00.000Z',
        user: { login: 'alice' },
        head: { sha: 'sha-44', ref: 'feature/other' },
        base: { ref: 'main' },
        labels: [{ name: 'new-label', color: '00ff00' }],
        requested_reviewers: [{ login: 'bob' }],
      },
    });

    expect(result).toEqual({
      updated: true,
      prUrl: 'https://github.com/example/repo/pull/44',
      apiRefreshTargets: [],
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/44');
    expect(detail?.status.state).toBe('merged');
    expect(detail?.status.mergeable).toBe('MERGEABLE');
    expect(detail?.status.review_decision).toBe('APPROVED');
    expect(detail?.status.check_rollup_state).toBe('success');
    expect(detail?.labels.map((label) => label.name)).toEqual(['new-label']);
    expect(detail?.checks.map((check) => check.name)).toEqual(['existing-check']);
    expect(detail?.reviews.map((review) => review.author)).toEqual(['reviewer-1']);
  });

  test('handlePullRequestEvent clears stale checks and rollup when synchronize changes the head SHA', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/45',
      owner: 'example',
      repo: 'repo',
      prNumber: 45,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      checkRollupState: 'success',
      headSha: 'sha-old',
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [
        { name: 'existing-check', source: 'check_run', status: 'completed', conclusion: 'success' },
      ],
    });

    const result = handlePullRequestEvent(db, {
      action: 'synchronize',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 45,
        title: 'Existing PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-new', ref: 'feature/webhook' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:00:00.000Z',
      },
    });

    expect(result.apiRefreshTargets).toEqual([
      {
        owner: 'example',
        repo: 'repo',
        prNumber: 45,
        operation: 'mergeable/review_decision refresh',
        type: 'mergeable',
      },
    ]);
    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/45');
    expect(detail?.status.head_sha).toBe('sha-new');
    expect(detail?.status.check_rollup_state).toBeNull();
    expect(detail?.checks).toEqual([]);
    expect(detail?.status.mergeable).toBe('MERGEABLE');
    expect(detail?.status.review_decision).toBe('APPROVED');
  });

  test('handlePullRequestEvent schedules targeted refresh when a draft PR becomes ready for review', async () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/48',
      owner: 'example',
      repo: 'repo',
      prNumber: 48,
      title: 'Draft PR',
      state: 'open',
      draft: true,
      lastFetchedAt: '2026-03-30T12:00:00.000Z',
    });

    const result = handlePullRequestEvent(db, {
      action: 'ready_for_review',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 48,
        title: 'Ready PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-48', ref: 'feature/ready' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:30:00.000Z',
      },
    });

    expect(result.updated).toBe(true);
    expect(result.prUrl).toBe('https://github.com/example/repo/pull/48');
    expect(result.prDraftTransition).toBe('became_ready');
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/48')?.status.ready_at).toBe(
      '2026-03-30T12:30:00.000Z'
    );
    expect(result.apiRefreshTargets).toEqual([
      {
        owner: 'example',
        repo: 'repo',
        prNumber: 48,
        operation: 'mergeable/review_decision refresh',
        type: 'mergeable',
      },
    ]);
  });

  test('handlePullRequestEvent reports ready transition for an applied ready_for_review action even when cache is already non-draft', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/49',
      owner: 'example',
      repo: 'repo',
      prNumber: 49,
      title: 'Ready PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-30T12:00:00.000Z',
    });

    const result = handlePullRequestEvent(db, {
      action: 'ready_for_review',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 49,
        title: 'Ready PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-49', ref: 'feature/ready' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:30:00.000Z',
      },
    });

    expect(result.updated).toBe(true);
    expect(result.prUrl).toBe('https://github.com/example/repo/pull/49');
    expect(result.prDraftTransition).toBe('became_ready');
  });

  test('handlePullRequestEvent reports when a ready PR is converted back to draft', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/55',
      owner: 'example',
      repo: 'repo',
      prNumber: 55,
      title: 'Ready PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-30T12:00:00.000Z',
    });

    const result = handlePullRequestEvent(db, {
      action: 'converted_to_draft',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 55,
        title: 'Ready PR',
        state: 'open',
        draft: true,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-55', ref: 'feature/ready' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:30:00.000Z',
      },
    });

    expect(result.updated).toBe(true);
    expect(result.prUrl).toBe('https://github.com/example/repo/pull/55');
    expect(result.prDraftTransition).toBe('became_draft');
    expect(
      getPrStatusByUrl(db, 'https://github.com/example/repo/pull/55')?.status.ready_at
    ).toBeNull();
    expect(result.apiRefreshTargets).toEqual([]);
  });

  test('handlePullRequestEvent flags prReadyForReview when a PR is opened in a ready state', () => {
    const result = handlePullRequestEvent(db, {
      action: 'opened',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 60,
        title: 'Opened ready',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-60', ref: 'feature/opened-ready' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:30:00.000Z',
      },
    });

    expect(result.updated).toBe(true);
    expect(result.prReadyForReview).toBe(true);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/60')?.status.ready_at).toBe(
      '2026-03-30T12:30:00.000Z'
    );
  });

  test('handlePullRequestEvent flags prReadyForReview when a draft PR becomes ready', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/61',
      owner: 'example',
      repo: 'repo',
      prNumber: 61,
      title: 'Draft PR',
      state: 'open',
      draft: true,
      lastFetchedAt: '2026-03-30T12:00:00.000Z',
    });

    const result = handlePullRequestEvent(db, {
      action: 'ready_for_review',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 61,
        title: 'Now ready',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-61', ref: 'feature/became-ready' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:30:00.000Z',
      },
    });

    expect(result.prReadyForReview).toBe(true);
    expect(result.prDraftTransition).toBe('became_ready');
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/61')?.status.ready_at).toBe(
      '2026-03-30T12:30:00.000Z'
    );
  });

  test('handlePullRequestEvent does not flag prReadyForReview for draft opens, draft conversions, or pushes', () => {
    const openedDraft = handlePullRequestEvent(db, {
      action: 'opened',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 62,
        title: 'Opened draft',
        state: 'open',
        draft: true,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-62', ref: 'feature/opened-draft' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:30:00.000Z',
      },
    });
    expect(openedDraft.prReadyForReview).toBeUndefined();

    const synchronize = handlePullRequestEvent(db, {
      action: 'synchronize',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 62,
        title: 'Opened draft',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-62b', ref: 'feature/opened-draft' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:31:00.000Z',
      },
    });
    // A push that happens to flip draft off still isn't a "ready_for_review"/"opened" action.
    expect(synchronize.prReadyForReview).toBeUndefined();
  });

  test('handlePullRequestEvent does not report a draft transition for new or unchanged PR rows', () => {
    const newPrResult = handlePullRequestEvent(db, {
      action: 'opened',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 56,
        title: 'New ready PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-56', ref: 'feature/new-ready' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:30:00.000Z',
      },
    });
    expect(newPrResult.updated).toBe(true);
    expect(newPrResult.prDraftTransition).toBeUndefined();

    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/57',
      owner: 'example',
      repo: 'repo',
      prNumber: 57,
      title: 'Still draft',
      state: 'open',
      draft: true,
      lastFetchedAt: '2026-03-30T12:00:00.000Z',
    });

    const unchangedDraftResult = handlePullRequestEvent(db, {
      action: 'synchronize',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 57,
        title: 'Still draft',
        state: 'open',
        draft: true,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-57', ref: 'feature/still-draft' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:30:00.000Z',
      },
    });

    expect(unchangedDraftResult.updated).toBe(true);
    expect(unchangedDraftResult.prDraftTransition).toBeUndefined();
  });

  test('handlePullRequestEvent does not report a draft transition when the draft flag is unchanged', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/58',
      owner: 'example',
      repo: 'repo',
      prNumber: 58,
      title: 'Ready PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-30T12:00:00.000Z',
    });

    const result = handlePullRequestEvent(db, {
      action: 'synchronize',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 58,
        title: 'Ready PR',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-58', ref: 'feature/still-ready' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:30:00.000Z',
      },
    });

    expect(result.updated).toBe(true);
    expect(result.prDraftTransition).toBeUndefined();
  });

  test('handlePullRequestEvent does not report a draft transition for stale metadata with a differing draft flag', () => {
    upsertPrStatusMetadata(db, {
      prUrl: 'https://github.com/example/repo/pull/59',
      owner: 'example',
      repo: 'repo',
      prNumber: 59,
      title: 'Newer ready PR',
      author: 'alice',
      state: 'open',
      draft: false,
      headSha: 'sha-new',
      requestedReviewers: [],
      prUpdatedAt: '2026-03-30T12:00:00.000Z',
      lastFetchedAt: '2026-03-30T12:00:00.000Z',
      checks: [],
      labels: [],
    });

    const result = handlePullRequestEvent(db, {
      action: 'converted_to_draft',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 59,
        title: 'Stale draft PR',
        state: 'open',
        draft: true,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-old', ref: 'feature/stale-draft' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T11:00:00.000Z',
      },
    });

    expect(result.updated).toBe(false);
    expect(result.prDraftTransition).toBeUndefined();
    expect(result.apiRefreshTargets).toEqual([]);
    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/59');
    expect(detail?.status.draft).toBe(0);
    expect(detail?.status.pr_updated_at).toBe('2026-03-30T12:00:00.000Z');
  });

  test('handlePullRequestEvent ignores stale pull_request metadata updates and preserves newer checks', () => {
    nonSyncedUpsertPlan(db, getOrCreateProject(db, 'github.com__example__repo').id, {
      uuid: 'plan-stale-branch',
      planId: 99,
      title: 'Stale branch plan',
      branch: 'feature/stale',
      filename: '99.plan.md',
    });

    upsertPrStatusMetadata(db, {
      prUrl: 'https://github.com/example/repo/pull/46',
      owner: 'example',
      repo: 'repo',
      prNumber: 46,
      title: 'Newest PR title',
      author: 'alice',
      state: 'open',
      draft: false,
      headSha: 'sha-new',
      requestedReviewers: ['bob'],
      prUpdatedAt: '2026-03-30T12:00:00.000Z',
      lastFetchedAt: '2026-03-30T12:00:00.000Z',
      checks: [],
      labels: [{ name: 'new-label', color: '00ff00' }],
    });
    const existing = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/46');
    upsertPrCheckRunByName(db, existing!.status.id, {
      name: 'existing-check',
      source: 'check_run',
      status: 'completed',
      conclusion: 'success',
    });
    recomputeCheckRollupState(db, existing!.status.id);

    const result = handlePullRequestEvent(db, {
      action: 'synchronize',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 46,
        title: 'Stale PR title',
        state: 'open',
        draft: false,
        merged_at: null,
        updated_at: '2026-03-30T11:00:00.000Z',
        user: { login: 'alice' },
        head: { sha: 'sha-old', ref: 'feature/stale' },
        base: { ref: 'main' },
        labels: [{ name: 'stale-label', color: 'ff0000' }],
        requested_reviewers: [],
      },
    });

    expect(result.apiRefreshTargets).toEqual([]);
    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/46');
    expect(result.updated).toBe(false);
    expect(detail?.status.title).toBe('Newest PR title');
    expect(detail?.status.head_sha).toBe('sha-new');
    expect(detail?.status.pr_updated_at).toBe('2026-03-30T12:00:00.000Z');
    expect(detail?.status.check_rollup_state).toBe('success');
    expect(detail?.checks.map((check) => check.name)).toEqual(['existing-check']);
    expect(detail?.labels.map((label) => label.name)).toEqual(['new-label']);
    expect(
      db
        .prepare('SELECT COUNT(*) as count FROM plan_pr WHERE pr_status_id = ?')
        .get(detail!.status.id)
    ).toEqual({ count: 0 });
  });

  test('handlePullRequestReviewEvent skips unknown PR rows even for known repositories', async () => {
    expect(
      handlePullRequestReviewEvent(db, {
        repository: { full_name: 'example/repo' },
        pull_request: { number: 404 },
        review: {
          state: 'approved',
          submitted_at: '2026-03-30T10:00:00.000Z',
          user: { login: 'reviewer-1' },
        },
      })
    ).toEqual({ updated: false });
  });

  test('handleCheckRunEvent updates checks and recomputes rollup state for matching PRs', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/43',
      owner: 'example',
      repo: 'repo',
      prNumber: 43,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const result = handleCheckRunEvent(db, {
      repository: { full_name: 'example/repo' },
      check_run: {
        name: 'unit tests',
        status: 'completed',
        conclusion: 'failure',
        details_url: 'https://example.com/checks/43',
        started_at: '2026-03-30T10:00:00.000Z',
        completed_at: '2026-03-30T10:05:00.000Z',
        pull_requests: [{ number: 43 }],
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/43');
    expect(result).toEqual({
      updated: true,
      prUrls: ['https://github.com/example/repo/pull/43'],
    });
    expect(detail?.checks).toEqual([
      expect.objectContaining({
        name: 'unit tests',
        status: 'completed',
        conclusion: 'failure',
      }),
    ]);
    expect(detail?.status.check_rollup_state).toBe('failure');
  });

  test('handleCheckRunEvent performs the check update and rollup recompute inside a transaction', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/46',
      owner: 'example',
      repo: 'repo',
      prNumber: 46,
      title: 'Existing PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const originalTransaction = db.transaction.bind(db);
    const transactionSpy = vi.fn((callback: () => void) => originalTransaction(callback));
    (
      db as Database & {
        transaction: typeof db.transaction;
      }
    ).transaction = transactionSpy as typeof db.transaction;

    const result = handleCheckRunEvent(db, {
      repository: { full_name: 'example/repo' },
      check_run: {
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        details_url: 'https://example.com/checks/46',
        started_at: '2026-03-30T10:00:00.000Z',
        completed_at: '2026-03-30T10:03:00.000Z',
        pull_requests: [{ number: 46 }],
      },
    });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      updated: true,
      prUrls: ['https://github.com/example/repo/pull/46'],
    });
    expect(
      getPrStatusByUrl(db, 'https://github.com/example/repo/pull/46')?.status.check_rollup_state
    ).toBe('success');
  });

  test('handleCheckRunEvent updates multiple PRs, skips unknown PR rows, and recomputes rollup per PR', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/52',
      owner: 'example',
      repo: 'repo',
      prNumber: 52,
      title: 'PR 52',
      state: 'open',
      draft: false,
      checkRollupState: 'success',
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [
        { name: 'existing-check', source: 'check_run', status: 'completed', conclusion: 'success' },
      ],
    });
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/53',
      owner: 'example',
      repo: 'repo',
      prNumber: 53,
      title: 'PR 53',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const result = handleCheckRunEvent(db, {
      repository: { full_name: 'example/repo' },
      check_run: {
        name: 'integration tests',
        status: 'completed',
        conclusion: 'neutral',
        details_url: 'https://example.com/checks/multi',
        started_at: '2026-03-30T10:00:00.000Z',
        completed_at: '2026-03-30T10:05:00.000Z',
        pull_requests: [{ number: 52 }, { number: 53 }, { number: 999 }],
      },
    });

    expect(result).toEqual({
      updated: true,
      prUrls: [
        'https://github.com/example/repo/pull/52',
        'https://github.com/example/repo/pull/53',
      ],
    });

    const detail52 = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/52');
    const detail53 = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/53');
    expect(detail52?.checks.map((check) => check.name).toSorted()).toEqual([
      'existing-check',
      'integration tests',
    ]);
    expect(detail52?.status.check_rollup_state).toBe('success');
    expect(detail53?.checks).toEqual([
      expect.objectContaining({
        name: 'integration tests',
        conclusion: 'neutral',
      }),
    ]);
    expect(detail53?.status.check_rollup_state).toBe('success');
  });

  test('handleCheckRunEvent returns unchanged when all referenced PR rows are unknown', async () => {
    expect(
      handleCheckRunEvent(db, {
        repository: { full_name: 'example/repo' },
        check_run: {
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          pull_requests: [{ number: 999 }],
        },
      })
    ).toEqual({
      updated: false,
      prUrls: [],
    });
  });

  test('handlePullRequestEvent stores diff stats from webhook payload', () => {
    handlePullRequestEvent(db, {
      action: 'opened',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 201,
        title: 'PR with diff stats',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-201', ref: 'feature/diff-stats' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:00:00.000Z',
        additions: 42,
        deletions: 17,
        changed_files: 3,
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/201');
    expect(detail?.status.additions).toBe(42);
    expect(detail?.status.deletions).toBe(17);
    expect(detail?.status.changed_files).toBe(3);
  });

  test('handlePullRequestEvent stores null diff stats when not provided in payload', () => {
    handlePullRequestEvent(db, {
      action: 'opened',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 202,
        title: 'PR without diff stats',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-202', ref: 'feature/no-stats' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:00:00.000Z',
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/202');
    expect(detail?.status.additions).toBeNull();
    expect(detail?.status.deletions).toBeNull();
    expect(detail?.status.changed_files).toBeNull();
  });

  test('handlePullRequestEvent preserves existing diff stats when new webhook payload has no diff stats', () => {
    // First upsert sets the diff stats via a full status insert
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/203',
      owner: 'example',
      repo: 'repo',
      prNumber: 203,
      author: 'alice',
      title: 'PR with initial diff stats',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-29T00:00:00.000Z',
      additions: 100,
      deletions: 50,
      changedFiles: 8,
    });

    // Webhook event without diff stats should not clear existing values (COALESCE)
    handlePullRequestEvent(db, {
      action: 'labeled',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 203,
        title: 'PR with initial diff stats',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-203', ref: 'feature/coalesce-test' },
        base: { ref: 'main' },
        labels: [{ name: 'bug', color: 'ff0000' }],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:00:00.000Z',
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/203');
    expect(detail?.status.additions).toBe(100);
    expect(detail?.status.deletions).toBe(50);
    expect(detail?.status.changed_files).toBe(8);
  });

  test('handlePullRequestEvent updates diff stats when new webhook payload provides them', () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/204',
      owner: 'example',
      repo: 'repo',
      prNumber: 204,
      author: 'alice',
      title: 'PR with diff stats to update',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-29T00:00:00.000Z',
      additions: 10,
      deletions: 5,
      changedFiles: 2,
    });

    handlePullRequestEvent(db, {
      action: 'synchronize',
      repository: { full_name: 'example/repo' },
      pull_request: {
        number: 204,
        title: 'PR with diff stats to update',
        state: 'open',
        draft: false,
        merged_at: null,
        user: { login: 'alice' },
        head: { sha: 'sha-204-new', ref: 'feature/update-stats' },
        base: { ref: 'main' },
        labels: [],
        requested_reviewers: [],
        updated_at: '2026-03-30T12:00:00.000Z',
        additions: 200,
        deletions: 80,
        changed_files: 15,
      },
    });

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/204');
    expect(detail?.status.additions).toBe(200);
    expect(detail?.status.deletions).toBe(80);
    expect(detail?.status.changed_files).toBe(15);
  });

  test('handlers ignore webhook events for unknown repositories', () => {
    expect(
      handlePullRequestEvent(db, {
        action: 'opened',
        repository: { full_name: 'other/repo' },
        pull_request: { number: 1, state: 'open', draft: false },
      })
    ).toEqual({ updated: false });
    expect(
      handlePullRequestReviewEvent(db, {
        repository: { full_name: 'other/repo' },
        pull_request: { number: 1 },
        review: { state: 'approved', user: { login: 'alice' } },
      })
    ).toEqual({ updated: false });
    expect(
      handleCheckRunEvent(db, {
        repository: { full_name: 'other/repo' },
        check_run: { name: 'ci', status: 'completed', pull_requests: [{ number: 1 }] },
      })
    ).toEqual({ updated: false });
  });
});
