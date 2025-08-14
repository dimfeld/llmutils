/**
 * @fileoverview Shared context gathering utility for rmplan commands.
 * Extracts plan data, hierarchy information, and diff context for use
 * by both review and description commands.
 */

import chalk from 'chalk';
import { resolvePlanFile, readPlanFile, readAllPlans } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getParentChain, getCompletedChildren } from './hierarchy.js';
import type { PlanWithFilename } from './hierarchy.js';
import { generateDiffForReview, getIncrementalSummary } from '../incremental_review.js';
import type { DiffResult } from '../incremental_review.js';
import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';

/**
 * Result object containing all gathered context for a plan
 */
export interface PlanContext {
  /** The resolved plan file path */
  resolvedPlanFile: string;
  /** The loaded plan data */
  planData: PlanSchema;
  /** Chain of parent plans from immediate parent to root */
  parentChain: PlanWithFilename[];
  /** All completed child plans */
  completedChildren: PlanWithFilename[];
  /** Diff result containing changed files and content */
  diffResult: DiffResult;
  /** Incremental review summary if applicable */
  incrementalSummary?: {
    lastReviewDate?: Date;
    totalFiles: number;
    newFiles: string[];
    modifiedFiles: string[];
  } | null;
  /** True if no changes were detected and review should be skipped */
  noChangesDetected?: boolean;
}

/**
 * Dependencies that can be injected for testing
 */
export interface ContextGatheringDependencies {
  resolvePlanFile: typeof resolvePlanFile;
  readPlanFile: typeof readPlanFile;
  readAllPlans: typeof readAllPlans;
  generateDiffForReview: typeof generateDiffForReview;
  getGitRoot: typeof getGitRoot;
  getParentChain: typeof getParentChain;
  getCompletedChildren: typeof getCompletedChildren;
  getIncrementalSummary: typeof getIncrementalSummary;
}

/**
 * Default dependencies using the actual implementations
 */
const defaultDependencies: ContextGatheringDependencies = {
  resolvePlanFile,
  readPlanFile,
  readAllPlans,
  generateDiffForReview,
  getGitRoot,
  getParentChain,
  getCompletedChildren,
  getIncrementalSummary,
};

/**
 * Gathers comprehensive context for a plan including hierarchy and diff information.
 * This function encapsulates the context-gathering logic previously embedded in handleReviewCommand.
 *
 * @param planFile - Plan file path or ID
 * @param options - Command options including incremental review settings
 * @param globalOpts - Global CLI options including config path
 * @param deps - Injectable dependencies for testing
 * @returns Promise<PlanContext> containing all gathered context
 */
export async function gatherPlanContext(
  planFile: string,
  options: {
    incremental?: boolean;
    sinceLastReview?: boolean;
    since?: string;
  },
  globalOpts: {
    config?: string;
  },
  deps: ContextGatheringDependencies = defaultDependencies
): Promise<PlanContext> {
  // Resolve the plan file (support both file paths and plan IDs)
  const resolvedPlanFile = await deps.resolvePlanFile(planFile, globalOpts.config);

  // Load the plan details
  const planData = await deps.readPlanFile(resolvedPlanFile);

  // Validate plan exists and has content
  if (!planData) {
    throw new Error(`Could not load plan from: ${resolvedPlanFile}`);
  }

  // Validate required plan fields
  if (!planData.goal) {
    throw new Error(`Plan file is missing required 'goal' field: ${resolvedPlanFile}`);
  }

  if (!planData.tasks || !Array.isArray(planData.tasks) || planData.tasks.length === 0) {
    throw new Error(`Plan file must have at least one task: ${resolvedPlanFile}`);
  }

  // Validate task structure
  for (const [index, task] of planData.tasks.entries()) {
    if (!task.title) {
      throw new Error(
        `Task ${index + 1} is missing required 'title' field in plan: ${resolvedPlanFile}`
      );
    }
    if (!task.description) {
      throw new Error(
        `Task ${index + 1} is missing required 'description' field in plan: ${resolvedPlanFile}`
      );
    }
  }

  log(chalk.green(`Loading plan context: ${planData.id} - ${planData.title}`));

  // Load all plans for hierarchy traversal
  const gitRoot = await deps.getGitRoot();
  const plansConfig = globalOpts.config || gitRoot;

  let parentChain: PlanWithFilename[] = [];
  let completedChildren: PlanWithFilename[] = [];

  try {
    const { plans: allPlans } = await deps.readAllPlans(plansConfig);

    // Add filename to the current plan for hierarchy compatibility
    const planWithFilename: PlanWithFilename = {
      ...planData,
      filename: resolvedPlanFile,
    };

    // Use hierarchy utilities to get parent chain
    if (planData.id) {
      try {
        parentChain = deps.getParentChain(planWithFilename, allPlans);

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
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    log(
      chalk.yellow(
        `Warning: Could not read plan hierarchy: ${errorMessage}. Continuing with basic context.`
      )
    );
  }

  // Handle incremental review options
  const incrementalOptions = {
    incremental: options.incremental || options.sinceLastReview,
    sinceLastReview: options.sinceLastReview,
    sinceCommit: options.since,
    planId: planData.id?.toString(),
  };

  // Generate incremental summary if applicable
  let incrementalSummary = null;
  let noChangesDetected = false;

  if (incrementalOptions.incremental && planData.id) {
    incrementalSummary = await deps.getIncrementalSummary(gitRoot, planData.id.toString(), []);
    if (incrementalSummary) {
      log(chalk.cyan(`Incremental review mode enabled`));
      log(chalk.gray(`Last review: ${incrementalSummary.lastReviewDate?.toLocaleString()}`));
      if (incrementalSummary.totalFiles === 0) {
        log(chalk.yellow('No changes detected since last review.'));
        noChangesDetected = true;
      } else {
        log(
          chalk.cyan(
            `Review delta: ${incrementalSummary.newFiles.length} new files, ${incrementalSummary.modifiedFiles.length} modified files`
          )
        );
      }
    }
  }

  // Generate diff against trunk branch or incremental diff
  const diffResult = await deps.generateDiffForReview(gitRoot, incrementalOptions);

  if (!diffResult.hasChanges) {
    const nothingMessage = incrementalOptions.incremental
      ? 'No changes detected since last review.'
      : 'No changes detected compared to trunk branch.';
    log(chalk.yellow(nothingMessage));
    noChangesDetected = true;
  } else {
    const changedFilesMessage = incrementalOptions.incremental
      ? `Found ${diffResult.changedFiles.length} changed files since last review`
      : `Found ${diffResult.changedFiles.length} changed files`;
    log(chalk.cyan(changedFilesMessage));
    log(chalk.gray(`Comparing against: ${diffResult.baseBranch}`));
  }

  return {
    resolvedPlanFile,
    planData,
    parentChain,
    completedChildren,
    diffResult,
    incrementalSummary,
    noChangesDetected,
  };
}
