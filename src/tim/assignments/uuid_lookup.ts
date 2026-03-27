import path from 'node:path';
import type { PlanSchema } from '../planSchema.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { readPlanFile } from '../plans.js';

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
  const repoRoot = await resolveRepoRootForPlanArg(planArg, process.cwd(), options.configPath);

  if (path.isAbsolute(planArg)) {
    const directExists = await Bun.file(planArg)
      .stat()
      .then((stats) => stats.isFile())
      .catch(() => false);
    if (directExists) {
      await readPlanFile(planArg);
      const persistedPlan = await readPlanFile(planArg);
      if (!persistedPlan.uuid) {
        throw new Error(`Plan ${planArg} does not have a UUID`);
      }

      return {
        plan: { ...persistedPlan, filename: planArg },
        repoRoot,
        uuid: persistedPlan.uuid,
      };
    }
  }

  const { plan, planPath } = await resolvePlanFromDbOrSyncFile(planArg, repoRoot, repoRoot);

  if (!plan.uuid) {
    throw new Error(`Plan ${planArg} does not have a UUID`);
  }

  return {
    plan: planPath ? { ...plan, filename: planPath } : plan,
    repoRoot,
    uuid: plan.uuid,
  };
}
