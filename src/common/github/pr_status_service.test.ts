import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../../tim/db/database.js';
import { getBranchMergeRequirements } from '../../tim/db/branch_merge_requirements.js';
import { getPrStatusByUrl, getPrStatusForPlan, upsertPrStatus } from '../../tim/db/pr_status.js';
import { upsertPlan } from '../../tim/db/plan.js';
import { getOrCreateProject } from '../../tim/db/project.js';

// Mock the GitHub modules
vi.mock('../../common/github/identifiers.ts', () => ({
  parsePrOrIssueNumber: vi.fn(),
  canonicalizePrUrl: vi.fn((identifier: string) => identifier),
  validatePrIdentifier: vi.fn(() => {}),
  tryCanonicalizePrUrl: vi.fn((identifier: string) => identifier),
}));

vi.mock('../../common/github/pr_status.ts', () => ({
  fetchPrFullStatus: vi.fn(),
  fetchPrCheckStatus: vi.fn(),
  fetchPrMergeableAndReviewDecision: vi.fn(),
  fetchPrReviewThread: vi.fn(),
  fetchPrReviewThreads: vi.fn(),
}));

vi.mock('../../common/github/branch_merge_requirements.ts', () => ({
  fetchBranchMergeRequirements: vi.fn(),
}));

// Import mocked modules
import {
  parsePrOrIssueNumber,
  canonicalizePrUrl,
  validatePrIdentifier,
  tryCanonicalizePrUrl,
} from '../../common/github/identifiers.ts';
import {
  fetchPrCheckStatus,
  fetchPrFullStatus,
  fetchPrMergeableAndReviewDecision,
  fetchPrReviewThread,
  fetchPrReviewThreads,
} from '../../common/github/pr_status.ts';
import { fetchBranchMergeRequirements } from '../../common/github/branch_merge_requirements.ts';

