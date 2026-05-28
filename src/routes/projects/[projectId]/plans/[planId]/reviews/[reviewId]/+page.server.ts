import { error } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { getReviewById, getReviewIssues } from '$tim/db/review.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const { db } = await getServerContext();
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

  const issues = getReviewIssues(db, reviewId);

  return {
    review,
    issues,
    plan: { uuid: plan.uuid, planId: plan.plan_id, title: plan.title, branch: plan.branch },
    projectId: routeProjectId,
  };
};
