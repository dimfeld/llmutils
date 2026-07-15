import { error, redirect } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import {
  getPlanDetailRouteData,
  loadMediaHostConfiguredForProject,
  loadProofConfiguredForProject,
  toPlanDetailView,
  toPlanReviewListItems,
} from '$lib/server/plans_browser.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, url }) => {
  const { db } = await getServerContext();
  const result = await getPlanDetailRouteData(db, params.planId, params.projectId, 'plans', {
    includeDeletedArtifacts: url.searchParams.get('includeDeletedArtifacts') === '1',
  });

  if (!result) {
    error(404, 'Plan not found');
  }

  if (result.redirectTo) {
    redirect(302, result.redirectTo);
  }

  const proofConfigured = await loadProofConfiguredForProject(db, result.planDetail.projectId);
  const mediaHostConfigured = await loadMediaHostConfiguredForProject(
    db,
    result.planDetail.projectId
  );

  return {
    planDetail: toPlanDetailView(result.planDetail),
    reviews: toPlanReviewListItems(result.reviews),
    openInEditorEnabled: Boolean(process.env.TIM_ENABLE_OPEN_IN_EDITOR),
    proofConfigured,
    mediaHostConfigured,
  };
};
