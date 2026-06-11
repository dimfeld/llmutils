import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';

import { resolveAutoreviewLinkedPr } from './autoreview.js';
import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { nonSyncedUpsertPlan } from '../db/plan.js';
import { linkPlanToPr, upsertPrStatus } from '../db/pr_status.js';
import type {
  BranchReviewTarget,
  CurrentWorktreeReviewTarget,
  PlanReviewTarget,
  PullRequestReviewTarget,
} from './review_target.js';
import type { PlanSchema } from '../planSchema.js';

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
}));

import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';

// Mocked because spinning a real git repo plus remote for repository identity is too
// heavyweight for this unit test; the DB layer still uses real SQLite fixtures.
const OWNER = 'testowner';
const REPO = 'testrepo';
const REPOSITORY_ID = `github.com__${OWNER}__${REPO}`;

function makePrInput(
  prNumber: number,
  state: 'open' | 'closed' | 'merged' = 'open',
  headBranch = 'feature-branch'
) {
  return {
    prUrl: `https://github.com/${OWNER}/${REPO}/pull/${prNumber}`,
    owner: OWNER,
    repo: REPO,
    prNumber,
    title: `PR #${prNumber}`,
    state,
    draft: false,
    lastFetchedAt: '2026-01-01T00:00:00.000Z',
    headBranch,
    baseBranch: 'main',
    headSha: `sha-${prNumber}`,
  };
}

