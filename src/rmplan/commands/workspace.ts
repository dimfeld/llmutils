// Command handler for 'rmplan workspace'
// Manages workspaces for plans (with subcommands list and add)

import * as path from 'path';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { table, type TableUserConfig } from 'table';
import { log, warn } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFile, readPlanFile, setPlanStatus } from '../plans.js';
import { generateAlphanumericId } from '../id_utils.js';
import { WorkspaceAutoSelector } from '../workspace/workspace_auto_selector.js';
import { createWorkspace } from '../workspace/workspace_manager.js';
import {
  buildWorkspaceListEntries,
  findWorkspacesByRepositoryId,
  findWorkspacesByTaskId,
  getWorkspaceMetadata,
  patchWorkspaceMetadata,
  readTrackingData,
  updateWorkspaceLockStatus,
  writeTrackingData,
  type WorkspaceInfo,
  type WorkspaceListEntry,
  type WorkspaceMetadataPatch,
} from '../workspace/workspace_tracker.js';
import { formatWorkspacePath, getCombinedTitleFromSummary } from '../display_utils.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import type { PlanSchema } from '../planSchema.js';
import type { RmplanConfig } from '../configSchema.js';
import type { Command } from 'commander';
import { claimPlan } from '../assignments/claim_plan.js';
import { logClaimOutcome } from '../assignments/claim_logging.js';
import { getRepositoryIdentity, getUserIdentity } from '../assignments/workspace_identifier.js';

export async function handleWorkspaceCommand(args: any, options: any) {
  // This is the main workspace command handler that delegates to subcommands
  // The actual delegation logic will be handled in rmplan.ts when setting up the command
}

export type WorkspaceListFormat = 'table' | 'tsv' | 'json';

export interface WorkspaceListOptions {
  repo?: string;
  format?: WorkspaceListFormat;
  header?: boolean;
  all?: boolean;
}

export async function handleWorkspaceListCommand(options: WorkspaceListOptions, command: Command) {
  const globalOpts = command.parent!.parent!.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const trackingFilePath = config.paths?.trackingFile;

  const format: WorkspaceListFormat = options.format ?? 'table';
  const showHeader = options.header ?? true;

  // Determine repository ID (unless --all is specified)
  let repositoryId: string | undefined;
  if (!options.all) {
    repositoryId = options.repo ?? (await determineRepositoryId());
  }

  // Get workspaces based on whether we're filtering by repo
  let workspaces: WorkspaceInfo[];
  if (repositoryId) {
    const removedWorkspaces = await removeMissingWorkspaceEntries(repositoryId, trackingFilePath);
    for (const workspacePath of removedWorkspaces) {
      warn(`Removed deleted workspace directory: ${workspacePath}`);
    }
    workspaces = await findWorkspacesByRepositoryId(repositoryId, trackingFilePath);
  } else {
    // --all: get all workspaces from tracking file, also cleaning up stale entries
    const removedWorkspaces = await removeAllMissingWorkspaceEntries(trackingFilePath);
    for (const workspacePath of removedWorkspaces) {
      warn(`Removed deleted workspace directory: ${workspacePath}`);
    }
    const trackingData = await readTrackingData(trackingFilePath);
    workspaces = Object.values(trackingData);
  }

  // Update lock status for all workspaces
  const workspacesWithStatus = await updateWorkspaceLockStatus(workspaces);

  // Build enriched list entries with live branch info
  const entries = await buildWorkspaceListEntries(workspacesWithStatus);

  if (entries.length === 0) {
    if (format === 'table') {
      console.log(repositoryId ? 'No workspaces found for this repository' : 'No workspaces found');
    } else if (format === 'json') {
      console.log('[]');
    } else if (format === 'tsv' && showHeader) {
      // Output just the header line with no data rows
      console.log(
        [
          'fullPath',
          'basename',
          'name',
          'description',
          'branch',
          'taskId',
          'planTitle',
          'issueUrls',
        ].join('\t')
      );
    }
    return;
  }

  // Output based on format
  switch (format) {
    case 'table':
      outputWorkspaceTable(entries, showHeader);
      break;
    case 'tsv':
      outputWorkspaceTsv(entries, showHeader);
      break;
    case 'json':
      outputWorkspaceJson(entries);
      break;
  }
}

/**
 * Output workspaces in table format with abbreviated paths and lock status.
 */
