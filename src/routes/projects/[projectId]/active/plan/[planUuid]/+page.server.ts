import { getServerContext } from '$lib/server/init.js';
import {
  loadMediaHostConfiguredForProject,
  loadChatExecutorOptionsForProject,
  loadProofConfiguredForProject,
} from '$lib/server/plans_browser.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const { db } = await getServerContext();
  const plan = getPlanByUuid(db, params.planUuid);

  const proofConfigured = plan ? await loadProofConfiguredForProject(db, plan.project_id) : false;
  const mediaHostConfigured = plan
    ? await loadMediaHostConfiguredForProject(db, plan.project_id)
    : false;
  const chatExecutorOptions = plan
    ? await loadChatExecutorOptionsForProject(db, plan.project_id)
    : undefined;

  return { proofConfigured, mediaHostConfigured, chatExecutorOptions };
};
