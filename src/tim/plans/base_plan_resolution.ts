import { fetchRemoteBranch, getTrunkBranch, remoteBranchExists } from '../../common/git.js';
import { getDatabase } from '../db/database.js';
import { resolveProjectContext } from '../plan_materialize.js';
import type { PlanSchema } from '../planSchema.js';
import { resolvePlanByNumericId } from '../plans.js';
import { generateBranchNameFromPlan, resolveBranchPrefix } from '../commands/branch.js';
import type { TimConfig } from '../configSchema.js';

export interface ResolveEffectivePlanBaseOptions {
  plan: PlanSchema;
  config: TimConfig;
  baseDir: string;
  trunkBranch?: string;
  fetchBasePlanRemote?: boolean;
  onMissingBasePlanBranch?: (branchName: string) => void;
}

export type EffectivePlanBaseSource = 'plan' | 'basePlan' | 'parent' | 'trunk';

export interface EffectivePlanBaseResolution {
  baseBranch: string;
  source: EffectivePlanBaseSource;
}

export async function resolveBasePlanBranch(
  plan: PlanSchema,
  config: TimConfig,
  currentBaseDir: string
): Promise<string | undefined> {
  if (!plan.basePlan) {
    return undefined;
  }

  const referencedPlan = await resolvePlanByNumericId(plan.basePlan, currentBaseDir);
  const projectContext = await resolveProjectContext(currentBaseDir);
  const branchPrefix = resolveBranchPrefix({
    config,
    db: getDatabase(),
    projectId: projectContext.projectId,
  });
  return (
    referencedPlan.plan.branch ??
    generateBranchNameFromPlan(referencedPlan.plan, {
      branchPrefix,
    })
  );
}

export async function resolveParentPlanBaseBranch(
  plan: PlanSchema,
  config: TimConfig,
  currentBaseDir: string
): Promise<string | undefined> {
  if (!plan.parent) {
    return undefined;
  }

  const parentPlan = (await resolvePlanByNumericId(plan.parent, currentBaseDir)).plan;
  if (parentPlan.branch) {
    return parentPlan.branch;
  }

  const parentBasePlanBranch = await resolveBasePlanBranch(parentPlan, config, currentBaseDir);
  if (parentBasePlanBranch) {
    return parentBasePlanBranch;
  }

  const parentBaseBranch = parentPlan.baseBranch?.trim();
  if (parentBaseBranch) {
    return parentBaseBranch;
  }

  const projectContext = await resolveProjectContext(currentBaseDir);
  const branchPrefix = resolveBranchPrefix({
    config,
    db: getDatabase(),
    projectId: projectContext.projectId,
  });
  return generateBranchNameFromPlan(parentPlan, { branchPrefix });
}

export async function resolveEffectivePlanBase(
  options: ResolveEffectivePlanBaseOptions
): Promise<string> {
  return (await resolveEffectivePlanBaseWithSource(options)).baseBranch;
}

export async function resolveEffectivePlanBaseWithSource(
  options: ResolveEffectivePlanBaseOptions
): Promise<EffectivePlanBaseResolution> {
  const explicitBaseBranch = options.plan.baseBranch?.trim();
  if (explicitBaseBranch) {
    return { baseBranch: explicitBaseBranch, source: 'plan' };
  }

  const trunkBranch = options.trunkBranch ?? (await getTrunkBranch(options.baseDir));
  const basePlanBranch = await resolveBasePlanBranch(options.plan, options.config, options.baseDir);
  let inheritedBaseBranch = basePlanBranch;
  let inheritedSource: EffectivePlanBaseSource = 'basePlan';
  if (!inheritedBaseBranch) {
    inheritedBaseBranch = await resolveParentPlanBaseBranch(
      options.plan,
      options.config,
      options.baseDir
    );
    inheritedSource = 'parent';
    if (!inheritedBaseBranch) {
      return { baseBranch: trunkBranch, source: 'trunk' };
    }
  }

  const existsOnRemote = await remoteBranchExists(options.baseDir, inheritedBaseBranch);
  if (existsOnRemote) {
    if (options.fetchBasePlanRemote) {
      // JJ callers usually leave this false because remoteBranchExistsJj already
      // runs `jj git fetch --branch`, so a second explicit fetch is redundant.
      const fetched = await fetchRemoteBranch(options.baseDir, inheritedBaseBranch);
      if (!fetched) {
        throw new Error(`Failed to fetch base plan branch "${inheritedBaseBranch}" from origin.`);
      }
    }
    return { baseBranch: inheritedBaseBranch, source: inheritedSource };
  }

  options.onMissingBasePlanBranch?.(inheritedBaseBranch);
  return { baseBranch: trunkBranch, source: 'trunk' };
}
