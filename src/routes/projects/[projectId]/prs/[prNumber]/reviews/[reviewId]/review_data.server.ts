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
import { getLinkedPlansByPrUrl, type LinkedPlanSummary } from '$tim/db/pr_status.js';

interface ReviewDataParams {
  projectId: string;
  prNumber: string;
  reviewId: string;
}

export interface ReviewDetailData {
  review: ReviewRow;
  issues: ReviewIssueRow[];
  submissions: PrReviewSubmissionRow[];
  currentHeadSha: string | null;
  linkedPlanUuid: string | null;
  linkedPlans: LinkedPlanSummary[];
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

export function getReviewDetailData(db: Database, params: ReviewDataParams): ReviewDetailData {
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

  const issues = getReviewIssues(db, reviewId);
  const submissions = getPrReviewSubmissionsForReview(db, reviewId);
  const linkedPlans = getLinkedPlansByPrUrl(db, [prUrl]).get(prUrl) ?? [];
  const linkedPlanUuid = linkedPlans.length === 1 ? (linkedPlans[0]?.planUuid ?? null) : null;

  const prStatusRow = db.prepare('SELECT head_sha FROM pr_status WHERE pr_url = ?').get(prUrl) as {
    head_sha: string | null;
  } | null;
  const currentHeadSha = prStatusRow?.head_sha ?? null;

  return { review, issues, submissions, currentHeadSha, linkedPlanUuid, linkedPlans };
}
