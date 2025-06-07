// Command handler for 'rmplan promote'
// Promotes tasks from a plan to new top-level plans

import * as path from 'node:path';
import { log } from '../../logging.js';
import { parseTaskIds } from '../utils/id_parser.js';
import { resolvePlanFile, readPlanFile, writePlanFile } from '../plans.js';
import { generateNumericPlanId } from '../id_utils.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot } from '../../common/git.js';
import type { PlanSchema } from '../planSchema.js';

export async function handlePromoteCommand(taskIds: string[], options: any) {
  if (taskIds.length === 0) {
    throw new Error('No task IDs provided');
  }

  // For now, handle only one task ID
  const taskId = taskIds[0];
  log(`Promoting task: ${taskId}`);

  // Parse the task ID
  const parsedTaskIds = parseTaskIds([taskId]);
  if (parsedTaskIds.length !== 1) {
    throw new Error('Expected exactly one task identifier');
  }

  const { planId, taskIndex } = parsedTaskIds[0];

  // Resolve the plan file path
  const originalPlanPath = await resolvePlanFile(planId, options.config);

  // Read the original plan
  const originalPlan = await readPlanFile(originalPlanPath);

  if (!originalPlan.tasks || originalPlan.tasks.length === 0) {
    throw new Error(`Plan ${planId} has no tasks to promote`);
  }

  if (taskIndex >= originalPlan.tasks.length) {
    throw new Error(
      `Task index ${taskIndex + 1} is out of range. Plan ${planId} has ${originalPlan.tasks.length} tasks`
    );
  }

  // Extract the task to be promoted
  const taskToPromote = originalPlan.tasks[taskIndex];

  // Get the tasks directory for generating the new plan ID
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

  // Generate a new numeric plan ID
  const newPlanId = await generateNumericPlanId(tasksDir);

  // Create the new plan
  const newPlan: PlanSchema = {
    id: newPlanId,
    goal: taskToPromote.title,
    details: taskToPromote.description,
    status: 'pending',
    tasks: [],
    dependencies: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Save the new plan
  const newPlanPath = path.join(tasksDir, `${newPlanId}.yml`);
  await writePlanFile(newPlanPath, newPlan);

  // Update the original plan: remove the promoted task and add dependency
  const updatedTasks = [...originalPlan.tasks];
  updatedTasks.splice(taskIndex, 1);

  const updatedDependencies = [...(originalPlan.dependencies || [])];
  updatedDependencies.push(newPlanId.toString());

  const updatedOriginalPlan: PlanSchema = {
    ...originalPlan,
    tasks: updatedTasks,
    dependencies: updatedDependencies,
    updatedAt: new Date().toISOString(),
  };

  // Write the updated original plan back
  await writePlanFile(originalPlanPath, updatedOriginalPlan);

  log(`Successfully promoted task "${taskToPromote.title}" to new plan ${newPlanId}`);
  log(`Created new plan file: ${newPlanPath}`);
  log(`Updated original plan ${planId} to depend on plan ${newPlanId}`);
}
