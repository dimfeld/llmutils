import { commitAll } from '../../../common/process.js';
import { boldMarkdownHeaders, closeLogFile, error, log } from '../../../logging.js';
import { executePostApplyCommand } from '../../actions.js';
import { type RmplanConfig } from '../../configSchema.js';
import type { Executor } from '../../executors/types.js';
import { readPlanFile, setPlanStatus, writePlanFile } from '../../plans.js';
import { getAllIncompleteTasks } from '../../plans/find_next.js';
import { buildExecutionPromptWithoutSteps } from '../../prompt_builder.js';
import { checkAndMarkParentDone, markParentInProgress } from './parent_plans.js';

export async function executeBatchMode({
  currentPlanFile,
  config,
  executor,
  baseDir,
  dryRun = false,
}: {
  currentPlanFile: string;
  config: RmplanConfig;
  executor: Executor;
  baseDir: string;
  dryRun?: boolean;
}) {
  log('Starting batch mode execution:', currentPlanFile);
  try {
    let hasError = false;

    // Batch mode: continue until no incomplete tasks remain
    while (true) {
      // Read the current plan file to get updated state
      const planData = await readPlanFile(currentPlanFile);

      // Check if status needs to be updated from 'pending' to 'in progress'
      if (planData.status === 'pending') {
        planData.status = 'in_progress';
        planData.updatedAt = new Date().toISOString();
        await writePlanFile(currentPlanFile, planData);

        // If this plan has a parent, mark it as in_progress too
        if (planData.parent) {
          await markParentInProgress(planData.parent, config);
        }
      }

      // Get all incomplete tasks
      const incompleteTasks = getAllIncompleteTasks(planData);

      // If no incomplete tasks remain, exit the loop
      if (incompleteTasks.length === 0) {
        log('Batch mode complete: No incomplete tasks remaining');
        break;
      }

      log(`Batch mode: Processing ${incompleteTasks.length} incomplete task(s)`);

      // Format all incomplete tasks into a single prompt for the executor
      const taskDescriptions = incompleteTasks
        .map((taskResult) => {
          const { taskIndex, task } = taskResult;
          let taskDescription = `Task ${taskIndex + 1}: ${task.title}`;
          if (task.description) {
            taskDescription += `\nDescription: ${task.description}`;
          }
          if (task.steps && task.steps.length > 0) {
            taskDescription += `\nSteps:`;
            task.steps.forEach((step, stepIdx) => {
              const status = step.done ? '[DONE]' : '[TODO]';
              taskDescription += `\n  ${stepIdx + 1}. ${status} ${step.prompt}`;
            });
          }
          if (task.files && task.files.length > 0) {
            taskDescription += `\nFiles: ${task.files.join(', ')}`;
          }
          return taskDescription;
        })
        .join('\n\n');

      // Build the batch prompt that includes the plan context and all incomplete task details
      const batchPrompt = await buildExecutionPromptWithoutSteps({
        executor,
        planData,
        planFilePath: currentPlanFile,
        baseDir,
        config,
        task: {
          title: `${incompleteTasks.length} Tasks`,
          description: `Please select and complete a logical subset of the following incomplete tasks that makes sense to work on together:\n\n${taskDescriptions}\n\nAfter completing your work, mark the completed tasks as 'done: true' in the plan file at: ${currentPlanFile}. Find the tasks in the file by title.`,
          files: [], // Files will be included via plan context
        },
        filePathPrefix: executor.filePathPrefix,
        includeCurrentPlanContext: true,
        batchMode: true,
      });

      if (dryRun) {
        log(boldMarkdownHeaders('\n## Batch Mode Dry Run - Generated Prompt\n'));
        log(batchPrompt);
        log('\n--dry-run mode: Would execute the above prompt');
        break;
      }

      try {
        log(boldMarkdownHeaders('\n## Batch Mode Execution\n'));
        await executor.execute(batchPrompt, {
          planId: planData.id?.toString() ?? 'unknown',
          planTitle: planData.title ?? 'Untitled Plan',
          planFilePath: currentPlanFile,
          batchMode: true,
        });
      } catch (err) {
        error('Batch execution failed:', err);
        hasError = true;
        break;
      }

      // Run post-apply commands if configured
      if (config.postApplyCommands && config.postApplyCommands.length > 0) {
        log(boldMarkdownHeaders('\n## Running Post-Apply Commands'));
        for (const commandConfig of config.postApplyCommands) {
          const commandSucceeded = await executePostApplyCommand(commandConfig, baseDir);
          if (!commandSucceeded) {
            error(`Batch mode stopping because required command "${commandConfig.title}" failed.`);
            hasError = true;
            break;
          }
        }
        if (hasError) {
          break;
        }
      }

      // After execution, re-read the plan file to get the updated state
      const updatedPlanData = await readPlanFile(currentPlanFile);
      const remainingIncompleteTasks = getAllIncompleteTasks(updatedPlanData);

      log(
        `Batch iteration complete. Remaining incomplete tasks: ${remainingIncompleteTasks.length}`
      );

      // If all tasks are now marked done, update the plan status to 'done'
      const finished = remainingIncompleteTasks.length === 0;
      if (finished) {
        log('Batch mode: All tasks completed, marking plan as done');
        await setPlanStatus(currentPlanFile, 'done');

        // Handle parent plan updates similar to existing logic
        if (updatedPlanData.parent) {
          await checkAndMarkParentDone(updatedPlanData.parent, config, baseDir);
        }
        break;
      }

      const commitMessage = finished
        ? `Plan complete: ${planData.title}`
        : 'Finish batch tasks iteration';
      await commitAll(commitMessage, baseDir);
    }

    if (hasError) {
      throw new Error('Batch mode stopped due to error.');
    }
  } finally {
    await closeLogFile();
  }
}
