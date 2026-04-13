import chalk from 'chalk';
import { editor } from '@inquirer/prompts';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveProjectContext, withPlanAutoSync } from '../plan_materialize.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { parsePlanIdFromCliArg, resolvePlanFromDb, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { promptForTaskInfo, type TaskInput } from '../utils/task_operations.js';
import type { PlanRow } from '../db/plan.js';
import { resolveWritablePath } from '../plans/resolve_writable_path.js';

export interface AddTaskOptions {
  title?: string;
  description?: string;
  editor?: boolean;
  interactive?: boolean;
}

type PlanTask = NonNullable<PlanSchema['tasks']>[number];

export async function handleAddTaskCommand(
  plan: string,
  options: AddTaskOptions,
  command: any
): Promise<void> {
  const planIdArg = String(parsePlanIdFromCliArg(plan));
  const globalOpts = command.parent?.opts?.() ?? {};
  const config = await loadEffectiveConfig(globalOpts.config);
  const repoRoot = await resolveRepoRoot(globalOpts.config);
  const initialPlan = await resolvePlanFromDb(planIdArg, repoRoot);
  const resolvedPlanArg = initialPlan.plan.uuid ?? planIdArg;

  const taskInfo = await collectTaskInput(options);
  await withPlanAutoSync(initialPlan.plan.id, repoRoot, async () => {
    const context = await resolveProjectContext(repoRoot);
    const target = await resolvePlanFromDb(resolvedPlanArg, repoRoot, { context });
    const planRow = getRequiredPlanRow(context.rows, target.plan.id);
    const planPath = await resolveWritablePath(planRow, repoRoot);
    const tasks = Array.isArray(target.plan.tasks) ? target.plan.tasks : [];
    const newTask: PlanTask = {
      title: taskInfo.title,
      description: taskInfo.description,
      done: false,
    };

    tasks.push(newTask);
    target.plan.tasks = tasks;
    target.plan.updatedAt = new Date().toISOString();

    await writePlanFile(planPath, target.plan, { cwdForIdentity: repoRoot, context });

    const index = tasks.length - 1;
    const planIdentifier = target.plan.id ? `plan ${target.plan.id}` : 'plan';
    log(
      chalk.green(
        `✓ Added task "${newTask.title}" at index ${index} to ${planIdentifier}${planPath ? ` (${planPath})` : ''}`
      )
    );
  });
}

async function collectTaskInput(options: AddTaskOptions): Promise<TaskInput> {
  if (options.interactive) {
    try {
      return await promptForTaskInfo({
        title: options.title,
        description: options.description,
      });
    } catch (err: any) {
      if (err instanceof Error && err.name === 'ExitPromptError') {
        throw new Error('Interactive task creation cancelled.');
      }
      throw err;
    }
  }

  const title = options.title?.trim();
  if (!title) {
    throw new Error('Task title is required unless using --interactive.');
  }

  let description = options.description ?? '';
  if (options.editor) {
    try {
      description = await editor({
        message: 'Task description (opens editor):',
        default: options.description ?? '',
      });
    } catch (err: any) {
      if (err instanceof Error && err.name === 'ExitPromptError') {
        throw new Error('Task description editor cancelled.');
      }
      throw err;
    }
  }

  if (!description.trim()) {
    throw new Error(
      'Task description is required unless using --interactive or providing one via --editor.'
    );
  }

  return {
    title: title.trim(),
    description: description.trim(),
  };
}

function getRequiredPlanRow(rows: PlanRow[], planId: number): PlanRow {
  const row = rows.find((candidate) => candidate.plan_id === planId);
  if (!row) {
    throw new Error(`Plan ${planId} not found`);
  }
  return row;
}