describe('resolveAutoreviewLinkedPr', () => {
  let tempDir: string;
  let db: Database;
  let projectId: number;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoreview-linked-pr-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    projectId = getOrCreateProject(db, REPOSITORY_ID).id;
    vi.resetAllMocks();
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('kind: pr target', () => {
    test('returns normalized shape from PullRequestReviewTarget fields', async () => {
      const prStatus = upsertPrStatus(db, makePrInput(42)).status;
      const target: PullRequestReviewTarget = {
        kind: 'pr',
        repoRoot: '/some/path',
        canonicalPrUrl: `https://github.com/${OWNER}/${REPO}/pull/42`,
        prNumber: 42,
        title: 'My PR',
        owner: OWNER,
        repo: REPO,
        baseBranch: 'main',
        headBranch: 'feature-branch',
        headSha: 'abc123',
        prStatusId: prStatus.id,
        prStatus,
      };

      const result = await resolveAutoreviewLinkedPr(target, undefined, () => {
        throw new Error('db should not be opened for pr targets');
      });

      expect(result).toEqual({
        prNumber: 42,
        owner: OWNER,
        repo: REPO,
        url: `https://github.com/${OWNER}/${REPO}/pull/42`,
        title: 'My PR',
        headSha: 'abc123',
      });
    });

    test('includes headSha from target', async () => {
      const prStatus = upsertPrStatus(db, makePrInput(10)).status;
      const target: PullRequestReviewTarget = {
        kind: 'pr',
        repoRoot: '/some/path',
        canonicalPrUrl: `https://github.com/${OWNER}/${REPO}/pull/10`,
        prNumber: 10,
        owner: OWNER,
        repo: REPO,
        baseBranch: 'main',
        headBranch: 'feature-10',
        headSha: 'deadbeef',
        prStatus,
      };

      const result = await resolveAutoreviewLinkedPr(target, undefined, () => db);

      expect(result?.prNumber).toBe(10);
      expect(result?.headSha).toBe('deadbeef');
    });
  });

  describe('kind: plan target', () => {
    function makePlanTarget(planId = 1): PlanReviewTarget {
      return {
        kind: 'plan',
        planId,
        planPath: `/some/path/${planId}.plan.md`,
        repoRoot: '/some/path',
      };
    }

    test('returns undefined when planData is undefined', async () => {
      const result = await resolveAutoreviewLinkedPr(makePlanTarget(), undefined, () => db);
      expect(result).toBeUndefined();
    });

    test('returns undefined when planData has no uuid', async () => {
      const planData = { title: 'Test Plan' } as PlanSchema;
      const result = await resolveAutoreviewLinkedPr(makePlanTarget(), planData, () => db);
      expect(result).toBeUndefined();
    });

    test('returns undefined when plan has no linked PR', async () => {
      nonSyncedUpsertPlan(db, projectId, {
        uuid: 'plan-no-pr',
        planId: 1,
        title: 'Plan with no PR',
        filename: '1.plan.md',
      });

      const planData: Partial<PlanSchema> = { uuid: 'plan-no-pr', title: 'Plan with no PR' };
      const result = await resolveAutoreviewLinkedPr(
        makePlanTarget(),
        planData as PlanSchema,
        () => db
      );
      expect(result).toBeUndefined();
    });

    test('returns normalized shape for a single linked PR', async () => {
      nonSyncedUpsertPlan(db, projectId, {
        uuid: 'plan-single-pr',
        planId: 2,
        title: 'Plan with one PR',
        filename: '2.plan.md',
      });
      const pr = upsertPrStatus(db, makePrInput(55, 'open'));
      linkPlanToPr(db, 'plan-single-pr', pr.status.id, 'explicit');

      const planData: Partial<PlanSchema> = {
        uuid: 'plan-single-pr',
        title: 'Plan with one PR',
        pullRequest: [`https://github.com/${OWNER}/${REPO}/pull/55`],
      };

      const result = await resolveAutoreviewLinkedPr(
        makePlanTarget(2),
        planData as PlanSchema,
        () => db
      );

      expect(result).toEqual({
        prNumber: 55,
        owner: OWNER,
        repo: REPO,
        url: `https://github.com/${OWNER}/${REPO}/pull/55`,
        title: 'PR #55',
        headSha: 'sha-55',
      });
    });

    test('prefers open PR over closed/merged PR', async () => {
      nonSyncedUpsertPlan(db, projectId, {
        uuid: 'plan-multi-state',
        planId: 3,
        title: 'Plan with open and closed PRs',
        filename: '3.plan.md',
      });

      const closedPr = upsertPrStatus(db, makePrInput(10, 'closed'));
      const openPr = upsertPrStatus(db, makePrInput(20, 'open'));

      linkPlanToPr(db, 'plan-multi-state', closedPr.status.id, 'explicit');
      linkPlanToPr(db, 'plan-multi-state', openPr.status.id, 'explicit');

      const planData: Partial<PlanSchema> = {
        uuid: 'plan-multi-state',
        title: 'Plan with open and closed PRs',
        pullRequest: [
          `https://github.com/${OWNER}/${REPO}/pull/10`,
          `https://github.com/${OWNER}/${REPO}/pull/20`,
        ],
      };

      const result = await resolveAutoreviewLinkedPr(
        makePlanTarget(3),
        planData as PlanSchema,
        () => db
      );

      expect(result?.prNumber).toBe(20);
    });

    test('returns closed PR when plan links only a closed PR (plan path is prefer-open, not open-only)', async () => {
      // Distinguishes the plan path (prefer-open, returns any PR) from the current/branch path
      // (open-only, returns undefined when no open PR exists). A plan may link a merged/closed PR
      // and still deserves an audit trail on that PR.
      nonSyncedUpsertPlan(db, projectId, {
        uuid: 'plan-closed-only',
        planId: 9,
        title: 'Plan with closed PR only',
        filename: '9.plan.md',
      });
      const closedPr = upsertPrStatus(db, makePrInput(500, 'closed'));
      linkPlanToPr(db, 'plan-closed-only', closedPr.status.id, 'explicit');

      const planData: Partial<PlanSchema> = {
        uuid: 'plan-closed-only',
        title: 'Plan with closed PR only',
        pullRequest: [`https://github.com/${OWNER}/${REPO}/pull/500`],
      };

      const result = await resolveAutoreviewLinkedPr(
        makePlanTarget(9),
        planData as PlanSchema,
        () => db
      );

      // The plan path must return the closed PR, unlike current/branch which would return undefined.
      expect(result?.prNumber).toBe(500);
    });

    test('among multiple open PRs, picks the one with the lowest pr_number', async () => {
      nonSyncedUpsertPlan(db, projectId, {
        uuid: 'plan-two-open',
        planId: 4,
        title: 'Plan with two open PRs',
        filename: '4.plan.md',
      });

      const highPr = upsertPrStatus(db, makePrInput(30, 'open', 'feature-30'));
      const lowPr = upsertPrStatus(db, makePrInput(15, 'open', 'feature-15'));

      linkPlanToPr(db, 'plan-two-open', highPr.status.id, 'explicit');
      linkPlanToPr(db, 'plan-two-open', lowPr.status.id, 'explicit');

      const planData: Partial<PlanSchema> = {
        uuid: 'plan-two-open',
        title: 'Plan with two open PRs',
        pullRequest: [
          `https://github.com/${OWNER}/${REPO}/pull/30`,
          `https://github.com/${OWNER}/${REPO}/pull/15`,
        ],
      };

      const result = await resolveAutoreviewLinkedPr(
        makePlanTarget(4),
        planData as PlanSchema,
        () => db
      );

      expect(result?.prNumber).toBe(15);
    });
  });

  describe('kind: current target', () => {
    function makeCurrentTarget(currentBranch = 'feature-branch'): CurrentWorktreeReviewTarget {
      return {
        kind: 'current',
        repoRoot: '/some/repo',
        currentBranch,
        baseBranch: 'main',
        worktreePath: '/some/repo',
      };
    }

    test('returns resolved PR when head branch matches an open pr_status row', async () => {
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: REPOSITORY_ID,
        remoteUrl: `https://github.com/${OWNER}/${REPO}`,
        gitRoot: '/some/repo',
      });

      upsertPrStatus(db, makePrInput(77, 'open', 'feature-branch'));

      const result = await resolveAutoreviewLinkedPr(
        makeCurrentTarget('feature-branch'),
        undefined,
        () => db
      );

      expect(result?.prNumber).toBe(77);
      expect(result?.owner).toBe(OWNER);
      expect(result?.repo).toBe(REPO);
    });

    test('returns undefined when no PR matches the head branch', async () => {
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: REPOSITORY_ID,
        remoteUrl: `https://github.com/${OWNER}/${REPO}`,
        gitRoot: '/some/repo',
      });

      // Insert a PR for a different branch
      upsertPrStatus(db, makePrInput(80, 'open', 'other-branch'));

      const result = await resolveAutoreviewLinkedPr(
        makeCurrentTarget('feature-branch'),
        undefined,
        () => db
      );

      expect(result).toBeUndefined();
    });

    test('returns undefined when currentBranch is undefined', async () => {
      const target: CurrentWorktreeReviewTarget = {
        kind: 'current',
        repoRoot: '/some/repo',
        currentBranch: undefined,
        baseBranch: 'main',
        worktreePath: '/some/repo',
      };

      const result = await resolveAutoreviewLinkedPr(target, undefined, () => db);

      expect(result).toBeUndefined();
    });

    test('returns undefined when no pr_status row matches the owner/repo/branch (no project row needed)', async () => {
      // Resolution now uses parseOwnerRepoFromRepositoryId directly and does NOT require a
      // project row to exist.  This test verifies it returns undefined when there is simply no
      // matching pr_status row — not because a project row is absent.
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: 'github.com__unknown__repo',
        remoteUrl: null,
        gitRoot: '/some/repo',
      });
      // No pr_status row inserted for unknown/repo, so no PR can be found.
      const result = await resolveAutoreviewLinkedPr(
        makeCurrentTarget('feature-branch'),
        undefined,
        () => db
      );

      expect(result).toBeUndefined();
    });

    test('resolves PR even when no project row exists for the repository', async () => {
      // The resolver must NOT require a project row — it parses owner/repo directly from the
      // repositoryId string returned by getRepositoryIdentity.
      const OWNER_NO_PROJECT = 'noprojectowner';
      const REPO_NO_PROJECT = 'noprojectrepo';
      const repositoryId = `github.com__${OWNER_NO_PROJECT}__${REPO_NO_PROJECT}`;

      // Deliberately do NOT call getOrCreateProject for this repositoryId.
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId,
        remoteUrl: `https://github.com/${OWNER_NO_PROJECT}/${REPO_NO_PROJECT}`,
        gitRoot: '/some/repo',
      });

      // Insert a pr_status row for this owner/repo/branch directly (no project row required).
      upsertPrStatus(db, {
        prUrl: `https://github.com/${OWNER_NO_PROJECT}/${REPO_NO_PROJECT}/pull/200`,
        owner: OWNER_NO_PROJECT,
        repo: REPO_NO_PROJECT,
        prNumber: 200,
        title: 'PR no project',
        state: 'open',
        draft: false,
        lastFetchedAt: '2026-01-01T00:00:00.000Z',
        headBranch: 'feature-no-project',
        baseBranch: 'main',
        headSha: 'sha-200',
      });

      const result = await resolveAutoreviewLinkedPr(
        makeCurrentTarget('feature-no-project'),
        undefined,
        () => db
      );

      expect(result?.prNumber).toBe(200);
      expect(result?.owner).toBe(OWNER_NO_PROJECT);
      expect(result?.repo).toBe(REPO_NO_PROJECT);
    });

    test('returns undefined when repositoryId cannot be parsed to owner/repo', async () => {
      // Use a non-GitHub-hosted repositoryId that parseOwnerRepoFromRepositoryId will reject
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: 'notgithub__owner__repo',
        remoteUrl: null,
        gitRoot: '/some/repo',
      });

      // Create a project with this non-parseable repositoryId
      getOrCreateProject(db, 'notgithub__owner__repo');

      const result = await resolveAutoreviewLinkedPr(
        makeCurrentTarget('feature-branch'),
        undefined,
        () => db
      );

      expect(result).toBeUndefined();
    });
  });

  describe('kind: branch target', () => {
    function makeBranchTarget(requestedBranch = 'feature-branch'): BranchReviewTarget {
      return {
        kind: 'branch',
        repoRoot: '/some/repo',
        requestedBranch,
        baseBranch: 'main',
      };
    }

    test('returns resolved PR when head branch matches an open pr_status row', async () => {
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: REPOSITORY_ID,
        remoteUrl: `https://github.com/${OWNER}/${REPO}`,
        gitRoot: '/some/repo',
      });

      upsertPrStatus(db, makePrInput(99, 'open', 'feature-branch'));

      const result = await resolveAutoreviewLinkedPr(
        makeBranchTarget('feature-branch'),
        undefined,
        () => db
      );

      expect(result?.prNumber).toBe(99);
    });

    test('returns undefined when branch has no matching PR', async () => {
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: REPOSITORY_ID,
        remoteUrl: `https://github.com/${OWNER}/${REPO}`,
        gitRoot: '/some/repo',
      });

      const result = await resolveAutoreviewLinkedPr(
        makeBranchTarget('no-pr-branch'),
        undefined,
        () => db
      );

      expect(result).toBeUndefined();
    });

    test('prefers open PR over closed when multiple PRs share a branch', async () => {
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: REPOSITORY_ID,
        remoteUrl: `https://github.com/${OWNER}/${REPO}`,
        gitRoot: '/some/repo',
      });

      upsertPrStatus(db, makePrInput(5, 'closed', 'shared-branch'));
      upsertPrStatus(db, makePrInput(6, 'open', 'shared-branch'));

      const result = await resolveAutoreviewLinkedPr(
        makeBranchTarget('shared-branch'),
        undefined,
        () => db
      );

      expect(result?.prNumber).toBe(6);
    });

    test('returns undefined when only a closed/merged PR matches the branch', async () => {
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: REPOSITORY_ID,
        remoteUrl: `https://github.com/${OWNER}/${REPO}`,
        gitRoot: '/some/repo',
      });

      // Only closed/merged PRs for the branch: a current/branch target has no active work
      // to mirror, so the resolver should report no linked PR.
      upsertPrStatus(db, makePrInput(11, 'closed', 'stale-branch'));
      upsertPrStatus(db, makePrInput(12, 'merged', 'stale-branch'));

      const result = await resolveAutoreviewLinkedPr(
        makeBranchTarget('stale-branch'),
        undefined,
        () => db
      );

      expect(result).toBeUndefined();
    });

    test('matches owner/repo case-insensitively', async () => {
      // The local remote identity may carry different casing than the cached pr_status row.
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: `github.com__${OWNER.toUpperCase()}__${REPO.toUpperCase()}`,
        remoteUrl: `https://github.com/${OWNER}/${REPO}`,
        gitRoot: '/some/repo',
      });

      upsertPrStatus(db, makePrInput(88, 'open', 'cased-branch'));

      const result = await resolveAutoreviewLinkedPr(
        makeBranchTarget('cased-branch'),
        undefined,
        () => db
      );

      expect(result?.prNumber).toBe(88);
    });
  });

  describe('graceful degradation', () => {
    test('returns undefined and does not throw when getRepositoryIdentity throws', async () => {
      vi.mocked(getRepositoryIdentity).mockRejectedValue(new Error('git error'));

      const target: BranchReviewTarget = {
        kind: 'branch',
        repoRoot: '/some/repo',
        requestedBranch: 'feature-branch',
        baseBranch: 'main',
      };

      await expect(resolveAutoreviewLinkedPr(target, undefined, () => db)).resolves.toBeUndefined();
    });

    test('returns undefined and does not throw when db acquisition throws', async () => {
      const target: BranchReviewTarget = {
        kind: 'branch',
        repoRoot: '/some/repo',
        requestedBranch: 'feature-branch',
        baseBranch: 'main',
      };

      await expect(
        resolveAutoreviewLinkedPr(target, undefined, () => {
          throw new Error('database open failed');
        })
      ).resolves.toBeUndefined();
    });

    test('returns undefined and does not throw when db.prepare throws', async () => {
      const brokenDb = {
        prepare: () => {
          throw new Error('DB error');
        },
      } as unknown as Database;

      const target: BranchReviewTarget = {
        kind: 'branch',
        repoRoot: '/some/repo',
        requestedBranch: 'feature-branch',
        baseBranch: 'main',
      };

      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: REPOSITORY_ID,
        remoteUrl: null,
        gitRoot: '/some/repo',
      });

      await expect(
        resolveAutoreviewLinkedPr(target, undefined, () => brokenDb)
      ).resolves.toBeUndefined();
    });

    test('returns undefined (not throws) when getPrStatusForPlan throws for plan target', async () => {
      // Use a plan uuid that doesn't exist in the DB — getPrStatusForPlan should still work
      // but we can break the DB to trigger the catch path
      const brokenDb = {
        prepare: () => {
          throw new Error('DB error');
        },
      } as unknown as Database;

      const planData: Partial<PlanSchema> = {
        uuid: 'some-plan-uuid',
        title: 'Test Plan',
        pullRequest: [`https://github.com/${OWNER}/${REPO}/pull/1`],
      };

      const target: PlanReviewTarget = {
        kind: 'plan',
        planId: 1,
        planPath: '/some/path',
        repoRoot: '/some/repo',
      };

      await expect(
        resolveAutoreviewLinkedPr(target, planData as PlanSchema, () => brokenDb)
      ).resolves.toBeUndefined();
    });
  });
});
