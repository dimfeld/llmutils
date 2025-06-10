// Command handler for 'rmplan agent' and 'rmplan run'
// Automatically executes steps in a plan YAML file

import * as path from 'path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import yaml from 'yaml';
import { select } from '@inquirer/prompts';
import { boldMarkdownHeaders, closeLogFile, error, log, openLogFile, warn } from '../../logging.js';
import { commitAll, logSpawn } from '../../common/process.js';
import { getGitRoot } from '../../common/git.js';
import {
  executePostApplyCommand,
  findPendingTask,
  markStepDone,
  prepareNextStep,
  preparePhase,
} from '../actions.js';
import {
  readAllPlans,
  readPlanFile,
  resolvePlanFile,
  setPlanStatus,
  writePlanFile,
} from '../plans.js';
import { loadEffectiveConfig } from '../configLoader.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { Executor, ExecutorCommonOptions } from '../executors/types.js';
import { createWorkspace } from '../workspace/workspace_manager.js';
import { WorkspaceAutoSelector } from '../workspace/workspace_auto_selector.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { findWorkspacesByTaskId } from '../workspace/workspace_tracker.js';
import type { PlanSchema } from '../planSchema.js';
import type { RmplanConfig } from '../configSchema.js';

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
  };

  const executor = buildExecutorAndLog(executorName, sharedExecutorOptions, config);

  // Check if the plan needs preparation
  const planData = await readPlanFile(currentPlanFile);

  // Check if prompts have been generated
  const needsPreparation =
    !planData.tasks.length || planData.tasks.some((task) => !task.steps?.length);

  if (needsPreparation) {
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

      // Direct execution branch - bypass step-by-step loop
      try {
        await executeStubPlan({
          config,
          baseDir: currentBaseDir,
          planFilePath: currentPlanFile,
          planData,
          executor,
          commit: options.commit,
        });
        return;
      } catch (err) {
        error('Direct execution failed:', err);
        throw err;
      }
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
      }

      const pendingTaskInfo = findPendingTask(planData);
      if (!pendingTaskInfo) {
        log('Plan complete!');
        break;
      }

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
}: {
  config: RmplanConfig;
  baseDir: string;
  planFilePath: string;
  planData: PlanSchema;
  executor: Executor;
  commit: boolean;
}) {
  // Update plan status to in_progress
  planData.status = 'in_progress';
  planData.updatedAt = new Date().toISOString();
  await writePlanFile(planFilePath, planData);

  // Construct single prompt from goal and details
  let directPrompt = '';
  if (planData.goal) {
    directPrompt += `# Goal\n\n${planData.goal}\n\n`;
  }
  if (planData.details) {
    directPrompt += `## Details\n\n${planData.details}\n\n`;
  }

  // Add parent plan information if available
  if (planData.parent) {
    const tasksDir = path.dirname(planFilePath);
    try {
      const { plans: allPlans } = await readAllPlans(tasksDir);
      const parentPlan = allPlans.get(planData.parent);
      if (parentPlan) {
        directPrompt += `## Parent Plan Context\n\n`;
        directPrompt += `**Parent Plan:** ${parentPlan.title || `Plan ${planData.parent}`} (ID: ${planData.parent})\n`;
        if (parentPlan.goal) {
          directPrompt += `**Parent Goal:** ${parentPlan.goal}\n`;
        }
        if (parentPlan.details) {
          directPrompt += `**Parent Details:** ${parentPlan.details}\n`;
        }
        directPrompt += `\n`;
      }
    } catch (err) {
      warn(`Warning: Could not load parent plan ${planData.parent}: ${err}`);
    }
  }

  if (!directPrompt.trim()) {
    throw new Error('Plan has no goal or details to execute directly');
  }

  log(boldMarkdownHeaders('\n## Execution\n'));
  log('Using combined goal and details as prompt:');
  log(directPrompt);

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
