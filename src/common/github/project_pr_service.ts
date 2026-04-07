import type { Database } from 'bun:sqlite';
import {
  fetchOpenPullRequestsWithReviewers,
  parseOwnerRepoFromRepositoryId,
  partitionUserRelevantOpenPrs,
} from './pull_requests.js';
import { fetchPrFullStatus, type PrFullStatus } from './pr_status.js';
import { normalizeGitHubUsername } from './user.js';
import { getPlansByProject } from '../../tim/db/plan.js';
import { getProjectById } from '../../tim/db/project.js';
import { SQL_NOW_ISO_UTC } from '../../tim/db/sql_utils.js';
import { linkPlanToPr, upsertPrStatus, type PrStatusDetail } from '../../tim/db/pr_status.js';

const PR_FETCH_CONCURRENCY = 5;

export interface ProjectPrLink {
  prUrl: string;
  planId: number;
}

export interface RefreshProjectPrsResult {
  authored: PrStatusDetail[];
  reviewing: PrStatusDetail[];
  newLinks: ProjectPrLink[];
}

interface BranchPlanMatch {
  planUuid: string;
  planId: number;
}

function getNowIsoString(): string {
  return new Date().toISOString();
}

function buildPrUrl(owner: string, repo: string, prNumber: number): string {
  return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}

function buildUpsertPrStatusInput(
  owner: string,
  repo: string,
  fullStatus: PrFullStatus,
  requestedReviewers: string[],
  lastFetchedAt: string
) {
  return {
    prUrl: buildPrUrl(owner, repo, fullStatus.number),
    owner,
    repo,
    prNumber: fullStatus.number,
    author: fullStatus.author,
    title: fullStatus.title,
    state: fullStatus.state,
    draft: fullStatus.isDraft,
    mergeable: fullStatus.mergeable,
    headSha: fullStatus.headSha,
    baseBranch: fullStatus.baseRefName,
    headBranch: fullStatus.headRefName,
    requestedReviewers,
    reviewDecision: fullStatus.reviewDecision,
    checkRollupState: fullStatus.checkRollupState,
    mergedAt: fullStatus.mergedAt,
    latestCommitPushedAt: fullStatus.latestCommitPushedAt,
    lastFetchedAt,
    checks: fullStatus.checks.map((check) => ({
      name: check.name,
      source: check.source,
      status: check.status,
      conclusion: check.conclusion,
      detailsUrl: check.detailsUrl,
      startedAt: check.startedAt,
      completedAt: check.completedAt,
    })),
    reviews: fullStatus.reviews.map((review) => ({
      author: review.author,
      state: review.state,
      submittedAt: review.submittedAt,
    })),
    labels: fullStatus.labels.map((label) => ({
      name: label.name,
      color: label.color,
    })),
  };
}

export function getProjectPlanBranchMatches(
  db: Database,
  projectId: number
): Map<string, BranchPlanMatch[]> {
  const plans = getPlansByProject(db, projectId);
  const matches = new Map<string, BranchPlanMatch[]>();

  for (const plan of plans) {
    if (!plan.branch) {
      continue;
    }

    const existing = matches.get(plan.branch) ?? [];
    existing.push({
      planUuid: plan.uuid,
      planId: plan.plan_id,
    });
    matches.set(plan.branch, existing);
  }

  return matches;
}

async function mapWithConcurrencyLimit<T, U>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<U>
): Promise<U[]> {
  const results: U[] = [];
  for (let index = 0; index < items.length; index += limit) {
    const batch = items.slice(index, index + limit);
    results.push(...(await Promise.all(batch.map((item) => mapper(item)))));
  }
  return results;
}

