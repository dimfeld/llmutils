/**
 * @fileoverview Shared context gathering utility for tim commands.
 * Extracts plan data, hierarchy information, and diff context for use
 * by both review and description commands.
 */

import chalk from 'chalk';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { resolvePlanByNumericId } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getLegacyAwareSearchDir } from '../path_resolver.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { loadPlansFromDb } from '../plans_db.js';
import { getParentChain, getCompletedChildren } from './hierarchy.js';
import { generateDiffForReview, type DiffResult } from '../review_diff.js';
import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveEffectivePlanBase } from '../plans/base_plan_resolution.js';

/**
 * Result object containing all gathered context for a plan
 */
export interface PlanContext {
  /** The resolved plan file path, or a plan ID string for DB-only plans without a backing file */
  resolvedPlanFile: string;
  /** The loaded plan data */
  planData: PlanSchema;
  /** The resolved repository root (from resolveRepoRoot) */
  repoRoot: string;
  /** The resolved git root (derived from repoRoot) */
  gitRoot: string;
  /** Chain of parent plans from immediate parent to root */
  parentChain: PlanSchema[];
  /** All completed child plans */
  completedChildren: PlanSchema[];
  /** Plans with the same direct parent, excluding the current plan */
  siblingPlans: PlanSchema[];
  /** Diff result containing changed files and content */
  diffResult: DiffResult;
  /** True if no changes were detected and review should be skipped */
  noChangesDetected?: boolean;
}

/**
 * Dependencies that can be injected for testing
 */
export interface ContextGatheringDependencies {
  resolvePlanByNumericId: typeof resolvePlanByNumericId;
  loadPlansFromDb: typeof loadPlansFromDb;
  generateDiffForReview: typeof generateDiffForReview;
  getGitRoot: typeof getGitRoot;
  getParentChain: typeof getParentChain;
  getCompletedChildren: typeof getCompletedChildren;
  resolveRepoRoot: typeof resolveRepoRoot;
  getRepositoryIdentity: typeof getRepositoryIdentity;
  loadEffectiveConfig: typeof loadEffectiveConfig;
  resolveEffectivePlanBase: typeof resolveEffectivePlanBase;
}

/**
 * Default dependencies using the actual implementations
 */
const defaultDependencies: ContextGatheringDependencies = {
  resolvePlanByNumericId,
  loadPlansFromDb,
  generateDiffForReview,
  getGitRoot,
  getParentChain,
  getCompletedChildren,
  resolveRepoRoot,
  getRepositoryIdentity,
  loadEffectiveConfig,
  resolveEffectivePlanBase,
};

/**
 * Gathers comprehensive context for a plan including hierarchy and diff information.
 * This function encapsulates the context-gathering logic previously embedded in handleReviewCommand.
 *
 * @param planId - Plan ID
 * @param options - Command options that control review context
 * @param globalOpts - Global CLI options including config path
 * @param deps - Injectable dependencies for testing
 * @returns Promise<PlanContext> containing all gathered context
 */
export async function gatherPlanContext(
  planId: number,
  options: {
    since?: string;
    base?: string;
    cwd?: string;
  },
  globalOpts: {
    config?: string;
  },
  deps: ContextGatheringDependencies = defaultDependencies
): Promise<PlanContext> {
  const repoRoot = await deps.resolveRepoRoot(globalOpts.config, options.cwd);
  const resolvedPlan = await deps.resolvePlanByNumericId(planId, repoRoot);
  const planData = resolvedPlan.plan;
  const resolvedPlanFile = resolvedPlan.planPath ?? String(planData.id ?? planId);

  // Validate plan exists and has content
  if (!planData) {
    throw new Error(`Could not load plan from: ${resolvedPlanFile}`);
  }

  log(chalk.green(`Loading plan context: ${planData.id} - ${planData.title}`));

  // Use repoRoot for git operations so --config cross-repo invocations use the correct repository
  const gitRoot = await deps.getGitRoot(repoRoot);

  let parentChain: PlanSchema[] = [];
  let completedChildren: PlanSchema[] = [];
  let siblingPlans: PlanSchema[] = [];

  try {
    const { repositoryId } = await deps.getRepositoryIdentity({ cwd: repoRoot });
    const { plans: allPlans } = deps.loadPlansFromDb(
      getLegacyAwareSearchDir(gitRoot, repoRoot),
      repositoryId
    );

    // Use hierarchy utilities to get parent chain
    if (planData.id) {
      try {
        parentChain = deps.getParentChain(planData, allPlans);

        if (parentChain.length > 0) {
          log(
            chalk.cyan(`Parent plan context loaded: ${parentChain[0].id} - ${parentChain[0].title}`)
          );
          if (parentChain.length > 1) {
            log(chalk.cyan(`Found ${parentChain.length} levels of parent plans`));
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(chalk.yellow(`Warning: Could not load parent chain: ${errorMessage}`));
        parentChain = [];
      }

      // Get completed children if this plan has any
      try {
        completedChildren = deps.getCompletedChildren(planData.id, allPlans);

        if (completedChildren.length > 0) {
          log(chalk.cyan(`Found ${completedChildren.length} completed child plans`));
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(chalk.yellow(`Warning: Could not load completed children: ${errorMessage}`));
        completedChildren = [];
      }

      if (planData.parent) {
        siblingPlans = Array.from(allPlans.values())
          .filter(
            (candidate) => candidate.id !== planData.id && candidate.parent === planData.parent
          )
          .toSorted((a, b) => (a.id ?? 0) - (b.id ?? 0));
        if (siblingPlans.length > 0) {
          log(chalk.cyan(`Found ${siblingPlans.length} sibling plans`));
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(
      chalk.yellow(
        `Warning: Could not read plan hierarchy: ${errorMessage}. Continuing with basic context.`
      )
    );
  }

  const config = await deps.loadEffectiveConfig(globalOpts.config);
  const baseBranch =
    options.base ??
    (await deps.resolveEffectivePlanBase({
      plan: planData,
      config,
      baseDir: gitRoot,
    }));

  const diffOptions = {
    baseBranch,
    sinceCommit: options.since,
  };

  let noChangesDetected = false;
  const diffResult = await deps.generateDiffForReview(gitRoot, diffOptions);

  if (!diffResult.hasChanges) {
    log(
      chalk.yellow(
        options.since
          ? `No changes detected since ${options.since}.`
          : 'No changes detected compared to trunk branch.'
      )
    );
    noChangesDetected = true;
  } else {
    log(chalk.cyan(`Found ${diffResult.changedFiles.length} changed files`));
    log(chalk.gray(`Comparing against: ${diffResult.baseBranch}`));
  }

  return {
    resolvedPlanFile,
    planData,
    repoRoot,
    gitRoot,
    parentChain,
    completedChildren,
    siblingPlans,
    diffResult,
    noChangesDetected,
  };
}
