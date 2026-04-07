import { query } from '$app/server';
import * as z from 'zod';

import { getPlanDetail as getPlanDetailFromDb } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { loadFinishConfigForProject } from '$lib/server/plans_browser.js';
import { getPlanByUuid } from '$tim/db/plan.js';

const planDetailSchema = z.object({ planUuid: z.string().uuid() });

export const getPlanDetail = query(planDetailSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();
  const planRow = getPlanByUuid(db, planUuid);
  if (!planRow) return null;

  const finishConfig = await loadFinishConfigForProject(db, planRow.project_id);
  const plan = getPlanDetailFromDb(db, planUuid, finishConfig);
  if (!plan) return null;
  return {
    plan,
    openInEditorEnabled: Boolean(process.env.TIM_ENABLE_OPEN_IN_EDITOR),
  };
});
