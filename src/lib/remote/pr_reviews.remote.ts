import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { getReviewIssueById, getReviewsByPrUrl, updateReviewIssue } from '$tim/db/review.js';

const prUrlSchema = z.object({
  prUrl: z.string().min(1),
});

export const getPrReviews = query(prUrlSchema, async ({ prUrl }) => {
  const { db } = await getServerContext();
  return getReviewsByPrUrl(db, prUrl);
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
