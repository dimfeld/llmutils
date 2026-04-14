import { error } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { getReviewById, getReviewIssues } from '$tim/db/review.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const { db } = await getServerContext();
  const reviewId = Number(params.reviewId);

  if (!Number.isFinite(reviewId)) {
    error(404, 'Review not found');
  }

  const review = getReviewById(db, reviewId);
  if (!review) {
    error(404, 'Review not found');
  }

  const issues = getReviewIssues(db, reviewId);

  const prStatusRow = db
    .prepare('SELECT head_sha FROM pr_status WHERE pr_url = ?')
    .get(review.pr_url) as { head_sha: string | null } | null;
  const currentHeadSha = prStatusRow?.head_sha ?? null;

  return { review, issues, currentHeadSha };
};
