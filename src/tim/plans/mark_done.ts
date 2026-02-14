import chalk from 'chalk';
import path from 'path';
import {
  getChangedFilesOnBranch,
  getGitRoot,
  type GetChangedFilesOptions,
} from '../../common/git.js';
import { commitAll } from '../../common/process.js';
import { boldMarkdownHeaders, log, warn } from '../../logging.js';
import { resolveTasksDir, type TimConfig } from '../configSchema.js';
import { resolveConfiguredTasksPath } from '../path_resolver.js';
import { clearPlanCache, readAllPlans, readPlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { type PendingTaskResult, findPendingTask, findNextActionableItem } from './find_next.js';
import { removePlanAssignment } from '../assignments/remove_plan_assignment.js';

/**
 * Marks a task as completed in a plan file and updates plan metadata.
 * This function integrates with the refactored common utilities for Git operations
 * and uses src/common/process.ts for commit operations when requested.
 *
 * The function handles:
 * - Updating task completion status in the plan file
 * - Refreshing plan metadata including timestamps and changed files
 * - Determining if the entire plan is now complete
 * - Optionally committing changes using the appropriate VCS (Git/Jujutsu)
 * - Providing formatted output for user feedback
 *
 * @param planFile - Path or ID of the plan file to update
 * @param options - Configuration for whether to commit
 * @param currentTask - Optional specific task index to mark (overrides automatic detection)
 * @param baseDir - Optional base directory for Git operations
 * @param config - Optional TimConfig for path configuration
 * @returns Promise resolving to completion status and user-facing message
 * @throws {Error} When plan file cannot be loaded/written or Git operations fail
 */
export async function markStepDone(
  planFile: string,
  options: { commit?: boolean },
  currentTask?: { taskIndex: number },
  baseDir?: string,
  config?: TimConfig
): Promise<{ planComplete: boolean; message: string }> {
  // 1. Load and parse the plan file
  let planData = await readPlanFile(planFile);

  // 2. Find the starting point
  let pending: PendingTaskResult | null = null;
  if (currentTask) {
    const { taskIndex } = currentTask;
    if (taskIndex >= 0 && taskIndex < planData.tasks.length) {
      pending = {
        taskIndex,
        task: planData.tasks[taskIndex],
      };
    } else {
      throw new Error('Invalid currentTask index');
    }
  } else {
    pending = findPendingTask(planData);
  }

  // 3. Handle no pending tasks
  if (!pending) {
    return { planComplete: true, message: 'All tasks in the plan are already done.' };
  }

  let output: string[] = [];
  // 4. Mark task as done
  const { task } = pending;
  task.done = true;
  log(chalk.bold(`Marked task done\n`));
  output.push(task.title);
  if (task.description) {
    output.push(`\n${task.description}`);
  }

  // 5. Update metadata fields
  const gitRoot = (await getGitRoot(baseDir)) || process.cwd();
  const tasksPath = config ? resolveConfiguredTasksPath(config, gitRoot) : undefined;

  // Always update the updatedAt timestamp
  planData.updatedAt = new Date().toISOString();

  // Update changedFiles by comparing against baseBranch (or main/master if not set)
  try {
    // Build exclude paths from config
    const excludePaths: string[] = [];
    if (tasksPath) {
      const relativeTasksPath = path.relative(gitRoot, tasksPath);
      if (
        relativeTasksPath &&
        !relativeTasksPath.startsWith('..') &&
        !path.isAbsolute(relativeTasksPath)
      ) {
        excludePaths.push(relativeTasksPath);
      }
    }

    const options: GetChangedFilesOptions = {
      baseBranch: planData.baseBranch,
      excludePaths,
    };

    const changedFiles = await getChangedFilesOnBranch(gitRoot, options);
    if (changedFiles.length > 0) {
      planData.changedFiles = changedFiles;
    }
  } catch (err) {
    // Log but don't fail if we can't get changed files
    warn(`Failed to get changed files: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check if plan is now complete
  const stillPending = findNextActionableItem(planData);
  const planComplete = !stillPending;

  // If plan is complete, update status to 'done'
  if (planComplete) {
    planData.status = 'done';
  }

  // 6. Write updated plan back
  await writePlanFile(planFile, planData);

  if (planComplete) {
    await removePlanAssignment(planData, baseDir);
  }

  // 7. Optionally commit
  const message = output.join('\n');
  log(boldMarkdownHeaders(message));
  if (options.commit) {
    log('');
    await commitAll(message, baseDir);
  }

  // 8. Check if parent plan should be marked done
  if (planComplete && planData.parent && config) {
    try {
      const parentPlan = await checkAndMarkParentDone(planData.parent, config, baseDir);

      if (parentPlan && parentPlan.status === 'done' && options.commit) {
        const title = parentPlan.title ? ` "${parentPlan.title}"` : '';
        await commitAll(`Mark plan${title} as done (ID: ${parentPlan.id})`, baseDir);
      }
    } catch (err) {
      // Log but don't fail the operation
      warn(`Failed to check parent plan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 9. Return result
  return { planComplete, message };
}

/**
 * Marks a simple task (without steps) as completed in a plan file and updates plan metadata.
 * This function handles task-level completion for tasks that have no steps, integrating with
 * the refactored common utilities for Git operations and commit functionality.
 *
 * The function handles:
 * - Updating task completion status (done flag) in the plan file
 * - Refreshing plan metadata including timestamps and changed files
 * - Determining if the entire plan is now complete
 * - Optionally committing changes using the appropriate VCS (Git/Jujutsu)
 * - Providing formatted output for user feedback
 *
 * @param planFile - Path or ID of the plan file to update
 * @param taskIndex - Index of the task to mark as done
 * @param options - Configuration options including whether to commit
 * @param baseDir - Optional base directory for Git operations
 * @param config - Optional TimConfig for path configuration
 * @returns Promise resolving to completion status and user-facing message
 * @throws {Error} When plan file cannot be loaded/written or task index is invalid
 */
export async function markTaskDone(
  planFile: string,
  taskIndex: number,
  options: { commit?: boolean } = {},
  baseDir?: string,
  config?: TimConfig
): Promise<{ planComplete: boolean; message: string }> {
  // 1. Load and parse the plan file
  let planData = await readPlanFile(planFile);

  // 2. Validate task index
  if (taskIndex < 0 || taskIndex >= planData.tasks.length) {
    throw new Error(`Invalid task index: ${taskIndex}. Plan has ${planData.tasks.length} tasks.`);
  }

  const task = planData.tasks[taskIndex];

  // 3. Check if task is already done
  if (task.done) {
    return { planComplete: false, message: `Task "${task.title}" is already marked as done.` };
  }

  // 4. Mark task as done
  task.done = true;
  log(chalk.bold(`Marked task "${task.title}" as done\n`));

  // 5. Build output message
  let output: string[] = [];
  output.push(`${task.title}`);
  if (task.description) {
    output.push(`\n${task.description}`);
  }

  // 6. Update metadata fields
  const gitRoot = (await getGitRoot(baseDir)) || process.cwd();
  const tasksPath = config ? resolveConfiguredTasksPath(config, gitRoot) : undefined;

  // Always update the updatedAt timestamp
  planData.updatedAt = new Date().toISOString();

  // Update changedFiles by comparing against baseBranch (or main/master if not set)
  try {
    // Build exclude paths from config
    const excludePaths: string[] = [];
    if (tasksPath) {
      const relativeTasksPath = path.relative(gitRoot, tasksPath);
      if (
        relativeTasksPath &&
        !relativeTasksPath.startsWith('..') &&
        !path.isAbsolute(relativeTasksPath)
      ) {
        excludePaths.push(relativeTasksPath);
      }
    }

    const options: GetChangedFilesOptions = {
      baseBranch: planData.baseBranch,
      excludePaths,
    };

    const changedFiles = await getChangedFilesOnBranch(gitRoot, options);
    if (changedFiles.length > 0) {
      planData.changedFiles = changedFiles;
    }
  } catch (err) {
    // Log but don't fail if we can't get changed files
    warn(`Failed to get changed files: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check if plan is now complete
  const stillPending = findNextActionableItem(planData);
  const planComplete = !stillPending;

  // If plan is complete, update status to 'done'
  if (planComplete) {
    planData.status = 'done';
  }

  // 7. Write updated plan back
  await writePlanFile(planFile, planData);

  if (planComplete) {
    await removePlanAssignment(planData, baseDir);
  }

  // 8. Optionally commit
  const message = output.join('\n');
  log(boldMarkdownHeaders(message));
  if (options.commit) {
    log('');
    await commitAll(message, baseDir);
  }

  // 9. Check if parent plan should be marked done
  if (planComplete && planData.parent && config) {
    try {
      await checkAndMarkParentDone(planData.parent, config, baseDir);
    } catch (err) {
      // Log but don't fail the operation
      warn(`Failed to check parent plan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 10. Return result
  return { planComplete, message };
}

/**
 * Marks a specific task as done by title or index in a plan file and updates plan metadata.
 * This function handles task-level completion by task identifier, integrating with
 * the refactored common utilities for Git operations and commit functionality.
 *
 * The function handles:
 * - Finding tasks by title (exact match) or index (one-based)
 * - Updating task completion status
 * - Refreshing plan metadata including timestamps and changed files
 * - Determining if the entire plan is now complete
 * - Optionally committing changes using the appropriate VCS (Git/Jujutsu)
 * - Providing formatted output for user feedback
 *
 * @param planFile - Path or ID of the plan file to update
 * @param options - Configuration options including task identifier and whether to commit
 * @param baseDir - Optional base directory for Git operations
 * @param config - Optional TimConfig for path configuration
 * @returns Promise resolving to completion status and user-facing message
 * @throws {Error} When plan file cannot be loaded/written or task not found
 */
export async function setTaskDone(
  planFile: string,
  options: { taskIdentifier: string | number; commit?: boolean },
  baseDir?: string,
  config?: TimConfig
): Promise<{ planComplete: boolean; message: string }> {
  // 1. Load and parse the plan file
  let planData = await readPlanFile(planFile);

  // 2. Find the task by title or index
  let taskIndex: number = -1;
  let task: PlanSchema['tasks'][0] | undefined;

  if (typeof options.taskIdentifier === 'string') {
    // Find by title (exact match first)
    taskIndex = planData.tasks.findIndex((t) => t.title === options.taskIdentifier);

    // If no exact match, try prefix matching
    if (taskIndex === -1) {
      const prefixMatches: { index: number; title: string }[] = [];
      for (let i = 0; i < planData.tasks.length; i++) {
        if (planData.tasks[i].title.startsWith(options.taskIdentifier)) {
          prefixMatches.push({ index: i, title: planData.tasks[i].title });
        }
      }

      if (prefixMatches.length === 1) {
        // Exactly one prefix match, use it
        taskIndex = prefixMatches[0].index;
      } else if (prefixMatches.length > 1) {
        // Multiple prefix matches, error with list
        const matchList = prefixMatches.map((m) => `  - "${m.title}"`).join('\n');
        throw new Error(
          `Multiple tasks match prefix "${options.taskIdentifier}":\n${matchList}\nPlease provide a more specific title.`
        );
      } else {
        // No matches at all
        throw new Error(`Task with title "${options.taskIdentifier}" not found in plan`);
      }
    }
    task = planData.tasks[taskIndex];
  } else {
    // Find by index (zero-based)
    const userIndex = options.taskIdentifier;
    if (userIndex < 0 || userIndex > planData.tasks.length - 1) {
      throw new Error(
        `Invalid task index: ${userIndex}. Plan has ${planData.tasks.length} tasks (use 0-${planData.tasks.length - 1})`
      );
    }
    taskIndex = userIndex;
    task = planData.tasks[taskIndex];
  }

  // 3. Check if task is already done
  if (task.done) {
    return { planComplete: false, message: `Task "${task.title}" is already marked as done.` };
  }

  // 4. Mark task as done
  task.done = true;
  log(chalk.bold(`Marked task "${task.title}" as done\n`));

  // 5. Build output message
  let output: string[] = [];
  output.push(`${task.title}`);
  if (task.description) {
    output.push(`\n${task.description}`);
  }

  // 6. Update metadata fields
  const gitRoot = (await getGitRoot(baseDir)) || process.cwd();
  const tasksPath = config ? resolveConfiguredTasksPath(config, gitRoot) : undefined;

  // Always update the updatedAt timestamp
  planData.updatedAt = new Date().toISOString();

  // Update changedFiles by comparing against baseBranch (or main/master if not set)
  try {
    // Build exclude paths from config
    const excludePaths: string[] = [];
    if (tasksPath) {
      const relativeTasksPath = path.relative(gitRoot, tasksPath);
      if (
        relativeTasksPath &&
        !relativeTasksPath.startsWith('..') &&
        !path.isAbsolute(relativeTasksPath)
      ) {
        excludePaths.push(relativeTasksPath);
      }
    }

    const options: GetChangedFilesOptions = {
      baseBranch: planData.baseBranch,
      excludePaths,
    };

    const changedFiles = await getChangedFilesOnBranch(gitRoot, options);
    if (changedFiles.length > 0) {
      planData.changedFiles = changedFiles;
    }
  } catch (err) {
    // Log but don't fail if we can't get changed files
    warn(`Failed to get changed files: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check if plan is now complete
  const stillPending = findNextActionableItem(planData);
  const planComplete = !stillPending;

  // If plan is complete, update status to 'done'
  if (planComplete) {
    planData.status = 'done';
  }

  // 7. Write updated plan back
  await writePlanFile(planFile, planData);

  if (planComplete) {
    await removePlanAssignment(planData, baseDir);
  }

  // 8. Optionally commit
  const message = output.join('\n');
  log(boldMarkdownHeaders(message));
  if (options.commit) {
    log('');
    await commitAll(message, baseDir);
  }

  // 9. Check if parent plan should be marked done
  if (planComplete && planData.parent && config) {
    try {
      await checkAndMarkParentDone(planData.parent, config, baseDir);
    } catch (err) {
      // Log but don't fail the operation
      warn(`Failed to check parent plan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 10. Return result
  return { planComplete, message };
}

/**
 * Checks if a parent plan's children are all complete and marks the parent as done if so.
 * This function is called after marking a child plan as complete to propagate completion
 * status up the plan hierarchy.
 *
 * @param parentId - ID of the parent plan to check
 * @param config - TimConfig for accessing paths and configuration
 * @param baseDir - Optional base directory for operations
 * @returns Promise that resolves when check is complete
 */
async function checkAndMarkParentDone(
  parentId: number,
  config: TimConfig,
  baseDir?: string
): Promise<PlanSchema | undefined> {
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
    log(chalk.green(`✓ Parent plan "${parentPlan.title}" marked as complete (all children done)`));

    // Recursively check if this parent has a parent
    if (parentPlan.parent) {
      await checkAndMarkParentDone(parentPlan.parent, config, baseDir);
    }
  }

  return parentPlan;
}
