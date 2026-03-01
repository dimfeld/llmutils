// Command handler for 'tim workspace'
// Manages workspaces for plans (with subcommands list and add)

import * as path from 'path';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { table, type TableUserConfig } from 'table';
import { log, warn } from '../../logging.js';
import {
  getCurrentBranchName,
  getCurrentCommitHash,
  getCurrentJujutsuBranch,
  getGitRoot,
  getUsingJj,
  hasUncommittedChanges,
  isInGitRepository,
} from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanFile, readPlanFile, setPlanStatus } from '../plans.js';
import { generateAlphanumericId } from '../id_utils.js';
import { WorkspaceAutoSelector } from '../workspace/workspace_auto_selector.js';
import {
  createWorkspace,
  prepareExistingWorkspace,
  runWorkspaceUpdateCommands,
} from '../workspace/workspace_manager.js';
import { deleteWorkspace } from '../db/workspace.js';
import { getDatabase } from '../db/database.js';
import {
  formatWorkspacePath,
  getCombinedTitleFromSummary,
  buildDescriptionFromPlan,
  extractIssueNumber,
} from '../display_utils.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import type { PlanSchema } from '../planSchema.js';
import type { TimConfig } from '../configSchema.js';
import type { Command } from 'commander';
import { claimPlan } from '../assignments/claim_plan.js';
import { logClaimOutcome } from '../assignments/claim_logging.js';
import { getRepositoryIdentity, getUserIdentity } from '../assignments/workspace_identifier.js';
import { getIssueTracker } from '../../common/issue_tracker/factory.js';
import { importSingleIssue } from './import/import.js';
import { readAllPlans } from '../plans.js';
import { parseIssueInput, type ParsedIssueInput } from '../issue_utils.js';
import { spawnAndLogOutput } from '../../common/process.js';
import { generateBranchNameFromPlan } from './branch.js';
import {
  findPrimaryWorkspaceForRepository,
  findWorkspaceInfosByRepositoryId,
  findWorkspaceInfosByTaskId,
  getWorkspaceInfoByPath,
  listAllWorkspaceInfos,
  patchWorkspaceInfo,
  type WorkspaceInfo,
  type WorkspaceMetadataPatch,
} from '../workspace/workspace_info.js';
import { getAssignmentEntriesByProject } from '../db/assignment.js';
import { getProject } from '../db/project.js';

const PRIMARY_REMOTE_NAME = 'primary';

export type WorkspaceListFormat = 'table' | 'tsv' | 'json';

interface WorkspaceListEntry {
  fullPath: string;
  basename: string;
  name?: string;
  description?: string;
  branch?: string;
  taskId: string;
  planTitle?: string;
  planId?: string;
  issueUrls?: string[];
  repositoryId?: string;
  lockedBy?: WorkspaceInfo['lockedBy'];
  isPrimary?: boolean;
  createdAt: string;
  updatedAt?: string;
  mostRecentAssignment?: string;
  mostRecentAssignmentPlanId?: number;
  mostRecentAssignmentStatus?: string;
}

interface WorkspaceAssignmentSummary {
  planId?: number;
  status?: string;
  updatedAt: string;
}

function getWorkspaceRecencyTimestamp(entry: WorkspaceListEntry): number {
  const updatedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : Number.NaN;
  if (!Number.isNaN(updatedAt)) {
    return updatedAt;
  }

  const createdAt = Date.parse(entry.createdAt);
  if (!Number.isNaN(createdAt)) {
    return createdAt;
  }

  return Number.NEGATIVE_INFINITY;
}

export interface WorkspaceListOptions {
  repo?: string;
  format?: WorkspaceListFormat;
  header?: boolean;
  all?: boolean;
}

async function updateWorkspaceLockStatus(workspaces: WorkspaceInfo[]): Promise<WorkspaceInfo[]> {
  return Promise.all(
    workspaces.map(async (workspace) => {
      const lockInfo = await WorkspaceLock.getLockInfo(workspace.workspacePath);
      if (lockInfo && !(await WorkspaceLock.isLockStale(lockInfo))) {
        return {
          ...workspace,
          lockedBy: {
            type: lockInfo.type,
            pid: lockInfo.pid,
            startedAt: lockInfo.startedAt,
            hostname: lockInfo.hostname,
            command: lockInfo.command,
          },
        };
      }

      const { lockedBy, ...workspaceWithoutLock } = workspace;
      return workspaceWithoutLock;
    })
  );
}

