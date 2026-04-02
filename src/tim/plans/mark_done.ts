import chalk from 'chalk';
import path from 'node:path';
import {
  getChangedFilesOnBranch,
  getGitRoot,
  type GetChangedFilesOptions,
} from '../../common/git.js';
import { commitAll } from '../../common/process.js';
import { boldMarkdownHeaders, log, warn } from '../../logging.js';
import type { TimConfig } from '../configSchema.js';
import { resolvePlanFromDbOrSyncFile } from '../ensure_plan_in_db.js';
import {
  resolveProjectContext,
  withPlanAutoSync,
  type ProjectContext,
} from '../plan_materialize.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { resolvePlanFromDb, writePlanFile } from '../plans.js';
import { checkAndMarkParentDone as checkAndMarkParentDoneShared } from './parent_cascade.js';
import type { PlanSchema } from '../planSchema.js';
import { type PendingTaskResult, findPendingTask, findNextActionableItem } from './find_next.js';
import { removePlanAssignment } from '../assignments/remove_plan_assignment.js';
import { resolveWritablePath } from './resolve_writable_path.js';
import { getCompletionStatus, isWorkComplete } from './plan_state_utils.js';

type MarkDoneResult = {
  planComplete: boolean;
  message: string;
  status?: PlanSchema['status'];
};

export async function markStepDone(
  planArg: string,
  options: { commit?: boolean },
  currentTask?: { taskIndex: number },
  baseDir?: string,
  config?: TimConfig,
  configPath?: string
): Promise<MarkDoneResult> {
  const repoRoot = await resolveRepoRootForPlanArg(
    planArg,
    (await getGitRoot(baseDir)) || baseDir,
    configPath
  );
  const initialPlan = await resolvePlanFromDbOrSyncFile(planArg, repoRoot, repoRoot);
  const resolvedPlanArg = initialPlan.plan.uuid ?? planArg;

  return withPlanAutoSync(initialPlan.plan.id, repoRoot, async () => {
    const context = await resolveProjectContext(repoRoot);
    const target = await resolvePlanFromDb(resolvedPlanArg, repoRoot, { context });
    const planData = target.plan;
    const outputPath = await resolveWritablePathForPlan(
      planArg,
      context,
      planData.id,
      config,
      repoRoot
    );

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

    if (!pending) {
      if (shouldFinalizeCompletedPlan(planData)) {
        const message = await finalizeTaskMutation(
          planData,
          outputPath,
          repoRoot,
          options,
          config,
          ['All tasks in the plan are already done.']
        );
        return {
          planComplete: isWorkComplete(planData),
          message,
          status: planData.status,
        };
      }

      return {
        planComplete: true,
        message: 'All tasks in the plan are already done.',
        status: planData.status,
      };
    }

    const { task } = pending;
    task.done = true;
    log(chalk.bold(`Marked task done\n`));

    const message = await finalizeTaskMutation(planData, outputPath, repoRoot, options, config, [
      task.title,
      ...(task.description ? [`\n${task.description}`] : []),
    ]);
    return {
      planComplete: isWorkComplete(planData),
      message,
      status: planData.status,
    };
  });
}

export async function markTaskDone(
  planArg: string,
  taskIndex: number,
  options: { commit?: boolean } = {},
  baseDir?: string,
  config?: TimConfig,
  configPath?: string
): Promise<MarkDoneResult> {
  const repoRoot = await resolveRepoRootForPlanArg(
    planArg,
    (await getGitRoot(baseDir)) || baseDir,
    configPath
  );
  const initialPlan = await resolvePlanFromDbOrSyncFile(planArg, repoRoot, repoRoot);
  const resolvedPlanArg = initialPlan.plan.uuid ?? planArg;

  return withPlanAutoSync(initialPlan.plan.id, repoRoot, async () => {
    const context = await resolveProjectContext(repoRoot);
    const target = await resolvePlanFromDb(resolvedPlanArg, repoRoot, { context });
    const planData = target.plan;
    const outputPath = await resolveWritablePathForPlan(
      planArg,
      context,
      planData.id,
      config,
      repoRoot
    );

    if (taskIndex < 0 || taskIndex >= planData.tasks.length) {
      throw new Error(`Invalid task index: ${taskIndex}. Plan has ${planData.tasks.length} tasks.`);
    }

    const task = planData.tasks[taskIndex];
    if (task.done) {
      if (shouldFinalizeCompletedPlan(planData)) {
        const message = await finalizeTaskMutation(
          planData,
          outputPath,
          repoRoot,
          options,
          config,
          [task.title, ...(task.description ? [`\n${task.description}`] : [])]
        );
        return {
          planComplete: isWorkComplete(planData),
          message,
          status: planData.status,
        };
      }

      return {
        planComplete: false,
        message: `Task "${task.title}" is already marked as done.`,
        status: planData.status,
      };
    }

    task.done = true;
    log(chalk.bold(`Marked task "${task.title}" as done\n`));

    const message = await finalizeTaskMutation(planData, outputPath, repoRoot, options, config, [
      task.title,
      ...(task.description ? [`\n${task.description}`] : []),
    ]);
    return {
      planComplete: isWorkComplete(planData),
      message,
      status: planData.status,
    };
  });
}

