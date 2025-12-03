import { commitAll } from '../../../common/process.js';
import { boldMarkdownHeaders, error, log } from '../../../logging.js';
import chalk from 'chalk';
import { executePostApplyCommand } from '../../actions.js';
import { type RmplanConfig } from '../../configSchema.js';
import type { Executor } from '../../executors/types.js';
import { readPlanFile, setPlanStatus, writePlanFile } from '../../plans.js';
import { getAllIncompleteTasks } from '../../plans/find_next.js';
import { buildExecutionPromptWithoutSteps } from '../../prompt_builder.js';
import { checkAndMarkParentDone, markParentInProgress } from './parent_plans.js';
import type { SummaryCollector } from '../../summary/collector.js';
import { runUpdateDocs } from '../update-docs.js';

export async function executeBatchMode(
  {
    currentPlanFile,
    config,
    executor,
    baseDir,
    dryRun = false,
    maxSteps = Infinity,
    executorName,
    executionMode = 'normal',
    updateDocsMode = 'never',
  }: {
    currentPlanFile: string;
    config: RmplanConfig;
    executor: Executor;
    baseDir: string;
    dryRun?: boolean;
    maxSteps?: number;
    executorName?: string;
    executionMode?: 'normal' | 'simple';
    updateDocsMode?: 'never' | 'after-iteration' | 'after-completion';
  },
  summaryCollector?: SummaryCollector
) {
  log('Starting batch mode execution:', currentPlanFile);
  try {
    let hasError = false;
    let iteration = 0;

    // Batch mode: continue until no incomplete tasks remain
    while (iteration < maxSteps) {
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
          description: `Please select and complete a logical subset of the following incomplete tasks that makes sense to work on together:\n\n${taskDescriptions}`,
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
        const start = Date.now();
        const output = await executor.execute(batchPrompt, {
          planId: planData.id?.toString() ?? 'unknown',
          planTitle: planData.title ?? 'Untitled Plan',
          planFilePath: currentPlanFile,
          batchMode: true,
          executionMode,
          captureOutput: summaryCollector ? 'result' : 'none',
        });
        iteration += 1;
        const ok = output ? (output as any).success !== false : true;
        if (!ok) {
          const fd = output?.failureDetails;
          const src = fd?.sourceAgent ? ` (${fd.sourceAgent})` : '';
          log(chalk.redBright(`\nFAILED${src}: ${fd?.problems || 'Executor reported failure.'}`));
          const req = typeof fd?.requirements === 'string' ? fd.requirements.trim() : '';
          if (req) {
            log(chalk.yellow('\nRequirements:\n') + req);
          }
          const sols = typeof fd?.solutions === 'string' ? fd.solutions.trim() : '';
          if (sols) {
            log(chalk.yellow('\nPossible solutions:\n') + sols);
          }
        }
        if (summaryCollector) {
          const end = Date.now();
          // Coerce executor output to normalized shape for predictable summaries
          const normalizedOutput =
            typeof output === 'string' ? { content: output } : ((output as any) ?? undefined);
          summaryCollector.addStepResult({
            title: `Batch Iteration ${iteration}`,
            executor: executorName ?? 'executor',
            success: ok,
            output: normalizedOutput,
            startedAt: new Date(start).toISOString(),
            endedAt: new Date(end).toISOString(),
            durationMs: end - start,
            iteration,
          });
        }
        if (!ok) {
          hasError = true;
          if (summaryCollector) {
            await summaryCollector.trackFileChanges(baseDir);
            summaryCollector.setBatchIterations(iteration);
          }
          break;
        }
      } catch (err) {
        error('Batch execution failed:', err);
        hasError = true;
        iteration += 1;
        if (summaryCollector) {
          summaryCollector.addStepResult({
            title: `Batch Iteration ${iteration}`,
            executor: executorName ?? 'executor',
            success: false,
            errorMessage: String(err instanceof Error ? err.message : err),
            iteration,
          });
          summaryCollector.addError(err);
        }
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
          if (summaryCollector) summaryCollector.addError('Post-apply command failed');
          break;
        }
      }

      // After execution, re-read the plan file to get the updated state
      const updatedPlanData = await readPlanFile(currentPlanFile);
      const remainingIncompleteTasks = getAllIncompleteTasks(updatedPlanData);

      log(
        `Batch iteration complete. Remaining incomplete tasks: ${remainingIncompleteTasks.length}`
      );

      // Update docs if configured for after-iteration mode
      // Calculate which tasks were just completed by comparing before/after state
      if (updateDocsMode === 'after-iteration') {
        const remainingIndices = new Set(remainingIncompleteTasks.map((t) => t.taskIndex));
        const justCompletedTaskIndices = incompleteTasks
          .map((t) => t.taskIndex)
          .filter((index) => !remainingIndices.has(index));

        try {
          await runUpdateDocs(currentPlanFile, config, {
            executor: config.updateDocs?.executor,
            model: config.updateDocs?.model,
            baseDir,
            justCompletedTaskIndices,
          });
        } catch (err) {
          error('Failed to update documentation:', err);
          // Don't stop execution for documentation update failures
        }
      }

      // If all tasks are now marked done, update the plan status to 'done'
      const finished = remainingIncompleteTasks.length === 0;
      if (finished) {
        log('Batch mode: All tasks completed, marking plan as done');
        await setPlanStatus(currentPlanFile, 'done');

        // Update docs if configured for after-completion mode
        if (updateDocsMode === 'after-completion') {
          try {
            await runUpdateDocs(currentPlanFile, config, {
              executor: config.updateDocs?.executor,
              model: config.updateDocs?.model,
              baseDir,
            });
          } catch (err) {
            error('Failed to update documentation:', err);
            // Don't stop execution for documentation update failures
          }
        }

        // Handle parent plan updates similar to existing logic
        if (updatedPlanData.parent) {
          await checkAndMarkParentDone(updatedPlanData.parent, config, baseDir);
        }
        await commitAll(`Plan complete: ${planData.title}`, baseDir);
        if (summaryCollector) {
          await summaryCollector.trackFileChanges(baseDir);
          summaryCollector.setBatchIterations(iteration);
        }
        break;
      } else {
        await commitAll('Finish batch tasks iteration', baseDir);
        if (summaryCollector) {
          await summaryCollector.trackFileChanges(baseDir);
          summaryCollector.setBatchIterations(iteration);
        }
      }
    }

    if (hasError) {
      throw new Error('Batch mode stopped due to error.');
    }
  } finally {
    // Logging lifecycle is managed by the caller (rmplanAgent)
  }
}
