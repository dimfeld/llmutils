import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { table, type TableUserConfig } from 'table';

import { log, warn } from '../../logging.js';
import {
  cleanStaleAssignments,
  getAssignmentEntriesByProject,
  type AssignmentEntry,
  type AssignmentsFile,
} from '../db/assignment.js';
import {
  getConfiguredStaleTimeoutDays,
  isStaleAssignment,
} from '../assignments/stale_detection.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { getDatabase } from '../db/database.js';
import { getProject } from '../db/project.js';
import { formatWorkspacePath, getCombinedTitleFromSummary } from '../display_utils.js';
import type { PlanSchema } from '../planSchema.js';
import { readAllPlans } from '../plans.js';

type PlanWithFilename = PlanSchema & { filename: string };

interface AssignmentsContext {
  assignments: AssignmentsFile;
  planLookup: Map<string, PlanWithFilename>;
  currentWorkspace: string;
  repositoryId: string;
  repositoryRemoteUrl: string | null;
  staleTimeoutDays: number;
}

interface AssignmentDisplay {
  uuid: string;
  planId: number | null;
  planLabel: string;
  status: string;
  workspaceSummaries: string[];
  rawWorkspaces: string[];
  users: string[];
  assignedAtDisplay: string;
  updatedAtDisplay: string;
  updatedAtTimestamp: number;
  isStale: boolean;
  entry: AssignmentEntry;
}

function getRootCommand(command: any): any {
  let cursor = command;
  while (cursor?.parent) {
    cursor = cursor.parent;
  }
  return cursor;
}

async function loadAssignmentsContext(command: any): Promise<AssignmentsContext> {
  const rootCommand = getRootCommand(command);
  const globalOpts = typeof rootCommand?.opts === 'function' ? rootCommand.opts() : {};

  const config = await loadEffectiveConfig(globalOpts?.config);
  const tasksDir = await resolveTasksDir(config);

  const repository = await getRepositoryIdentity();

  const assignments = loadAssignmentsFromDb(repository.repositoryId, repository.remoteUrl);

  const { plans } = await readAllPlans(tasksDir);
  const planLookup = new Map<string, PlanWithFilename>();
  for (const plan of plans.values()) {
    if (plan.uuid) {
      planLookup.set(plan.uuid, plan);
    }
  }

  const staleTimeoutDays = getConfiguredStaleTimeoutDays(config);

  return {
    assignments,
    planLookup,
    currentWorkspace: repository.gitRoot,
    repositoryId: repository.repositoryId,
    repositoryRemoteUrl: repository.remoteUrl,
    staleTimeoutDays,
  };
}

function loadAssignmentsFromDb(
  repositoryId: string,
  repositoryRemoteUrl: string | null
): AssignmentsFile {
  const db = getDatabase();
  const project = getProject(db, repositoryId);
  if (!project) {
    return {
      repositoryId,
      repositoryRemoteUrl,
      version: 0,
      assignments: {},
      highestPlanId: 0,
    };
  }

  return {
    repositoryId,
    repositoryRemoteUrl,
    version: 0,
    assignments: getAssignmentEntriesByProject(db, project.id),
    highestPlanId: project.highest_plan_id,
  };
}

function uniqueValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) {
      continue;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

function collectUsers(entry: AssignmentEntry): string[] {
  const result = uniqueValues(entry.users ?? []);
  const ownerValues = entry.workspaceOwners ? Object.values(entry.workspaceOwners) : [];
  for (const owner of uniqueValues(ownerValues)) {
    if (!result.includes(owner)) {
      result.push(owner);
    }
  }
  return result;
}

function formatIsoTimestamp(value: string): { display: string; timestamp: number } {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return { display: value, timestamp: Number.NEGATIVE_INFINITY };
  }

  return { display: new Date(parsed).toISOString(), timestamp: parsed };
}

function buildAssignmentDisplays(
  assignments: AssignmentsFile,
  planLookup: Map<string, PlanWithFilename>,
  currentWorkspace: string,
  staleTimeoutDays: number,
  referenceDate: Date = new Date()
): AssignmentDisplay[] {
  const displays: AssignmentDisplay[] = [];

  for (const [uuid, entry] of Object.entries(assignments.assignments)) {
    const plan = planLookup.get(uuid);
    const planId = entry.planId ?? plan?.id ?? null;
    const planTitle = plan ? getCombinedTitleFromSummary(plan) : 'Unknown plan';
    const planLabel = planId ? `#${planId} ${planTitle}` : planTitle;

    const rawWorkspaces = uniqueValues(entry.workspacePaths ?? []);
    const workspaceSummaries = rawWorkspaces.map((workspacePath) => {
      const owner = entry.workspaceOwners?.[workspacePath] ?? null;
      const formatted = formatWorkspacePath(workspacePath, { currentWorkspace });
      const display = formatted === 'this workspace' ? chalk.green(formatted) : formatted;
      return owner ? `${display} (${owner})` : display;
    });

    const users = collectUsers(entry);
    const status = entry.status ?? plan?.status ?? 'pending';

    const assignedAt = formatIsoTimestamp(entry.assignedAt);
    const updatedAt = formatIsoTimestamp(entry.updatedAt);

    displays.push({
      uuid,
      planId,
      planLabel,
      status,
      workspaceSummaries: workspaceSummaries.length > 0 ? workspaceSummaries : [chalk.gray('none')],
      rawWorkspaces,
      users: users.length > 0 ? users : [chalk.gray('none')],
      assignedAtDisplay: assignedAt.display,
      updatedAtDisplay: updatedAt.display,
      updatedAtTimestamp: updatedAt.timestamp,
      isStale: isStaleAssignment(entry, staleTimeoutDays, referenceDate),
      entry,
    });
  }

  displays.sort((a, b) => b.updatedAtTimestamp - a.updatedAtTimestamp);
  return displays;
}

