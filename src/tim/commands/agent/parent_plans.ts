import { sendStructured, warn } from '../../../logging.js';
import { removePlanAssignment } from '../../assignments/remove_plan_assignment.js';
import { resolveTasksDir, type TimConfig } from '../../configSchema.js';
import { clearPlanCache, readAllPlans, writePlanFile } from '../../plans.js';
import { timestamp } from './agent_helpers.js';

/**
 * Marks a parent plan as in_progress if it's currently pending.
 * Recursively marks all ancestor plans as in_progress as well.
 */
export async function markParentInProgress(parentId: number, config: TimConfig): Promise<void> {
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
    sendStructured({
      type: 'workflow_progress',
      timestamp: timestamp(),
      phase: 'parent-plan-start',
      message: `Parent plan "${parentPlan.title}" marked as in_progress`,
    });

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
  config: TimConfig,
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

  // If parent is already complete, nothing to do
  if (parentPlan.status === 'done' || parentPlan.status === 'cancelled') {
    return;
  }

  // Find all children of this parent
  const children = Array.from(allPlans.values()).filter((plan) => plan.parent === parentId);

  // Check if all children are done
  const allChildrenDone = children.every(
    (child) => child.status === 'done' || child.status === 'cancelled'
  );

  if (allChildrenDone && children.length > 0 && parentPlan.epic) {
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
    await removePlanAssignment(parentPlan, baseDir);
    sendStructured({
      type: 'workflow_progress',
      timestamp: timestamp(),
      phase: 'parent-plan-complete',
      message: `Parent plan "${parentPlan.title}" marked as complete`,
    });

    // Recursively check if this parent has a parent
    if (parentPlan.parent) {
      await checkAndMarkParentDone(parentPlan.parent, config, baseDir);
    }
  }
}
