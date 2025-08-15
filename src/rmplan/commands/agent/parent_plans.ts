import chalk from 'chalk';
import { debugLog, log, warn } from '../../../logging.js';
import { resolveTasksDir, type RmplanConfig } from '../../configSchema.js';
import { clearPlanCache, readAllPlans, writePlanFile } from '../../plans.js';

/**
 * Marks a parent plan as in_progress if it's currently pending.
 * Recursively marks all ancestor plans as in_progress as well.
 */
export async function markParentInProgress(parentId: number, config: RmplanConfig): Promise<void> {
  const tasksDir = await resolveTasksDir(config);
  // Force re-read to get updated statuses
  clearPlanCache();
  const { plans: allPlans } = await readAllPlans(tasksDir);

  // Get the parent plan
  const parentPlan = allPlans.get(parentId);
  if (!parentPlan) {
    warn(`Parent plan with ID ${parentId} not found`);
    return;
  }

  // Only update if parent is still pending
  if (parentPlan.status === 'pending') {
    parentPlan.status = 'in_progress';
    parentPlan.updatedAt = new Date().toISOString();
    await writePlanFile(parentPlan.filename, parentPlan);
    log(chalk.yellow(`↻ Parent plan "${parentPlan.title}" marked as in_progress`));

    // Recursively mark parent's parent if it exists
    if (parentPlan.parent) {
      await markParentInProgress(parentPlan.parent, config);
    }
  }
}

/**
 * Checks if a parent plan's children are all complete and marks the parent as done if so.
 * This function is duplicated here to avoid circular dependencies with actions.ts
 */
export async function checkAndMarkParentDone(
  parentId: number,
  config: RmplanConfig,
  baseDir?: string
): Promise<void> {
  const tasksDir = await resolveTasksDir(config);
  // Force re-read to get updated statuses
  clearPlanCache();
  const { plans: allPlans } = await readAllPlans(tasksDir);

  // Get the parent plan
  const parentPlan = allPlans.get(parentId);
  if (!parentPlan) {
    warn(`Parent plan with ID ${parentId} not found`);
    return;
  }

  // If parent is already done, nothing to do
  if (parentPlan.status === 'done') {
    return;
  }

  // Find all children of this parent
  const children = Array.from(allPlans.values()).filter((plan) => plan.parent === parentId);

  // Check if all children are done
  const allChildrenDone = children.every((child) => child.status === 'done');

  if (allChildrenDone && children.length > 0) {
    // Mark parent as done
    parentPlan.status = 'done';
    parentPlan.updatedAt = new Date().toISOString();

    // Update changed files from children
    const allChangedFiles = new Set<string>();
    for (const child of children) {
      if (child.changedFiles) {
        child.changedFiles.forEach((file) => allChangedFiles.add(file));
      }
    }
    if (allChangedFiles.size > 0) {
      parentPlan.changedFiles = Array.from(allChangedFiles).sort();
    }

    await writePlanFile(parentPlan.filename, parentPlan);
    log(chalk.green(`✓ Parent plan "${parentPlan.title}" marked as complete (all children done)`));

    // Recursively check if this parent has a parent
    if (parentPlan.parent) {
      await checkAndMarkParentDone(parentPlan.parent, config, baseDir);
    }
  }
}
