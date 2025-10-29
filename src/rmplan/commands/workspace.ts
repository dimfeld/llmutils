// Command handler for 'rmplan workspace'
// Manages workspaces for plans (with subcommands list and add)

import * as path from 'path';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { $ } from 'bun';
import { log, warn } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFile, readPlanFile, setPlanStatus } from '../plans.js';
import { generateAlphanumericId } from '../id_utils.js';
import { WorkspaceAutoSelector } from '../workspace/workspace_auto_selector.js';
import { createWorkspace } from '../workspace/workspace_manager.js';
import {
  findWorkspacesByRepoUrl,
  findWorkspacesByTaskId,
  getWorkspaceMetadata,
  readTrackingData,
  updateWorkspaceLockStatus,
  writeTrackingData,
  type WorkspaceInfo,
} from '../workspace/workspace_tracker.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import type { PlanSchema } from '../planSchema.js';
import type { RmplanConfig } from '../configSchema.js';
import type { Command } from 'commander';

export async function handleWorkspaceCommand(args: any, options: any) {
  // This is the main workspace command handler that delegates to subcommands
  // The actual delegation logic will be handled in rmplan.ts when setting up the command
}

export async function handleWorkspaceListCommand(options: any, command: Command) {
  const globalOpts = command.parent!.parent!.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const trackingFilePath = config.paths?.trackingFile;

  let repoUrl = options.repo;
  if (!repoUrl) {
    // Try to get repo URL from current directory
    try {
      const gitRoot = await getGitRoot();
      const result = await $`git remote get-url origin`.cwd(gitRoot).text();
      repoUrl = result.trim();
    } catch (err) {
      throw new Error('Could not determine repository URL. Please specify --repo');
    }
  }

  const removedWorkspaces = await removeMissingWorkspaceEntries(repoUrl, trackingFilePath);
  for (const workspacePath of removedWorkspaces) {
    warn(`Removed deleted workspace directory: ${workspacePath}`);
  }

  await WorkspaceAutoSelector.listWorkspacesWithStatus(repoUrl, trackingFilePath);
}

async function removeMissingWorkspaceEntries(
  repositoryUrl: string,
  trackingFilePath?: string
): Promise<string[]> {
  const [trackingData, workspaces] = await Promise.all([
    readTrackingData(trackingFilePath),
    findWorkspacesByRepoUrl(repositoryUrl, trackingFilePath),
  ]);

  const removed: string[] = [];

  for (const workspace of workspaces) {
    const exists = await workspaceDirectoryExists(workspace.workspacePath);
    if (!exists && trackingData[workspace.workspacePath]) {
      delete trackingData[workspace.workspacePath];
      removed.push(workspace.workspacePath);
    }
  }

  if (removed.length > 0) {
    await writeTrackingData(trackingData, trackingFilePath);
  }

  return removed;
}

async function workspaceDirectoryExists(directoryPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(directoryPath);
    return stats.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }

    warn(`Failed to check workspace directory ${directoryPath}: ${error as Error}`);
    return false;
  }
}

