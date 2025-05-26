import * as path from 'path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import yaml from 'yaml';
import { boldMarkdownHeaders, closeLogFile, error, log, openLogFile, warn } from '../logging.ts';
import { getGitRoot, logSpawn } from '../rmfilter/utils.ts';
import {
  executePostApplyCommand,
  findPendingTask,
  markStepDone,
  prepareNextStep,
} from './actions.ts';
import { loadEffectiveConfig } from './configLoader.ts';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from './executors/index.ts';
import type { ExecutorCommonOptions } from './executors/types.ts';
import { planSchema } from './planSchema.ts';
import { createWorkspace } from './workspace/workspace_manager.ts';
import { WorkspaceAutoSelector } from './workspace/workspace_auto_selector.ts';
import { WorkspaceLock } from './workspace/workspace_lock.ts';
import {
  findWorkspacesByTaskId,
  lockWorkspaceToTask,
  unlockWorkspace,
} from './workspace/workspace_tracker.ts';
import { saveCheckpoint, deleteCheckpoint } from '../bot/db/task_checkpoints_manager.ts';

export interface RmplanAgentOptions {
  workspace?: string;
  autoWorkspace?: boolean;
  newWorkspace?: boolean;
  nonInteractive?: boolean;
  requireWorkspace?: boolean;
  botTaskId?: string;
  steps?: string;
  executor?: string;
  model?: string;
  'no-log'?: boolean;
  progressCallback?: (details: {
    taskIndex: number;
    stepIndex: number;
    stepPrompt: string;
    taskTitle: string;
    planFile: string;
  }) => Promise<void>;
  resumeFromCheckpoint?: {
    stepIndex: number;
    checkpointData: any;
  };
}

