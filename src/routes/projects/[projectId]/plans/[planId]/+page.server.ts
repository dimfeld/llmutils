import { error, redirect } from '@sveltejs/kit';
import { getServerContext } from '$lib/server/init.js';
import { getPlanDetailRouteData } from '$lib/server/plans_browser.js';
import { loadEffectiveConfig } from '$tim/configLoader.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info.js';
import { isProofConfigured } from '$lib/utils/proof_eligibility.js';
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

  let proofConfigured = false;
  const cwd = getPreferredProjectGitRoot(db, result.planDetail.projectId);
  if (cwd) {
    try {
      const cfg = await loadEffectiveConfig(undefined, { cwd });
      proofConfigured = isProofConfigured(cfg);
    } catch (err) {
      console.warn(
        `Failed to load tim config for project ${result.planDetail.projectId} when checking proofGeneration: ${err as Error}`
      );
      proofConfigured = false;
    }
  }

  return {
    planDetail: result.planDetail,
    reviews: result.reviews,
    openInEditorEnabled: Boolean(process.env.TIM_ENABLE_OPEN_IN_EDITOR),
    proofConfigured,
  };
};