export async function handleWorkspaceAddCommand(
  planIdentifier: string | undefined,
  options: any,
  command: Command
) {
  const globalOpts = command.parent!.parent!.opts();

  // Load configuration
  const config = await loadEffectiveConfig(globalOpts.config);
  const gitRoot = (await getGitRoot()) || process.cwd();

  // Check if workspace creation is enabled
  if (!config.workspaceCreation) {
    throw new Error(
      'Workspace creation is not enabled in configuration.\nAdd "workspaceCreation" section to your rmplan config file.'
    );
  }

  // Override config with command line options if provided
  const effectiveConfig = {
    ...config,
    workspaceCreation: {
      ...config.workspaceCreation,
      ...(options.cloneMethod && { cloneMethod: options.cloneMethod }),
      ...(options.sourceDir && { sourceDirectory: options.sourceDir }),
      ...(options.repoUrl && { repositoryUrl: options.repoUrl }),
    },
  };

  // Validate clone method if provided
  if (options.cloneMethod && !['git', 'cp', 'mac-cow'].includes(options.cloneMethod)) {
    throw new Error(
      `Invalid clone method: ${options.cloneMethod}. Must be one of: git, cp, mac-cow`
    );
  }

  // Determine workspace ID
  let workspaceId: string;
  if (options.id) {
    workspaceId = options.id;
  } else if (planIdentifier) {
    // Generate ID based on plan
    workspaceId = `task-${planIdentifier}`;
  } else {
    // Generate a random ID for standalone workspace
    workspaceId = generateAlphanumericId();
  }

  // Resolve plan file if provided
  let resolvedPlanFilePath: string | undefined;
  let planData: PlanSchema | undefined;

  if (planIdentifier) {
    try {
      resolvedPlanFilePath = await resolvePlanFile(planIdentifier, globalOpts.config);

      // Read and parse the plan file
      planData = await readPlanFile(resolvedPlanFilePath);

      // If no custom ID was provided, use the plan's ID if available
      if (!options.id && planData.id) {
        workspaceId = `task-${planData.id}`;
      }

      log(`Using plan: ${planData.title || planData.goal || resolvedPlanFilePath}`);
    } catch (err) {
      throw new Error(`Failed to resolve plan: ${err as Error}`);
    }
  }

  log(`Creating workspace with ID: ${workspaceId}`);

  // Update plan status BEFORE creating workspace if a plan was provided
  if (resolvedPlanFilePath && planData) {
    try {
      await setPlanStatus(resolvedPlanFilePath, 'in_progress');
      log('Plan status updated to in_progress in original location');
    } catch (err) {
      warn(`Failed to update plan status: ${err as Error}`);
    }
  }

  // Create the workspace
  const workspace = await createWorkspace(
    gitRoot,
    workspaceId,
    resolvedPlanFilePath,
    effectiveConfig
  );

  if (!workspace) {
    throw new Error('Failed to create workspace');
  }

  // Update plan status in the new workspace if plan was copied
  if (workspace.planFilePathInWorkspace) {
    try {
      await setPlanStatus(workspace.planFilePathInWorkspace, 'in_progress');
      log('Plan status updated to in_progress in workspace');
    } catch (err) {
      warn(`Failed to update plan status in workspace: ${err as Error}`);
    }
  }

  // Success message
  log(chalk.green('✓ Workspace created successfully!'));
  log(`  Path: ${workspace.path}`);
  log(`  ID: ${workspace.taskId}`);
  if (workspace.planFilePathInWorkspace) {
    log(`  Plan file: ${path.relative(workspace.path, workspace.planFilePathInWorkspace)}`);
  }
  log('');
  log('Next steps:');
  log(`  1. cd ${workspace.path}`);
  if (resolvedPlanFilePath) {
    log(
      `  2. rmplan agent ${path.basename(workspace.planFilePathInWorkspace || resolvedPlanFilePath)}`
    );
    log(
      `     or rmplan show ${path.basename(workspace.planFilePathInWorkspace || resolvedPlanFilePath)} to view the plan`
    );
  } else {
    log('  2. Start working on your task');
  }
}

export async function handleWorkspaceLockCommand(
  target: string | undefined,
  options: any,
  command: Command
) {
  const globalOpts = command.parent!.parent!.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const trackingFilePath = config.paths?.trackingFile;

  if (options.available && target) {
    throw new Error('Cannot specify a workspace identifier when using --available');
  }

  if (options.available) {
    await lockAvailableWorkspace(config, trackingFilePath, options);
    return;
  }

  const workspace = await resolveWorkspaceIdentifier(target, trackingFilePath);

  if (!(await workspaceDirectoryExists(workspace.workspacePath))) {
    throw new Error(`Workspace directory does not exist: ${workspace.workspacePath}`);
  }

  const existingLock = await WorkspaceLock.getLockInfo(workspace.workspacePath);
  if (existingLock) {
    if (existingLock.type === 'pid' && (await WorkspaceLock.isLockStale(existingLock))) {
      await WorkspaceLock.clearStaleLock(workspace.workspacePath);
    } else {
      throw new Error(`Workspace already locked: ${workspace.workspacePath}`);
    }
  }

  const lockInfo = await WorkspaceLock.acquireLock(
    workspace.workspacePath,
    buildLockCommandLabel(target, options),
    {
      owner: getDefaultLockOwner(),
    }
  );

  log(chalk.green('✓ Workspace locked'));
  log(`  Path: ${workspace.workspacePath}`);
  log(`  Task: ${workspace.taskId}`);
  log(`  Lock type: ${lockInfo.type}`);
  console.log(workspace.workspacePath);
}

