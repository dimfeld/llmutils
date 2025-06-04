// Command handler for 'rmplan show'
// Displays detailed information about a plan

import * as path from 'path';
import chalk from 'chalk';
import { error, log } from '../../logging.js';
import { getGitRoot } from '../../rmfilter/utils.js';
import { loadEffectiveConfig } from '../configLoader.js';
import {
  resolvePlanFile,
  readPlanFile,
  readAllPlans,
  findNextPlan,
  isPlanReady,
} from '../plans.js';
import {
  getCombinedTitle,
  getCombinedGoal,
  getCombinedTitleFromSummary,
} from '../display_utils.js';

export async function handleShowCommand(planFile: string | undefined, options: any) {
  const globalOpts = options.parent.opts();

  try {
    const config = await loadEffectiveConfig(globalOpts.config);

    let resolvedPlanFile: string;

    if (options.next || options.current) {
      // Find the next ready plan or current plan
      const tasksDir = await resolveTasksDir(config);
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

      const message = options.current
        ? `Found current plan: ${plan.id}`
        : `Found next ready plan: ${plan.id}`;
      log(chalk.green(message));
      resolvedPlanFile = plan.filename;
    } else {
      if (!planFile) {
        error('Please provide a plan file or use --next/--current to find a plan');
        process.exit(1);
      }
      resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
    }

    // Read the plan file
    const plan = await readPlanFile(resolvedPlanFile);

    // Check if plan is ready (we'll need to load all plans to check dependencies)
    const tasksDir = await resolveTasksDir(config);
    const { plans: allPlans } = await readAllPlans(tasksDir);

    // Display basic information
    log(chalk.bold('\nPlan Information:'));
    log('─'.repeat(60));
    log(`${chalk.cyan('ID:')} ${plan.id || 'Not set'}`);
    log(`${chalk.cyan('Title:')} ${getCombinedTitle(plan)}`);

    // Display "ready" for pending plans whose dependencies are done
    const actualStatus = plan.status || 'pending';
    const isReady = plan.id
      ? isPlanReady(
          {
            id: plan.id,
            status: actualStatus,
            dependencies: plan.dependencies,
            goal: plan.goal,
            filename: resolvedPlanFile,
          },
          allPlans
        )
      : false;
    const statusDisplay = isReady ? 'ready' : actualStatus;
    const statusColor = isReady ? chalk.cyan : chalk.white;
    log(`${chalk.cyan('Status:')} ${statusColor(statusDisplay)}`);

    log(`${chalk.cyan('Priority:')} ${plan.priority || ''}`);
    log(`${chalk.cyan('Goal:')} ${getCombinedGoal(plan)}`);
    log(`${chalk.cyan('File:')} ${resolvedPlanFile}`);

    if (plan.baseBranch) {
      log(`${chalk.cyan('Base Branch:')} ${plan.baseBranch}`);
    }

    if (plan.createdAt) {
      log(`${chalk.cyan('Created:')} ${new Date(plan.createdAt).toLocaleString()}`);
    }

    if (plan.updatedAt) {
      log(`${chalk.cyan('Updated:')} ${new Date(plan.updatedAt).toLocaleString()}`);
    }

    // Display dependencies with resolution
    if (plan.dependencies && plan.dependencies.length > 0) {
      log('\n' + chalk.bold('Dependencies:'));
      log('─'.repeat(60));

      for (const depId of plan.dependencies) {
        const depPlan = allPlans.get(depId);
        if (depPlan) {
          const statusIcon =
            depPlan.status === 'done' ? '✓' : depPlan.status === 'in_progress' ? '⏳' : '○';
          const statusColor =
            depPlan.status === 'done'
              ? chalk.green
              : depPlan.status === 'in_progress'
                ? chalk.yellow
                : chalk.gray;
          log(
            `  ${statusIcon} ${chalk.cyan(depId)} - ${getCombinedTitleFromSummary(depPlan)} ${statusColor(`[${depPlan.status || 'pending'}]`)}`
          );
        } else {
          log(`  ○ ${chalk.cyan(depId)} ${chalk.red('[Not found]')}`);
        }
      }
    }

    // Display issues and PRs
    if (plan.issue && plan.issue.length > 0) {
      log('\n' + chalk.bold('Issues:'));
      log('─'.repeat(60));
      plan.issue.forEach((url) => log(`  • ${url}`));
    }

    if (plan.pullRequest && plan.pullRequest.length > 0) {
      log('\n' + chalk.bold('Pull Requests:'));
      log('─'.repeat(60));
      plan.pullRequest.forEach((url) => log(`  • ${url}`));
    }

    // Display details
    if (plan.details) {
      log('\n' + chalk.bold('Details:'));
      log('─'.repeat(60));
      log(plan.details);
    }

    // Display tasks with completion status
    if (plan.tasks && plan.tasks.length > 0) {
      log('\n' + chalk.bold('Tasks:'));
      log('─'.repeat(60));

      plan.tasks.forEach((task, taskIdx) => {
        const totalSteps = task.steps.length;
        const doneSteps = task.steps.filter((s) => s.done).length;
        const taskComplete = totalSteps > 0 && doneSteps === totalSteps;
        const taskIcon = taskComplete ? '✓' : totalSteps > 0 && doneSteps > 0 ? '⏳' : '○';
        const taskColor = taskComplete
          ? chalk.green
          : totalSteps > 0 && doneSteps > 0
            ? chalk.yellow
            : chalk.white;

        log(`\n${taskIcon} ${chalk.bold(`Task ${taskIdx + 1}:`)} ${taskColor(task.title)}`);
        if (totalSteps > 0) {
          log(`  Progress: ${doneSteps}/${totalSteps} steps completed`);
        }
        log(`  ${chalk.gray(task.description)}`);

        if (task.files && task.files.length > 0) {
          log(`  Files: ${task.files.join(', ')}`);
        }

        if (task.steps && task.steps.length > 0) {
          log('  Steps:');
          task.steps.forEach((step, stepIdx) => {
            const stepIcon = step.done ? '✓' : '○';
            const stepColor = step.done ? chalk.green : chalk.gray;
            const prompt = step.prompt.split('\n')[0];
            const truncated = prompt.length > 60 ? prompt.substring(0, 60) + '...' : prompt;
            log(`    ${stepIcon} ${stepColor(`Step ${stepIdx + 1}: ${truncated}`)}`);
          });
        }
      });
    }

    // Display rmfilter args if present
    if (plan.rmfilter && plan.rmfilter.length > 0) {
      log('\n' + chalk.bold('RmFilter Arguments:'));
      log('─'.repeat(60));
      log(`  ${plan.rmfilter.join(' ')}`);
    }

    // Display changed files if present
    if (plan.changedFiles && plan.changedFiles.length > 0) {
      log('\n' + chalk.bold('Changed Files:'));
      log('─'.repeat(60));
      plan.changedFiles.forEach((file) => log(`  • ${file}`));
    }

    log('');
  } catch (err) {
    error(`Failed to show plan: ${err as Error}`);
    process.exit(1);
  }
}

/**
 * Resolves the tasks directory path, handling both absolute and relative paths.
 * If tasks path is relative, it's resolved relative to the git root.
 */
async function resolveTasksDir(config: any): Promise<string> {
  const gitRoot = (await getGitRoot()) || process.cwd();

  if (config.paths?.tasks) {
    return path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  }

  return gitRoot;
}
