// Command handler for 'rmplan ready'
// Lists all plans that are ready to execute (pending/in_progress with dependencies done)

import chalk from 'chalk';
import * as path from 'path';
import { table, type TableUserConfig } from 'table';

import { log, warn } from '../../logging.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { AssignmentsFileParseError, readAssignments } from '../assignments/assignments_io.js';
import type { AssignmentEntry } from '../assignments/assignments_schema.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import {
  formatTagsSummary,
  formatWorkspacePath,
  getCombinedTitleFromSummary,
} from '../display_utils.js';
import { readAllPlans } from '../plans.js';
import {
  READY_PLAN_SORT_FIELDS,
  filterAndSortReadyPlans,
  formatReadyPlansAsJson,
  isReadyPlan,
  sortReadyPlans,
} from '../ready_plans.js';
import type { EnrichedReadyPlan, ReadyPlanSortField } from '../ready_plans.js';
import { getGitRoot } from '../../common/git.js';
import type {
  GenerateModeRegistrationContext,
  ListReadyPlansArguments,
} from '../mcp/generate_mode.js';
import { isUnderEpic } from '../utils/hierarchy.js';
import { normalizeTags } from '../utils/tags.js';
import { listReadyPlansTool } from '../tools/index.js';

type PlanWithFilename = EnrichedReadyPlan;

type ReadyPlan = PlanWithFilename & {
  assignmentEntry?: AssignmentEntry;
  assignedWorkspaces: string[];
  assignedUsers: string[];
  isAssignedHere: boolean;
  isUnassigned: boolean;
};

interface ReadyDisplayContext {
  currentWorkspace: string | null;
}

interface ReadyCommandOptions {
  format?: string;
  sort?: string;
  reverse?: boolean;
  pendingOnly?: boolean;
  priority?: string;
  verbose?: boolean;
  all?: boolean;
  unassigned?: boolean;
  user?: string;
  hasTasks?: boolean;
  tag?: string[];
  epic?: number | string;
}

const VALID_FORMATS = ['list', 'table', 'json'] as const;
const VALID_SORT_FIELDS = READY_PLAN_SORT_FIELDS;
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent', 'maybe'] as const;

/**
 * Get color for priority
 */
