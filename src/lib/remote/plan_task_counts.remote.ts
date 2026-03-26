import { query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { getPlanByUuid, getPlanTasksByUuid } from '$tim/db/plan.js';

const planUuidSchema = z.object({
  planUuid: z.string().min(1),
});

export const getPlanTaskCounts = query(planUuidSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();
  const plan = getPlanByUuid(db, planUuid);
  if (!plan) {
    error(404, 'Plan not found');
  }

  const tasks = getPlanTasksByUuid(db, planUuid);

  const total = tasks.length;
  const done = tasks.filter((t) => t.done === 1).length;

  return { done, total };
});