function makeIdentifiersMock(
  parsePrOrIssueNumberImpl: (...args: unknown[]) => unknown,
  options?: {
    canonicalizePrUrl?: (identifier: string) => string;
    validatePrIdentifier?: (identifier: string) => void;
    tryCanonicalizePrUrl?: (identifier: string) => string;
  }
) {
  return {
    canonicalizePrUrl: options?.canonicalizePrUrl ?? ((identifier: string) => identifier),
    parsePrOrIssueNumber: vi.fn(parsePrOrIssueNumberImpl),
    validatePrIdentifier: options?.validatePrIdentifier ?? (() => {}),
    tryCanonicalizePrUrl: options?.tryCanonicalizePrUrl ?? ((identifier: string) => identifier),
  };
}

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

    vi.mocked(fetchBranchMergeRequirements).mockResolvedValue({
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      requirements: [],
    });

    // Reset all mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.resetAllMocks();
    vi.clearAllMocks();
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('refreshPrStatus fetches and caches a full PR record', async () => {
    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);
    const mockFetchBranchMergeRequirements = vi.mocked(fetchBranchMergeRequirements);

    mockFetchPrFullStatus.mockResolvedValue({
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
      additions: 10,
      deletions: 5,
      changedFiles: 3,
    });
    mockFetchPrReviewThreads.mockResolvedValue([]);
    mockFetchBranchMergeRequirements.mockResolvedValue({
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      requirements: [
        {
          sourceKind: 'legacy_branch_protection',
          sourceId: 0,
          sourceName: null,
          strict: true,
          checks: [{ context: 'test', integrationId: null }],
        },
      ],
    });

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 201 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/201');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/201');

    const { refreshPrStatus } = await import('./pr_status_service.ts');
    const result = await refreshPrStatus(db, 'https://github.com/example/repo/pull/201');

    expect(fetchPrFullStatus).toHaveBeenCalledWith('example', 'repo', 201);
    expect(fetchBranchMergeRequirements).toHaveBeenCalledWith('example', 'repo', 'main');
    expect(result.status.title).toBe('Service PR');
    expect(result.status.check_rollup_state).toBe('success');
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/201')?.checks).toHaveLength(
      1
    );
    expect(getBranchMergeRequirements(db, 'example', 'repo', 'main')?.requirements).toHaveLength(1);
  });

  test('refreshPrStatus persists additions, deletions, and changedFiles to the DB', async () => {
    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);
    const mockFetchBranchMergeRequirements = vi.mocked(fetchBranchMergeRequirements);

    mockFetchPrFullStatus.mockResolvedValue({
      number: 250,
      title: 'Diff stats PR',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'diff-sha',
      baseRefName: 'main',
      headRefName: 'feature/diff-stats',
      reviewDecision: null,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'success' as const,
      additions: 42,
      deletions: 17,
      changedFiles: 3,
    });
    mockFetchPrReviewThreads.mockResolvedValue([]);
    mockFetchBranchMergeRequirements.mockResolvedValue({
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      requirements: [],
    });

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 250 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/250');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/250');

    const { refreshPrStatus } = await import('./pr_status_service.ts');
    await refreshPrStatus(db, 'https://github.com/example/repo/pull/250');

    const stored = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/250');
    expect(stored?.status.additions).toBe(42);
    expect(stored?.status.deletions).toBe(17);
    expect(stored?.status.changed_files).toBe(3);
  });

  test('refreshPrStatus handles null diff stats gracefully', async () => {
    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);
    const mockFetchBranchMergeRequirements = vi.mocked(fetchBranchMergeRequirements);

    mockFetchPrFullStatus.mockResolvedValue({
      number: 251,
      title: 'No diff stats PR',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'nodiff-sha',
      baseRefName: 'main',
      headRefName: 'feature/no-diff',
      reviewDecision: null,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'success' as const,
      additions: null,
      deletions: null,
      changedFiles: null,
    });
    mockFetchPrReviewThreads.mockResolvedValue([]);
    mockFetchBranchMergeRequirements.mockResolvedValue({
      owner: 'example',
      repo: 'repo',
      branchName: 'main',
      requirements: [],
    });

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 251 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/251');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/251');

    const { refreshPrStatus } = await import('./pr_status_service.ts');
    await refreshPrStatus(db, 'https://github.com/example/repo/pull/251');

    const stored = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/251');
    expect(stored?.status.additions).toBeNull();
    expect(stored?.status.deletions).toBeNull();
    expect(stored?.status.changed_files).toBeNull();
  });

  test('refreshPrStatus persists review threads when the GitHub fetch succeeds', async () => {
    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);

    mockFetchPrFullStatus.mockResolvedValue({
      number: 207,
      title: 'Threaded PR',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'thread-sha',
      baseRefName: 'main',
      headRefName: 'feature/threaded',
      reviewDecision: 'CHANGES_REQUESTED' as const,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'failure' as const,
    });
    mockFetchPrReviewThreads.mockResolvedValue([
      {
        threadId: 'thread-1',
        path: 'src/example.ts',
        line: 42,
        isResolved: false,
        isOutdated: false,
        comments: [
          {
            commentId: 'comment-1',
            databaseId: 401,
            author: 'reviewer',
            body: 'Please rename this.',
            diffHunk: '@@ -42,1 +42,1 @@',
            state: 'COMMENTED',
            createdAt: '2026-03-20T00:20:00.000Z',
          },
        ],
      },
    ]);
    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 207 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/207');

    const { refreshPrStatus } = await import('./pr_status_service.ts');
    const result = await refreshPrStatus(db, 'https://github.com/example/repo/pull/207');

    expect(fetchPrReviewThreads).toHaveBeenCalledWith('example', 'repo', 207);
    expect(result.reviewThreads).toHaveLength(1);
    expect(result.reviewThreads?.[0]?.thread.path).toBe('src/example.ts');
    expect(result.reviewThreads?.[0]?.comments[0]?.database_id).toBe(401);
  });

  test('refreshPrStatus preserves cached review threads when review thread fetch fails', async () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/208',
      owner: 'example',
      repo: 'repo',
      prNumber: 208,
      title: 'Cached review thread PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      reviewThreads: [
        {
          threadId: 'cached-thread',
          path: 'src/cached.ts',
          line: 7,
          isResolved: false,
          isOutdated: false,
          comments: [{ commentId: 'cached-comment', body: 'Keep me cached.' }],
        },
      ],
    });

    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    mockFetchPrFullStatus.mockResolvedValue({
      number: 208,
      title: 'Cached review thread PR',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'cached-thread-sha',
      baseRefName: 'main',
      headRefName: 'feature/cached-thread',
      reviewDecision: null,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'success' as const,
    });
    mockFetchPrReviewThreads.mockRejectedValue(new Error('thread fetch failed'));
    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 208 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/208');

    const { refreshPrStatus } = await import('./pr_status_service.ts');
    await refreshPrStatus(db, 'https://github.com/example/repo/pull/208');

    expect(warnSpy).toHaveBeenCalled();
    expect(
      getPrStatusByUrl(db, 'https://github.com/example/repo/pull/208', {
        includeReviewThreads: true,
      })?.reviewThreads
    ).toHaveLength(1);
    expect(
      getPrStatusByUrl(db, 'https://github.com/example/repo/pull/208', {
        includeReviewThreads: true,
      })?.reviewThreads?.[0]?.thread.thread_id
    ).toBe('cached-thread');
    warnSpy.mockRestore();
  });

  test('refreshPrStatus uses the real URL canonicalization path before caching', async () => {
    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockResolvedValue({
      number: 219,
      title: 'Canonicalized by service',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'canonical-sha',
      baseRefName: 'main',
      headRefName: 'feature/canonical',
      reviewDecision: null,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'success' as const,
    });
    mockFetchPrReviewThreads.mockResolvedValue([]);

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 219 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/219');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/219');

    const { refreshPrStatus } = await import('./pr_status_service.ts');
    await refreshPrStatus(
      db,
      'https://github.com/example/repo/pulls/219/?tab=checks#partial-pull-merging'
    );

    expect(fetchPrFullStatus).toHaveBeenCalledWith('example', 'repo', 219);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/219')).not.toBeNull();
    expect(
      getPrStatusByUrl(
        db,
        'https://github.com/example/repo/pulls/219/?tab=checks#partial-pull-merging'
      )
    ).not.toBeNull();
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

    const mockFetchPrCheckStatus = vi.mocked(fetchPrCheckStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrCheckStatus.mockResolvedValue({
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
    });

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 202 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/202');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/202');

    const { refreshPrCheckStatus } = await import('./pr_status_service.ts');
    const result = await refreshPrCheckStatus(db, 'https://github.com/example/repo/pull/202');

    expect(fetchPrCheckStatus).toHaveBeenCalledWith('example', 'repo', 202);
    expect(result.checks.map((check) => check.name)).toEqual(['new-check']);
    expect(result.checks.map((check) => check.source)).toEqual(['check_run']);
    expect(result.status.check_rollup_state).toBe('failure');
    expect(result.reviews.map((review) => review.author)).toEqual(['bob']);
    expect(result.labels.map((label) => label.name)).toEqual(['bug']);
  });

  test('fetchAndUpdatePrReviewThreads updates only the targeted thread when a thread id is provided', async () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/230',
      owner: 'example',
      repo: 'repo',
      prNumber: 230,
      title: 'Targeted thread refresh',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      reviewThreads: [
        {
          threadId: 'thread-1',
          path: 'src/one.ts',
          line: 10,
          isResolved: false,
          isOutdated: false,
          comments: [{ commentId: 'comment-1', body: 'Keep this thread.' }],
        },
        {
          threadId: 'thread-2',
          path: 'src/two.ts',
          line: 20,
          isResolved: false,
          isOutdated: false,
          comments: [{ commentId: 'comment-2', body: 'Replace this thread.' }],
        },
      ],
    });

    const mockFetchPrReviewThread = vi.mocked(fetchPrReviewThread);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrReviewThread.mockResolvedValue({
      threadId: 'thread-2',
      path: 'src/two.ts',
      line: 22,
      isResolved: true,
      isOutdated: false,
      comments: [{ commentId: 'comment-2b', body: 'Updated thread body.' }],
    });
    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 230 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/230');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/230');

    const { fetchAndUpdatePrReviewThreads } = await import('./pr_status_service.ts');
    await fetchAndUpdatePrReviewThreads(db, 'https://github.com/example/repo/pull/230', 'thread-2');

    expect(fetchPrReviewThread).toHaveBeenCalledWith('thread-2');
    expect(mockFetchPrReviewThreads).not.toHaveBeenCalled();

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/230', {
      includeReviewThreads: true,
    });
    expect(detail?.reviewThreads?.map((thread) => thread.thread.thread_id)).toEqual([
      'thread-1',
      'thread-2',
    ]);
    expect(
      detail?.reviewThreads?.find((thread) => thread.thread.thread_id === 'thread-1')?.comments
    ).toEqual([expect.objectContaining({ comment_id: 'comment-1' })]);
    expect(
      detail?.reviewThreads?.find((thread) => thread.thread.thread_id === 'thread-2')?.thread.line
    ).toBe(22);
    expect(
      detail?.reviewThreads?.find((thread) => thread.thread.thread_id === 'thread-2')?.thread
        .is_resolved
    ).toBe(1);
    expect(
      detail?.reviewThreads?.find((thread) => thread.thread.thread_id === 'thread-2')?.comments
    ).toEqual([expect.objectContaining({ comment_id: 'comment-2b' })]);
  });

  test('fetchAndUpdatePrReviewThreads preserves checks, reviews, and labels on full thread refresh', async () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/231',
      owner: 'example',
      repo: 'repo',
      prNumber: 231,
      title: 'Preserve status data',
      state: 'open',
      draft: false,
      checkRollupState: 'failure',
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [
        { name: 'ci/test', source: 'check_run', status: 'completed', conclusion: 'failure' },
      ],
      reviews: [{ author: 'bob', state: 'CHANGES_REQUESTED', body: 'Needs changes' }],
      labels: [{ name: 'bug', color: 'ff0000' }],
      reviewThreads: [
        {
          threadId: 'thread-1',
          path: 'src/one.ts',
          line: 10,
          isResolved: false,
          isOutdated: false,
          comments: [{ commentId: 'comment-1', body: 'Old thread' }],
        },
      ],
    });

    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrReviewThreads.mockResolvedValue([
      {
        threadId: 'thread-2',
        path: 'src/two.ts',
        line: 22,
        isResolved: false,
        isOutdated: false,
        comments: [{ commentId: 'comment-2', body: 'New thread' }],
      },
    ]);

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 231 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/231');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/231');

    const { fetchAndUpdatePrReviewThreads } = await import('./pr_status_service.ts');
    await fetchAndUpdatePrReviewThreads(db, 'https://github.com/example/repo/pull/231');

    const updated = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/231', {
      includeReviewThreads: true,
    });
    expect(updated?.checks.map((check) => check.name)).toEqual(['ci/test']);
    expect(updated?.reviews.map((review) => review.author)).toEqual(['bob']);
    expect(updated?.labels.map((label) => label.name)).toEqual(['bug']);
    expect(updated?.reviewThreads?.map((thread) => thread.thread.thread_id)).toEqual(['thread-2']);
  });

  test('refreshPrCheckStatus canonicalizes equivalent PR URLs before cache lookup', async () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/220',
      owner: 'example',
      repo: 'repo',
      prNumber: 220,
      title: 'Canonical PR',
      state: 'open',
      draft: false,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
    });

    const mockFetchPrCheckStatus = vi.mocked(fetchPrCheckStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrCheckStatus.mockResolvedValue({
      checks: [],
      checkRollupState: 'success' as const,
    });

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 220 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/220');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/220');

    const { refreshPrCheckStatus } = await import('./pr_status_service.ts');
    await refreshPrCheckStatus(db, 'https://github.com/example/repo/pulls/220?tab=checks');

    expect(fetchPrCheckStatus).toHaveBeenCalledWith('example', 'repo', 220);
  });

  test('refreshPrCheckStatus validates identifiers before using cached rows', async () => {
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockValidatePrIdentifier = vi.mocked(validatePrIdentifier);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 221 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/221');
    mockTryCanonicalizePrUrl.mockImplementation((identifier: string) => {
      throw new Error(`Not a pull request URL: ${identifier}`);
    });

    const { refreshPrCheckStatus } = await import('./pr_status_service.ts');

    await expect(
      refreshPrCheckStatus(db, 'https://github.com/example/repo/issues/221')
    ).rejects.toThrow('Not a pull request URL');
    expect(canonicalizePrUrl).toHaveBeenCalledWith('https://github.com/example/repo/issues/221');
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

    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockImplementation(async () => {
      throw new Error('should not be called');
    });
    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 203 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/203');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/203');

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

    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockResolvedValue({
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
    });
    mockFetchPrReviewThreads.mockResolvedValue([]);

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 204 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/204');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/204');

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

    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockResolvedValue({
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
    });
    mockFetchPrReviewThreads.mockResolvedValue([]);

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 208 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/208');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/208');

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
    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockImplementation(async () => {
      throw new Error('should not fetch');
    });
    mockParsePrOrIssueNumber.mockResolvedValue(null);
    mockCanonicalizePrUrl.mockReturnValue('not-a-pr');
    mockTryCanonicalizePrUrl.mockReturnValue('not-a-pr');

    const { refreshPrStatus } = await import('./pr_status_service.ts');

    await expect(refreshPrStatus(db, 'not-a-pr')).rejects.toThrow(
      'Invalid GitHub pull request identifier: not-a-pr'
    );
    expect(fetchPrFullStatus).not.toHaveBeenCalled();
  });

  test('refreshPrCheckStatus falls back to full refresh when cache is missing', async () => {
    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrCheckStatus = vi.mocked(fetchPrCheckStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockResolvedValue({
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
    });
    mockFetchPrCheckStatus.mockImplementation(async () => {
      throw new Error('should not fetch lightweight checks');
    });

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 209 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/209');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/209');

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

    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockResolvedValue({
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
    });

    mockParsePrOrIssueNumber.mockImplementation(async (identifier: string) => {
      if (identifier.endsWith('/206')) {
        return { owner: 'example', repo: 'repo', number: 206 };
      }

      if (identifier.endsWith('/207')) {
        return { owner: 'example', repo: 'repo', number: 207 };
      }

      return { owner: 'example', repo: 'repo', number: 205 };
    });
    mockCanonicalizePrUrl.mockImplementation((identifier: string) => identifier);
    mockTryCanonicalizePrUrl.mockImplementation((identifier: string) => identifier);

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
    // Orphaned PR status record remains (cleanup is caller's responsibility, not syncPlanPrLinks')
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/205')).not.toBeNull();
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

    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockImplementation(async () => {
      throw new Error('should not fetch cached PR');
    });

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 210 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/210');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/210');

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

  test('syncPlanPrLinks canonicalizes equivalent URLs before fetching and linking', async () => {
    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockResolvedValue({
      number: 222,
      title: 'Fetched canonical PR',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'sha-222',
      baseRefName: 'main',
      headRefName: 'feature/222',
      reviewDecision: null,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'success' as const,
    });

    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 222 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/222');
    mockTryCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/222');

    const { syncPlanPrLinks } = await import('./pr_status_service.ts');
    const result = await syncPlanPrLinks(db, 'plan-service', [
      'https://github.com/example/repo/pulls/222?tab=checks',
      'https://github.com/example/repo/pull/222',
    ]);

    expect(fetchPrFullStatus).toHaveBeenCalledTimes(1);
    expect(result.map((detail) => detail.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/222',
    ]);
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/222')).not.toBeNull();
  });

  test('syncPlanPrLinks surfaces parse failures for newly linked PRs', async () => {
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockParsePrOrIssueNumber.mockResolvedValue(null);
    mockCanonicalizePrUrl.mockReturnValue('invalid-pr-url');
    mockTryCanonicalizePrUrl.mockReturnValue('invalid-pr-url');

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

    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockParsePrOrIssueNumber.mockImplementation(async (identifier: string) => {
      if (identifier.endsWith('/213')) {
        return { owner: 'example', repo: 'repo', number: 213 };
      }

      if (identifier.endsWith('/211')) {
        return { owner: 'example', repo: 'repo', number: 211 };
      }

      return { owner: 'example', repo: 'repo', number: 212 };
    });
    mockCanonicalizePrUrl.mockImplementation((identifier: string) => identifier);
    mockTryCanonicalizePrUrl.mockImplementation((identifier: string) => identifier);
    mockFetchPrFullStatus.mockImplementation(async () => {
      throw new Error('GitHub fetch failed');
    });

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

  test('syncPlanPrLinks keeps existing links unchanged when one new PR fetch succeeds and another fails', async () => {
    const existingDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/214',
      owner: 'example',
      repo: 'repo',
      prNumber: 214,
      title: 'Existing linked PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });
    const removedIfNonAtomic = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/215',
      owner: 'example',
      repo: 'repo',
      prNumber: 215,
      title: 'Should stay linked',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });

    const linkPlanToPr = db.prepare('INSERT INTO plan_pr (plan_uuid, pr_status_id) VALUES (?, ?)');
    linkPlanToPr.run('plan-service', existingDetail.status.id);
    linkPlanToPr.run('plan-service', removedIfNonAtomic.status.id);

    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);
    const mockTryCanonicalizePrUrl = vi.mocked(tryCanonicalizePrUrl);

    mockFetchPrFullStatus.mockImplementation(
      async (_owner: string, _repo: string, prNumber: number) => {
        if (prNumber === 216) {
          return {
            number: 216,
            title: 'Prefetched PR',
            state: 'open' as const,
            isDraft: false,
            mergeable: 'MERGEABLE' as const,
            mergedAt: null,
            headSha: 'sha-216',
            baseRefName: 'main',
            headRefName: 'feature/216',
            reviewDecision: null,
            labels: [],
            reviews: [],
            checks: [],
            checkRollupState: 'pending' as const,
          };
        }

        throw new Error('GitHub fetch failed after partial prefetch');
      }
    );

    mockParsePrOrIssueNumber.mockImplementation(async (identifier: string) => {
      if (identifier.endsWith('/214')) {
        return { owner: 'example', repo: 'repo', number: 214 };
      }

      if (identifier.endsWith('/216')) {
        return { owner: 'example', repo: 'repo', number: 216 };
      }

      if (identifier.endsWith('/217')) {
        return { owner: 'example', repo: 'repo', number: 217 };
      }

      return { owner: 'example', repo: 'repo', number: 215 };
    });
    mockCanonicalizePrUrl.mockImplementation((identifier: string) => identifier);
    mockTryCanonicalizePrUrl.mockImplementation((identifier: string) => identifier);

    const { syncPlanPrLinks } = await import('./pr_status_service.ts');

    await expect(
      syncPlanPrLinks(db, 'plan-service', [
        'https://github.com/example/repo/pull/214',
        'https://github.com/example/repo/pull/216',
        'https://github.com/example/repo/pull/217',
      ])
    ).rejects.toThrow('GitHub fetch failed after partial prefetch');

    expect(fetchPrFullStatus).toHaveBeenCalledTimes(2);
    // With atomic sync, no DB mutations should occur on failure:
    // - Original links remain unchanged
    expect(getPrStatusForPlan(db, 'plan-service').map((detail) => detail.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/214',
      'https://github.com/example/repo/pull/215',
    ]);
    // - Successfully fetched PR data is NOT written to cache when the overall sync fails
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/216')).toBeNull();
    expect(getPrStatusByUrl(db, 'https://github.com/example/repo/pull/217')).toBeNull();
  });

  test('syncPlanPrLinks only removes explicit links and preserves auto-linked rows', async () => {
    const explicitDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/230',
      owner: 'example',
      repo: 'repo',
      prNumber: 230,
      title: 'Explicit PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });
    const autoDetail = upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/231',
      owner: 'example',
      repo: 'repo',
      prNumber: 231,
      title: 'Auto PR',
      state: 'open',
      draft: false,
      lastFetchedAt: new Date().toISOString(),
    });

    db.prepare(
      "INSERT INTO plan_pr (plan_uuid, pr_status_id, source) VALUES (?, ?, 'explicit')"
    ).run('plan-service', explicitDetail.status.id);
    db.prepare("INSERT INTO plan_pr (plan_uuid, pr_status_id, source) VALUES (?, ?, 'auto')").run(
      'plan-service',
      autoDetail.status.id
    );

    const { syncPlanPrLinks } = await import('./pr_status_service.ts');
    await syncPlanPrLinks(db, 'plan-service', []);

    expect(getPrStatusForPlan(db, 'plan-service').map((detail) => detail.status.pr_url)).toEqual([
      'https://github.com/example/repo/pull/231',
    ]);
  });
  test('fetchAndUpdatePrMergeableStatus updates targeted fields for an existing PR row', async () => {
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/301',
      owner: 'example',
      repo: 'repo',
      prNumber: 301,
      title: 'Webhook-created PR',
      state: 'open',
      draft: false,
      mergeable: null,
      reviewDecision: null,
      lastFetchedAt: '2026-03-20T00:00:00.000Z',
      checks: [{ name: 'existing-check', source: 'check_run', status: 'pending' }],
      reviews: [{ author: 'alice', state: 'COMMENTED', submittedAt: '2026-03-20T00:10:00.000Z' }],
    });

    const mockFetchPrMergeableAndReviewDecision = vi.mocked(fetchPrMergeableAndReviewDecision);
    mockFetchPrMergeableAndReviewDecision.mockResolvedValue({
      mergeable: 'MERGEABLE' as const,
      reviewDecision: 'APPROVED' as const,
    });

    const { fetchAndUpdatePrMergeableStatus } = await import('./pr_status_service.ts');
    await fetchAndUpdatePrMergeableStatus(db, 'example', 'repo', 301);

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/301');
    expect(mockFetchPrMergeableAndReviewDecision).toHaveBeenCalledWith('example', 'repo', 301);
    expect(detail?.status.mergeable).toBe('MERGEABLE');
    expect(detail?.status.review_decision).toBe('APPROVED');
    expect(detail?.checks.map((check) => check.name)).toEqual(['existing-check']);
    expect(detail?.reviews.map((review) => review.author)).toEqual(['alice']);
  });

  test('fetchAndUpdatePrReviewThreads falls back to a full refresh when the PR is uncached', async () => {
    const mockFetchPrFullStatus = vi.mocked(fetchPrFullStatus);
    const mockFetchPrReviewThreads = vi.mocked(fetchPrReviewThreads);
    const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
    const mockCanonicalizePrUrl = vi.mocked(canonicalizePrUrl);

    mockFetchPrFullStatus.mockResolvedValue({
      number: 302,
      title: 'Uncached review thread PR',
      state: 'open' as const,
      isDraft: false,
      mergeable: 'MERGEABLE' as const,
      mergedAt: null,
      headSha: 'uncached-sha',
      baseRefName: 'main',
      headRefName: 'feature/uncached',
      reviewDecision: null,
      labels: [],
      reviews: [],
      checks: [],
      checkRollupState: 'success' as const,
    });
    mockFetchPrReviewThreads.mockResolvedValue([
      {
        threadId: 'thread-uncached',
        path: 'src/uncached.ts',
        line: 4,
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    ]);
    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'example', repo: 'repo', number: 302 });
    mockCanonicalizePrUrl.mockReturnValue('https://github.com/example/repo/pull/302');

    const { fetchAndUpdatePrReviewThreads } = await import('./pr_status_service.ts');
    await fetchAndUpdatePrReviewThreads(db, 'https://github.com/example/repo/pull/302');

    const detail = getPrStatusByUrl(db, 'https://github.com/example/repo/pull/302', {
      includeReviewThreads: true,
    });
    expect(fetchPrFullStatus).toHaveBeenCalledWith('example', 'repo', 302);
    expect(fetchPrReviewThreads).toHaveBeenCalledWith('example', 'repo', 302);
    expect(detail?.reviewThreads).toHaveLength(1);
    expect(detail?.reviewThreads?.[0]?.thread.thread_id).toBe('thread-uncached');
  });
});