function outputWorkspaceTable(entries: WorkspaceListEntry[], showHeader: boolean): void {
  const tableData: string[][] = [];

  if (showHeader) {
    tableData.push([
      chalk.bold('Path'),
      chalk.bold('Name'),
      chalk.bold('Description'),
      chalk.bold('Branch'),
      chalk.bold('Status'),
    ]);
  }

  for (const entry of entries) {
    const abbreviatedPath = formatWorkspacePath(entry.fullPath);
    const name = entry.name || '-';
    const description = entry.description || '-';
    const branch = entry.branch || '-';

    let status: string;
    if (entry.lockedBy) {
      const lockType = entry.lockedBy.type;
      status = chalk.red(`Locked (${lockType})`);
    } else {
      status = chalk.green('Available');
    }

    tableData.push([abbreviatedPath, name, description, branch, status]);
  }

  const tableConfig: TableUserConfig = {
    columns: {
      0: { width: 30, wrapWord: true },
      1: { width: 15, wrapWord: true },
      2: { width: 35, wrapWord: true },
      3: { width: 20, wrapWord: true },
      4: { width: 15, wrapWord: true },
    },
    border: {
      topBody: '-',
      topJoin: '+',
      topLeft: '+',
      topRight: '+',
      bottomBody: '-',
      bottomJoin: '+',
      bottomLeft: '+',
      bottomRight: '+',
      bodyLeft: '|',
      bodyRight: '|',
      bodyJoin: '|',
      joinBody: '-',
      joinLeft: '+',
      joinRight: '+',
      joinJoin: '+',
    },
  };

  console.log(table(tableData, tableConfig));
  log(`Showing ${entries.length} workspace(s)`);
}

/**
 * Output workspaces in TSV format for machine consumption.
 * Format: fullPath\tbasename\tname\tdescription\tbranch\ttaskId\tplanTitle\tissueUrls
 * Lock status is omitted from TSV/JSON per requirements.
 */
function outputWorkspaceTsv(entries: WorkspaceListEntry[], showHeader: boolean): void {
  if (showHeader) {
    console.log(
      [
        'fullPath',
        'basename',
        'name',
        'description',
        'branch',
        'taskId',
        'planTitle',
        'issueUrls',
      ].join('\t')
    );
  }

  for (const entry of entries) {
    const row = [
      entry.fullPath,
      entry.basename,
      entry.name || '',
      entry.description || '',
      entry.branch || '',
      entry.taskId,
      entry.planTitle || '',
      (entry.issueUrls || []).join(','),
    ];
    console.log(row.join('\t'));
  }
}

/**
 * Output workspaces in JSON format with full metadata.
 * Lock status is omitted from TSV/JSON per requirements.
 */
function outputWorkspaceJson(entries: WorkspaceListEntry[]): void {
  // Remove lockedBy from entries for JSON output
  const sanitizedEntries = entries.map(({ lockedBy, ...rest }) => rest);
  console.log(JSON.stringify(sanitizedEntries, null, 2));
}

async function removeMissingWorkspaceEntries(
  repositoryId: string,
  trackingFilePath?: string
): Promise<string[]> {
  const [trackingData, workspaces] = await Promise.all([
    readTrackingData(trackingFilePath),
    findWorkspacesByRepositoryId(repositoryId, trackingFilePath),
  ]);

  const removed: string[] = [];

  for (const workspace of workspaces) {
    const status = await getWorkspaceDirectoryStatus(workspace.workspacePath);
    if (status === 'missing' && trackingData[workspace.workspacePath]) {
      delete trackingData[workspace.workspacePath];
      removed.push(workspace.workspacePath);
    }
  }

  if (removed.length > 0) {
    await writeTrackingData(trackingData, trackingFilePath);
  }

  return removed;
}

/**
 * Removes workspace entries whose directories no longer exist across all repositories.
 * Used by --all flag to ensure stale entries are cleaned up globally.
 */
