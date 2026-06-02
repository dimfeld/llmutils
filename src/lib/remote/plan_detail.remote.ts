import { query } from '$app/server';
import * as z from 'zod';

import { getPlanDetail as getPlanDetailFromDb } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { loadFinishConfigForProject } from '$lib/server/plans_browser.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { getReviewsByPlanUuid } from '$tim/db/review.js';

const planDetailSchema = z.object({ planUuid: z.string().uuid() });

export const getPlanDetail = query(planDetailSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();
  const planRow = getPlanByUuid(db, planUuid);
  if (!planRow) return null;

  const finishConfig = await loadFinishConfigForProject(db, planRow.project_id);
  const plan = await getPlanDetailFromDb(db, planUuid, finishConfig);
  if (!plan) return null;
  const linkedPrUrls = plan.prStatuses.map((pr) => pr.status.pr_url);
  return {
    plan,
    reviews: getReviewsByPlanUuid(db, plan.uuid, { linkedPrUrls }),
    openInEditorEnabled: Boolean(process.env.TIM_ENABLE_OPEN_IN_EDITOR),
  };
});