function getPriorityColor(priority?: string): (text: string) => string {
  switch (priority) {
    case 'urgent':
      return chalk.red;
    case 'high':
      return chalk.rgb(255, 165, 0); // orange
    case 'medium':
      return chalk.yellow;
    case 'low':
      return chalk.blue;
    case 'maybe':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

/**
 * Get color for status
 */
function getStatusColor(status?: string): (text: string) => string {
  switch (status) {
    case 'in_progress':
      return chalk.yellow;
    case 'pending':
      return chalk.white;
    default:
      return chalk.gray;
  }
}

/**
 * Format dependency list with status indicators
 */
function formatDependencies(
  dependencies: (string | number)[] | undefined,
  allPlans: Map<number, ReadyPlan>
): string {
  if (!dependencies || dependencies.length === 0) {
    return chalk.gray('✓ No dependencies');
  }

  const depSummary = dependencies
    .map((id) => {
      // Convert to number if it's a numeric string
      const numericId = typeof id === 'string' ? parseInt(id, 10) : id;
      let dep = allPlans.get(numericId);

      // Try alternate lookup if not found
      if (!dep && typeof id === 'number') {
        dep = allPlans.get(id);
      }

      if (!dep) {
        return `${id} ${chalk.gray('(not found)')}`;
      }

      const status = dep.status || 'pending';
      if (status === 'done') {
        return `${id} ${chalk.green('(done)')}`;
      } else if (status === 'in_progress') {
        return `${id} ${chalk.yellow('(in progress)')}`;
      } else {
        return `${id} (${status})`;
      }
    })
    .join(', ');

  return chalk.green('✓ All dependencies done: ') + depSummary;
}

/**
 * Display plans in list format (default)
 */
function displayListFormat(
  plans: ReadyPlan[],
  allPlans: Map<number, ReadyPlan>,
  verbose: boolean,
  context: ReadyDisplayContext
): void {
  log(chalk.bold(`\n✓ Ready Plans (${plans.length}):\n`));
  log('─'.repeat(80));

  for (const plan of plans) {
    const title = getCombinedTitleFromSummary(plan);
    log(chalk.cyan(`\n[${plan.id}] ${title}`));

    // Status
    const status = plan.status || 'pending';
    const statusColor = getStatusColor(status);
    log(`  Status: ${statusColor(status)}`);

    // Priority
    if (plan.priority) {
      const priorityColor = getPriorityColor(plan.priority);
      log(`  Priority: ${priorityColor(plan.priority)}`);
    }

    const tagsSummary = formatTagsSummary(plan.tags, { emptyValue: 'none' });
    const hasTags = Boolean(plan.tags && plan.tags.length > 0);
    log(`  Tags: ${hasTags ? tagsSummary : chalk.gray(tagsSummary)}`);

    // Task count
    const taskCount = plan.tasks?.length || 0;
    const doneTasks = plan.tasks?.filter((t) => t.done).length || 0;
    const taskDisplay = doneTasks > 0 ? `${taskCount} (${doneTasks} done)` : `${taskCount}`;
    const taskColor = taskCount === 0 ? chalk.red : chalk.green;
    log(taskColor(`  Tasks: ${taskDisplay}`));

    // Assignment
    if (plan.assignedWorkspaces.length > 0) {
      const currentWorkspace = context.currentWorkspace;
      const workspaceLabels = plan.assignedWorkspaces
        .map((workspace) => {
          const formatted = currentWorkspace
            ? formatWorkspacePath(workspace, { currentWorkspace })
            : formatWorkspacePath(workspace);
          const isCurrent = currentWorkspace !== null && workspace === currentWorkspace;
          return isCurrent ? chalk.green(formatted) : formatted;
        })
        .join(', ');
      log(`  Workspace: ${workspaceLabels}`);
    } else {
      log(`  Workspace: ${chalk.gray('unassigned')}`);
    }

    if (plan.assignedUsers.length > 0) {
      log(`  Users: ${plan.assignedUsers.join(', ')}`);
    }

    if (plan.assignedTo) {
      log(`  Assigned to: ${plan.assignedTo}`);
    }

    // Dependencies
    log(`  ${formatDependencies(plan.dependencies, allPlans)}`);

    // File path in verbose mode
    if (verbose) {
      log(chalk.gray(`  File: ${plan.filename}`));
    }
  }

  log('\n' + '─'.repeat(80));
  log(`\nRun ${chalk.bold('rmplan agent <id>')} to execute a plan`);
  log(`Run ${chalk.bold('rmplan show <id>')} to see full details`);
}

/**
 * Display plans in table format
 */
function displayTableFormat(
  plans: ReadyPlan[],
  allPlans: Map<number, ReadyPlan>,
  context: ReadyDisplayContext
): void {
  const tagsColumnWidth = 18;
  const tableData: string[][] = [];

  // Header row
  tableData.push([
    chalk.bold('ID'),
    chalk.bold('Title'),
    chalk.bold('Status'),
    chalk.bold('Priority'),
    chalk.bold('Tags'),
    chalk.bold('Tasks'),
    chalk.bold('Workspace'),
    chalk.bold('Deps'),
  ]);

  // Data rows
  for (const plan of plans) {
    const status = plan.status || 'pending';
    const statusColor = getStatusColor(status);

    const priority = plan.priority || '';
    const priorityColor = getPriorityColor(plan.priority);

    const taskCount = plan.tasks?.length || 0;
    const doneTasks = plan.tasks?.filter((t) => t.done).length || 0;
    const taskDisplay = doneTasks > 0 ? `${doneTasks}/${taskCount}` : `${taskCount}`;

    // Workspace summary
    const currentWorkspace = context.currentWorkspace;
    let workspaceDisplay = '-';
    if (plan.assignedWorkspaces.length > 0) {
      const formatted = plan.assignedWorkspaces.map((workspace) => {
        const display = currentWorkspace
          ? formatWorkspacePath(workspace, { currentWorkspace })
          : formatWorkspacePath(workspace);
        const isCurrent = currentWorkspace !== null && workspace === currentWorkspace;
        return isCurrent ? chalk.green(display) : display;
      });
      const [first, ...rest] = formatted;
      workspaceDisplay = rest.length > 0 ? `${first} (+${rest.length})` : first;
    } else {
      workspaceDisplay = chalk.gray('unassigned');
    }

    // Dependency count
    const depCount = plan.dependencies?.length || 0;
    const depDisplay = depCount > 0 ? `${depCount} done` : '-';

    tableData.push([
      chalk.cyan(plan.id || 'no-id'),
      getCombinedTitleFromSummary(plan),
      statusColor(status),
      priority ? priorityColor(priority) : '-',
      formatTagsSummary(plan.tags, { maxLength: tagsColumnWidth }),
      taskDisplay,
      workspaceDisplay,
      depCount > 0 ? chalk.green(depDisplay) : depDisplay,
    ]);
  }

  // Calculate responsive column widths
  const terminalWidth = process.stdout.columns || 120;
  const workspaceColumnWidth = 22;
  const depsColumnWidth = 12;
  // Columns: ID(6) + Status(12) + Priority(10) + Tags + Tasks(8) + Workspace + Deps + borders(8*3=24)
  const borderPadding = 8 * 3;
  const fixedWidth =
    6 + 12 + 10 + tagsColumnWidth + 8 + workspaceColumnWidth + depsColumnWidth + borderPadding;
  const titleWidth = Math.max(30, terminalWidth - fixedWidth);

  // Configure table
  const tableConfig: TableUserConfig = {
    columns: {
      1: { width: titleWidth, wrapWord: true },
      4: { width: tagsColumnWidth, wrapWord: true },
      6: { width: workspaceColumnWidth, wrapWord: true },
      7: { width: depsColumnWidth, wrapWord: true },
    },
    border: {
      topBody: '─',
      topJoin: '┬',
      topLeft: '┌',
      topRight: '┐',
      bottomBody: '─',
      bottomJoin: '┴',
      bottomLeft: '└',
      bottomRight: '┘',
      bodyLeft: '│',
      bodyRight: '│',
      bodyJoin: '│',
      joinBody: '─',
      joinLeft: '├',
      joinRight: '┤',
      joinJoin: '┼',
    },
  };

  log(table(tableData, tableConfig));
  log(`Showing ${plans.length} ready plan(s)`);
}

/**
 * Display plans in JSON format
 */
async function displayJsonFormat(plans: ReadyPlan[], context: ReadyDisplayContext): Promise<void> {
  const gitRoot = await getGitRoot();

  const result = {
    count: plans.length,
    plans: plans.map((plan) => ({
      id: plan.id,
      title: plan.title || plan.goal || '',
      goal: plan.goal || '',
      priority: plan.priority,
      status: plan.status,
      taskCount: plan.tasks?.length || 0,
      completedTasks: plan.tasks?.filter((t) => t.done).length || 0,
      needsGenerate: (plan.tasks?.length || 0) === 0,
      dependencies: plan.dependencies || [],
      assignedTo: plan.assignedTo,
      filename: path.relative(gitRoot, plan.filename),
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      workspacePaths: plan.assignedWorkspaces,
      users: plan.assignedUsers,
      isAssignedHere: plan.isAssignedHere,
      isUnassigned: plan.isUnassigned,
      assignmentUpdatedAt: plan.assignmentEntry?.updatedAt,
      assignmentAssignedAt: plan.assignmentEntry?.assignedAt,
      currentWorkspace: context.currentWorkspace,
      tags: plan.tags ?? [],
    })),
  };

  log(JSON.stringify(result, null, 2));
}

function emitMultiWorkspaceWarnings(plans: ReadyPlan[], context: ReadyDisplayContext): void {
  for (const plan of plans) {
    const entry = plan.assignmentEntry;
    if (!entry) {
      continue;
    }

    const uniqueWorkspaces = Array.from(new Set(entry.workspacePaths ?? []));
    if (uniqueWorkspaces.length <= 1) {
      continue;
    }

    const currentWorkspace = context.currentWorkspace;
    const formatted = uniqueWorkspaces
      .map((workspace) => {
        const display = currentWorkspace
          ? formatWorkspacePath(workspace, { currentWorkspace })
          : formatWorkspacePath(workspace);
        const isCurrent = currentWorkspace !== null && workspace === currentWorkspace;
        return isCurrent ? chalk.green(display) : display;
      })
      .join(', ');

    const label = plan.id ?? plan.uuid ?? 'unknown';
    warn(`${chalk.yellow('⚠')} Plan ${label} is claimed in multiple workspaces: ${formatted}`);
  }
}

export async function handleReadyCommand(options: ReadyCommandOptions, command: any) {
  if (options.format && !VALID_FORMATS.includes(options.format as any)) {
    throw new Error(
      `Invalid format: ${options.format}. Valid formats are: ${VALID_FORMATS.join(', ')}`
    );
  }

  if (options.sort && !VALID_SORT_FIELDS.includes(options.sort as ReadyPlanSortField)) {
    throw new Error(
      `Invalid sort field: ${options.sort}. Valid sort fields are: ${VALID_SORT_FIELDS.join(', ')}`
    );
  }

  if (options.priority && !VALID_PRIORITIES.includes(options.priority as any)) {
    throw new Error(
      `Invalid priority: ${options.priority}. Valid priorities are: ${VALID_PRIORITIES.join(', ')}`
    );
  }

  const userFilter =
    typeof options.user === 'string' && options.user.trim().length > 0
      ? options.user.trim()
      : undefined;
  const normalizedUserFilter = userFilter?.toLowerCase();

  if (options.all && options.unassigned) {
    throw new Error('Cannot combine --all with --unassigned; choose one assignment filter.');
  }

  if (options.unassigned && normalizedUserFilter) {
    throw new Error('Cannot combine --unassigned with --user filter.');
  }

  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const tasksDir = await resolveTasksDir(config);
  const { plans: rawPlans } = await readAllPlans(tasksDir);

  const repository = await getRepositoryIdentity();

  let assignmentsLookup: Record<string, AssignmentEntry> = {};
  try {
    const assignmentsFile = await readAssignments({
      repositoryId: repository.repositoryId,
      repositoryRemoteUrl: repository.remoteUrl,
    });
    assignmentsLookup = assignmentsFile.assignments;
  } catch (error) {
    if (error instanceof AssignmentsFileParseError) {
      warn(`${chalk.yellow('⚠')} ${error.message}`);
    } else {
      throw error;
    }
  }

  const enrichedPlans = new Map<number, ReadyPlan>();
  for (const [planId, plan] of rawPlans.entries()) {
    const assignmentEntry = plan.uuid ? assignmentsLookup[plan.uuid] : undefined;
    const assignedWorkspaces = Array.from(
      new Set(
        (assignmentEntry?.workspacePaths ?? []).filter((workspace): workspace is string =>
          Boolean(workspace && workspace.trim())
        )
      )
    );
    const assignedUsers = Array.from(
      new Set(
        (assignmentEntry?.users ?? []).filter((candidate): candidate is string =>
          Boolean(candidate && candidate.trim())
        )
      )
    );

    const effectiveStatus = assignmentEntry?.status ?? plan.status ?? 'pending';

    const readyPlan: ReadyPlan = {
      ...plan,
      status: effectiveStatus,
      assignmentEntry,
      assignedWorkspaces,
      assignedUsers,
      isAssignedHere: assignedWorkspaces.includes(repository.gitRoot),
      isUnassigned: assignedWorkspaces.length === 0,
    };

    enrichedPlans.set(planId, readyPlan);
  }

  const pendingOnly = options.pendingOnly ?? false;
  let readyPlans = Array.from(enrichedPlans.values()).filter((plan) =>
    isReadyPlan(plan, enrichedPlans, pendingOnly)
  );

  if (options.priority) {
    readyPlans = readyPlans.filter((plan) => plan.priority === options.priority);
  }

  if (normalizedUserFilter) {
    readyPlans = readyPlans.filter((plan) => {
      if (
        plan.assignedUsers.some((candidate) => candidate.toLowerCase() === normalizedUserFilter)
      ) {
        return true;
      }

      const fallbackAssignedTo = plan.assignedTo?.trim();
      if (fallbackAssignedTo && fallbackAssignedTo.toLowerCase() === normalizedUserFilter) {
        return true;
      }

      return false;
    });
  }

  if (options.unassigned) {
    readyPlans = readyPlans.filter((plan) => plan.isUnassigned);
  } else if (!options.all && !normalizedUserFilter) {
    readyPlans = readyPlans.filter((plan) => plan.isUnassigned || plan.isAssignedHere);
  }

  if (options.hasTasks) {
    readyPlans = readyPlans.filter((plan) => (plan.tasks?.length ?? 0) > 0);
  }

  const desiredTags = normalizeTags(options.tag);
  if (desiredTags.length > 0) {
    const tagFilter = new Set(desiredTags);
    readyPlans = readyPlans.filter((plan) => {
      const planTags = normalizeTags(plan.tags);
      if (planTags.length === 0) {
        return false;
      }
      return planTags.some((tag) => tagFilter.has(tag));
    });
  }

  if (options.epic !== undefined) {
    const epicId =
      typeof options.epic === 'number' ? options.epic : Number.parseInt(options.epic, 10);

    if (Number.isNaN(epicId) || !Number.isInteger(epicId) || epicId <= 0) {
      throw new Error(`Invalid epic ID: ${options.epic}`);
    }

    if (!enrichedPlans.has(epicId)) {
      throw new Error(`Epic plan ${epicId} not found`);
    }

    readyPlans = readyPlans.filter(
      (plan) => plan.id === epicId || isUnderEpic(plan, epicId, enrichedPlans)
    );
  }

  if (readyPlans.length === 0) {
    log('No plans are currently ready to execute.');

    if (pendingOnly) {
      log('Try without --pending-only to include in_progress plans.');
    }

    if (options.unassigned) {
      log('No unassigned plans are ready right now.');
    } else if (userFilter) {
      log(`No ready plans are assigned to user "${userFilter}".`);
    } else if (options.all) {
      log('All pending plans have incomplete dependencies.');
    } else {
      log('All ready plans are claimed in other workspaces or blocked by dependencies.');
    }

    if (!options.all) {
      log(`Use ${chalk.bold('rmplan ready --all')} to include plans claimed in other workspaces.`);
    }

    if (!options.unassigned) {
      log(
        `Use ${chalk.bold('rmplan ready --unassigned')} to focus on unassigned plans that are ready.`
      );
    }

    if (options.hasTasks) {
      log('Try without --has-tasks to include plans without tasks defined.');
    }
    return;
  }

  const sortBy = (options.sort as ReadyPlanSortField | undefined) ?? 'priority';
  const reverse = options.reverse ?? false;
  readyPlans = sortReadyPlans(readyPlans, sortBy, reverse);

  const context: ReadyDisplayContext = {
    currentWorkspace: repository.gitRoot,
  };

  emitMultiWorkspaceWarnings(readyPlans, context);

  const format = options.format || 'list';
  switch (format) {
    case 'table':
      displayTableFormat(readyPlans, enrichedPlans, context);
      break;
    case 'json':
      await displayJsonFormat(readyPlans, context);
      break;
    case 'list':
    default:
      displayListFormat(readyPlans, enrichedPlans, options.verbose || false, context);
      break;
  }
}

export async function mcpListReadyPlans(
  args: ListReadyPlansArguments,
  context: GenerateModeRegistrationContext
): Promise<string> {
  const result = await listReadyPlansTool(args, context);
  return result.text;
}
