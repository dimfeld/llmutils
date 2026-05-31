import { command } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { toPlanMetadataRemoteError } from '$lib/server/plan_metadata_errors.js';
import { createPlanFromWeb, updatePlanMetadataFromWeb } from '$lib/server/plan_metadata.js';
import { getServerContext } from '$lib/server/init.js';

const planMetadataFieldsSchema = z.object({
  title: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
  details: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  simple: z.boolean().nullable().optional(),
  tags: z.array(z.string()).optional(),
  parentUuid: z.string().nullable().optional(),
  basePlanUuid: z.string().nullable().optional(),
  dependencyUuids: z.array(z.string()).optional(),
});

const createPlanSchema = planMetadataFieldsSchema.extend({
  projectId: z.union([z.number().int().positive(), z.literal('all')]),
});

const updatePlanMetadataSchema = planMetadataFieldsSchema.extend({
  projectId: z.union([z.number().int().positive(), z.literal('all')]),
  planUuid: z.string().min(1),
});

export const createPlan = command(createPlanSchema, async (input) => {
  const { db } = await getServerContext();
  try {
    return await createPlanFromWeb(db, input);
  } catch (caughtError) {
    throwStructuredPlanMetadataError(caughtError);
  }
});

export const updatePlanMetadata = command(updatePlanMetadataSchema, async (input) => {
  const { db } = await getServerContext();
  try {
    return await updatePlanMetadataFromWeb(db, input);
  } catch (caughtError) {
    throwStructuredPlanMetadataError(caughtError);
  }
});

function throwStructuredPlanMetadataError(caughtError: unknown): never {
  const remoteError = toPlanMetadataRemoteError(caughtError);
  if (remoteError) {
    error(remoteError.status, remoteError.body);
  }
  throw caughtError;
}