export async function rmplanAgent(
  planFile: string,
  options: RmplanAgentOptions,
  globalCliOptions: any
) {
  // Initialize currentPlanFile (absolute path)
  let currentPlanFile = path.resolve(planFile);

  const config = await loadEffectiveConfig(globalCliOptions.config);

  let parsed = path.parse(currentPlanFile);
  if (parsed.ext === '.md' || parsed.ext === '.' || !parsed.ext) {
    parsed.base = parsed.name + '.yml';
    parsed.ext = 'yml';
    currentPlanFile = path.join(parsed.dir, parsed.base);
  }

  // Verify the original plan file exists
  try {
    // Use stat to check if file exists
    try {
      await Bun.file(currentPlanFile).text();
    } catch {
      error(`Plan file ${currentPlanFile} does not exist or is empty.`);
      process.exit(1);
    }
  } catch (err) {
    error(`Error checking plan file: ${String(err)}`);
    process.exit(1);
  }

  if (!options['no-log']) {
    let logFilePath = path.join(parsed.dir, parsed.name + '-agent-output.md');
    openLogFile(logFilePath);
  }

  // Determine the base directory for operations
  let currentBaseDir = await getGitRoot();

  // For tracking workspace lock - use botTaskId if provided, otherwise fall back to workspace ID
  let workspaceLockedPath: string | null = null;

  // Handle workspace creation or auto-selection
  if (options.workspace || options.autoWorkspace) {
    let workspace;
    let selectedWorkspace;

    if (options.autoWorkspace) {
      // Use auto-selector to find or create a workspace
      log('Auto-selecting workspace...');
      const selector = new WorkspaceAutoSelector(currentBaseDir, config);

      // Use botTaskId if provided, otherwise use workspace ID or generate one
      const taskId =
        options.botTaskId ||
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

        // The auto-selector already handles locking the workspace to the task ID
        workspaceLockedPath = workspace.path;

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
      const workspaceId = options.workspace!;
      const taskId = options.botTaskId || workspaceId;
      const existingWorkspaces = await findWorkspacesByTaskId(workspaceId);

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
          log(`Using existing workspace for task: ${workspaceId}`);
          workspace = {
            path: availableWorkspace.workspacePath,
            originalPlanFilePath: availableWorkspace.originalPlanFilePath,
            taskId: availableWorkspace.taskId,
          };

          // Lock the workspace to the task ID
          if (options.botTaskId) {
            try {
              await lockWorkspaceToTask(workspace.path, options.botTaskId);
              workspaceLockedPath = workspace.path;
              log(`Locked workspace to bot task: ${options.botTaskId}`);
            } catch (error) {
              log(`Warning: Failed to lock workspace to bot task: ${String(error)}`);
            }
          }
        } else {
          error(
            `Workspace with task ID '${workspaceId}' exists but is locked, and --new-workspace was not specified. Cannot proceed.`
          );
          process.exit(1);
        }
      } else if (options.newWorkspace) {
        // No existing workspace, create a new one
        log(`Creating workspace for task: ${workspaceId}`);
        workspace = await createWorkspace(currentBaseDir, workspaceId, currentPlanFile, config);

        // If botTaskId is provided, lock the workspace to it
        if (workspace && options.botTaskId) {
          try {
            await lockWorkspaceToTask(workspace.path, options.botTaskId);
            workspaceLockedPath = workspace.path;
            log(`Locked new workspace to bot task: ${options.botTaskId}`);
          } catch (error) {
            log(`Warning: Failed to lock workspace to bot task: ${String(error)}`);
          }
        }
      } else {
        error(
          `No workspace found for task ID '${workspaceId}' and --new-workspace was not specified. Cannot proceed.`
        );
        process.exit(1);
      }
    }

    if (workspace) {
      log(boldMarkdownHeaders('\n## Workspace Information'));
      log(`Task ID: ${workspace.taskId}`);
      if (options.botTaskId) {
        log(`Bot Task ID: ${options.botTaskId}`);
      }
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
        error('Workspace creation was required but failed. Exiting.');
        process.exit(1);
      }
    }
  }

  // Save checkpoint after workspace setup if we have a botTaskId
  if (options.botTaskId) {
    try {
      await saveCheckpoint(options.botTaskId, 0, {
        taskType: 'planning',
        planFile: currentPlanFile,
        workspacePath: currentBaseDir,
        originalPlanFile: planFile,
        workspaceLocked: workspaceLockedPath,
      });
      debugLog(`Saved checkpoint for task ${options.botTaskId} after workspace setup`);
    } catch (error) {
      log(`Warning: Failed to save checkpoint: ${String(error)}`);
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

  // Handle resumeFromCheckpoint - restore workspace and other state if provided
  if (options.resumeFromCheckpoint?.checkpointData) {
    const checkpointData = options.resumeFromCheckpoint.checkpointData;
    if (checkpointData.workspacePath && checkpointData.workspacePath !== currentBaseDir) {
      log(`Restoring workspace from checkpoint: ${checkpointData.workspacePath}`);
      currentBaseDir = checkpointData.workspacePath;
    }
    if (checkpointData.planFile && checkpointData.planFile !== currentPlanFile) {
      log(`Restoring plan file from checkpoint: ${checkpointData.planFile}`);
      currentPlanFile = checkpointData.planFile;
    }
    if (checkpointData.executorName) {
      log(`Restoring executor from checkpoint: ${checkpointData.executorName}`);
      // Re-build executor with checkpoint settings if different
      if (checkpointData.executorName !== executorName) {
        const checkpointExecutor = buildExecutorAndLog(
          checkpointData.executorName,
          {
            baseDir: currentBaseDir,
            model: checkpointData.model || agentExecutionModel,
          },
          config
        );
        // Update to use checkpoint executor
        Object.assign(executor, checkpointExecutor);
      }
    }
  }

  log('Starting agent to execute plan:', currentPlanFile);
  if (options.resumeFromCheckpoint) {
    log(`Resuming from step index: ${options.resumeFromCheckpoint.stepIndex}`);
  }
  try {
    let hasError = false;

    const maxSteps = options.steps ? parseInt(options.steps, 10) : Infinity;
    let stepCount = 0;
    while (stepCount < maxSteps) {
      stepCount++;

      const fileContent = await Bun.file(currentPlanFile).text();
      let parsed;
      try {
        parsed = yaml.parse(fileContent);
      } catch (err) {
        error('Failed to parse YAML:', err);
        process.exit(1);
      }

      const planResult = planSchema.safeParse(parsed);
      if (!planResult.success) {
        error('Validation errors:', JSON.stringify(planResult.error.issues, null, 2));
        process.exit(1);
      }

      const planData = planResult.data;

      // If resuming from checkpoint and this is the first iteration,
      // skip to the checkpoint step
      if (options.resumeFromCheckpoint && stepCount === 1) {
        const { stepIndex: resumeStepIndex, checkpointData } = options.resumeFromCheckpoint;

        if (
          checkpointData.taskIndex !== undefined &&
          checkpointData.completedStepIndex !== undefined
        ) {
          // Mark all steps up to completedStepIndex as done
          const taskIndex = checkpointData.taskIndex;
          if (taskIndex < planData.tasks.length) {
            const task = planData.tasks[taskIndex];
            for (let i = 0; i <= checkpointData.completedStepIndex && i < task.steps.length; i++) {
              task.steps[i].done = true;
            }
            log(
              `Marked ${checkpointData.completedStepIndex + 1} steps as done in task ${taskIndex + 1} based on checkpoint`
            );
          }
        }

        // Clear the resumeFromCheckpoint flag after first use
        delete options.resumeFromCheckpoint;
      }

      const pendingTaskInfo = findPendingTask(planData);
      if (!pendingTaskInfo) {
        log('Plan complete!');
        break;
      }

      log(
        boldMarkdownHeaders(
          `# Iteration ${stepCount}: Task ${pendingTaskInfo.taskIndex + 1}, Step ${pendingTaskInfo.stepIndex + 1}...`
        )
      );

      const executorStepOptions = executor.prepareStepOptions?.() ?? {};
      const stepPreparationResult = await prepareNextStep(
        config,
        currentPlanFile,
        {
          previous: true,
          ...executorStepOptions,
          model: executorStepOptions.model || agentExecutionModel,
          selectSteps: false,
          filePathPrefix: executor.filePathPrefix,
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

      // ---> NEW: Execute Post-Apply Commands <---
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
      // ---> END NEW SECTION <---
      let markResult;
      try {
        log(boldMarkdownHeaders('\n## Marking done\n'));
        markResult = await markStepDone(
          currentPlanFile,
          { steps: 1, commit: true },
          { taskIndex, stepIndex },
          currentBaseDir,
          options.progressCallback
        );
        log(`Marked step as done: ${markResult.message.split('\n')[0]}`);

        // Save checkpoint after successful step completion if we have a botTaskId
        if (options.botTaskId && !markResult.planComplete) {
          try {
            await saveCheckpoint(options.botTaskId, stepIndex + 1, {
              taskType: 'planning',
              planFile: currentPlanFile,
              workspacePath: currentBaseDir,
              originalPlanFile: planFile,
              workspaceLocked: workspaceLockedPath,
              taskIndex: taskIndex,
              completedStepIndex: stepIndex,
              executorName: executorName,
              model: agentExecutionModel,
            });
            debugLog(`Saved checkpoint for task ${options.botTaskId} after step ${stepIndex + 1}`);
          } catch (error) {
            log(`Warning: Failed to save checkpoint: ${String(error)}`);
          }
        }

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
      error('Agent stopped due to error.');
      process.exit(1);
    } else {
      // Clean up checkpoint on successful completion
      if (options.botTaskId) {
        try {
          await deleteCheckpoint(options.botTaskId);
          debugLog(`Deleted checkpoint for completed task ${options.botTaskId}`);
        } catch (error) {
          log(`Warning: Failed to delete checkpoint: ${String(error)}`);
        }
      }
    }
  } catch (err) {
    error('Unexpected error during agent execution:', err);
    error('Agent stopped due to error.');
    process.exit(1);
  } finally {
    // Release workspace lock if we acquired one
    if (workspaceLockedPath && options.botTaskId) {
      try {
        await unlockWorkspace(workspaceLockedPath);
        log(`Released workspace lock for bot task: ${options.botTaskId}`);
      } catch (error) {
        log(`Warning: Failed to release workspace lock: ${String(error)}`);
      }
    }

    // Release filesystem lock if we hold one
    if (workspaceLockedPath) {
      try {
        await WorkspaceLock.releaseLock(workspaceLockedPath);
      } catch (error) {
        // Silent failure - cleanup handlers may have already handled it
      }
    }

    await closeLogFile();
  }
}