function renderListTable(
  displays: AssignmentDisplay[],
  staleTimeoutDays: number,
  summaryLabel = 'Total assignments'
): void {
  if (displays.length === 0) {
    log('No assignments recorded for this repository.');
    return;
  }

  const header = [
    'Plan',
    'UUID',
    'Status',
    'Workspaces',
    'Users',
    'Updated',
    `Stale (${staleTimeoutDays}d)`,
  ];
  const rows = displays.map((display) => [
    display.planLabel,
    display.uuid,
    display.status,
    display.workspaceSummaries.join('\n'),
    display.users.join('\n'),
    display.updatedAtDisplay,
    display.isStale ? chalk.yellow('yes') : chalk.gray('no'),
  ]);

  const tableConfig: TableUserConfig = {
    columnDefault: {
      wrapWord: true,
      paddingLeft: 1,
      paddingRight: 1,
    },
    columns: {
      0: { width: Math.min(Math.max(24, Math.floor((process.stdout.columns ?? 120) * 0.25)), 48) },
      3: { width: 32 },
      4: { width: 20 },
    },
  };

  log(table([header, ...rows], tableConfig));
  log(`${summaryLabel}: ${displays.length}`);
}

function renderConflictsTable(displays: AssignmentDisplay[]): void {
  void displays;
  log('Assignment conflicts are not possible in the single-workspace assignment model.');
}

interface CleanStaleOptions {
  yes?: boolean;
}

export async function handleAssignmentsListCommand(options: any, command: any): Promise<void> {
  const context = await loadAssignmentsContext(command);
  const displays = buildAssignmentDisplays(
    context.assignments,
    context.planLookup,
    context.currentWorkspace,
    context.staleTimeoutDays
  );
  renderListTable(displays, context.staleTimeoutDays);
}

export async function handleAssignmentsShowConflictsCommand(
  options: any,
  command: any
): Promise<void> {
  void options;
  void command;
  renderConflictsTable([]);
}

export async function handleAssignmentsCleanStaleCommand(
  options: CleanStaleOptions,
  command: any
): Promise<void> {
  const context = await loadAssignmentsContext(command);
  const referenceDate = new Date();
  const displays = buildAssignmentDisplays(
    context.assignments,
    context.planLookup,
    context.currentWorkspace,
    context.staleTimeoutDays,
    referenceDate
  );

  const staleDisplays = displays.filter((display) => display.isStale);

  if (staleDisplays.length === 0) {
    log(
      `No stale assignments found (threshold ${context.staleTimeoutDays} day${
        context.staleTimeoutDays === 1 ? '' : 's'
      }).`
    );
    return;
  }

  log(
    chalk.yellow(
      `Found ${staleDisplays.length} stale assignment${
        staleDisplays.length === 1 ? '' : 's'
      } older than ${context.staleTimeoutDays} day${context.staleTimeoutDays === 1 ? '' : 's'}.`
    )
  );
  renderListTable(staleDisplays, context.staleTimeoutDays, 'Stale assignments');

  let proceed = Boolean(options.yes);
  if (!proceed) {
    proceed = await confirm({
      message: 'Remove the stale assignments listed above?',
      default: false,
    });
  }

  if (!proceed) {
    warn('Aborted stale assignment cleanup.');
    return;
  }

  const db = getDatabase();
  const project = getProject(db, context.repositoryId);
  if (!project) {
    warn(`${chalk.yellow('⚠')} No project row found for repository ${context.repositoryId}.`);
    return;
  }
  const removedCount = cleanStaleAssignments(db, project.id, context.staleTimeoutDays);

  for (const display of staleDisplays) {
    log(`${chalk.green('✓')} Removed assignment for ${display.planLabel} (${display.uuid})`);
  }

  log(`Removed ${removedCount} stale assignment${removedCount === 1 ? '' : 's'}.`);
}
