// Command handler for 'rmplan list'
// Lists all plan files in the tasks directory

import chalk from 'chalk';
import * as path from 'path';
import { table } from 'table';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { getCombinedTitleFromSummary } from '../display_utils.js';
import { isPlanReady, isTaskDone, readAllPlans } from '../plans.js';

export async function handleListCommand(options: any, command: any, searchTerms?: string[]) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  // Determine directory to search
  let searchDir = options.dir || (await resolveTasksDir(config));

  // Read all plans
  const { plans, duplicates } = await readAllPlans(searchDir);

  if (plans.size === 0) {
    log('No plan files found in', searchDir);
    return;
  }

  // Filter plans based on status
  let planArray = Array.from(plans.values());

  // Filter by assignedTo if requested
  if (options.user || options.mine) {
    const filterUser = options.mine ? process.env.USER || process.env.USERNAME : options.user;
    if (filterUser) {
      planArray = planArray.filter((plan) => plan.assignedTo === filterUser);
    } else if (options.mine) {
      log(chalk.yellow('Warning: Could not determine current user from environment'));
    }
  }

  // Filter by search terms if provided
  if (searchTerms && searchTerms.length > 0) {
    planArray = planArray.filter((plan) => {
      const title = getCombinedTitleFromSummary(plan).toLowerCase();
      return searchTerms.some((term: string) => title.includes(term.toLowerCase()));
    });
  }

  if (!options.all) {
    // Determine which statuses to show
    let statusesToShow: Set<string>;

    if (options.status && options.status.length > 0) {
      // Use explicitly specified statuses
      statusesToShow = new Set(options.status);
    } else {
      // Default: show pending, deferred, and in_progress
      statusesToShow = new Set(['pending', 'deferred', 'in_progress']);
    }

    // Filter plans
    planArray = planArray.filter((plan) => {
      const status = plan.status || 'pending';

      // Handle "ready" status filter
      if (statusesToShow.has('ready')) {
        if (isPlanReady(plan, plans)) {
          return true;
        }
      }

      return statusesToShow.has(status);
    });
  }

  // Sort based on the specified field
  planArray.sort((a, b) => {
    let aVal: string | number;
    let bVal: string | number;
    switch (options.sort) {
      case 'title':
        aVal = (a.title || a.goal || '').toLowerCase();
        bVal = (b.title || b.goal || '').toLowerCase();
        break;
      case 'status':
        aVal = a.status || '';
        bVal = b.status || '';
        break;
      case 'priority': {
        // Sort priority in reverse (high first)
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
      case 'created':
        aVal = a.createdAt || '';
        bVal = b.createdAt || '';
        break;
      case 'updated':
        aVal = a.updatedAt || '';
        bVal = b.updatedAt || '';
        break;
      case 'id':
      default: {
        let aNum = Number(a.id || 0);
        let bNum = Number(b.id || 0);

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
    }

    if (aVal < bVal) return options.reverse ? 1 : -1;
    if (aVal > bVal) return options.reverse ? -1 : 1;
    return 0;
  });

  // Store the original filtered count before applying limit
  const originalFilteredCount = planArray.length;

  // Apply result limit if specified
  if (options.number && options.number > 0) {
    planArray = planArray.slice(-options.number);
  }

  // Prepare table data
  const tableData: string[][] = [];

  // Header row
  const headers = [
    chalk.bold('ID'),
    chalk.bold('Title'),
    chalk.bold('Status'),
    chalk.bold('Priority'),
    chalk.bold('Tasks'),
    chalk.bold('Steps'),
    chalk.bold('Depends On'),
  ];

  if (options.files) {
    headers.push(chalk.bold('File'));
  }

  tableData.push(headers);

  // Data rows
  for (const plan of planArray) {
    // Display "ready" for pending plans whose dependencies are all done
    const actualStatus = plan.status || 'pending';
    const isReady = isPlanReady(plan, plans);
    const statusDisplay = isReady ? 'ready' : actualStatus;

    const statusColor =
      actualStatus === 'done'
        ? chalk.green
        : actualStatus === 'cancelled'
          ? chalk.strikethrough.gray
          : actualStatus === 'deferred'
            ? chalk.dim.gray
            : isReady
              ? chalk.cyan
              : actualStatus === 'in_progress'
                ? chalk.yellow
                : actualStatus === 'pending'
                  ? chalk.white
                  : chalk.gray;

    const priorityColor =
      plan.priority === 'urgent'
        ? chalk.red
        : plan.priority === 'high'
          ? // orange
            chalk.rgb(255, 165, 0)
          : plan.priority === 'medium'
            ? chalk.yellow
            : plan.priority === 'low'
              ? chalk.blue
              : plan.priority === 'maybe'
                ? chalk.gray
                : chalk.white;

    const priorityDisplay = plan.priority || '';

    // Format dependencies with their status
    let dependenciesDisplay = '-';
    if (plan.dependencies && plan.dependencies.length > 0) {
      dependenciesDisplay = plan.dependencies
        .map((depId) => {
          // Try to get the dependency plan
          let depPlan = plans.get(depId);

          // If not found and the dependency ID is a numeric string, try as a number
          if (!depPlan && typeof depId === 'string' && /^\d+$/.test(depId)) {
            depPlan = plans.get(parseInt(depId, 10));
          }

          if (!depPlan) {
            return `${depId}(?)`;
          }

          const depStatus = depPlan.status || 'pending';
          if (depStatus === 'done') {
            return chalk.green(`${depId}✓`);
          } else if (depStatus === 'in_progress') {
            return chalk.yellow(`${depId}…`);
          } else if (depStatus === 'cancelled') {
            return chalk.gray(`${depId}✗`);
          } else {
            return `${depId}`;
          }
        })
        .join(', ');
    }

    const row = [
      chalk.cyan(plan.id || 'no-id'),
      getCombinedTitleFromSummary(plan),
      statusColor(statusDisplay),
      priorityDisplay ? priorityColor(priorityDisplay) : '-',
      (() => {
        const taskCount = plan.tasks?.length || 0;
        if (taskCount) {
          const doneTasks = plan.tasks?.filter(isTaskDone);
          if (doneTasks?.length) {
            return `${doneTasks.length}/${taskCount}`;
          }

          return taskCount.toString();
        }
        return plan.container ? 'CTR' : '-';
      })(),
      (() => {
        const stepCount =
          plan.tasks?.reduce((sum, task) => sum + (task.steps?.length || 0), 0) || 0;
        return stepCount === 0 ? '-' : stepCount.toString();
      })(),
      dependenciesDisplay,
    ];

    if (options.files) {
      row.push(chalk.gray(path.relative(searchDir, plan.filename)));
    }

    tableData.push(row);
  }

  // Find the maximum title length in the data
  let maxTitleLength = 5; // Start with header length "Title"
  for (const plan of planArray) {
    const title = getCombinedTitleFromSummary(plan);
    maxTitleLength = Math.max(maxTitleLength, title.length);
  }

  // Configure table options with dynamic column widths
  const terminalWidth = process.stdout.columns || 120; // fallback to 120 if not available

  // Fixed column widths: ID(5), Status(12), Priority(10), Tasks(7), Steps(7), Depends(15)
  const fixedColumnsWidth = 5 + 12 + 10 + 7 + 7 + 15;
  const fileColumnWidth = options.files ? 20 : 0;
  const columnCount = options.files ? 8 : 7;
  const borderPadding = columnCount * 3 + 1; // 3 chars per column separator + 1 for end

  // Calculate available width for the title column
  const usedWidth = fixedColumnsWidth + fileColumnWidth + borderPadding;
  const availableWidth = terminalWidth - usedWidth;

  // Use the smaller of calculated width or max title length (with some padding)
  const calculatedTitleWidth = Math.max(20, availableWidth);
  const titleWidth = Math.min(calculatedTitleWidth, maxTitleLength + 2); // +2 for padding
  const dependsWidth = 15;
  const fileWidth = 20;

  const tableConfig: any = {
    columns: {
      1: { width: titleWidth, wrapWord: true },
      6: { width: dependsWidth, wrapWord: true },
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

  // Add file column configuration if showing files
  if (options.files) {
    tableConfig.columns[7] = { width: fileWidth, wrapWord: true };
  }

  const output = table(tableData, tableConfig);
  log(output);

  // Display appropriate status message
  if (options.number && options.number > 0 && planArray.length < originalFilteredCount) {
    log(
      `Showing ${planArray.length} of ${originalFilteredCount} plan(s) (limited to ${options.number})`
    );
  } else {
    log(`Showing ${planArray.length} of ${plans.size} plan(s)`);
  }

  // Display duplicate IDs if any exist
  const duplicateIds = Object.keys(duplicates)
    .map(Number)
    .sort((a, b) => a - b);
  if (duplicateIds.length > 0) {
    log('');
    log(chalk.yellow.bold('⚠️  Duplicate plan IDs found:'));
    for (const duplicateId of duplicateIds) {
      log(chalk.yellow(`   - ID ${duplicateId}:`));
      const filePaths = duplicates[duplicateId].sort((a, b) => a.localeCompare(b));
      for (const filePath of filePaths) {
        const relativePath = path.relative(searchDir, filePath);
        log(chalk.gray(`     • ${relativePath}`));
      }
    }
    log('');
    log(chalk.cyan('Run'), chalk.bold('rmplan renumber'), chalk.cyan('to fix duplicate IDs.'));
  }
}
