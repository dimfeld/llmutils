import { normalizeGitHubUsername } from '$common/github/user.js';
import type { ActionablePr } from '$lib/utils/dashboard_attention.js';
import type { LinkedPlanSummary, PrReviewRequestRow, PrStatusDetail } from '$tim/db/pr_status.js';

export type ActionReason = ActionablePr['actionReason'];

export interface ClassifiedPr {
  actionReason: ActionReason;
  checkStatus: ActionablePr['checkStatus'];
}

/** Classify a PR's check_rollup_state into a simplified check status. */
export function classifyCheckStatus(checkRollupState: string | null): ActionablePr['checkStatus'] {
  if (checkRollupState === null) return 'none';
  if (checkRollupState === 'SUCCESS') return 'passing';
  if (checkRollupState === 'FAILURE' || checkRollupState === 'ERROR') return 'failing';
  return 'pending';
}

/**
 * Determine if a user's own PR is actionable and why.
 * Returns null if the PR is not actionable.
 * Only considers open, non-draft PRs.
 */
export function classifyOwnPr(pr: PrStatusDetail): ClassifiedPr | null {
  const { state, draft, review_decision, check_rollup_state, mergeable } = pr.status;

  if (state !== 'open' || draft) return null;

  const checkStatus = classifyCheckStatus(check_rollup_state);

  // Priority: changes_requested > checks_failing > ready_to_merge
  if (review_decision === 'CHANGES_REQUESTED') {
    return { actionReason: 'changes_requested', checkStatus };
  }

  if (checkStatus === 'failing') {
    return { actionReason: 'checks_failing', checkStatus };
  }

  if (
    check_rollup_state === 'SUCCESS' &&
    review_decision === 'APPROVED' &&
    mergeable === 'MERGEABLE'
  ) {
    return { actionReason: 'ready_to_merge', checkStatus };
  }

  return { actionReason: 'open', checkStatus };
}

function parseRequestedReviewers(requestedReviewers: string | null): string[] {
  if (!requestedReviewers) return [];
  try {
    const parsed = JSON.parse(requestedReviewers);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function getLatestSubmittedReviewAt(pr: PrStatusDetail, normalizedUsername: string): string | null {
  let latest: string | null = null;
  for (const review of pr.reviews) {
    if (review.state === 'PENDING') continue;
    if (normalizeGitHubUsername(review.author) !== normalizedUsername) continue;
    if (review.submitted_at == null) continue;
    if (latest === null || review.submitted_at > latest) {
      latest = review.submitted_at;
    }
  }
  return latest;
}

/**
 * Determine if a PR has a pending review request for the given user.
 * Checks both detailed review request rows and the snapshot requested_reviewers field.
 */
export function hasReviewRequestForUser(pr: PrStatusDetail, normalizedUsername: string): boolean {
  // Check detailed review request rows
  const request = pr.reviewRequests.find(
    (row: PrReviewRequestRow) => normalizeGitHubUsername(row.reviewer) === normalizedUsername
  );

  if (request && request.requested_at !== null) {
    const isCurrentlyRequested =
      request.removed_at === null || request.requested_at > request.removed_at;
    if (isCurrentlyRequested) {
      const latestReviewAt = getLatestSubmittedReviewAt(pr, normalizedUsername);
      if (latestReviewAt === null || request.requested_at > latestReviewAt) {
        return true;
      }
    }
  }

  // Fallback to snapshot requested_reviewers.
  // This path is intentionally conservative: if the user has any prior review, we return false
  // because the snapshot doesn't carry a timestamp, so we can't distinguish stale requests
  // from fresh re-requests. The detailed reviewRequests rows (primary path above) handle
  // re-requests correctly via timestamp comparison.
  const snapshotRequested = parseRequestedReviewers(pr.status.requested_reviewers).some(
    (reviewer) => normalizeGitHubUsername(reviewer) === normalizedUsername
  );
  if (snapshotRequested) {
    const latestReviewAt = getLatestSubmittedReviewAt(pr, normalizedUsername);
    if (latestReviewAt === null) {
      return true;
    }
  }

  return false;
}

/** Build actionable PRs for a single repo. Pure function for testability. */
export function buildActionablePrsForRepo(
  projectId: number,
  prs: PrStatusDetail[],
  linkedPlansByPrUrl: Map<string, LinkedPlanSummary[]>,
  normalizedUsername: string | null
): ActionablePr[] {
  const results: ActionablePr[] = [];

  for (const pr of prs) {
    if (pr.status.state !== 'open') continue;

    const { owner, repo, pr_url, pr_number, title, author } = pr.status;
    const linkedPlans = linkedPlansByPrUrl.get(pr_url) ?? [];
    const firstLinkedPlan = linkedPlans[0] ?? null;

    const isAuthored =
      normalizedUsername !== null &&
      author != null &&
      normalizeGitHubUsername(author) === normalizedUsername;

    if (isAuthored) {
      const classification = classifyOwnPr(pr);
      if (classification) {
        results.push({
          prUrl: pr_url,
          prNumber: pr_number,
          title,
          owner,
          repo,
          author,
          actionReason: classification.actionReason,
          checkStatus: classification.checkStatus,
          linkedPlanId: firstLinkedPlan?.planId ?? null,
          linkedPlanUuid: firstLinkedPlan?.planUuid ?? null,
          linkedPlanTitle: firstLinkedPlan?.title ?? null,
          projectId,
        });
      }
    } else if (normalizedUsername !== null && hasReviewRequestForUser(pr, normalizedUsername)) {
      results.push({
        prUrl: pr_url,
        prNumber: pr_number,
        title,
        owner,
        repo,
        author,
        actionReason: 'review_requested',
        checkStatus: classifyCheckStatus(pr.status.check_rollup_state),
        linkedPlanId: firstLinkedPlan?.planId ?? null,
        linkedPlanUuid: firstLinkedPlan?.planUuid ?? null,
        linkedPlanTitle: firstLinkedPlan?.title ?? null,
        projectId,
      });
    }
  }

  return results;
}