export async function handleWorkspaceUnlockCommand(
  target: string | undefined,
  _options: any,
  command: Command
) {
  const globalOpts = command.parent!.parent!.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const trackingFilePath = config.paths?.trackingFile;

  const workspace = await resolveWorkspaceIdentifier(target, trackingFilePath);

  if (!(await workspaceDirectoryExists(workspace.workspacePath))) {
    throw new Error(`Workspace directory does not exist: ${workspace.workspacePath}`);
  }

  const lockInfo = await WorkspaceLock.getLockInfo(workspace.workspacePath);
  if (!lockInfo) {
    throw new Error(`Workspace is not locked: ${workspace.workspacePath}`);
  }

  const released = await WorkspaceLock.releaseLock(workspace.workspacePath, { force: true });
  if (!released) {
    throw new Error('Failed to release workspace lock');
  }

  log(chalk.green('✓ Workspace unlocked'));
  log(`  Path: ${workspace.workspacePath}`);
  console.log(workspace.workspacePath);
}

async function resolveWorkspaceIdentifier(
  identifier: string | undefined,
  trackingFilePath?: string
): Promise<WorkspaceInfo> {
  if (identifier) {
    const asPath = path.resolve(process.cwd(), identifier);
    if (await workspaceDirectoryExists(asPath)) {
      const metadata = await getWorkspaceMetadata(asPath, trackingFilePath);
      if (!metadata) {
        throw new Error(
          `Directory ${asPath} is not a tracked workspace. Run rmplan workspace list to see known workspaces.`
        );
      }
      return metadata;
    }

    const matches = await findWorkspacesByTaskId(identifier, trackingFilePath);

    if (matches.length === 0) {
      throw new Error(`No workspace found for task ID: ${identifier}`);
    }

    if (matches.length > 1) {
      throw new Error(
        `Multiple workspaces found for task ID ${identifier}. Please specify the workspace directory.`
      );
    }

    return matches[0];
  }

  const currentDir = process.cwd();
  const metadata = await getWorkspaceMetadata(currentDir, trackingFilePath);
  if (!metadata) {
    throw new Error(
      'The current directory is not a tracked workspace. Provide a task ID or workspace path to lock/unlock.'
    );
  }

  return metadata;
}

async function lockAvailableWorkspace(
  config: RmplanConfig,
  trackingFilePath: string | undefined,
  options: { create?: boolean }
): Promise<void> {
  const repositoryUrl = await determineRepositoryUrl(config);
  await removeMissingWorkspaceEntries(repositoryUrl, trackingFilePath);

  const workspaces = await findWorkspacesByRepoUrl(repositoryUrl, trackingFilePath);
  const workspacesWithStatus = await updateWorkspaceLockStatus(workspaces);
  const available = workspacesWithStatus.find((workspace) => !workspace.lockedBy);

  if (available) {
    await WorkspaceLock.acquireLock(
      available.workspacePath,
      buildLockCommandLabel(undefined, { available: true }),
      {
        owner: getDefaultLockOwner(),
      }
    );
    log(chalk.green('✓ Locked existing workspace'));
    log(`  Path: ${available.workspacePath}`);
    log(`  Task: ${available.taskId}`);
    console.log(available.workspacePath);
    return;
  }

  if (!options.create) {
    throw new Error('No available workspace found. Use --create to create a new workspace.');
  }

  const gitRoot = (await getGitRoot()) || process.cwd();
  const workspaceId = `task-${generateAlphanumericId()}`;
  const workspace = await createWorkspace(gitRoot, workspaceId, undefined, config);

  if (!workspace) {
    throw new Error('Failed to create a new workspace');
  }

  log(chalk.green('✓ Created and locked new workspace'));
  log(`  Path: ${workspace.path}`);
  log(`  Task: ${workspace.taskId}`);
  console.log(workspace.path);
}

function buildLockCommandLabel(
  target: string | undefined,
  options: { available?: boolean; create?: boolean }
): string {
  const parts = ['rmplan workspace lock'];

  if (target) {
    parts.push(target);
  }

  if (options.available) {
    parts.push('--available');
  }

  if (options.create) {
    parts.push('--create');
  }

  return parts.join(' ');
}

async function determineRepositoryUrl(config: RmplanConfig): Promise<string> {
  if (config.workspaceCreation?.repositoryUrl) {
    return config.workspaceCreation.repositoryUrl;
  }

  try {
    const gitRoot = await getGitRoot();
    if (!gitRoot) {
      throw new Error('Could not determine repository root');
    }
    const result = await $`git remote get-url origin`.cwd(gitRoot).text();
    const url = result.trim();
    if (!url) {
      throw new Error('Origin remote URL is empty');
    }
    return url;
  } catch (error) {
    throw new Error(
      `Could not determine repository URL automatically: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function getDefaultLockOwner(): string | undefined {
  return process.env.USER || process.env.LOGNAME || process.env.USERNAME;
}
