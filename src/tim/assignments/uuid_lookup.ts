import type { PlanSchema } from '../planSchema.js';
import { resolvePlanFromDb } from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';

export interface ResolvePlanWithUuidOptions {
  configPath?: string;
}

export interface ResolvePlanWithUuidResult {
  plan: PlanSchema & { filename?: string };
  repoRoot: string;
  uuid: string;
}

export function findPlanByUuid(
  uuid: string,
  allPlans: Map<number, PlanSchema>
): PlanSchema | undefined {
  for (const plan of allPlans.values()) {
    if (plan.uuid === uuid) {
      return plan;
    }
  }

  return undefined;
}

export interface VerifyPlanIdResult {
  plan: PlanSchema;
  planId: number;
  cacheUpdated: boolean;
}

export function verifyPlanIdCache(
  cachedPlanId: number | null | undefined,
  uuid: string,
  allPlans: Map<number, PlanSchema>
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
  const repoRoot = await resolveRepoRoot(options.configPath, process.cwd());

  const { plan, planPath } = await resolvePlanFromDb(planArg, repoRoot);

  if (!plan.uuid) {
    throw new Error(`Plan ${planArg} does not have a UUID`);
  }

  return {
    plan: planPath ? { ...plan, filename: planPath } : plan,
    repoRoot,
    uuid: plan.uuid,
  };
}
