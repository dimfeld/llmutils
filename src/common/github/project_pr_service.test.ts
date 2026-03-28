import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { DATABASE_FILENAME, openDatabase } from '../../tim/db/database.js';
import { upsertPlan } from '../../tim/db/plan.js';
import { getOrCreateProject } from '../../tim/db/project.js';
import {
  getLinkedPlansByPrUrl,
  getPrStatusesForRepo,
  upsertPrStatus,
} from '../../tim/db/pr_status.js';
import {
  partitionUserRelevantOpenPrs,
  type OpenPullRequestWithRequestedReviewers,
} from './pull_requests.js';

const moduleMocker = new ModuleMocker(import.meta);

function makePr(opts: {
  number: number;
  title: string;
  headRefName: string;
  userLogin: string;
  requestedReviewers?: string[];
}): OpenPullRequestWithRequestedReviewers {
  return {
    number: opts.number,
    title: opts.title,
    headRefName: opts.headRefName,
    html_url: `https://github.com/example/repo/pull/${opts.number}`,
    user: { login: opts.userLogin },
    requestedReviewers: (opts.requestedReviewers ?? []).map((login) => ({ login })),
  };
}

function makeFullStatus(prNumber: number, overrides: Record<string, unknown> = {}) {
  return {
    number: prNumber,
    author: `author-${prNumber}`,
    title: `PR #${prNumber}`,
    state: 'open' as const,
    isDraft: false,
    mergeable: 'MERGEABLE' as const,
    mergedAt: null,
    headSha: `sha-${prNumber}`,
    baseRefName: 'main',
    headRefName: `feature/${prNumber}`,
    reviewDecision: null,
    labels: [],
    reviews: [],
    checks: [],
    checkRollupState: 'pending' as const,
    ...overrides,
  };
}

