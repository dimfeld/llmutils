import { query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { getPlanByUuid, getPlanTasksByUuid } from '$tim/db/plan.js';

const planUuidSchema = z.object({
  planUuid: z.string().min(1),
});

/** Batched so that a list of sessions loads all of its counts in one request. */
export const getPlanTaskCounts = query.batch(planUuidSchema, async (inputs) => {
  const { db } = await getServerContext();
  const counts = new Map<string, { done: number; total: number } | null>();
  for (const { planUuid } of inputs) {
    if (counts.has(planUuid)) continue;
    const plan = getPlanByUuid(db, planUuid);
    if (!plan) {
      counts.set(planUuid, null);
      continue;
    }

    const tasks = getPlanTasksByUuid(db, planUuid);
    counts.set(planUuid, {
      done: tasks.filter((t) => t.done === 1).length,
      total: tasks.length,
    });
  }

  return ({ planUuid }) => {
    const result = counts.get(planUuid);
    if (!result) {
      error(404, 'Plan not found');
    }
    return result;
  };
});