export async function refreshProjectPrs(
  db: Database,
  projectId: number,
  username: string
): Promise<RefreshProjectPrsResult> {
  const project = getProjectById(db, projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  const ownerRepo = parseOwnerRepoFromRepositoryId(project.repository_id);
  if (!ownerRepo) {
    throw new Error(`Project ${projectId} does not have a GitHub repository id`);
  }

  const { owner, repo } = ownerRepo;

  // Phase 1: Fetch all open PRs with reviewer info in a single API call
  const openPrs = await fetchOpenPullRequestsWithReviewers(owner, repo);
  const requestedReviewersByPrNumber = new Map(
    openPrs.map((pr) => [pr.number, pr.requestedReviewers.map((reviewer) => reviewer.login)])
  );

  const relevantPrs = partitionUserRelevantOpenPrs(openPrs, username);

  // Phase 2: Fetch full status for all open PRs
  const fullStatuses = await mapWithConcurrencyLimit(openPrs, PR_FETCH_CONCURRENCY, async (pr) => ({
    prNumber: pr.number,
    fullStatus: await fetchPrFullStatus(owner, repo, pr.number),
  }));
  const lastFetchedAt = getNowIsoString();

  // Phase 3: Write all data to DB in a single transaction
  const writePhase = db.transaction(() => {
    const details = fullStatuses.map(({ prNumber, fullStatus }) =>
      upsertPrStatus(
        db,
        buildUpsertPrStatusInput(
          owner,
          repo,
          fullStatus,
          requestedReviewersByPrNumber.get(prNumber) ?? [],
          lastFetchedAt
        )
      )
    );
    const openPrNumbers = fullStatuses.map(({ prNumber }) => prNumber);
    const staleOpenPrsQuery =
      openPrNumbers.length > 0
        ? `
            UPDATE pr_status
            SET state = 'closed',
                updated_at = ${SQL_NOW_ISO_UTC}
            WHERE owner = ?
              AND repo = ?
              AND state = 'open'
              AND pr_number NOT IN (${openPrNumbers.map(() => '?').join(', ')})
          `
        : `
            UPDATE pr_status
            SET state = 'closed',
                updated_at = ${SQL_NOW_ISO_UTC}
            WHERE owner = ?
              AND repo = ?
              AND state = 'open'
          `;
    db.prepare(staleOpenPrsQuery).run(owner, repo, ...openPrNumbers);

    const detailsByNumber = new Map(details.map((detail) => [detail.status.pr_number, detail]));
    const normalizedUsername = normalizeGitHubUsername(username);
    const authoredNumbers = new Set(relevantPrs.authored.map((pr) => pr.number));

    const authored = [...authoredNumbers]
      .map((prNumber) => detailsByNumber.get(prNumber))
      .filter((detail): detail is PrStatusDetail => detail !== undefined)
      .sort((a, b) => a.status.pr_number - b.status.pr_number);

    const reviewingNumbers = new Set(relevantPrs.reviewing.map((pr) => pr.number));
    for (const detail of details) {
      if (
        !authoredNumbers.has(detail.status.pr_number) &&
        detail.reviews.some(
          (review) =>
            normalizeGitHubUsername(review.author) === normalizedUsername &&
            review.state !== 'PENDING'
        )
      ) {
        reviewingNumbers.add(detail.status.pr_number);
      }
    }

    const reviewing = [...reviewingNumbers]
      .map((prNumber) => detailsByNumber.get(prNumber))
      .filter((detail): detail is PrStatusDetail => detail !== undefined)
      .sort((a, b) => a.status.pr_number - b.status.pr_number);

    // Auto-link PRs to plans based on branch name matching
    const branchMatches = getProjectPlanBranchMatches(db, projectId);
    const existingLinkQuery = db.prepare(
      "SELECT 1 FROM plan_pr WHERE plan_uuid = ? AND pr_status_id = ? AND source = 'auto'"
    );
    const newLinks: ProjectPrLink[] = [];

    for (const detail of details) {
      // Only auto-link PRs authored by the user, not review-only PRs
      if (!authoredNumbers.has(detail.status.pr_number)) {
        continue;
      }

      const headBranch = detail.status.head_branch;
      if (!headBranch) {
        continue;
      }

      const matchedPlans = branchMatches.get(headBranch) ?? [];
      for (const match of matchedPlans) {
        const existingLink = existingLinkQuery.get(match.planUuid, detail.status.id) as {
          1: number;
        } | null;
        if (existingLink) {
          continue;
        }

        linkPlanToPr(db, match.planUuid, detail.status.id, 'auto');
        newLinks.push({
          prUrl: detail.status.pr_url,
          planId: match.planId,
        });
      }
    }

    return { authored, reviewing, newLinks };
  });

  return writePhase.immediate();
}
