import type { PlanSchema, PlanSchemaWithFilename } from '../planSchema.js';
import { readPlanFile, resolvePlanFile } from '../plans.js';

export interface ResolvePlanWithUuidOptions {
  configPath?: string;
}

export interface ResolvePlanWithUuidResult {
  plan: PlanSchemaWithFilename;
  uuid: string;
}

export function findPlanByUuid(
  uuid: string,
  allPlans: Map<number, PlanSchemaWithFilename>
): PlanSchemaWithFilename | undefined {
  for (const plan of allPlans.values()) {
    if (plan.uuid === uuid) {
      return plan;
    }
  }

  return undefined;
}

export interface VerifyPlanIdResult {
  plan: PlanSchemaWithFilename;
  planId: number;
  cacheUpdated: boolean;
}

export function verifyPlanIdCache(
  cachedPlanId: number | null | undefined,
  uuid: string,
  allPlans: Map<number, PlanSchemaWithFilename>
): VerifyPlanIdResult | null {
  if (!uuid) {
    return null;
  }

  if (cachedPlanId) {
    const candidate = allPlans.get(cachedPlanId);
    if (candidate?.uuid === uuid) {
      return {
        plan: candidate,
        planId: cachedPlanId,
        cacheUpdated: false,
      };
    }
  }

  const located = findPlanByUuid(uuid, allPlans);
  if (!located || !located.id) {
    return null;
  }

  return {
    plan: located,
    planId: located.id,
    cacheUpdated: cachedPlanId !== located.id,
  };
}

export async function resolvePlanWithUuid(
  planArg: string,
  options: ResolvePlanWithUuidOptions = {}
): Promise<ResolvePlanWithUuidResult> {
  const resolvedPath = await resolvePlanFile(planArg, options.configPath);
  const plan = await readPlanFile(resolvedPath);

  if (!plan.uuid) {
    throw new Error(`Plan at ${resolvedPath} does not have a UUID`);
  }

  return {
    plan: { ...plan, filename: resolvedPath },
    uuid: plan.uuid,
  };
}
