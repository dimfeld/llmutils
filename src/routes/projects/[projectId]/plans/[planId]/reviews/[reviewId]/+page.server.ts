import { error } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { getReviewById } from '$tim/db/review.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { getReviewDetailDataForReview } from '../../../../prs/[prNumber]/reviews/[reviewId]/review_data.server.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const { db, config } = await getServerContext();
  const reviewId = Number(params.reviewId);

  if (!Number.isFinite(reviewId)) {
    error(404, 'Review not found');
  }

  const plan = getPlanByUuid(db, params.planId);
  if (!plan) {
    error(404, 'Plan not found');
  }

  const routeProjectId = params.projectId;
  if (routeProjectId !== 'all' && String(plan.project_id) !== routeProjectId) {
    error(404, 'Plan not found in project');
  }

  const review = getReviewById(db, reviewId);
  if (!review) {
    error(404, 'Review not found');
  }
  if (review.plan_uuid !== plan.uuid) {
    error(404, 'Review not found for plan');
  }

  const reviewDetail = await getReviewDetailDataForReview(db, review, config);

  return {
    ...reviewDetail,
    plan: { uuid: plan.uuid, planId: plan.plan_id, title: plan.title, branch: plan.branch },
    projectId: routeProjectId,
  };
};
