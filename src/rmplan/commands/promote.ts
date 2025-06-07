// Command handler for 'rmplan promote'
// Promotes tasks from a plan to new top-level plans

import * as path from 'node:path';
import { log } from '../../logging.js';
import { parseTaskIds } from '../utils/id_parser.js';
import { resolvePlanFile, readPlanFile, writePlanFile, clearPlanCache } from '../plans.js';
import { generateNumericPlanId } from '../id_utils.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot } from '../../common/git.js';
import type { PlanSchema } from '../planSchema.js';

export async function handlePromoteCommand(taskIds: string[], options: any) {
  if (taskIds.length === 0) {
    throw new Error('No task IDs provided');
  }

  log(`Promoting tasks: ${taskIds.join(', ')}`);

  // Parse all task IDs
  const parsedTaskIds = parseTaskIds(taskIds);
  if (parsedTaskIds.length === 0) {
    throw new Error('No valid task identifiers found');
  }

  // Group parsed task identifiers by planId
  const tasksByPlan = new Map<string, Array<{ taskIndex: number; planId: string }>>();
  for (const { planId, taskIndex } of parsedTaskIds) {
    if (!tasksByPlan.has(planId)) {
      tasksByPlan.set(planId, []);
    }
    tasksByPlan.get(planId)!.push({ taskIndex, planId });
  }

  // Get the tasks directory for generating new plan IDs
  const config = await loadEffectiveConfig(options.config);
  const gitRoot = (await getGitRoot()) || process.cwd();
  let tasksDir: string;
  if (config.paths?.tasks) {
    tasksDir = path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  } else {
    tasksDir = gitRoot;
  }

  // Process each plan group
  for (const [planId, taskInfo] of tasksByPlan) {
    // Sort task indices in ascending order to maintain proper indexing during removal
    const sortedTaskInfo = taskInfo.sort((a, b) => a.taskIndex - b.taskIndex);

    // Resolve the plan file path
    const originalPlanPath = await resolvePlanFile(planId, options.config);

    // Read the original plan
    const originalPlan = await readPlanFile(originalPlanPath);

    if (!originalPlan.tasks || originalPlan.tasks.length === 0) {
      throw new Error(`Plan ${planId} has no tasks to promote`);
    }

    // Validate all task indices
    for (const { taskIndex } of sortedTaskInfo) {
      if (taskIndex >= originalPlan.tasks.length) {
        throw new Error(
          `Task index ${taskIndex + 1} is out of range. Plan ${planId} has ${originalPlan.tasks.length} tasks`
        );
      }
    }

    // Create all new plans with chained dependencies, generating IDs sequentially
    const newPlans: PlanSchema[] = [];
    const newPlanIds: number[] = [];
    for (let i = 0; i < sortedTaskInfo.length; i++) {
      const { taskIndex } = sortedTaskInfo[i];
      const taskToPromote = originalPlan.tasks[taskIndex];

      // Generate new plan ID
      const newPlanId = await generateNumericPlanId(tasksDir);
      newPlanIds.push(newPlanId);

      // Add dependency on the previously created plan (except for the first one)
      const dependencies = i > 0 ? [newPlanIds[i - 1].toString()] : [];

      const newPlan: PlanSchema = {
        id: newPlanId,
        goal: taskToPromote.title,
        details: taskToPromote.description,
        status: 'pending',
        tasks: [],
        dependencies,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      newPlans.push(newPlan);

      // Save the new plan
      const newPlanPath = path.join(tasksDir, `${newPlanId}.yml`);
      await writePlanFile(newPlanPath, newPlan);

      // Clear cache so next generateNumericPlanId call gets updated max ID
      clearPlanCache();

      log(`Created new plan file: ${newPlanPath}`);
      log(`Successfully promoted task "${taskToPromote.title}" to new plan ${newPlanId}`);
    }

    // Update the original plan: remove all promoted tasks and add dependencies
    const updatedTasks = [...originalPlan.tasks];
    // Remove tasks in reverse order to maintain correct indices
    for (let i = sortedTaskInfo.length - 1; i >= 0; i--) {
      const { taskIndex } = sortedTaskInfo[i];
      updatedTasks.splice(taskIndex, 1);
    }

    const updatedDependencies = [...(originalPlan.dependencies || [])];
    // Add all new plan IDs to dependencies
    for (const newPlanId of newPlanIds) {
      updatedDependencies.push(newPlanId.toString());
    }

    const updatedOriginalPlan: PlanSchema = {
      ...originalPlan,
      tasks: updatedTasks,
      dependencies: updatedDependencies,
      updatedAt: new Date().toISOString(),
    };

    // Write the updated original plan back
    await writePlanFile(originalPlanPath, updatedOriginalPlan);

    log(`Updated original plan ${planId} to depend on plans ${newPlanIds.join(', ')}`);
  }
}
