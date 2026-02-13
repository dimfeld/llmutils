import { commitAll } from '../../../common/process.js';
import { promptConfirm } from '../../../common/input.js';
import { boldMarkdownHeaders, error, log, sendStructured, warn } from '../../../logging.js';
import chalk from 'chalk';
import { executePostApplyCommand } from '../../actions.js';
import { type TimConfig } from '../../configSchema.js';
import type { Executor } from '../../executors/types.js';
import { readPlanFile, setPlanStatus, writePlanFile } from '../../plans.js';
import { getAllIncompleteTasks } from '../../plans/find_next.js';
import { buildExecutionPromptWithoutSteps } from '../../prompt_builder.js';
import { checkAndMarkParentDone, markParentInProgress } from './parent_plans.js';
import { sendFailureReport, timestamp } from './agent_helpers.js';
import type { SummaryCollector } from '../../summary/collector.js';
import { runUpdateDocs } from '../update-docs.js';
import { runUpdateLessons } from '../update-lessons.js';
import { handleReviewCommand } from '../review.js';

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
    applyLessons = false,
    finalReview,
    configPath,
  }: {
    currentPlanFile: string;
    config: TimConfig;
    executor: Executor;
    baseDir: string;
    dryRun?: boolean;
    maxSteps?: number;
    executorName?: string;
    executionMode?: 'normal' | 'simple' | 'tdd';
    updateDocsMode?: 'never' | 'after-iteration' | 'after-completion';
    applyLessons?: boolean;
    finalReview?: boolean;
    configPath?: string;
  },
  summaryCollector?: SummaryCollector
) {
  sendStructured({
    type: 'workflow_progress',
    timestamp: timestamp(),
    phase: 'batch',
    message: `Starting batch mode execution: ${currentPlanFile}`,
  });
  try {
    let hasError = false;
    let iteration = 0;

    // Track initial state to determine whether to skip final review
    // We skip final review if we started with no tasks completed and finished in a single iteration
    const initialPlanData = await readPlanFile(currentPlanFile);
    const initialCompletedTaskCount = initialPlanData.tasks.filter((t) => t.done).length;

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
        sendStructured({
          type: 'task_completion',
          timestamp: timestamp(),
          planComplete: true,
        });
        break;
      }

      sendStructured({
        type: 'agent_iteration_start',
        timestamp: timestamp(),
        iterationNumber: iteration + 1,
        taskTitle: `${incompleteTasks.length} task(s) selected`,
        taskDescription: incompleteTasks.map((taskResult) => taskResult.task.title).join(', '),
      });

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
          description: `Please select and complete a logical subset of the following incomplete tasks that makes sense to work on together.

IMPORTANT: It's better to choose a small number of closely related tasks that form an atomic unit than to take on too many at once. Focus on what can be completed well in a single iteration.

Available tasks:\n\n${taskDescriptions}`,
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
        sendStructured({
          type: 'agent_step_start',
          timestamp: timestamp(),
          phase: 'execution',
          executor: executorName,
          stepNumber: iteration + 1,
        });
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
          sendFailureReport(fd?.problems || 'Executor reported failure.', {
            requirements: fd?.requirements,
            problems: fd?.problems,
            solutions: fd?.solutions,
            sourceAgent: fd?.sourceAgent,
          });
        }
        sendStructured({
          type: 'agent_step_end',
          timestamp: timestamp(),
          phase: 'execution',
          success: ok,
          summary: ok ? 'Batch executor step completed.' : 'Batch executor step failed.',
        });
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
        sendStructured({
          type: 'agent_step_end',
          timestamp: timestamp(),
          phase: 'execution',
          success: false,
          summary: `Batch executor step threw: ${String(err instanceof Error ? err.message : err)}`,
        });
        break;
      }

      // Run post-apply commands if configured
      if (config.postApplyCommands && config.postApplyCommands.length > 0) {
        sendStructured({
          type: 'workflow_progress',
          timestamp: timestamp(),
          phase: 'post-apply',
          message: 'Running post-apply commands',
        });
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
      const remainingTaskIndices = new Set(remainingIncompleteTasks.map((task) => task.taskIndex));
      const completedTaskTitles = incompleteTasks
        .filter((task) => !remainingTaskIndices.has(task.taskIndex))
        .map((task) => task.task.title);

      log(
        `Batch iteration complete. Remaining incomplete tasks: ${remainingIncompleteTasks.length}`
      );

      // Update docs if configured for after-iteration mode
      // Calculate which tasks were just completed by comparing before/after state
      if (updateDocsMode === 'after-iteration') {
        const justCompletedTaskIndices = incompleteTasks
          .map((t) => t.taskIndex)
          .filter((index) => !remainingTaskIndices.has(index));

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
        sendStructured({
          type: 'task_completion',
          timestamp: timestamp(),
          taskTitle: completedTaskTitles.join(', ') || 'Batch mode iteration',
          planComplete: true,
        });
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

        // Run final review if enabled
        // Skip if we started with no completed tasks and finished in a single iteration
        const shouldSkipFinalReview =
          finalReview === false || (initialCompletedTaskCount === 0 && iteration === 1);
        let planStillCompleteAfterReview = true;
        if (!shouldSkipFinalReview) {
          sendStructured({
            type: 'workflow_progress',
            timestamp: timestamp(),
            phase: 'final-review',
            message: 'Running final review',
          });
          try {
            const reviewResult = await handleReviewCommand(
              currentPlanFile,
              {},
              {
                parent: { opts: () => ({ config: configPath }) },
              }
            );

            // If tasks were appended, ask if user wants to continue
            if (reviewResult?.tasksAppended && reviewResult.tasksAppended > 0) {
              const planIdStr = updatedPlanData.id ? ` ${updatedPlanData.id}` : '';
              const shouldContinue = await promptConfirm({
                message: `${reviewResult.tasksAppended} new task(s) added from review to plan${planIdStr}. You can edit the plan first if needed. Continue running?`,
                default: true,
              });

              if (shouldContinue) {
                continue; // Continue the loop to process new tasks
              }

              // New tasks were appended but execution is not continuing,
              // so the plan is no longer complete.
              planStillCompleteAfterReview = false;
            }
          } catch (err) {
            warn(`Final review failed: ${err as Error}`);
            // Don't fail the agent - plan execution succeeded
          }
        }

        if (planStillCompleteAfterReview && (config.updateDocs?.applyLessons || applyLessons)) {
          try {
            await runUpdateLessons(currentPlanFile, config, {
              executor: config.updateDocs?.executor,
              model: config.updateDocs?.model,
              baseDir,
            });
          } catch (err) {
            error('Failed to apply lessons learned:', err as Error);
            // Don't stop execution for lessons update failures
          }
        } else if (
          !planStillCompleteAfterReview &&
          (config.updateDocs?.applyLessons || applyLessons)
        ) {
          log('Skipping lessons-learned documentation update because review added new tasks.');
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
    // Logging lifecycle is managed by the caller (timAgent)
  }
}
