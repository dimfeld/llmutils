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
import { formatWorkspacePath, getCombinedTitleFromSummary } from '../display_utils.js';
import { readAllPlans } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getGitRoot } from '../../common/git.js';

type PlanWithFilename = PlanSchema & { filename: string };

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
}

const VALID_FORMATS = ['list', 'table', 'json'] as const;
const VALID_SORT_FIELDS = ['priority', 'id', 'title', 'created', 'updated'] as const;
const VALID_PRIORITIES = ['low', 'medium', 'high', 'urgent', 'maybe'] as const;

/**
 * Check if a plan is ready to execute
 * A plan is ready when:
 * 1. Status is 'pending' OR 'in_progress'
 * 2. All dependencies (if any) have status 'done'
 *
 * Note: This is NOT the same as the existing isPlanReady() function from plans.ts,
 * which only checks for pending status. This function intentionally includes
 * in_progress plans to provide a complete view of executable work, as specified
 * in the design requirements for the 'ready' command.
 */
function isReadyPlan(
  plan: ReadyPlan,
  allPlans: Map<number, ReadyPlan>,
  pendingOnly: boolean
): boolean {
  const status = plan.status || 'pending';

  // Check status
  const statusMatch = pendingOnly
    ? status === 'pending'
    : status === 'pending' || status === 'in_progress';

  if (!statusMatch) {
    return false;
  }

  // If no dependencies, it's ready
  if (!plan.dependencies || plan.dependencies.length === 0) {
    return true;
  }

  // Check if all dependencies are done
  return plan.dependencies.every((depId) => {
    // Try to get the dependency plan by ID
    let depPlan = allPlans.get(depId);

    // If not found and the dependency ID is a numeric string, try as a number
    if (!depPlan && typeof depId === 'string' && /^\d+$/.test(depId)) {
      depPlan = allPlans.get(parseInt(depId, 10));
    }

    return depPlan && depPlan.status === 'done';
  });
}

/**
 * Sort plans by the specified field
 */
function sortPlans(plans: ReadyPlan[], sortBy: string, reverse: boolean): ReadyPlan[] {
  const sorted = [...plans];

  sorted.sort((a, b) => {
    let aVal: string | number;
    let bVal: string | number;

    switch (sortBy) {
      case 'title':
        aVal = (a.title || a.goal || '').toLowerCase();
        bVal = (b.title || b.goal || '').toLowerCase();
        break;
      case 'id': {
        const aNum = Number(a.id || 0);
        const bNum = Number(b.id || 0);

        if (!isNaN(aNum) && !isNaN(bNum)) {
          aVal = aNum;
          bVal = bNum;
        } else if (!isNaN(aNum) && isNaN(bNum)) {
          aVal = aNum;
          bVal = 0;
        } else if (isNaN(aNum) && !isNaN(bNum)) {
          aVal = 0;
          bVal = bNum;
        } else {
          aVal = a.id || '';
          bVal = b.id || '';
        }
        break;
      }
      case 'created':
        aVal = a.createdAt || '';
        bVal = b.createdAt || '';
        break;
      case 'updated':
        aVal = a.updatedAt || '';
        bVal = b.updatedAt || '';
        break;
      case 'priority':
      default: {
        // Priority order: urgent=5, high=4, medium=3, low=2, maybe=1, undefined=0
        const priorityOrder: Record<string, number> = {
          urgent: 5,
          high: 4,
          medium: 3,
          low: 2,
          maybe: 1,
        };

        aVal = a.priority ? priorityOrder[a.priority] || 0 : 0;
        bVal = b.priority ? priorityOrder[b.priority] || 0 : 0;
        break;
      }
    }

    // Secondary sort: by createdAt (oldest first) unless already sorting by created
    if (aVal === bVal) {
      if (sortBy === 'created') {
        aVal = a.id || '';
        bVal = b.id || '';
      } else {
        aVal = a.createdAt || '';
        bVal = b.createdAt || '';
      }
    }

    // For priority sorting, we want descending order by default (urgent first)
    // For other sorts, ascending order is default
    const isPrioritySorting = sortBy === 'priority' && a.priority !== b.priority;
    const compareResult = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;

    if (isPrioritySorting) {
      // Descending by default for priority, unless reverse flag is set
      return reverse ? compareResult : -compareResult;
    } else {
      // Ascending by default for other fields
      return reverse ? -compareResult : compareResult;
    }
  });

  return sorted;
}

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

    // Task count
    const taskCount = plan.tasks?.length || 0;
    const doneTasks = plan.tasks?.filter((t) => t.done).length || 0;
    const taskDisplay = doneTasks > 0 ? `${taskCount} (${doneTasks} done)` : `${taskCount}`;
    log(`  Tasks: ${taskDisplay}`);

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
  const tableData: string[][] = [];

  // Header row
  tableData.push([
    chalk.bold('ID'),
    chalk.bold('Title'),
    chalk.bold('Status'),
    chalk.bold('Priority'),
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
      taskDisplay,
      workspaceDisplay,
      depCount > 0 ? chalk.green(depDisplay) : depDisplay,
    ]);
  }

  // Calculate responsive column widths
  const terminalWidth = process.stdout.columns || 120;
  const workspaceColumnWidth = 22;
  const depsColumnWidth = 12;
  // Columns: ID(6) + Status(12) + Priority(10) + Tasks(8) + Workspace + Deps + borders(7*3=21)
  const fixedWidth = 6 + 12 + 10 + 8 + workspaceColumnWidth + depsColumnWidth + 21;
  const titleWidth = Math.max(30, terminalWidth - fixedWidth);

  // Configure table
  const tableConfig: TableUserConfig = {
    columns: {
      1: { width: titleWidth, wrapWord: true },
      5: { width: workspaceColumnWidth, wrapWord: true },
      6: { width: depsColumnWidth, wrapWord: true },
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

  if (options.sort && !VALID_SORT_FIELDS.includes(options.sort as any)) {
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
    return;
  }

  const sortBy = options.sort || 'priority';
  const reverse = options.reverse || false;
  readyPlans = sortPlans(readyPlans, sortBy, reverse);

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
