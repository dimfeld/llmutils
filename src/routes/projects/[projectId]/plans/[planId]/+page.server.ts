import { error, redirect } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { getPlanDetailRouteData } from '$lib/server/plans_browser.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const { db, config } = await getServerContext();
  const result = getPlanDetailRouteData(db, params.planId, params.projectId, 'plans', config);

  if (!result) {
    error(404, 'Plan not found');
  }

  if (result.redirectTo) {
    redirect(302, result.redirectTo);
  }

  return {
    planDetail: result.planDetail,
    openInEditorEnabled: Boolean(process.env.TIM_ENABLE_OPEN_IN_EDITOR),
  };
};
