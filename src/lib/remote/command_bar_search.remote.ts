import { query } from '$app/server';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { searchPlans, searchPrs } from '$lib/server/command_bar_queries.js';

const commandBarSearchSchema = z.object({
  query: z.string(),
  projectId: z.number().int().positive().optional(),
});

export const searchCommandBar = query(commandBarSearchSchema, async ({ query, projectId }) => {
  const { db } = await getServerContext();

  return {
    plans: searchPlans(db, query, projectId),
    prs: searchPrs(db, query, projectId),
  };
});
