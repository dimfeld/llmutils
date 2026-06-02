import { error } from '@sveltejs/kit';
import type { Database } from 'bun:sqlite';

import {
  getPrReviewSubmissionsForReview,
  getReviewById,
  getReviewIssues,
  type PrReviewSubmissionRow,
  type ReviewIssueRow,
  type ReviewRow,
} from '$tim/db/review.js';
import { getGitHubUsername } from '$common/github/user.js';
import {
  getLinkedPlansByPrUrl,
  getPrStatusForPlan,
  getPrStatusByUrl,
  type LinkedPlanSummary,
  type PrStatusDetail,
  type PrReviewThreadDetail,
} from '$tim/db/pr_status.js';

interface ReviewDataParams {
  projectId: string;
  prNumber: string;
  reviewId: string;
}

export interface ReviewDetailData {
  review: ReviewRow;
  issues: ReviewIssueRow[];
  submissions: PrReviewSubmissionRow[];
  currentBranch: string | null;
  currentHeadSha: string | null;
  submissionPrUrl: string | null;
  submitAsCommentOnly: boolean;
  linkedPlanUuid: string | null;
  linkedPlans: LinkedPlanSummary[];
  reviewThreads: PrReviewThreadDetail[];
}

function getSubmissionPrDetail(db: Database, review: ReviewRow): PrStatusDetail | null {
  if (review.pr_url != null) {
    return getPrStatusByUrl(db, review.pr_url, { includeReviewThreads: true });
  }
  if (review.plan_uuid == null) {
    return null;
  }

  const linkedPrs = getPrStatusForPlan(db, review.plan_uuid, undefined, {
    includeReviewThreads: true,
  });
  return linkedPrs.length === 1 ? (linkedPrs[0] ?? null) : null;
}

export interface ReviewDetailConfig {
  githubUsername?: string | null;
}

function parseRouteInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    error(404, `${label} not found`);
  }
  return parsed;
}

function getPrNumberFromUrl(prUrl: string): number | null {
  try {
    const url = new URL(prUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length < 4 || (segments[2] !== 'pull' && segments[2] !== 'pulls')) {
      return null;
    }

    const parsed = Number(segments[3]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function getSubmitAsCommentOnly(
  prAuthor: string | null | undefined,
  config: ReviewDetailConfig
): Promise<boolean> {
  if (prAuthor == null) {
    return false;
  }

  const currentUser = await getGitHubUsername({ githubUsername: config.githubUsername });
  return currentUser != null && currentUser.toLowerCase() === prAuthor.toLowerCase();
}

export async function getReviewDetailDataForReview(
  db: Database,
  review: ReviewRow,
  config: ReviewDetailConfig = {}
): Promise<ReviewDetailData> {
  const issues = getReviewIssues(db, review.id);
  const submissions = getPrReviewSubmissionsForReview(db, review.id);
  const prStatus = getSubmissionPrDetail(db, review);
  const submissionPrUrl = review.pr_url ?? prStatus?.status.pr_url ?? null;
  if (submissionPrUrl == null) {
    return {
      review,
      issues,
      submissions,
      currentBranch: null,
      currentHeadSha: null,
      submissionPrUrl: null,
      submitAsCommentOnly: false,
      linkedPlanUuid: review.plan_uuid,
      linkedPlans: [],
      reviewThreads: [],
    };
  }

  const linkedPlans = getLinkedPlansByPrUrl(db, [submissionPrUrl]).get(submissionPrUrl) ?? [];
  const linkedPlanUuid =
    review.plan_uuid ?? (linkedPlans.length === 1 ? (linkedPlans[0]?.planUuid ?? null) : null);

  const currentBranch = prStatus?.status.head_branch ?? null;
  const currentHeadSha = prStatus?.status.head_sha ?? null;
  const submitAsCommentOnly = await getSubmitAsCommentOnly(prStatus?.status.author, config);
  const reviewThreads = prStatus?.reviewThreads ?? [];

  return {
    review,
    issues,
    submissions,
    currentBranch,
    currentHeadSha,
    submissionPrUrl,
    submitAsCommentOnly,
    linkedPlanUuid,
    linkedPlans,
    reviewThreads,
  };
}

export async function getReviewDetailData(
  db: Database,
  params: ReviewDataParams,
  config: ReviewDetailConfig = {}
): Promise<ReviewDetailData> {
  const projectId = parseRouteInteger(params.projectId, 'Project');
  const prNumber = parseRouteInteger(params.prNumber, 'Pull request');
  const reviewId = parseRouteInteger(params.reviewId, 'Review');

  const review = getReviewById(db, reviewId);
  if (!review || review.project_id !== projectId) {
    error(404, 'Review not found');
  }
  if (review.pr_url == null) {
    error(404, 'PR review not found');
  }
  const prUrl = review.pr_url;
  if (getPrNumberFromUrl(prUrl) !== prNumber) {
    error(404, 'Review not found');
  }

  return getReviewDetailDataForReview(db, review, config);
}
