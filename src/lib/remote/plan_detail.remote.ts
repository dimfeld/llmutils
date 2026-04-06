import { query } from '$app/server';
import * as z from 'zod';

import { getPlanDetail as getPlanDetailFromDb } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';

const planDetailSchema = z.object({ planUuid: z.string().uuid() });

export const getPlanDetail = query(planDetailSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();
  const plan = getPlanDetailFromDb(db, planUuid);
  if (!plan) return null;
  return {
    plan,
    openInEditorEnabled: Boolean(process.env.TIM_ENABLE_OPEN_IN_EDITOR),
  };
});