async function removeAllMissingWorkspaceEntries(trackingFilePath?: string): Promise<string[]> {
  const trackingData = await readTrackingData(trackingFilePath);
  const removed: string[] = [];

  for (const workspacePath of Object.keys(trackingData)) {
    const status = await getWorkspaceDirectoryStatus(workspacePath);
    if (status === 'missing') {
      delete trackingData[workspacePath];
      removed.push(workspacePath);
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

type WorkspaceDirectoryStatus = 'exists' | 'missing' | 'unknown';

async function getWorkspaceDirectoryStatus(
  directoryPath: string
): Promise<WorkspaceDirectoryStatus> {
  try {
    const stats = await fs.stat(directoryPath);
    return stats.isDirectory() ? 'exists' : 'missing';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing';
    }

    warn(`Failed to check workspace directory ${directoryPath}: ${error as Error}`);
    return 'unknown';
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
      ...(options.createBranch !== undefined && { createBranch: options.createBranch }),
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

  // Claim the plan in the new workspace
  if (planData?.uuid) {
    try {
      const repository = await getRepositoryIdentity({ cwd: workspace.path });
      const user = getUserIdentity();
      const planId =
        typeof planData.id === 'number' && !Number.isNaN(planData.id) ? planData.id : undefined;
      const planLabel = planId !== undefined ? String(planId) : planData.uuid;

      const claimResult = await claimPlan(planId, {
        uuid: planData.uuid,
        repositoryId: repository.repositoryId,
        repositoryRemoteUrl: repository.remoteUrl,
        workspacePath: repository.gitRoot,
        user,
      });

      logClaimOutcome(claimResult, {
        planLabel,
        workspacePath: repository.gitRoot,
        user,
      });
    } catch (err) {
      warn(`Failed to claim plan in workspace: ${err as Error}`);
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
  const repositoryId = await determineRepositoryId();
  await removeMissingWorkspaceEntries(repositoryId, trackingFilePath);

  const workspaces = await findWorkspacesByRepositoryId(repositoryId, trackingFilePath);
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

async function determineRepositoryId(cwd?: string): Promise<string> {
  const identity = await getRepositoryIdentity({ cwd });
  return identity.repositoryId;
}

function getDefaultLockOwner(): string | undefined {
  return process.env.USER || process.env.LOGNAME || process.env.USERNAME;
}

/**
 * Extracts issue number from an issue URL.
 * For example: "https://github.com/owner/repo/issues/123" -> "#123"
 */
export function extractIssueNumber(url: string): string | undefined {
  // Match common issue URL patterns (GitHub, GitLab, Linear, etc.)
  const patterns = [
    /\/issues\/(\d+)/, // GitHub, GitLab
    /\/issue\/([A-Z]+-\d+)/i, // Linear (e.g., PROJ-123)
    /\/browse\/([A-Z]+-\d+)/i, // Jira (e.g., PROJ-123)
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      // For numeric issue numbers, add #; for alphanumeric (like Linear/Jira), return as-is
      return match[1].match(/^\d+$/) ? `#${match[1]}` : match[1];
    }
  }

  return undefined;
}

/**
 * Builds a workspace description from a plan.
 * Format: "#issueNumber planTitle" or just "planTitle" if no issue.
 */
export function buildDescriptionFromPlan(plan: PlanSchema): string {
  const title = getCombinedTitleFromSummary(plan);

  // Try to extract issue number from the first issue URL
  if (plan.issue && plan.issue.length > 0) {
    const issueRef = extractIssueNumber(plan.issue[0]);
    if (issueRef) {
      return `${issueRef} ${title}`;
    }
  }

  return title;
}

export async function handleWorkspaceUpdateCommand(
  target: string | undefined,
  options: { name?: string; description?: string; fromPlan?: string },
  command: Command
) {
  const globalOpts = command.parent!.parent!.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const trackingFilePath = config.paths?.trackingFile;

  // Validate that at least one update option is provided
  if (options.name === undefined && options.description === undefined && !options.fromPlan) {
    throw new Error('At least one of --name, --description, or --from-plan must be provided.');
  }

  // Resolve workspace path - either from identifier or current directory
  let workspacePath: string;

  if (target) {
    // Try to resolve as a path first
    const asPath = path.resolve(process.cwd(), target);
    if (await workspaceDirectoryExists(asPath)) {
      workspacePath = asPath;
    } else {
      // Try to resolve as task ID
      const matches = await findWorkspacesByTaskId(target, trackingFilePath);
      if (matches.length === 0) {
        throw new Error(`No workspace found for task ID: ${target}`);
      }
      if (matches.length > 1) {
        throw new Error(
          `Multiple workspaces found for task ID ${target}. Please specify the workspace directory.`
        );
      }
      workspacePath = matches[0].workspacePath;
    }
  } else {
    // Use current directory
    workspacePath = process.cwd();
  }

  // Verify directory exists
  if (!(await workspaceDirectoryExists(workspacePath))) {
    throw new Error(`Workspace directory does not exist: ${workspacePath}`);
  }

  // Build the patch object
  const patch: WorkspaceMetadataPatch = {};
  const existingMetadata = await getWorkspaceMetadata(workspacePath, trackingFilePath);

  // Handle name
  if (options.name !== undefined) {
    patch.name = options.name;
  }

  // Handle description - from-plan takes precedence if both specified
  if (options.fromPlan) {
    try {
      const planPath = await resolvePlanFile(options.fromPlan, globalOpts.config);
      const plan = await readPlanFile(planPath);
      patch.description = buildDescriptionFromPlan(plan);

      // Also populate plan metadata fields
      patch.planId = plan.id ? String(plan.id) : '';
      const planTitle = getCombinedTitleFromSummary(plan);
      patch.planTitle = planTitle || '';
      patch.issueUrls = plan.issue && plan.issue.length > 0 ? [...plan.issue] : [];
    } catch (err) {
      throw new Error(`Failed to read plan for --from-plan: ${err as Error}`);
    }
  } else if (options.description !== undefined) {
    patch.description = options.description;
  }

  if (!existingMetadata?.repositoryId) {
    patch.repositoryId = await determineRepositoryId(workspacePath);
  }

  // Apply the patch
  const updated = await patchWorkspaceMetadata(workspacePath, patch, trackingFilePath);

  // Display result
  log(chalk.green('Workspace metadata updated'));
  log(`  Path: ${workspacePath}`);
  if (updated.name) {
    log(`  Name: ${updated.name}`);
  }
  if (updated.description) {
    log(`  Description: ${updated.description}`);
  }
  if (updated.planId) {
    log(`  Plan ID: ${updated.planId}`);
  }
}
