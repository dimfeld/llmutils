import { query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { getServerContext } from '$lib/server/init.js';
import { toPlanMetadataRemoteError } from '$lib/server/plan_metadata_errors.js';
import { planPickerRelations, searchPlanPickerOptions } from '$lib/server/plan_picker_queries.js';

const planPickerSearchSchema = z.object({
  projectId: z.number().int().positive(),
  query: z.string(),
  relation: z.enum(planPickerRelations),
  currentPlanUuid: z.string().optional().nullable(),
  limit: z.number().int().positive().max(50).optional(),
});

export const searchPlanPicker = query(planPickerSearchSchema, async (input) => {
  const { db } = await getServerContext();
  try {
    return searchPlanPickerOptions(db, input);
  } catch (caughtError) {
    const remoteError = toPlanMetadataRemoteError(caughtError);
    if (remoteError) {
      error(remoteError.status, remoteError.body);
    }
    throw caughtError;
  }
});