export async function setTaskDone(
  planArg: string,
  options: { taskIdentifier: string | number; commit?: boolean },
  baseDir?: string,
  config?: TimConfig,
  configPath?: string
): Promise<MarkDoneResult> {
  const repoRoot = await resolveRepoRootForPlanArg(
    planArg,
    (await getGitRoot(baseDir)) || baseDir,
    configPath
  );
  const initialPlan = await resolvePlanFromDbOrSyncFile(planArg, repoRoot, repoRoot);
  const resolvedPlanArg = initialPlan.plan.uuid ?? planArg;

  return withPlanAutoSync(initialPlan.plan.id, repoRoot, async () => {
    const context = await resolveProjectContext(repoRoot);
    const target = await resolvePlanFromDb(resolvedPlanArg, repoRoot, { context });
    const planData = target.plan;
    const outputPath = await resolveWritablePathForPlan(
      planArg,
      context,
      planData.id,
      config,
      repoRoot
    );

    let taskIndex = -1;
    let task: PlanSchema['tasks'][0] | undefined;

    if (typeof options.taskIdentifier === 'string') {
      taskIndex = planData.tasks.findIndex(
        (candidate) => candidate.title === options.taskIdentifier
      );
      if (taskIndex === -1) {
        const prefixMatches: { index: number; title: string }[] = [];
        for (let i = 0; i < planData.tasks.length; i++) {
          if (planData.tasks[i].title.startsWith(options.taskIdentifier)) {
            prefixMatches.push({ index: i, title: planData.tasks[i].title });
          }
        }

        if (prefixMatches.length === 1) {
          taskIndex = prefixMatches[0].index;
        } else if (prefixMatches.length > 1) {
          const matchList = prefixMatches.map((match) => `  - "${match.title}"`).join('\n');
          throw new Error(
            `Multiple tasks match prefix "${options.taskIdentifier}":\n${matchList}\nPlease provide a more specific title.`
          );
        } else {
          throw new Error(`Task with title "${options.taskIdentifier}" not found in plan`);
        }
      }
      task = planData.tasks[taskIndex];
    } else {
      if (options.taskIdentifier < 0 || options.taskIdentifier > planData.tasks.length - 1) {
        throw new Error(
          `Invalid task index: ${options.taskIdentifier}. Plan has ${planData.tasks.length} tasks (use 0-${planData.tasks.length - 1})`
        );
      }
      taskIndex = options.taskIdentifier;
      task = planData.tasks[taskIndex];
    }

    if (task.done) {
      if (shouldFinalizeCompletedPlan(planData)) {
        const message = await finalizeTaskMutation(
          planData,
          outputPath,
          repoRoot,
          options,
          config,
          [task.title, ...(task.description ? [`\n${task.description}`] : [])]
        );
        return {
          planComplete: isWorkComplete(planData),
          message,
          status: planData.status,
        };
      }

      return {
        planComplete: false,
        message: `Task "${task.title}" is already marked as done.`,
        status: planData.status,
      };
    }

    task.done = true;
    log(chalk.bold(`Marked task "${task.title}" as done\n`));

    const message = await finalizeTaskMutation(planData, outputPath, repoRoot, options, config, [
      task.title,
      ...(task.description ? [`\n${task.description}`] : []),
    ]);
    return {
      planComplete: isWorkComplete(planData),
      message,
      status: planData.status,
    };
  });
}

function shouldFinalizeCompletedPlan(planData: PlanSchema): boolean {
  return !findNextActionableItem(planData) && !isWorkComplete(planData);
}

async function finalizeTaskMutation(
  planData: PlanSchema,
  outputPath: string | null,
  repoRoot: string,
  options: { commit?: boolean },
  config: TimConfig | undefined,
  output: string[]
): Promise<string> {
  planData.updatedAt = new Date().toISOString();

  try {
    const gitOptions: GetChangedFilesOptions = {
      baseBranch: planData.baseBranch,
    };
    const changedFiles = await getChangedFilesOnBranch(repoRoot, gitOptions);
    if (changedFiles.length > 0) {
      planData.changedFiles = changedFiles;
    }
  } catch (err) {
    warn(`Failed to get changed files: ${err instanceof Error ? err.message : String(err)}`);
  }

  const stillPending = findNextActionableItem(planData);
  const planComplete = !stillPending;
  if (planComplete) {
    planData.status = getCompletionStatus(config ?? {});
  }

  await writePlanFile(outputPath, planData, { cwdForIdentity: repoRoot });

  if (planData.status === 'done') {
    await removePlanAssignment(planData, repoRoot);
  }

  const message = output.join('\n');
  log(boldMarkdownHeaders(message));
  if (options.commit) {
    log('');
    await commitAll(message, repoRoot);
  }

  if (planComplete && planData.parent && config) {
    try {
      const parentPlan = await checkAndMarkParentDone(planData.parent, config, repoRoot);
      if (
        parentPlan &&
        (parentPlan.status === 'done' || parentPlan.status === 'needs_review') &&
        options.commit
      ) {
        const title = parentPlan.title ? ` "${parentPlan.title}"` : '';
        await commitAll(
          `Mark plan${title} as ${parentPlan.status} (ID: ${parentPlan.id})`,
          repoRoot
        );
      }
    } catch (err) {
      warn(`Failed to check parent plan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return message;
}

async function checkAndMarkParentDone(
  parentId: number,
  config: TimConfig,
  baseDir?: string
): Promise<PlanSchema | undefined> {
  return checkAndMarkParentDoneShared(parentId, config, {
    baseDir,
    onParentMarkedDone(parentPlan) {
      log(
        chalk.green(`✓ Parent plan "${parentPlan.title}" marked as complete (all children done)`)
      );
    },
  });
}

async function resolveWritablePathForPlan(
  planArg: string,
  context: ProjectContext,
  planId: number,
  config: TimConfig | undefined,
  repoRoot: string
): Promise<string | null> {
  const row = context.rows.find((candidate) => candidate.plan_id === planId);
  return resolveWritablePath(planArg, row, repoRoot, repoRoot);
}