describe('common/github/project_pr_service', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-project-pr-service-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, 'github.com__example__repo').id;

    upsertPlan(db, projectId, {
      uuid: 'plan-1',
      planId: 1,
      title: 'Plan 1',
      branch: 'feature/one',
      filename: '1.plan.md',
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-2',
      planId: 2,
      title: 'Plan 2',
      branch: 'feature/two',
      filename: '2.plan.md',
    });
    upsertPlan(db, projectId, {
      uuid: 'plan-3',
      planId: 3,
      title: 'Plan 3',
      filename: '3.plan.md',
    });
  });

  afterEach(async () => {
    moduleMocker.clear();
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('getProjectPlanBranchMatches groups plans by exact branch name', async () => {
    const { getProjectPlanBranchMatches } = await import('./project_pr_service.ts');

    expect(getProjectPlanBranchMatches(db, projectId)).toEqual(
      new Map([
        ['feature/one', [{ planUuid: 'plan-1', planId: 1 }]],
        ['feature/two', [{ planUuid: 'plan-2', planId: 2 }]],
      ])
    );
  });

  test('refreshProjectPrs fetches, caches, groups, and auto-links project PRs', async () => {
    const fetchOpenPullRequestsWithReviewers = mock(async () => [
      makePr({ number: 11, title: 'My PR', headRefName: 'feature/one', userLogin: 'dimfeld' }),
      makePr({
        number: 12,
        title: 'Needs review',
        headRefName: 'feature/two',
        userLogin: 'alice',
        requestedReviewers: ['dimfeld'],
      }),
      makePr({
        number: 13,
        title: 'Already reviewed',
        headRefName: 'feature/three',
        userLogin: 'bob',
      }),
    ]);

    const fetchPrFullStatus = mock(async (_owner: string, _repo: string, prNumber: number) =>
      makeFullStatus(prNumber, {
        title: prNumber === 11 ? 'My PR' : prNumber === 12 ? 'Needs review' : 'Already reviewed',
        headRefName:
          prNumber === 11 ? 'feature/one' : prNumber === 12 ? 'feature/two' : 'feature/three',
        reviewDecision: prNumber === 12 ? 'REVIEW_REQUIRED' : null,
        reviews:
          prNumber === 11
            ? [{ author: 'dimfeld', state: 'COMMENTED', submittedAt: null }]
            : prNumber === 12
              ? [{ author: 'alice', state: 'COMMENTED', submittedAt: null }]
              : [{ author: 'dimfeld', state: 'APPROVED', submittedAt: null }],
      })
    );

    await moduleMocker.mock('./pull_requests.ts', () => ({
      fetchOpenPullRequestsWithReviewers,
      parseOwnerRepoFromRepositoryId: (id: string) => {
        const parts = id.split('__');
        if (parts[0] !== 'github.com') return null;
        return { owner: parts[1]!, repo: parts[2]! };
      },
      partitionUserRelevantOpenPrs,
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
    }));

    const { refreshProjectPrs } = await import('./project_pr_service.ts');
    const result = await refreshProjectPrs(db, projectId, 'dimfeld');

    expect(fetchOpenPullRequestsWithReviewers).toHaveBeenCalledTimes(1);
    expect(fetchPrFullStatus).toHaveBeenCalledTimes(3);
    expect(result.authored.map((detail) => detail.status.pr_number)).toEqual([11]);
    expect(result.authored[0]?.status.author).toBe('author-11');
    expect(result.reviewing[0]?.status.requested_reviewers).toBe('["dimfeld"]');
    // PR 12 is in reviewing (requested reviewer), PR 13 has dimfeld APPROVED review
    expect(result.reviewing.map((detail) => detail.status.pr_number)).toEqual([12, 13]);
    // Only authored PRs are auto-linked, not review-only PRs
    expect(result.newLinks).toEqual([
      { prUrl: 'https://github.com/example/repo/pull/11', planId: 1 },
    ]);

    expect(
      getPrStatusesForRepo(db, 'example', 'repo').map((detail) => detail.status.pr_number)
    ).toEqual([11, 12, 13]);
    expect(
      getLinkedPlansByPrUrl(db, ['https://github.com/example/repo/pull/11']).get(
        'https://github.com/example/repo/pull/11'
      )
    ).toEqual([{ planUuid: 'plan-1', planId: 1, title: 'Plan 1' }]);
  });

  test('refreshProjectPrs excludes self-authored PRs from reviewing group', async () => {
    const fetchOpenPullRequestsWithReviewers = mock(async () => [
      makePr({ number: 11, title: 'My PR', headRefName: 'feature/one', userLogin: 'dimfeld' }),
    ]);

    const fetchPrFullStatus = mock(async () =>
      makeFullStatus(11, {
        title: 'My PR',
        headRefName: 'feature/one',
        reviews: [{ author: 'dimfeld', state: 'COMMENTED', submittedAt: '2026-01-01T00:00:00Z' }],
      })
    );

    await moduleMocker.mock('./pull_requests.ts', () => ({
      fetchOpenPullRequestsWithReviewers,
      parseOwnerRepoFromRepositoryId: () => ({ owner: 'example', repo: 'repo' }),
      partitionUserRelevantOpenPrs,
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
    }));

    const { refreshProjectPrs } = await import('./project_pr_service.ts');
    const result = await refreshProjectPrs(db, projectId, 'dimfeld');

    expect(result.authored.map((d) => d.status.pr_number)).toEqual([11]);
    expect(result.reviewing).toEqual([]);
  });

  test('refreshProjectPrs includes reviewed-but-not-requested PRs in reviewing', async () => {
    const fetchOpenPullRequestsWithReviewers = mock(async () => [
      makePr({ number: 14, title: 'Past review', headRefName: 'feature/past', userLogin: 'bob' }),
    ]);

    const fetchPrFullStatus = mock(async () =>
      makeFullStatus(14, {
        title: 'Past review',
        headRefName: 'feature/past',
        reviews: [{ author: 'dimfeld', state: 'APPROVED', submittedAt: '2026-01-01T00:00:00Z' }],
      })
    );

    await moduleMocker.mock('./pull_requests.ts', () => ({
      fetchOpenPullRequestsWithReviewers,
      parseOwnerRepoFromRepositoryId: () => ({ owner: 'example', repo: 'repo' }),
      partitionUserRelevantOpenPrs,
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
    }));

    const { refreshProjectPrs } = await import('./project_pr_service.ts');
    const result = await refreshProjectPrs(db, projectId, 'dimfeld');

    expect(result.authored).toEqual([]);
    expect(result.reviewing.map((d) => d.status.pr_number)).toEqual([14]);
  });

  test('refreshProjectPrs excludes PRs with only PENDING reviews from reviewing', async () => {
    const fetchOpenPullRequestsWithReviewers = mock(async () => [
      makePr({
        number: 15,
        title: 'Draft review',
        headRefName: 'feature/draft',
        userLogin: 'carol',
      }),
    ]);

    const fetchPrFullStatus = mock(async () =>
      makeFullStatus(15, {
        title: 'Draft review',
        headRefName: 'feature/draft',
        reviews: [{ author: 'dimfeld', state: 'PENDING', submittedAt: null }],
      })
    );

    await moduleMocker.mock('./pull_requests.ts', () => ({
      fetchOpenPullRequestsWithReviewers,
      parseOwnerRepoFromRepositoryId: () => ({ owner: 'example', repo: 'repo' }),
      partitionUserRelevantOpenPrs,
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
    }));

    const { refreshProjectPrs } = await import('./project_pr_service.ts');
    const result = await refreshProjectPrs(db, projectId, 'dimfeld');

    expect(result.authored).toEqual([]);
    expect(result.reviewing).toEqual([]);
  });

  test('refreshProjectPrs does not duplicate existing auto-links on subsequent refreshes', async () => {
    const fetchOpenPullRequestsWithReviewers = mock(async () => [
      makePr({ number: 11, title: 'My PR', headRefName: 'feature/one', userLogin: 'dimfeld' }),
    ]);

    const fetchPrFullStatus = mock(async () =>
      makeFullStatus(11, {
        title: 'My PR',
        headRefName: 'feature/one',
      })
    );

    await moduleMocker.mock('./pull_requests.ts', () => ({
      fetchOpenPullRequestsWithReviewers,
      parseOwnerRepoFromRepositoryId: () => ({ owner: 'example', repo: 'repo' }),
      partitionUserRelevantOpenPrs,
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
    }));

    const { refreshProjectPrs } = await import('./project_pr_service.ts');

    const firstResult = await refreshProjectPrs(db, projectId, 'dimfeld');
    const secondResult = await refreshProjectPrs(db, projectId, 'dimfeld');

    expect(firstResult.newLinks).toEqual([
      { prUrl: 'https://github.com/example/repo/pull/11', planId: 1 },
    ]);
    expect(secondResult.newLinks).toEqual([]);
  });

  test('refreshProjectPrs closes cached open PRs that are no longer returned by GitHub', async () => {
    const fetchOpenPullRequestsWithReviewers = mock(async () => [
      makePr({ number: 11, title: 'Current PR', headRefName: 'feature/one', userLogin: 'dimfeld' }),
    ]);

    const fetchPrFullStatus = mock(async () =>
      makeFullStatus(11, {
        title: 'Current PR',
        headRefName: 'feature/one',
      })
    );

    await moduleMocker.mock('./pull_requests.ts', () => ({
      fetchOpenPullRequestsWithReviewers,
      parseOwnerRepoFromRepositoryId: () => ({ owner: 'example', repo: 'repo' }),
      partitionUserRelevantOpenPrs,
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
    }));

    const existingLastFetchedAt = '2026-01-01T00:00:00.000Z';
    upsertPrStatus(db, {
      prUrl: 'https://github.com/example/repo/pull/10',
      owner: 'example',
      repo: 'repo',
      prNumber: 10,
      author: 'alice',
      title: 'Stale PR',
      state: 'open',
      draft: false,
      headSha: 'sha-10',
      baseBranch: 'main',
      headBranch: 'feature/stale',
      lastFetchedAt: existingLastFetchedAt,
    });

    const { refreshProjectPrs } = await import('./project_pr_service.ts');
    await refreshProjectPrs(db, projectId, 'dimfeld');

    expect(
      getPrStatusesForRepo(db, 'example', 'repo').map((detail) => detail.status.pr_number)
    ).toEqual([11]);
  });

  test('refreshProjectPrs does not write partial results when one full-status fetch fails', async () => {
    const fetchOpenPullRequestsWithReviewers = mock(async () => [
      makePr({ number: 11, title: 'My PR', headRefName: 'feature/one', userLogin: 'dimfeld' }),
      makePr({ number: 12, title: 'Broken PR', headRefName: 'feature/two', userLogin: 'alice' }),
    ]);

    const fetchPrFullStatus = mock(async (_owner: string, _repo: string, prNumber: number) => {
      if (prNumber === 12) {
        throw new Error('status fetch failed');
      }
      return makeFullStatus(prNumber, {
        title: 'My PR',
        headRefName: 'feature/one',
      });
    });

    await moduleMocker.mock('./pull_requests.ts', () => ({
      fetchOpenPullRequestsWithReviewers,
      parseOwnerRepoFromRepositoryId: () => ({ owner: 'example', repo: 'repo' }),
      partitionUserRelevantOpenPrs,
    }));
    await moduleMocker.mock('./pr_status.ts', () => ({
      fetchPrFullStatus,
    }));

    const { refreshProjectPrs } = await import('./project_pr_service.ts');

    await expect(refreshProjectPrs(db, projectId, 'dimfeld')).rejects.toThrow(
      'status fetch failed'
    );
    expect(getPrStatusesForRepo(db, 'example', 'repo')).toEqual([]);
    expect(
      getLinkedPlansByPrUrl(db, ['https://github.com/example/repo/pull/11']).get(
        'https://github.com/example/repo/pull/11'
      )
    ).toEqual([]);
  });

  test('refreshProjectPrs throws when project does not exist', async () => {
    const { refreshProjectPrs } = await import('./project_pr_service.ts');

    await expect(refreshProjectPrs(db, 999_999, 'dimfeld')).rejects.toThrow(
      'Project 999999 not found'
    );
  });
});
