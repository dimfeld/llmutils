// Command handler for 'rmplan agent' and 'rmplan run'
// Automatically executes steps in a plan YAML file

import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import * as path from 'path';
import { getGitRoot } from '../../common/git.js';
import { commitAll, logSpawn } from '../../common/process.js';
import { boldMarkdownHeaders, closeLogFile, error, log, openLogFile, warn } from '../../logging.js';
import { executePostApplyCommand } from '../actions.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir, type RmplanConfig } from '../configSchema.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { Executor, ExecutorCommonOptions } from '../executors/types.js';
import {
  clearPlanCache,
  readAllPlans,
  readPlanFile,
  resolvePlanFile,
  setPlanStatus,
  writePlanFile,
} from '../plans.js';
import { findNextActionableItem } from '../plans/find_next.js';
import { markStepDone, markTaskDone } from '../plans/mark_done.js';
import { preparePhase } from '../plans/prepare_phase.js';
import { prepareNextStep } from '../plans/prepare_step.js';
import type { PlanSchema } from '../planSchema.js';
import { buildExecutionPromptWithoutSteps } from '../prompt_builder.js';
import { WorkspaceAutoSelector } from '../workspace/workspace_auto_selector.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { createWorkspace } from '../workspace/workspace_manager.js';
import { findWorkspacesByTaskId } from '../workspace/workspace_tracker.js';

export async function handleAgentCommand(
  planFile: string | undefined,
  options: any,
  globalCliOptions: any
) {
  if (!planFile) {
    throw new Error('Plan file is required');
  }
  await rmplanAgent(planFile, options, globalCliOptions);
}

