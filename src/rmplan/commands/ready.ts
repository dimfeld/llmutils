// Command handler for 'rmplan ready'
// Lists all plans that are ready to execute (pending/in_progress with dependencies done)

import chalk from 'chalk';
import * as path from 'path';
import { table, type TableUserConfig } from 'table';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { getCombinedTitleFromSummary } from '../display_utils.js';
import { readAllPlans } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { getGitRoot } from '../../common/git.js';

type PlanWithFilename = PlanSchema & { filename: string };

interface ReadyCommandOptions {
  format?: string;
  sort?: string;
  reverse?: boolean;
  pendingOnly?: boolean;
  priority?: string;
  verbose?: boolean;
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
  plan: PlanWithFilename,
  allPlans: Map<number, PlanWithFilename>,
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
function sortPlans(
  plans: PlanWithFilename[],
  sortBy: string,
  reverse: boolean
): PlanWithFilename[] {
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

    // Secondary sort by ID
    if (aVal === bVal) {
      aVal = a.id || '';
      bVal = b.id || '';
    }

    // For priority sorting, we want descending order by default (urgent first)
    // For other sorts, ascending order is default
    const isPrioritySorting = sortBy === 'priority';
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
  allPlans: Map<number, PlanWithFilename>
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
  plans: PlanWithFilename[],
  allPlans: Map<number, PlanWithFilename>,
  verbose: boolean
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
  plans: PlanWithFilename[],
  allPlans: Map<number, PlanWithFilename>
): void {
  const tableData: string[][] = [];

  // Header row
  tableData.push([
    chalk.bold('ID'),
    chalk.bold('Title'),
    chalk.bold('Status'),
    chalk.bold('Priority'),
    chalk.bold('Tasks'),
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

    // Dependency count
    const depCount = plan.dependencies?.length || 0;
    const depDisplay = depCount > 0 ? `${depCount} done` : '-';

    tableData.push([
      chalk.cyan(plan.id || 'no-id'),
      getCombinedTitleFromSummary(plan),
      statusColor(status),
      priority ? priorityColor(priority) : '-',
      taskDisplay,
      depCount > 0 ? chalk.green(depDisplay) : depDisplay,
    ]);
  }

  // Calculate responsive column widths
  const terminalWidth = process.stdout.columns || 120;
  // Columns: ID(6) + Status(12) + Priority(10) + Tasks(8) + Deps(12) + borders(7*3=21) = 69
  const fixedWidth = 69;
  const titleWidth = Math.max(30, terminalWidth - fixedWidth);

  // Configure table
  const tableConfig: TableUserConfig = {
    columns: {
      1: { width: titleWidth, wrapWord: true },
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
async function displayJsonFormat(plans: PlanWithFilename[]): Promise<void> {
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
    })),
  };

  log(JSON.stringify(result, null, 2));
}

export async function handleReadyCommand(options: ReadyCommandOptions, command: any) {
  // Validate input options
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

  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const tasksDir = await resolveTasksDir(config);
  const { plans } = await readAllPlans(tasksDir);

  // Filter to ready plans
  const pendingOnly = options.pendingOnly || false;
  let readyPlans = Array.from(plans.values()).filter((plan) =>
    isReadyPlan(plan, plans, pendingOnly)
  );

  // Apply priority filter if specified
  if (options.priority) {
    readyPlans = readyPlans.filter((plan) => plan.priority === options.priority);
  }

  if (readyPlans.length === 0) {
    log('No plans are currently ready to execute.');
    if (pendingOnly) {
      log('Try without --pending-only to include in_progress plans.');
    } else {
      log('All pending plans have incomplete dependencies.');
    }
    return;
  }

  // Sort plans
  const sortBy = options.sort || 'priority';
  const reverse = options.reverse || false;
  readyPlans = sortPlans(readyPlans, sortBy, reverse);

  // Display in requested format
  const format = options.format || 'list';
  switch (format) {
    case 'table':
      displayTableFormat(readyPlans, plans);
      break;
    case 'json':
      await displayJsonFormat(readyPlans);
      break;
    case 'list':
    default:
      displayListFormat(readyPlans, plans, options.verbose || false);
      break;
  }
}
