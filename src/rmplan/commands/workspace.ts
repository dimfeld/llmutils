// Command handler for 'rmplan workspace'
// Manages workspaces for plans (with subcommands list and add)

import * as path from 'path';
import chalk from 'chalk';
import { $ } from 'bun';
import { log, warn } from '../../logging.js';
import { getGitRoot } from '../../rmfilter/utils.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFile, readPlanFile, setPlanStatus } from '../plans.js';
import { generateAlphanumericPlanId } from '../id_utils.js';
import { WorkspaceAutoSelector } from '../workspace/workspace_auto_selector.js';
import { createWorkspace } from '../workspace/workspace_manager.js';
import type { PlanSchema } from '../planSchema.js';

export async function handleWorkspaceCommand(args: any, options: any) {
  // This is the main workspace command handler that delegates to subcommands
  // The actual delegation logic will be handled in rmplan.ts when setting up the command
}

export async function handleWorkspaceListCommand(options: any) {
  const globalOpts = options.parent.parent.opts();
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

  await WorkspaceAutoSelector.listWorkspacesWithStatus(repoUrl, trackingFilePath);
}

export async function handleWorkspaceAddCommand(planIdentifier: string | undefined, options: any) {
  const globalOpts = options.parent.parent.opts();

  // Load configuration
  const config = await loadEffectiveConfig(globalOpts.config);
  const gitRoot = (await getGitRoot()) || process.cwd();

  // Check if workspace creation is enabled
  if (!config.workspaceCreation) {
    throw new Error(
      'Workspace creation is not enabled in configuration.\nAdd "workspaceCreation" section to your rmplan config file.'
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
    workspaceId = generateAlphanumericPlanId();
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
  const workspace = await createWorkspace(gitRoot, workspaceId, resolvedPlanFilePath, config);

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
      `  2. rmplan next ${path.basename(workspace.planFilePathInWorkspace || resolvedPlanFilePath)}`
    );
  } else {
    log('  2. Start working on your task');
  }
}