export async function rmplanAgent(planFile: string, options: any, globalCliOptions: any) {
  let currentPlanFile = await resolvePlanFile(planFile, globalCliOptions.config);
  const config = await loadEffectiveConfig(globalCliOptions.config);

  if (!options['no-log']) {
    const parsed = path.parse(currentPlanFile);
    let logFilePath = path.join(parsed.dir, parsed.name + '-agent-output.md');
    openLogFile(logFilePath);
  }

  // Determine the base directory for operations
  let currentBaseDir = await getGitRoot();

  // Handle workspace creation or auto-selection
  if (options.workspace || options.autoWorkspace) {
    let workspace;
    let selectedWorkspace;

    if (options.autoWorkspace) {
      // Use auto-selector to find or create a workspace
      log('Auto-selecting workspace...');
      const selector = new WorkspaceAutoSelector(currentBaseDir, config);
      const taskId =
        options.workspace ||
        `${path.parse(currentBaseDir).dir.split(path.sep).pop()}-${Date.now()}`;

      selectedWorkspace = await selector.selectWorkspace(taskId, currentPlanFile, {
        interactive: !options.nonInteractive,
        preferNewWorkspace: options.newWorkspace,
      });

      if (selectedWorkspace) {
        workspace = {
          path: selectedWorkspace.workspace.workspacePath,
          originalPlanFilePath: selectedWorkspace.workspace.originalPlanFilePath,
          taskId: selectedWorkspace.workspace.taskId,
        };

        if (selectedWorkspace.isNew) {
          log(`Created new workspace for task: ${workspace.taskId}`);
        } else {
          log(`Selected existing workspace for task: ${selectedWorkspace.workspace.taskId}`);
          if (selectedWorkspace.clearedStaleLock) {
            log('(Cleared stale lock)');
          }
        }
      }
    } else {
      // Manual workspace handling - check if workspace exists first
      const trackingFilePath = config.paths?.trackingFile;
      const existingWorkspaces = await findWorkspacesByTaskId(options.workspace, trackingFilePath);

      if (existingWorkspaces.length > 0) {
        // Find the first available workspace (not locked)
        let availableWorkspace = null;
        for (const ws of existingWorkspaces) {
          const lockInfo = await WorkspaceLock.getLockInfo(ws.workspacePath);
          if (!lockInfo || (await WorkspaceLock.isLockStale(lockInfo))) {
            availableWorkspace = ws;
            break;
          }
        }

        if (availableWorkspace) {
          log(`Using existing workspace for task: ${options.workspace}`);
          workspace = {
            path: availableWorkspace.workspacePath,
            originalPlanFilePath: availableWorkspace.originalPlanFilePath,
            taskId: availableWorkspace.taskId,
          };
        } else {
          throw new Error(
            `Workspace with task ID '${options.workspace}' exists but is locked, and --new-workspace was not specified. Cannot proceed.`
          );
        }
      } else if (options.newWorkspace) {
        // No existing workspace, create a new one
        log(`Creating workspace for task: ${options.workspace}`);
        workspace = await createWorkspace(
          currentBaseDir,
          options.workspace,
          currentPlanFile,
          config
        );
      } else {
        throw new Error(
          `No workspace found for task ID '${options.workspace}' and --new-workspace was not specified. Cannot proceed.`
        );
      }
    }

    if (workspace) {
      log(boldMarkdownHeaders('\n## Workspace Information'));
      log(`Task ID: ${options.workspace}`);
      log(`Workspace Path: ${workspace.path}`);
      log(`Original Plan: ${currentPlanFile}`);

      // Validate that the workspace is properly initialized
      try {
        const gitStatus = logSpawn(['git', 'status'], {
          cwd: workspace.path,
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (gitStatus.exitCode !== 0) {
          warn(
            `Workspace at ${workspace.path} may not be properly initialized. Git operations failed.`
          );
        }
      } catch (err) {
        warn(`Error validating workspace: ${String(err)}`);
      }

      // Copy the plan file to the workspace
      const workspacePlanFile = path.join(workspace.path, currentPlanFile);
      try {
        log(`Copying plan file to workspace: ${workspacePlanFile}`);
        await Bun.write(workspacePlanFile, await Bun.file(currentPlanFile).text());

        // Update the planFile to use the copy in the workspace
        currentPlanFile = workspacePlanFile;
        log(`Using plan file in workspace: ${currentPlanFile}`);
      } catch (err) {
        error(`Failed to copy plan file to workspace: ${String(err)}`);
        error('Continuing with original plan file.');
      }

      // Use the workspace path as the base directory for operations
      currentBaseDir = workspace.path;
      log(`Using workspace as base directory: ${workspace.path}`);

      // Acquire lock if we didn't already (auto-selector doesn't create new workspaces)
      if (selectedWorkspace && !selectedWorkspace.isNew) {
        try {
          await WorkspaceLock.acquireLock(
            workspace.path,
            `rmplan agent --workspace ${workspace.taskId}`
          );
          WorkspaceLock.setupCleanupHandlers(workspace.path);
        } catch (error) {
          log(`Warning: Failed to acquire workspace lock: ${String(error)}`);
        }
      }

      log('---');
    } else {
      error('Failed to create workspace. Continuing in the current directory.');
      // If workspace creation is explicitly required, exit
      if (options.requireWorkspace) {
        throw new Error('Workspace creation was required but failed. Exiting.');
      }
    }
  }

  // Use executor from CLI options, fallback to config defaultExecutor, or fallback to CopyOnlyExecutor
  const executorName = options.executor || config.defaultExecutor || DEFAULT_EXECUTOR;
  const agentExecutionModel =
    options.model || config.models?.execution || defaultModelForExecutor(executorName, 'execution');

  const sharedExecutorOptions: ExecutorCommonOptions = {
    baseDir: currentBaseDir,
    model: agentExecutionModel,
    interactive: options.interactiveExecutor,
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

  // Check if the plan needs preparation
  const planData = await readPlanFile(currentPlanFile);

  // Check if this is a true stub plan (no tasks at all)
  const needsPreparation = !planData.tasks.length;

  if (needsPreparation) {
    // This is a true stub plan with no tasks - handle it specially
    let shouldGenerateSteps = true; // Default behavior

    if (!options.nonInteractive) {
      // Interactive mode - ask user what to do
      const choice = await select({
        message: 'This plan lacks detailed steps. How would you like to proceed?',
        choices: [
          {
            name: 'Generate detailed steps first',
            value: 'generate',
            description: 'Create step-by-step instructions before execution',
          },
          {
            name: 'Run the simple plan directly',
            value: 'direct',
            description: 'Execute using just the high-level goal and details',
          },
        ],
      });

      shouldGenerateSteps = choice === 'generate';
    }

    if (shouldGenerateSteps) {
      log('Plan needs preparation. Generating detailed steps and prompts...');
      try {
        await preparePhase(currentPlanFile, config, {
          model: options.model,
          direct: options.direct,
        });
        log('Successfully prepared the plan with detailed steps.');
      } catch (err) {
        throw new Error(`Failed to automatically prepare the plan: ${err as Error}`);
      }
    } else {
      log('Proceeding to execute plan directly using high-level description.');

      // Direct execution branch for true stub plans (no tasks)
      try {
        await executeStubPlan({
          config,
          baseDir: currentBaseDir,
          planFilePath: currentPlanFile,
          planData,
          executor,
          commit: true,
          dryRun: options.dryRun,
        });
        return;
      } catch (err) {
        error('Direct execution failed:', err);
        throw err;
      }
    }
  } else if (
    planData.tasks.length > 0 &&
    planData.tasks.some((task) => !task.steps || task.steps.length === 0)
  ) {
    // This plan has simple tasks (tasks without steps)
    let shouldGenerateSteps = true; // Default behavior

    if (!options.nonInteractive) {
      // Interactive mode - ask user what to do
      const choice = await select({
        message: 'This plan lacks detailed steps. How would you like to proceed?',
        choices: [
          {
            name: 'Generate detailed steps first',
            value: 'generate',
            description: 'Create step-by-step instructions before execution',
          },
          {
            name: 'Run the simple plan directly',
            value: 'direct',
            description: 'Execute using just the high-level goal and details',
          },
        ],
      });

      shouldGenerateSteps = choice === 'generate';
    }

    if (shouldGenerateSteps) {
      log('Plan needs preparation. Generating detailed steps and prompts...');
      try {
        await preparePhase(currentPlanFile, config, {
          model: options.model,
          direct: options.direct,
        });
        log('Successfully prepared the plan with detailed steps.');
      } catch (err) {
        throw new Error(`Failed to automatically prepare the plan: ${err as Error}`);
      }
    } else {
      log('Proceeding to execute simple tasks directly.');
      // For simple tasks, proceed to the main execution loop
      // Do NOT call executeStubPlan - that's only for plans with no tasks
    }
  }

  log('Starting agent to execute plan:', currentPlanFile);
  try {
    let hasError = false;

    const maxSteps = options.steps ? parseInt(options.steps, 10) : Infinity;
    let stepCount = 0;
    while (stepCount < maxSteps) {
      stepCount++;

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

      const actionableItem = findNextActionableItem(planData);
      if (!actionableItem) {
        log('Plan complete!');
        break;
      }

      // Branch based on the type of actionable item
      if (actionableItem.type === 'task') {
        // Simple task without steps
        log(
          boldMarkdownHeaders(
            `# Iteration ${stepCount}: Simple Task ${actionableItem.taskIndex + 1}...`
          )
        );
        log(`Title: ${actionableItem.task.title}`);
        if (actionableItem.task.description) {
          log(`Description: ${actionableItem.task.description}`);
        }

        // Build the prompt for the simple task using the unified function
        const taskPrompt = await buildExecutionPromptWithoutSteps({
          executor,
          planData,
          planFilePath: currentPlanFile,
          baseDir: currentBaseDir,
          config,
          task: {
            title: actionableItem.task.title,
            description: actionableItem.task.description,
            files: actionableItem.task.files,
          },
          filePathPrefix: executor.filePathPrefix,
          includeCurrentPlanContext: false, // Don't include current plan context since it's already in project context
        });

        if (options.dryRun) {
          log(boldMarkdownHeaders('\n## Dry Run - Generated Prompt\n'));
          log(taskPrompt);
          log('\n--dry-run mode: Would execute the above prompt');
          break;
        }

        try {
          log(boldMarkdownHeaders('\n## Execution\n'));
          await executor.execute(taskPrompt);
        } catch (err) {
          error('Task execution failed:', err);
          hasError = true;
          break;
        }

        // Run post-apply commands if configured
        if (config.postApplyCommands && config.postApplyCommands.length > 0) {
          log(boldMarkdownHeaders('\n## Running Post-Apply Commands'));
          for (const commandConfig of config.postApplyCommands) {
            const commandSucceeded = await executePostApplyCommand(commandConfig, currentBaseDir);
            if (!commandSucceeded) {
              error(`Agent stopping because required command "${commandConfig.title}" failed.`);
              hasError = true;
              break;
            }
          }
          if (hasError) {
            break;
          }
        }

        // Mark the task as done
        try {
          log(boldMarkdownHeaders('\n## Marking task done\n'));
          const markResult = await markTaskDone(
            currentPlanFile,
            actionableItem.taskIndex,
            { commit: true },
            currentBaseDir,
            config
          );

          if (markResult.planComplete) {
            log('Plan fully completed!');
            break;
          }
        } catch (err) {
          error('Failed to mark task as done:', err);
          hasError = true;
          break;
        }

        continue;
      }

      // Handle step execution (existing logic)
      const pendingTaskInfo = {
        taskIndex: actionableItem.taskIndex,
        task: actionableItem.task,
      };

      const executorStepOptions = executor.prepareStepOptions?.() ?? {};
      const stepPreparationResult = await prepareNextStep(
        config,
        currentPlanFile,
        {
          previous: true,
          selectSteps: false,
          model: agentExecutionModel,
          ...executorStepOptions,
          filePathPrefix: executor.filePathPrefix,
          rmfilterArgs: options.rmfilterArgs,
        },
        currentBaseDir
      ).catch((err) => {
        error('Failed to prepare next step:', err);
        hasError = true;
        return null;
      });

      if (!stepPreparationResult) {
        break;
      }

      let stepIndexes: string;
      if (stepPreparationResult.numStepsSelected === 1) {
        stepIndexes = `Step ${stepPreparationResult.stepIndex + 1}`;
      } else {
        const endIndex =
          stepPreparationResult.stepIndex + stepPreparationResult.numStepsSelected + 1;
        stepIndexes = `Steps ${stepPreparationResult.stepIndex + 1}-${endIndex}`;
      }

      log(
        boldMarkdownHeaders(
          `# Iteration ${stepCount}: Task ${pendingTaskInfo.taskIndex + 1}, ${stepIndexes}...`
        )
      );

      const { promptFilePath, taskIndex, stepIndex, rmfilterArgs } = stepPreparationResult;

      let contextContent: string;

      if (executorStepOptions.rmfilter) {
        if (!promptFilePath || !rmfilterArgs) {
          error(
            'Executor requires rmfilter, but no prompt file path or rmfilter args were generated by prepareNextStep.'
          );
          hasError = true;
          break;
        }
        log(boldMarkdownHeaders('\n## Generating Context with rmfilter\n'));
        const rmfilterOutputPath = promptFilePath.replace('.md', '.xml');
        const proc = logSpawn(['rmfilter', '--output', rmfilterOutputPath, ...rmfilterArgs], {
          cwd: currentBaseDir,
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        const exitRes = await proc.exited;
        if (exitRes !== 0) {
          error(`rmfilter exited with code ${exitRes}`);
          hasError = true;
          break;
        }
        contextContent = await Bun.file(rmfilterOutputPath).text();
        // Clean up rmfilter output path if needed, or handle in executor
      } else {
        log(boldMarkdownHeaders('\n## Using Direct Prompt as Context\n'));
        contextContent = stepPreparationResult.prompt;
        log(contextContent);
      }

      if (options.dryRun) {
        log(boldMarkdownHeaders('\n## Dry Run - Generated Context\n'));
        if (!executorStepOptions.rmfilter) {
          log('(Context already shown above)');
        } else {
          log(contextContent);
        }
        log('\n--dry-run mode: Would execute the above context');
        break;
      }

      try {
        log(boldMarkdownHeaders('\n## Execution\n'));
        await executor.execute(contextContent);
      } catch (err) {
        error('Execution step failed:', err);
        hasError = true;
        break;
      }

      if (config.postApplyCommands && config.postApplyCommands.length > 0) {
        log(boldMarkdownHeaders('\n## Running Post-Apply Commands'));
        for (const commandConfig of config.postApplyCommands) {
          const commandSucceeded = await executePostApplyCommand(commandConfig, currentBaseDir);
          if (!commandSucceeded) {
            // Error logging is handled within executePostApplyCommand
            error(`Agent stopping because required command "${commandConfig.title}" failed.`);
            hasError = true;
            break;
          }
        }
        if (hasError) {
          break;
        }
      }

      let markResult;
      try {
        log(boldMarkdownHeaders('\n## Marking done\n'));
        markResult = await markStepDone(
          currentPlanFile,
          { steps: stepPreparationResult.numStepsSelected, commit: true },
          { taskIndex, stepIndex },
          currentBaseDir,
          config
        );
        log(`Marked step as done: ${markResult.message.split('\n')[0]}`);
        if (markResult.planComplete) {
          log('Plan fully completed!');
          break;
        }
      } catch (err) {
        error('Failed to mark step as done:', err);
        hasError = true;
        break;
      } finally {
        if (promptFilePath && executorStepOptions.rmfilter) {
          // Only unlink if rmfilter was supposed to use it
          try {
            await Bun.file(promptFilePath).unlink();
          } catch (e) {
            warn('Warning: failed to clean up temp file:', promptFilePath);
          }
        }
      }
    }

    if (hasError) {
      throw new Error('Agent stopped due to error.');
    }
  } finally {
    await closeLogFile();
  }
}

async function executeStubPlan({
  config,
  baseDir,
  planFilePath,
  planData,
  executor,
  commit,
  dryRun = false,
}: {
  config: RmplanConfig;
  baseDir: string;
  planFilePath: string;
  planData: PlanSchema;
  executor: Executor;
  commit: boolean;
  dryRun?: boolean;
}) {
  // Update plan status to in_progress
  planData.status = 'in_progress';
  planData.updatedAt = new Date().toISOString();
  await writePlanFile(planFilePath, planData);

  // If this plan has a parent, mark it as in_progress too
  if (planData.parent) {
    await markParentInProgress(planData.parent, config);
  }

  // Build execution prompt using the unified function
  const directPrompt = await buildExecutionPromptWithoutSteps({
    executor,
    planData,
    planFilePath,
    baseDir,
    config,
    filePathPrefix: executor.filePathPrefix,
    includeCurrentPlanContext: true,
  });

  if (!directPrompt.trim()) {
    throw new Error('Plan has no goal or details to execute directly');
  }

  log(boldMarkdownHeaders('\n## Execution\n'));
  log('Using combined goal and details as prompt:');
  log(directPrompt);

  if (dryRun) {
    log('\n--dry-run mode: Would execute the above prompt');
    return;
  }

  // Execute the consolidated prompt
  await executor.execute(directPrompt);

  // Execute post-apply commands if configured and no error occurred
  if (config.postApplyCommands && config.postApplyCommands.length > 0) {
    log(boldMarkdownHeaders('\n## Running Post-Apply Commands'));
    for (const commandConfig of config.postApplyCommands) {
      const commandSucceeded = await executePostApplyCommand(commandConfig, baseDir);
      if (!commandSucceeded) {
        throw new Error(`Required command "${commandConfig.title}" failed`);
      }
    }
  }

  // Mark plan as complete only if no error occurred
  await setPlanStatus(planFilePath, 'done');
  log('Plan executed directly and marked as complete!');

  // Check if parent plan should be marked done
  if (planData.parent) {
    await checkAndMarkParentDone(planData.parent, config, baseDir);
  }

  // Check if commit was requested
  if (commit) {
    const commitMessage = [planData.title, planData.goal, planData.details]
      .filter(Boolean)
      .join('\n\n');
    const exitCode = await commitAll(commitMessage, baseDir);
    if (exitCode === 0) {
      log('Changes committed successfully');
    } else {
      throw new Error('Commit failed');
    }
  }
}

/**
 * Marks a parent plan as in_progress if it's currently pending.
 * Recursively marks all ancestor plans as in_progress as well.
 */
async function markParentInProgress(parentId: number, config: RmplanConfig): Promise<void> {
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
    log(chalk.yellow(`↻ Parent plan "${parentPlan.title}" marked as in_progress`));

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
async function checkAndMarkParentDone(
  parentId: number,
  config: RmplanConfig,
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

  // If parent is already done, nothing to do
  if (parentPlan.status === 'done') {
    return;
  }

  // Find all children of this parent
  const children = Array.from(allPlans.values()).filter((plan) => plan.parent === parentId);

  // Check if all children are done
  const allChildrenDone = children.every((child) => child.status === 'done');

  if (allChildrenDone && children.length > 0) {
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
      parentPlan.changedFiles = Array.from(allChangedFiles);
    }

    await writePlanFile(parentPlan.filename, parentPlan);
    log(chalk.green(`✓ Parent plan "${parentPlan.title}" marked as complete (all children done)`));

    // Recursively check if this parent has a parent
    if (parentPlan.parent) {
      await checkAndMarkParentDone(parentPlan.parent, config, baseDir);
    }
  }
}
