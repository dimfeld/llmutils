import chalk from 'chalk';
import { log, writeStdout } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { getCombinedTitle } from '../display_utils.js';
import { slugify } from '../id_utils.js';
import { findNextReadyDependency } from './find_next_dependency.js';
import { findMostRecentlyUpdatedPlan } from './prompts.js';
import { findNextPlan, readAllPlans, readPlanFile, resolvePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

type BranchCommandOptions = {
  next?: boolean;
  current?: boolean;
  nextReady?: string;
  latest?: boolean;
};

export function generateBranchNameFromPlan(plan: PlanSchema): string {
  const title = getCombinedTitle(plan) || plan.goal || 'plan';
  const slug = slugify(title);

  if (plan.id !== undefined && plan.id !== null) {
    return slug.length > 0 ? `task-${plan.id}-${slug}` : `task-${plan.id}`;
  }

  return slug.length > 0 ? `task-${slug}` : 'task-plan';
}

export async function handleBranchCommand(
  planFile: string | undefined,
  options: BranchCommandOptions,
  command: any
): Promise<void> {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const tasksDir = await resolveTasksDir(config);

  let resolvedPlanFile: string;
  let selectedPlan: PlanSchema | undefined;

  if (options.nextReady) {
    if (!options.nextReady || options.nextReady.trim() === '') {
      throw new Error('--next-ready requires a parent plan ID or file path');
    }

    let parentPlanId: number;
    const parsedId = Number.parseInt(options.nextReady, 10);
    if (!Number.isNaN(parsedId)) {
      parentPlanId = parsedId;
    } else {
      const resolvedInput = await resolvePlanFile(options.nextReady, globalOpts.config);
      const planFromFile = await readPlanFile(resolvedInput);
      if (!planFromFile.id || typeof planFromFile.id !== 'number') {
        throw new Error(`Plan file ${resolvedInput} does not have a valid numeric ID`);
      }
      parentPlanId = planFromFile.id;
    }

    const result = await findNextReadyDependency(parentPlanId, tasksDir, true);
    if (!result.plan) {
      log(result.message);
      return;
    }

    resolvedPlanFile = result.plan.filename;
    selectedPlan = result.plan;
  } else if (options.latest) {
    const { plans } = await readAllPlans(tasksDir);
    if (plans.size === 0) {
      log('No plans found in tasks directory.');
      return;
    }

    const latestPlan = await findMostRecentlyUpdatedPlan(plans);
    if (!latestPlan) {
      log('No plans with updatedAt field found in tasks directory.');
      return;
    }

    const title = getCombinedTitle(latestPlan);
    const label =
      latestPlan.id !== undefined && latestPlan.id !== null
        ? `${latestPlan.id} - ${title}`
        : title || latestPlan.filename;
    log(chalk.green(`Found latest plan: ${label}`));

    resolvedPlanFile = latestPlan.filename;
    selectedPlan = latestPlan;
  } else if (options.next || options.current) {
    const plan = await findNextPlan(tasksDir, {
      includePending: true,
      includeInProgress: options.current,
    });

    if (!plan) {
      if (options.current) {
        log('No current plans found. No plans are in progress or ready to be implemented.');
      } else {
        log('No ready plans found. All pending plans have incomplete dependencies.');
      }
      return;
    }

    resolvedPlanFile = plan.filename;
    selectedPlan = plan;
  } else {
    if (!planFile) {
      throw new Error(
        'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
      );
    }

    resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  }

  const plan = selectedPlan ?? (await readPlanFile(resolvedPlanFile));
  const branchName = generateBranchNameFromPlan(plan);
  writeStdout(`${branchName}\n`);
}