async function buildWorkspaceListEntries(
  workspaces: WorkspaceInfo[],
  mostRecentAssignmentByWorkspace: Record<string, WorkspaceAssignmentSummary>
): Promise<WorkspaceListEntry[]> {
  const entries: WorkspaceListEntry[] = [];

  for (const workspace of workspaces) {
    try {
      const stats = await fs.stat(workspace.workspacePath);
      if (!stats.isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    let branch: string | undefined;
    try {
      branch = (await getCurrentBranchName(workspace.workspacePath)) ?? undefined;
    } catch {
      // Keep metadata branch fallback below.
    }

    entries.push({
      fullPath: workspace.workspacePath,
      basename: path.basename(workspace.workspacePath),
      name: workspace.name,
      description: workspace.description,
      branch: branch ?? workspace.branch,
      taskId: workspace.taskId,
      planTitle: workspace.planTitle,
      planId: workspace.planId,
      issueUrls: workspace.issueUrls,
      repositoryId: workspace.repositoryId,
      lockedBy: workspace.lockedBy,
      isPrimary: workspace.isPrimary,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      mostRecentAssignment: buildWorkspaceAssignmentDisplay(
        mostRecentAssignmentByWorkspace[workspace.workspacePath]
      ),
      mostRecentAssignmentPlanId: mostRecentAssignmentByWorkspace[workspace.workspacePath]?.planId,
      mostRecentAssignmentStatus:
        mostRecentAssignmentByWorkspace[workspace.workspacePath]?.status ?? undefined,
    });
  }

  return entries;
}

function buildWorkspaceAssignmentDisplay(assignment?: WorkspaceAssignmentSummary): string {
  if (!assignment?.planId) {
    return '-';
  }

  const status = assignment.status ? assignment.status.replace(/_/g, ' ') : 'pending';
  return `${assignment.planId} - ${status}`;
}

async function resolveMostRecentAssignmentsForWorkspaces(
  workspaces: WorkspaceInfo[]
): Promise<Record<string, WorkspaceAssignmentSummary>> {
  const db = getDatabase();
  const mostRecentByWorkspacePath: Record<string, WorkspaceAssignmentSummary> = {};
  const workspacePathsByRepository = new Map<string, Set<string>>();

  for (const workspace of workspaces) {
    if (!workspace.repositoryId) {
      continue;
    }

    const repoPaths = workspacePathsByRepository.get(workspace.repositoryId) ?? new Set();
    repoPaths.add(workspace.workspacePath);
    workspacePathsByRepository.set(workspace.repositoryId, repoPaths);
  }

  for (const [repositoryId, workspacePaths] of workspacePathsByRepository) {
    const project = getProject(db, repositoryId);
    if (!project) {
      continue;
    }

    const assignments = getAssignmentEntriesByProject(db, project.id);
    for (const assignment of Object.values(assignments)) {
      for (const workspacePath of assignment.workspacePaths) {
        if (!workspacePaths.has(workspacePath)) {
          continue;
        }

        const current = mostRecentByWorkspacePath[workspacePath];
        const candidateUpdatedAt = Date.parse(assignment.updatedAt);
        if (Number.isNaN(candidateUpdatedAt)) {
          continue;
        }

        const currentUpdatedAt = current ? Date.parse(current.updatedAt) : Number.NaN;
        if (Number.isNaN(currentUpdatedAt) || candidateUpdatedAt > currentUpdatedAt) {
          mostRecentByWorkspacePath[workspacePath] = {
            planId: assignment.planId,
            status: assignment.status,
            updatedAt: assignment.updatedAt,
          };
        }
      }
    }
  }

  return mostRecentByWorkspacePath;
}

export async function handleWorkspaceListCommand(options: WorkspaceListOptions, command: Command) {
  const globalOpts = command.parent!.parent!.opts();

  // Check if we're in a git repository
  const inGitRepo = await isInGitRepository();

  // If not in a git repo, suppress the external storage message
  const config = await loadEffectiveConfig(globalOpts.config, { quiet: !inGitRepo });

  const format: WorkspaceListFormat = options.format ?? 'table';
  const showHeader = options.header ?? true;

  // Determine repository ID (unless --all is specified OR we're outside a git repo)
  let repositoryId: string | undefined;
  if (!options.all && inGitRepo) {
    repositoryId = options.repo ?? (await determineRepositoryId());
  }

  // Get workspaces based on whether we're filtering by repo
  let workspaces: WorkspaceInfo[];
  if (repositoryId) {
    const removedWorkspaces = await removeMissingWorkspaceEntries(repositoryId);
    for (const workspacePath of removedWorkspaces) {
      warn(`Removed deleted workspace directory: ${workspacePath}`);
    }
    workspaces = findWorkspaceInfosByRepositoryId(repositoryId);
  } else {
    // --all: get all workspaces from tracking file, also cleaning up stale entries
    const removedWorkspaces = await removeAllMissingWorkspaceEntries();
    for (const workspacePath of removedWorkspaces) {
      warn(`Removed deleted workspace directory: ${workspacePath}`);
    }
    workspaces = listAllWorkspaceInfos();
  }

  // Update lock status for all workspaces
  const workspacesWithStatus = await updateWorkspaceLockStatus(workspaces);
  const mostRecentAssignments =
    await resolveMostRecentAssignmentsForWorkspaces(workspacesWithStatus);

  // Build enriched list entries with live branch info
  const entries = await buildWorkspaceListEntries(workspacesWithStatus, mostRecentAssignments);

  // Sort entries by recency (most recent first).
  entries.sort((a, b) => {
    const recencyDiff = getWorkspaceRecencyTimestamp(b) - getWorkspaceRecencyTimestamp(a);
    if (recencyDiff !== 0) {
      return recencyDiff;
    }

    return a.fullPath.localeCompare(b.fullPath);
  });

  if (entries.length === 0) {
    if (format === 'table') {
      console.log(repositoryId ? 'No workspaces found for this repository' : 'No workspaces found');
    } else if (format === 'json') {
      console.log('[]');
    }
    // For TSV with no entries, output nothing (no header needed for 2-column format)
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
  const relativeFormatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

  const formatRelativeTime = (updatedAt: string | undefined): string => {
    if (!updatedAt) {
      return '-';
    }

    const parsed = Date.parse(updatedAt);
    if (Number.isNaN(parsed)) {
      return updatedAt;
    }

    const now = Date.now();
    const deltaMs = now - parsed;
    const absMs = Math.abs(deltaMs);

    if (absMs < 60 * 1000) {
      return 'just now';
    }

    const formatElapsed = (value: number, unit: Intl.RelativeTimeFormatUnit): string => {
      const amount = deltaMs >= 0 ? -Math.round(value) : Math.round(value);
      return relativeFormatter.format(amount, unit);
    };

    const minutes = deltaMs / (1000 * 60);
    if (Math.abs(minutes) < 60) {
      return formatElapsed(minutes, 'minute');
    }

    const hours = minutes / 60;
    if (Math.abs(hours) < 24) {
      return formatElapsed(hours, 'hour');
    }

    const days = hours / 24;
    return formatElapsed(days, 'day');
  };

  const tableData: string[][] = [];

  if (showHeader) {
    tableData.push([
      chalk.bold('Path'),
      chalk.bold('Name'),
      chalk.bold('Description'),
      chalk.bold('Branch'),
      chalk.bold('Status'),
      chalk.bold('Plan'),
    ]);
  }

  for (const entry of entries) {
    const abbreviatedPath = formatWorkspacePath(entry.fullPath);
    const name = entry.name || '-';
    const description = entry.description || '-';
    const branch = entry.branch || '-';
    const relativeUpdatedAt = formatRelativeTime(entry.updatedAt);
    const plan = `${relativeUpdatedAt}\n${entry.mostRecentAssignment || '-'}`;

    let status: string;
    if (entry.isPrimary) {
      status = chalk.blue('Primary');
    } else if (entry.lockedBy) {
      const lockType = entry.lockedBy.type;
      status = chalk.red(`Locked (${lockType})`);
    } else {
      status = chalk.green('Available');
    }

    tableData.push([abbreviatedPath, name, description, branch, status, plan]);
  }

  const tableConfig: TableUserConfig = {
    columns: {
      0: { width: 30, wrapWord: true },
      1: { width: 15, wrapWord: true },
      2: { width: 35, wrapWord: true },
      3: { width: 20, wrapWord: true },
      4: { width: 15, wrapWord: true },
      5: { width: 24, wrapWord: true },
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
 * Formats a workspace entry into a human-readable description string.
 * Deduplicates identical values (e.g., if name equals planTitle, only show once).
 * Exported for testing.
 */
export function formatWorkspaceDescription(entry: WorkspaceListEntry): string {
  const parts: string[] = [];

  // Start with the directory basename for identification
  parts.push(entry.basename);

  // Collect unique descriptive elements (deduplicate identical values)
  const seenValues = new Set<string>();

  // Add name if distinct
  if (entry.name && !seenValues.has(entry.name.toLowerCase())) {
    seenValues.add(entry.name.toLowerCase());
    parts.push(entry.name);
  }

  // Add planTitle if distinct from name
  if (entry.planTitle && !seenValues.has(entry.planTitle.toLowerCase())) {
    seenValues.add(entry.planTitle.toLowerCase());
    parts.push(entry.planTitle);
  }

  // Add description if distinct and meaningful
  if (entry.description && !seenValues.has(entry.description.toLowerCase())) {
    // Skip if description is just a subset of already-included text
    const descLower = entry.description.toLowerCase();
    const alreadyCovered = Array.from(seenValues).some(
      (v) => v.includes(descLower) || descLower.includes(v)
    );
    if (!alreadyCovered) {
      seenValues.add(descLower);
      parts.push(entry.description);
    }
  }

  // Add branch if present
  if (entry.branch) {
    parts.push(`[${entry.branch}]`);
  }

  // Add issue reference if present (extract short form from URLs)
  if (entry.issueUrls && entry.issueUrls.length > 0) {
    const issueRefs = entry.issueUrls
      .map((url) => extractIssueNumber(url))
      .filter((ref): ref is string => !!ref);
    if (issueRefs.length > 0) {
      // Only add if not already mentioned in description/name
      const refsStr = issueRefs.join(', ');
      const alreadyMentioned = Array.from(seenValues).some((v) =>
        issueRefs.some((ref) => v.includes(ref.toLowerCase()))
      );
      if (!alreadyMentioned) {
        parts.push(refsStr);
      }
    }
  }

  return parts.join(' | ');
}

/**
 * Output workspaces in TSV format for machine consumption.
 * Format: fullPath\tformattedDescription
 * The first column is the full path (for machine use), the second is a human-readable description.
 * Lock status is omitted from TSV/JSON per requirements.
 */
function outputWorkspaceTsv(entries: WorkspaceListEntry[], _showHeader: boolean): void {
  for (const entry of entries) {
    const description = formatWorkspaceDescription(entry);
    console.log(`${entry.fullPath}\t${description}`);
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

async function removeMissingWorkspaceEntries(repositoryId: string): Promise<string[]> {
  const workspaces = findWorkspaceInfosByRepositoryId(repositoryId);
  const removed: string[] = [];
  const db = getDatabase();

  for (const workspace of workspaces) {
    const status = await getWorkspaceDirectoryStatus(workspace.workspacePath);
    if (status === 'missing') {
      deleteWorkspace(db, workspace.workspacePath);
      removed.push(workspace.workspacePath);
    }
  }

  return removed;
}

/**
 * Removes workspace entries whose directories no longer exist across all repositories.
 * Used by --all flag to ensure stale entries are cleaned up globally.
 */
async function removeAllMissingWorkspaceEntries(): Promise<string[]> {
  const workspaces = listAllWorkspaceInfos();
  const removed: string[] = [];
  const db = getDatabase();

  for (const workspace of workspaces) {
    const status = await getWorkspaceDirectoryStatus(workspace.workspacePath);
    if (status === 'missing') {
      deleteWorkspace(db, workspace.workspacePath);
      removed.push(workspace.workspacePath);
    }
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

/**
 * Result of attempting to reuse an existing workspace.
 */
interface TryReuseResult {
  /** Whether an existing workspace was successfully reused */
  success: boolean;
  /** Error message describing the last reuse failure */
  error?: string;
  /** Path to the reused workspace (only set if success is true) */
  workspacePath?: string;
  /** Existing task ID for the reused workspace */
  taskId?: string;
  /** The actual branch name created (may include auto-suffix) */
  actualBranchName?: string;
  /** Path to the plan file copied to the workspace (only set if a plan was provided) */
  planFilePathInWorkspace?: string;
}

interface WorkspaceRestoreState {
  branch: string | null;
  commit: string | null;
  isJj: boolean;
}

async function captureWorkspaceRestoreState(
  workspacePath: string
): Promise<WorkspaceRestoreState | null> {
  try {
    const gitRoot = await getGitRoot(workspacePath);
    const isJj = await fs
      .stat(path.join(gitRoot, '.jj'))
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    const [branch, commit] = await Promise.all([
      isJj ? getCurrentJujutsuBranch(workspacePath) : getCurrentBranchName(workspacePath),
      getCurrentCommitHash(gitRoot),
    ]);

    return { branch, commit, isJj };
  } catch (error) {
    warn(`Failed to capture workspace state before reuse: ${error as Error}`);
    return null;
  }
}

async function restoreWorkspaceState(
  workspacePath: string,
  state: WorkspaceRestoreState,
  createdBranch: string | undefined,
  shouldCreateBranch: boolean
): Promise<void> {
  const restoreTargets = [state.branch, state.commit].filter(
    (target, index, items): target is string => Boolean(target) && items.indexOf(target) === index
  );
  if (restoreTargets.length === 0) {
    warn('Unable to restore workspace state: no branch or commit recorded.');
    return;
  }

  let restored = false;
  let lastRestoreError: string | undefined;
  for (const restoreTarget of restoreTargets) {
    const restoreArgs = state.isJj
      ? ['jj', 'edit', restoreTarget]
      : ['git', 'checkout', restoreTarget];
    const restoreResult = await spawnAndLogOutput(restoreArgs, { cwd: workspacePath });
    if (restoreResult.exitCode === 0) {
      restored = true;
      break;
    }
    lastRestoreError = restoreResult.stderr;
  }

  if (!restored) {
    const errorMessage = `Failed to restore workspace to ${restoreTargets[0]}: ${
      lastRestoreError ?? ''
    }`.trim();
    warn(errorMessage);
    return;
  }

  if (!shouldCreateBranch || !createdBranch || createdBranch === state.branch) {
    return;
  }

  const deleteArgs = state.isJj
    ? ['jj', 'bookmark', 'delete', createdBranch]
    : ['git', 'branch', '-D', createdBranch];
  const deleteResult = await spawnAndLogOutput(deleteArgs, { cwd: workspacePath });
  if (deleteResult.exitCode !== 0) {
    warn(`Failed to delete branch "${createdBranch}": ${deleteResult.stderr}`);
  }
}

async function cleanupCopiedPlanPath(
  workspacePath: string,
  planFilePathInWorkspace: string | undefined,
  planFileExisted: boolean
): Promise<void> {
  if (!planFilePathInWorkspace || planFileExisted) {
    return;
  }

  const relativePath = path.relative(workspacePath, planFilePathInWorkspace);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    warn(`Skipping plan cleanup for unexpected path: ${planFilePathInWorkspace}`);
    return;
  }

  try {
    await fs.rm(planFilePathInWorkspace, { force: true, recursive: true });
  } catch (error) {
    warn(`Failed to remove copied plan file: ${error as Error}`);
    return;
  }

  let currentDir = path.dirname(planFilePathInWorkspace);
  while (currentDir !== workspacePath) {
    try {
      const entries = await fs.readdir(currentDir);
      if (entries.length > 0) {
        break;
      }
      await fs.rmdir(currentDir);
    } catch {
      break;
    }
    currentDir = path.dirname(currentDir);
  }
}

/**
 * Attempts to find and reuse an existing unlocked, clean workspace.
 *
 * This function:
 * 1. Finds available workspaces for the same repository
 * 2. Filters out locked workspaces and those with uncommitted changes
 * 3. Acquires a lock on the workspace
 * 4. Prepares the selected workspace (fetch, checkout base, create new branch)
 * 5. Updates workspace metadata
 *
 * @returns TryReuseResult indicating success and workspace details, or failure
 */
async function tryReuseExistingWorkspace(
  config: TimConfig,
  _trackingFilePath: string | undefined,
  options: {
    fromBranch?: string;
    createBranch?: boolean;
    branchName: string;
    planData?: PlanSchema;
    resolvedPlanFilePath?: string;
    mainRepoRoot: string;
    name?: string;
    issueUrls?: string[];
  }
): Promise<TryReuseResult> {
  // Find repository ID
  const repositoryId = await determineRepositoryId();

  // Clean up missing workspace entries
  await removeMissingWorkspaceEntries(repositoryId);

  // Find all workspaces for this repository
  const workspaces = findWorkspaceInfosByRepositoryId(repositoryId);
  const workspacesWithStatus = await updateWorkspaceLockStatus(workspaces);

  // Filter to only unlocked workspaces
  const unlockedWorkspaces = workspacesWithStatus.filter(
    (workspace) => !workspace.lockedBy && !workspace.isPrimary
  );

  if (unlockedWorkspaces.length === 0) {
    log('No unlocked workspaces found for reuse');
    return { success: false };
  }

  // Check each unlocked workspace for uncommitted changes, attempt to lock, and prepare
  let foundCleanWorkspace = false;
  let lastFailureReason: string | undefined;

  for (const workspace of unlockedWorkspaces) {
    const dirStatus = await getWorkspaceDirectoryStatus(workspace.workspacePath);
    if (dirStatus !== 'exists') {
      continue;
    }

    const [isJjWorkspace, hasChanges] = await Promise.all([
      getUsingJj(workspace.workspacePath),
      hasUncommittedChanges(workspace.workspacePath),
    ]);
    if (hasChanges && !isJjWorkspace) {
      log(`Skipping workspace ${workspace.workspacePath}: has uncommitted changes`);
      continue;
    }

    foundCleanWorkspace = true;

    // Acquire lock on the workspace before making any changes
    let lockInfo: Awaited<ReturnType<typeof WorkspaceLock.acquireLock>> | null = null;
    const shouldCreateBranch = options.createBranch ?? true;
    try {
      lockInfo = await WorkspaceLock.acquireLock(
        workspace.workspacePath,
        `tim workspace add --reuse`,
        {
          owner: getDefaultLockOwner(),
        }
      );
      WorkspaceLock.setupCleanupHandlers(workspace.workspacePath, lockInfo.type);
    } catch (error) {
      warn(`Failed to acquire workspace lock: ${error as Error}`);
      continue;
    }

    const restoreState = await captureWorkspaceRestoreState(workspace.workspacePath);
    const restoreWorkspace = async (createdBranch: string | undefined) => {
      if (!restoreState) {
        return;
      }
      await restoreWorkspaceState(
        workspace.workspacePath,
        restoreState,
        createdBranch,
        shouldCreateBranch
      );
    };

    let prepareResult: Awaited<ReturnType<typeof prepareExistingWorkspace>> | null = null;
    try {
      log(`Reusing existing workspace: ${workspace.workspacePath}`);

      // Prepare the workspace (fetch, checkout base branch, create new branch)
      prepareResult = await prepareExistingWorkspace(workspace.workspacePath, {
        baseBranch: options.fromBranch,
        branchName: options.branchName,
        createBranch: shouldCreateBranch,
      });

      if (!prepareResult.success) {
        const failureReason = `Failed to prepare workspace for reuse: ${prepareResult.error}`;
        warn(failureReason);
        lastFailureReason = failureReason;
        await restoreWorkspace(undefined);
        await WorkspaceLock.releaseLock(workspace.workspacePath, { force: true });
        continue;
      }

      const planFilePathInWorkspace = options.resolvedPlanFilePath
        ? path.join(
            workspace.workspacePath,
            path.relative(options.mainRepoRoot, options.resolvedPlanFilePath)
          )
        : undefined;
      // Copy plan file to workspace if provided
      let planFileExisted = false;
      if (options.resolvedPlanFilePath) {
        const resolvedPlanPathInWorkspace = planFilePathInWorkspace!;
        const relativePlanPath = path.relative(options.mainRepoRoot, options.resolvedPlanFilePath);
        const planFileDir = path.dirname(resolvedPlanPathInWorkspace);

        try {
          planFileExisted = await fs
            .access(resolvedPlanPathInWorkspace)
            .then(() => true)
            .catch(() => false);
          await fs.mkdir(planFileDir, { recursive: true });
          log(`Copying plan file to workspace: ${relativePlanPath}`);
          await fs.copyFile(options.resolvedPlanFilePath, resolvedPlanPathInWorkspace);
        } catch (error) {
          const failureReason = `Failed to copy plan file: ${error as Error}`;
          warn(failureReason);
          lastFailureReason = failureReason;
          await cleanupCopiedPlanPath(
            workspace.workspacePath,
            resolvedPlanPathInWorkspace,
            planFileExisted
          );
          await restoreWorkspace(prepareResult.actualBranchName);
          await WorkspaceLock.releaseLock(workspace.workspacePath, { force: true });
          continue;
        }
      }

      const updateSuccess = await runWorkspaceUpdateCommands(
        workspace.workspacePath,
        config,
        workspace.taskId,
        planFilePathInWorkspace
      );
      if (!updateSuccess) {
        const failureReason = 'Failed to run workspace update commands for workspace reuse';
        warn(failureReason);
        lastFailureReason = failureReason;
        await cleanupCopiedPlanPath(
          workspace.workspacePath,
          planFilePathInWorkspace,
          planFileExisted
        );
        await restoreWorkspace(prepareResult.actualBranchName);
        await WorkspaceLock.releaseLock(workspace.workspacePath, { force: true });
        continue;
      }

      // Update workspace metadata
      const metadataPatch: WorkspaceMetadataPatch = {
        name: options.name,
        branch: prepareResult.actualBranchName,
      };

      if (options.planData) {
        const planDescription = buildDescriptionFromPlan(options.planData);
        const planId = options.planData.id ? String(options.planData.id) : '';
        metadataPatch.description = planId ? `${planId} - ${planDescription}` : planDescription;
        metadataPatch.planId = planId;
        metadataPatch.planTitle = options.planData.title || options.planData.goal || '';
        if (options.planData.issue?.length) {
          metadataPatch.issueUrls = [...options.planData.issue];
        } else {
          metadataPatch.issueUrls = [];
        }
      } else {
        metadataPatch.description = '';
        metadataPatch.planId = '';
        metadataPatch.planTitle = '';
        metadataPatch.issueUrls = [];
      }

      if (options.issueUrls?.length) {
        metadataPatch.issueUrls = options.issueUrls;
      }

      patchWorkspaceInfo(workspace.workspacePath, metadataPatch);

      return {
        success: true,
        workspacePath: workspace.workspacePath,
        taskId: workspace.taskId,
        actualBranchName: prepareResult.actualBranchName,
        planFilePathInWorkspace,
      };
    } catch (error) {
      await restoreWorkspace(prepareResult?.actualBranchName);
      await WorkspaceLock.releaseLock(workspace.workspacePath, { force: true });
      throw error;
    }
  }

  if (!foundCleanWorkspace) {
    log('No clean, unlocked workspaces found for reuse');
  } else {
    log('No available workspace could be prepared for reuse');
  }

  return { success: false, ...(lastFailureReason ? { error: lastFailureReason } : {}) };
}

export async function handleWorkspaceAddCommand(
  planIdentifier: string | undefined,
  options: any,
  command: Command
) {
  const globalOpts = command.parent!.parent!.opts();

  if (options.reuse && options.tryReuse) {
    throw new Error('Cannot use both --reuse and --try-reuse');
  }

  // Load configuration
  const config = await loadEffectiveConfig(globalOpts.config);
  const gitRoot = (await getGitRoot()) || process.cwd();

  // Check if workspace creation is enabled
  if (!config.workspaceCreation) {
    throw new Error(
      'Workspace creation is not enabled in configuration.\nAdd "workspaceCreation" section to your tim config file.'
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

  // Handle --issue option: parse issue identifier and determine branch naming
  let issueInfo: ParsedIssueInput | null = null;
  let customBranchName: string | undefined;

  if (options.issue) {
    issueInfo = parseIssueInput(options.issue);
    if (!issueInfo) {
      throw new Error(
        `Invalid issue identifier: ${options.issue}. ` +
          'Expected a Linear key (e.g., DF-1245), GitHub issue number (e.g., 123), ' +
          'issue URL, or branch name containing an issue ID (e.g., feature-df-1245).'
      );
    }

    // If input was a branch name, use it as the custom branch name
    if (issueInfo.isBranchName) {
      customBranchName = issueInfo.originalInput;
    }
  }

  // Determine workspace ID
  let workspaceId: string;
  if (options.id) {
    workspaceId = options.id;
  } else if (issueInfo) {
    // Use issue identifier for workspace ID
    workspaceId = `issue-${issueInfo.identifier}`;
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

  // Determine the branch name to use
  const branchName = customBranchName || workspaceId;

  // Try to reuse an existing workspace if --reuse or --try-reuse is specified
  const shouldTryReuse = options.reuse || options.tryReuse;

  // Workspace-like object to hold the path and plan file path
  let workspace: { path: string; planFilePathInWorkspace?: string; taskId: string } | null = null;
  let wasReused = false;

  if (shouldTryReuse) {
    const trackingFilePath = effectiveConfig.paths?.trackingFile;
    const issueUrls = planData?.issue?.length
      ? planData.issue
      : issueInfo
        ? [issueInfo.originalInput]
        : undefined;
    const reuseResult = await tryReuseExistingWorkspace(effectiveConfig, trackingFilePath, {
      fromBranch: options.fromBranch,
      createBranch: effectiveConfig.workspaceCreation?.createBranch,
      branchName,
      planData,
      resolvedPlanFilePath,
      mainRepoRoot: gitRoot,
      name: planData?.title || planData?.goal || issueInfo?.identifier || workspaceId,
      issueUrls,
    });

    if (reuseResult.success) {
      log(chalk.green(`Reusing existing workspace at: ${reuseResult.workspacePath}`));
      workspace = {
        path: reuseResult.workspacePath!,
        planFilePathInWorkspace: reuseResult.planFilePathInWorkspace,
        taskId: reuseResult.taskId ?? workspaceId,
      };
      wasReused = true;
    } else {
      if (options.reuse) {
        const reuseFailureReason = reuseResult.error
          ? `Last reuse attempt failed: ${reuseResult.error}`
          : 'All workspaces are either locked or have uncommitted changes.';
        throw new Error(`No available workspace found for reuse. ${reuseFailureReason}`);
      }
      // --try-reuse: fall through to normal workspace creation
      log('No available workspace found for reuse, creating new workspace...');
    }
  }

  // Create a new workspace if we didn't reuse one
  if (!workspace) {
    log(`Creating workspace with ID: ${workspaceId}`);

    const createdWorkspace = await createWorkspace(
      gitRoot,
      workspaceId,
      resolvedPlanFilePath,
      effectiveConfig,
      {
        ...(customBranchName && { branchName: customBranchName }),
        ...(options.fromBranch && { fromBranch: options.fromBranch }),
        ...(planData && { planData }),
        ...(options.targetDir && { targetDir: options.targetDir }),
      }
    );

    if (!createdWorkspace) {
      throw new Error('Failed to create workspace');
    }

    workspace = createdWorkspace;
  }

  // Import issue into workspace if --issue was provided
  let importedPlanFile: string | undefined;
  let importedPlan: (PlanSchema & { filename: string }) | undefined;
  if (issueInfo) {
    try {
      log(`Importing issue ${issueInfo.identifier} into workspace...`);

      // Get issue tracker and import the issue
      const issueTracker = await getIssueTracker(effectiveConfig);
      const tasksDir = path.join(workspace.path, effectiveConfig.paths?.tasks || 'tasks');

      // Read existing plans from workspace to pass to importSingleIssue
      const { plans: allPlans } = await readAllPlans(tasksDir);

      // Import the issue
      const success = await importSingleIssue(
        issueInfo.originalInput,
        tasksDir,
        issueTracker,
        {}, // No additional options for import
        allPlans,
        false // withSubissues
      );

      if (success) {
        log(chalk.green(`✓ Issue ${issueInfo.identifier} imported successfully`));
        // Find the imported plan file to show in success message
        const { plans: updatedPlans } = await readAllPlans(tasksDir, false);
        for (const [_, plan] of updatedPlans) {
          if (plan.issue?.some((url: string) => url.includes(issueInfo.identifier))) {
            importedPlanFile = plan.filename;
            importedPlan = plan;
            break;
          }
        }
      } else {
        warn(`Issue ${issueInfo.identifier} was already imported or import failed`);
      }
    } catch (err) {
      warn(`Failed to import issue: ${err as Error}`);
    }
  }

  if (wasReused && importedPlan) {
    const planDescription = buildDescriptionFromPlan(importedPlan);
    const planId = importedPlan.id ? String(importedPlan.id) : '';
    const metadataPatch: WorkspaceMetadataPatch = {
      planId,
      planTitle: importedPlan.title || importedPlan.goal || '',
      description: planId ? `${planId} - ${planDescription}` : planDescription,
      issueUrls: importedPlan.issue?.length ? [...importedPlan.issue] : [],
    };

    patchWorkspaceInfo(workspace.path, metadataPatch);
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
      const planLabel = String(planData.id);

      const claimResult = await claimPlan(planData.id, {
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
  const actionVerb = wasReused ? 'reused' : 'created';
  log(chalk.green(`✓ Workspace ${actionVerb} successfully!`));
  log(`  Path: ${workspace.path}`);
  log(`  ID: ${workspace.taskId}`);
  if (wasReused && workspace.taskId !== workspaceId) {
    log(`  Requested ID: ${workspaceId}`);
  }
  if (workspace.planFilePathInWorkspace) {
    log(`  Plan file: ${path.relative(workspace.path, workspace.planFilePathInWorkspace)}`);
  }
  if (importedPlanFile) {
    log(`  Imported plan: ${path.relative(workspace.path, importedPlanFile)}`);
  }
  log('');
  log('Next steps:');
  log(`  1. cd ${workspace.path}`);
  if (resolvedPlanFilePath) {
    log(
      `  2. tim agent ${path.basename(workspace.planFilePathInWorkspace || resolvedPlanFilePath)}`
    );
    log(
      `     or tim edit ${path.basename(workspace.planFilePathInWorkspace || resolvedPlanFilePath)} to view the plan`
    );
  } else if (importedPlanFile) {
    log(`  2. tim agent ${path.basename(importedPlanFile)}`);
    log(`     or tim edit ${path.basename(importedPlanFile)} to view the plan`);
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

  if (options.available && target) {
    throw new Error('Cannot specify a workspace identifier when using --available');
  }

  if (options.available) {
    await lockAvailableWorkspace(config, options);
    return;
  }

  const workspace = await resolveWorkspaceIdentifier(target);

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
  const workspace = await resolveWorkspaceIdentifier(target);

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

export async function handleWorkspacePushCommand(
  workspaceIdentifier: string | undefined,
  options: { from?: string; to?: string; branch?: string },
  _command: Command
) {
  const sourceWorkspace = await resolveWorkspaceIdentifier(options.from);
  const sourceWorkspacePath = sourceWorkspace.workspacePath;
  const sourceRepositoryId =
    sourceWorkspace.repositoryId ?? (await determineRepositoryId(sourceWorkspacePath));

  let destinationWorkspace: WorkspaceInfo;
  if (options.to) {
    destinationWorkspace = await resolveWorkspaceIdentifier(options.to);
    const destinationRepositoryId =
      destinationWorkspace.repositoryId ??
      (await determineRepositoryId(destinationWorkspace.workspacePath));
    if (destinationRepositoryId !== sourceRepositoryId) {
      throw new Error(
        `Source and destination workspaces are in different repositories: ${sourceRepositoryId} vs ${destinationRepositoryId}`
      );
    }
  } else if (workspaceIdentifier) {
    destinationWorkspace = await resolveWorkspaceIdentifier(workspaceIdentifier);
    const destinationRepositoryId =
      destinationWorkspace.repositoryId ??
      (await determineRepositoryId(destinationWorkspace.workspacePath));
    if (destinationRepositoryId !== sourceRepositoryId) {
      throw new Error(
        `Source and destination workspaces are in different repositories: ${sourceRepositoryId} vs ${destinationRepositoryId}`
      );
    }
  } else {
    const primaryWorkspace = findPrimaryWorkspaceForRepository(sourceRepositoryId);
    if (!primaryWorkspace) {
      throw new Error(
        'No primary workspace is configured for this repository. Mark one with: tim workspace update --primary'
      );
    }
    destinationWorkspace = primaryWorkspace;
  }

  if (path.resolve(sourceWorkspacePath) === path.resolve(destinationWorkspace.workspacePath)) {
    throw new Error('Source and destination workspaces are the same. Choose different workspaces.');
  }

  const branch =
    options.branch ?? (await getCurrentBranchName(sourceWorkspacePath)) ?? sourceWorkspace.branch;
  if (!branch) {
    throw new Error(
      `No current branch/bookmark detected for workspace ${sourceWorkspacePath}. Check out or create a branch before pushing.`
    );
  }

  await pushWorkspaceRefBetweenWorkspaces({
    sourceWorkspacePath,
    destinationWorkspacePath: destinationWorkspace.workspacePath,
    refName: branch,
  });

  log(chalk.green('✓ Workspace branch/bookmark pushed'));
  log(`  Source: ${sourceWorkspacePath}`);
  log(`  Destination: ${destinationWorkspace.workspacePath}`);
  log(`  Ref: ${branch}`);
}

export async function handleWorkspacePullPlanCommand(
  planIdentifier: string | undefined,
  options: { workspace?: string; branch?: string; remote?: string },
  command: Command
) {
  if (!planIdentifier) {
    throw new Error('Plan identifier is required.');
  }

  const globalOpts = command.parent!.parent!.opts();
  const workspace = await resolveWorkspaceIdentifier(options.workspace);
  const planFile = await resolvePlanFile(planIdentifier, globalOpts.config);
  const plan = await readPlanFile(planFile);
  const branchName = options.branch ?? plan.branch ?? generateBranchNameFromPlan(plan);
  const remoteName = options.remote ?? 'origin';

  if (!branchName) {
    throw new Error(
      `Could not determine a branch/bookmark name from plan ${planIdentifier}. Use --branch to specify one explicitly.`
    );
  }

  const pulled = await pullWorkspaceRefIfExists(workspace.workspacePath, branchName, remoteName);
  if (!pulled) {
    log(`No branch/bookmark "${branchName}" found in ${remoteName}; workspace left unchanged.`);
    log(`  Workspace: ${workspace.workspacePath}`);
    return;
  }

  log(chalk.green('✓ Workspace branch/bookmark pulled and checked out'));
  log(`  Workspace: ${workspace.workspacePath}`);
  log(`  Ref: ${branchName}`);
  log(`  Remote: ${remoteName}`);
}

async function resolveWorkspaceIdentifier(identifier: string | undefined): Promise<WorkspaceInfo> {
  if (identifier) {
    const asPath = path.resolve(process.cwd(), identifier);
    if (await workspaceDirectoryExists(asPath)) {
      const metadata = getWorkspaceInfoByPath(asPath);
      if (!metadata) {
        throw new Error(
          `Directory ${asPath} is not a tracked workspace. Run tim workspace list to see known workspaces.`
        );
      }
      return metadata;
    }

    const matches = findWorkspaceInfosByTaskId(identifier);

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
  const metadata = getWorkspaceInfoByPath(currentDir);
  if (!metadata) {
    throw new Error(
      'The current directory is not a tracked workspace. Provide a task ID or workspace path to lock/unlock.'
    );
  }

  return metadata;
}

async function lockAvailableWorkspace(
  config: TimConfig,
  options: { create?: boolean }
): Promise<void> {
  const repositoryId = await determineRepositoryId();
  await removeMissingWorkspaceEntries(repositoryId);

  const workspaces = findWorkspaceInfosByRepositoryId(repositoryId);
  const workspacesWithStatus = await updateWorkspaceLockStatus(workspaces);
  const available = workspacesWithStatus.find(
    (workspace) => !workspace.lockedBy && !workspace.isPrimary
  );

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
  const parts = ['tim workspace lock'];

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

export async function pushWorkspaceRefBetweenWorkspaces(options: {
  sourceWorkspacePath: string;
  destinationWorkspacePath: string;
  refName: string;
  ensureJjBookmarkAtCurrent?: boolean;
  remoteName?: string;
}): Promise<void> {
  const remoteName = options.remoteName ?? PRIMARY_REMOTE_NAME;
  const isJj = await getUsingJj(options.sourceWorkspacePath);

  if (isJj) {
    if (options.ensureJjBookmarkAtCurrent) {
      await setWorkspaceBookmarkToCurrent(options.sourceWorkspacePath, options.refName);
    }
    await ensureJjRemote(options.sourceWorkspacePath, options.destinationWorkspacePath, remoteName);
    await pushJjBookmarkToWorkspace(options.sourceWorkspacePath, options.refName, remoteName);
    return;
  }

  await pushGitBranchToWorkspace(
    options.sourceWorkspacePath,
    options.destinationWorkspacePath,
    options.refName
  );
}

export async function pushWorkspaceRefToRemote(options: {
  workspacePath: string;
  refName: string;
  remoteName?: string;
  ensureJjBookmarkAtCurrent?: boolean;
}): Promise<void> {
  const remoteName = options.remoteName ?? 'origin';
  const isJj = await getUsingJj(options.workspacePath);

  if (isJj) {
    if (options.ensureJjBookmarkAtCurrent) {
      await setWorkspaceBookmarkToCurrent(options.workspacePath, options.refName);
    }
    await pushJjBookmarkToWorkspace(options.workspacePath, options.refName, remoteName);
    return;
  }

  const pushResult = await spawnAndLogOutput(
    ['git', 'push', remoteName, `${options.refName}:${options.refName}`],
    { cwd: options.workspacePath }
  );
  if (pushResult.exitCode !== 0) {
    throw new Error(
      `Failed to push branch "${options.refName}" to remote "${remoteName}": ${pushResult.stderr}`
    );
  }
}

function isMissingJjBookmarkError(message: string): boolean {
  return /no such bookmark|bookmark .* not found|could not resolve revision/i.test(message);
}

export async function pullWorkspaceRefIfExists(
  workspacePath: string,
  refName: string,
  remoteName = 'origin'
): Promise<boolean> {
  const isJj = await getUsingJj(workspacePath);

  if (isJj) {
    const fetchResult = await spawnAndLogOutput(['jj', 'git', 'fetch'], { cwd: workspacePath });
    if (fetchResult.exitCode !== 0) {
      throw new Error(`Failed to fetch from remote: ${fetchResult.stderr}`);
    }

    const trackResult = await spawnAndLogOutput(
      ['jj', 'bookmark', 'track', refName, '--remote', remoteName],
      { cwd: workspacePath, quiet: true }
    );
    if (trackResult.exitCode !== 0 && !isMissingJjBookmarkError(trackResult.stderr)) {
      throw new Error(
        `Failed to track bookmark "${refName}" from remote "${remoteName}": ${trackResult.stderr}`
      );
    }

    const editResult = await spawnAndLogOutput(['jj', 'edit', refName], {
      cwd: workspacePath,
      quiet: true,
    });
    if (editResult.exitCode !== 0) {
      if (isMissingJjBookmarkError(editResult.stderr)) {
        return false;
      }
      throw new Error(`Failed to check out bookmark "${refName}": ${editResult.stderr}`);
    }

    return true;
  }

  const fetchResult = await spawnAndLogOutput(['git', 'fetch', remoteName], { cwd: workspacePath });
  if (fetchResult.exitCode !== 0) {
    throw new Error(`Failed to fetch from remote "${remoteName}": ${fetchResult.stderr}`);
  }

  const localExists = await spawnAndLogOutput(
    ['git', 'rev-parse', '--verify', `refs/heads/${refName}`],
    {
      cwd: workspacePath,
      quiet: true,
    }
  ).then((result) => result.exitCode === 0);

  const remoteExists = await spawnAndLogOutput(
    ['git', 'rev-parse', '--verify', `refs/remotes/${remoteName}/${refName}`],
    {
      cwd: workspacePath,
      quiet: true,
    }
  ).then((result) => result.exitCode === 0);

  if (!localExists && !remoteExists) {
    return false;
  }

  if (localExists) {
    const checkoutResult = await spawnAndLogOutput(['git', 'checkout', refName], {
      cwd: workspacePath,
    });
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`Failed to check out branch "${refName}": ${checkoutResult.stderr}`);
    }
  } else {
    const checkoutResult = await spawnAndLogOutput(
      ['git', 'checkout', '--track', '-b', refName, `${remoteName}/${refName}`],
      { cwd: workspacePath }
    );
    if (checkoutResult.exitCode !== 0) {
      throw new Error(
        `Failed to create and check out tracking branch "${refName}": ${checkoutResult.stderr}`
      );
    }
  }

  if (remoteExists) {
    const pullResult = await spawnAndLogOutput(['git', 'pull', '--ff-only', remoteName, refName], {
      cwd: workspacePath,
      quiet: true,
    });
    if (pullResult.exitCode !== 0) {
      throw new Error(
        `Failed to fast-forward branch "${refName}" from ${remoteName}: ${pullResult.stderr}`
      );
    }
  }

  return true;
}

export async function ensureWorkspaceRefExists(
  workspacePath: string,
  refName: string
): Promise<void> {
  const isJj = await getUsingJj(workspacePath);
  if (isJj) {
    const listResult = await spawnAndLogOutput(['jj', 'bookmark', 'list'], {
      cwd: workspacePath,
      quiet: true,
    });
    if (listResult.exitCode !== 0) {
      throw new Error(`Failed to list jj bookmarks: ${listResult.stderr}`);
    }

    const bookmarkExists = listResult.stdout.split('\n').some((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const name = trimmed.split(/\s+|:/)[0];
      return name === refName;
    });

    if (!bookmarkExists) {
      await setWorkspaceBookmarkToCurrent(workspacePath, refName);
    }
    return;
  }

  const checkResult = await spawnAndLogOutput(['git', 'rev-parse', '--verify', refName], {
    cwd: workspacePath,
    quiet: true,
  });
  if (checkResult.exitCode === 0) {
    return;
  }

  const createResult = await spawnAndLogOutput(['git', 'branch', refName, 'HEAD'], {
    cwd: workspacePath,
  });
  if (createResult.exitCode !== 0) {
    throw new Error(`Failed to create branch "${refName}": ${createResult.stderr}`);
  }
}

export async function setWorkspaceBookmarkToCurrent(
  workspacePath: string,
  bookmark: string
): Promise<void> {
  const setResult = await spawnAndLogOutput(['jj', 'bookmark', 'set', bookmark], {
    cwd: workspacePath,
  });
  if (setResult.exitCode !== 0) {
    throw new Error(`Failed to set bookmark "${bookmark}" to current change: ${setResult.stderr}`);
  }
}

async function ensureJjRemote(
  workspacePath: string,
  destinationWorkspacePath: string,
  remoteName: string
): Promise<void> {
  const listResult = await spawnAndLogOutput(['jj', 'git', 'remote', 'list'], {
    cwd: workspacePath,
    quiet: true,
  });
  if (listResult.exitCode !== 0) {
    throw new Error(`Failed to list jj remotes: ${listResult.stderr}`);
  }

  const remoteLines = listResult.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const destinationRemoteLine = remoteLines.find((line) => line.split(/\s+/, 1)[0] === remoteName);

  if (!destinationRemoteLine) {
    const addRemoteResult = await spawnAndLogOutput(
      ['jj', 'git', 'remote', 'add', remoteName, destinationWorkspacePath],
      { cwd: workspacePath }
    );
    if (addRemoteResult.exitCode !== 0) {
      throw new Error(`Failed to add jj remote "${remoteName}": ${addRemoteResult.stderr}`);
    }
    return;
  }

  const existingUrl = destinationRemoteLine.split(/\s+/).slice(1).join(' ').trim();
  if (existingUrl === destinationWorkspacePath) {
    return;
  }

  const setUrlResult = await spawnAndLogOutput(
    ['jj', 'git', 'remote', 'set-url', remoteName, destinationWorkspacePath],
    { cwd: workspacePath }
  );
  if (setUrlResult.exitCode !== 0) {
    throw new Error(`Failed to update jj remote "${remoteName}": ${setUrlResult.stderr}`);
  }
}

async function pushGitBranchToWorkspace(
  sourceWorkspacePath: string,
  destinationWorkspacePath: string,
  branch: string
): Promise<void> {
  const fetchResult = await spawnAndLogOutput(
    ['git', 'fetch', '--update-head-ok', sourceWorkspacePath, `${branch}:${branch}`],
    { cwd: destinationWorkspacePath }
  );
  if (fetchResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch branch "${branch}" into destination workspace: ${fetchResult.stderr}`
    );
  }
}

async function pushJjBookmarkToWorkspace(
  workspacePath: string,
  bookmark: string,
  remoteName: string
): Promise<void> {
  const trackOutput = await spawnAndLogOutput(
    ['jj', 'bookmark', 'track', bookmark, '--remote', remoteName],
    { cwd: workspacePath }
  );
  if (trackOutput.exitCode !== 0) {
    throw new Error(
      `Failed to track remote bookmark "${bookmark}" to ${remoteName}: ${trackOutput.stderr}`
    );
  }

  const pushResult = await spawnAndLogOutput(
    ['jj', 'git', 'push', '--remote', remoteName, '--bookmark', bookmark],
    { cwd: workspacePath }
  );
  if (pushResult.exitCode !== 0) {
    throw new Error(`Failed to push bookmark "${bookmark}" to ${remoteName}: ${pushResult.stderr}`);
  }
}

async function determineRepositoryId(cwd?: string): Promise<string> {
  const identity = await getRepositoryIdentity({ cwd });
  return identity.repositoryId;
}

function getDefaultLockOwner(): string | undefined {
  return process.env.USER || process.env.LOGNAME || process.env.USERNAME;
}

export async function handleWorkspaceUpdateCommand(
  target: string | undefined,
  options: { name?: string; description?: string; fromPlan?: string; primary?: boolean },
  command: Command
) {
  const globalOpts = command.parent!.parent!.opts();

  // Validate that at least one update option is provided
  if (
    options.name === undefined &&
    options.description === undefined &&
    !options.fromPlan &&
    options.primary === undefined
  ) {
    throw new Error(
      'At least one of --name, --description, --from-plan, or --primary/--no-primary must be provided.'
    );
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
      const matches = findWorkspaceInfosByTaskId(target);
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
  const existingMetadata = getWorkspaceInfoByPath(workspacePath);

  // Handle name
  if (options.name !== undefined) {
    patch.name = options.name;
  }

  // Handle description - from-plan takes precedence if both specified
  if (options.fromPlan) {
    try {
      const planPath = await resolvePlanFile(options.fromPlan, globalOpts.config);
      const plan = await readPlanFile(planPath);
      const planDescription = buildDescriptionFromPlan(plan);
      const planId = plan.id ? String(plan.id) : '';
      patch.description = planId ? `${planId} - ${planDescription}` : planDescription;

      // Also populate plan metadata fields
      patch.planId = planId;
      const planTitle = getCombinedTitleFromSummary(plan);
      patch.planTitle = planTitle || '';
      patch.issueUrls = plan.issue && plan.issue.length > 0 ? [...plan.issue] : [];
    } catch (err) {
      throw new Error(`Failed to read plan for --from-plan: ${err as Error}`);
    }
  } else if (options.description !== undefined) {
    patch.description = options.description;
  }
  if (options.primary !== undefined) {
    patch.isPrimary = options.primary;
  }

  if (!existingMetadata?.repositoryId) {
    patch.repositoryId = await determineRepositoryId(workspacePath);
  }

  // Apply the patch
  const updated = patchWorkspaceInfo(workspacePath, patch);

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
  if (updated.isPrimary) {
    log(`  Primary: yes`);
  }
}
