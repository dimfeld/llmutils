import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import {
  getReviewById,
  getReviewIssueById,
  getReviewsByPrUrl,
  updateReviewIssue,
} from '$tim/db/review.js';
import { setReviewItemViewed } from '$tim/db/review_file.js';

const prUrlSchema = z.object({
  prUrl: z.string().min(1),
  linkedPlanUuids: z.array(z.string()).optional(),
});

export const getPrReviews = query(prUrlSchema, async ({ prUrl, linkedPlanUuids }) => {
  const { db } = await getServerContext();
  return getReviewsByPrUrl(db, prUrl, { linkedPlanUuids });
});

const toggleIssueSchema = z.object({
  issueId: z.number().int(),
  resolved: z.boolean(),
});

export const toggleReviewIssueResolved = command(
  toggleIssueSchema,
  async ({ issueId, resolved }) => {
    const { db } = await getServerContext();
    const issue = getReviewIssueById(db, issueId);
    if (!issue) {
      error(404, 'Review issue not found');
    }
    if (issue.severity === 'note') {
      error(400, 'Notes cannot be resolved');
    }

    const updated = updateReviewIssue(db, issueId, { resolved });
    if (!updated) {
      error(404, 'Review issue not found');
    }
    return { resolved: updated.resolved === 1 };
  }
);

const convertQuestionSchema = z.object({
  issueId: z.number().int(),
});

/**
 * Turn a `question` annotation into an `info` review issue, so the reviewer can
 * send it to the PR as a comment. Other notes stay local-only.
 */
export const convertQuestionToComment = command(convertQuestionSchema, async ({ issueId }) => {
  const { db } = await getServerContext();
  const issue = getReviewIssueById(db, issueId);
  if (!issue) {
    error(404, 'Review issue not found');
  }
  if (issue.severity !== 'note' || issue.annotationKind !== 'question') {
    error(400, 'Only question annotations can be converted to comments');
  }
  if (issue.file == null) {
    error(400, 'The question has no file anchor');
  }

  const updated = updateReviewIssue(db, issueId, {
    severity: 'info',
    category: 'other',
    side: issue.side ?? 'RIGHT',
  });
  if (!updated) {
    error(404, 'Review issue not found');
  }
  return updated;
});

const viewedItemSchema = z.object({
  reviewId: z.number().int(),
  kind: z.enum(['section', 'file']),
  key: z.string().min(1).max(1000),
  viewed: z.boolean(),
});

export const setReviewGuideItemViewed = command(
  viewedItemSchema,
  async ({ reviewId, kind, key, viewed }) => {
    const { db } = await getServerContext();
    if (!getReviewById(db, reviewId)) {
      error(404, 'Review not found');
    }
    setReviewItemViewed(db, { reviewId, kind, key, viewed });
    return { viewed };
  }
);
