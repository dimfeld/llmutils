// Command handler for 'rmplan list'
// Lists all plan files in the tasks directory

import chalk from 'chalk';
import * as path from 'path';
import { table } from 'table';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { getCombinedTitleFromSummary } from '../display_utils.js';
import { isPlanReady, readAllPlans } from '../plans.js';

export async function handleListCommand(options: any, command: any) {
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

  if (!options.all) {
    // Determine which statuses to show
    let statusesToShow: Set<string>;

    if (options.status && options.status.length > 0) {
      // Use explicitly specified statuses
      statusesToShow = new Set(options.status);
    } else {
      // Default: show pending and in_progress
      statusesToShow = new Set(['pending', 'in_progress']);
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

  // Display as table
  log(chalk.bold('Plan Files:'));
  log('');

  // Prepare table data
  const tableData: string[][] = [];

  // Header row
  tableData.push([
    chalk.bold('ID'),
    chalk.bold('Title'),
    chalk.bold('Status'),
    chalk.bold('Priority'),
    chalk.bold('Tasks'),
    chalk.bold('Steps'),
    chalk.bold('Depends On'),
    chalk.bold('File'),
  ]);

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
          } else {
            return `${depId}`;
          }
        })
        .join(', ');
    }

    tableData.push([
      chalk.cyan(plan.id || 'no-id'),
      getCombinedTitleFromSummary(plan),
      statusColor(statusDisplay),
      priorityColor(priorityDisplay),
      (() => {
        const taskCount = plan.tasks?.length || 0;
        return plan.container && taskCount === 0 ? '-' : taskCount.toString();
      })(),
      (() => {
        const stepCount =
          plan.tasks?.reduce((sum, task) => sum + (task.steps?.length || 0), 0) || 0;
        return stepCount === 0 ? '-' : stepCount.toString();
      })(),
      dependenciesDisplay,
      chalk.gray(path.relative(searchDir, plan.filename)),
    ]);
  }

  // Configure table options
  const tableConfig = {
    columns: {
      1: { width: 50, wrapWord: true },
      6: { width: 15, wrapWord: true },
      7: { width: 20, wrapWord: true },
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

  const output = table(tableData, tableConfig);
  log(output);

  log(`Showing: ${planArray.length} of ${plans.size} plan(s)`);

  // Display duplicate IDs if any exist
  if (duplicates.length > 0) {
    log('');
    log(chalk.yellow.bold('⚠️  Duplicate plan IDs found:'));
    for (const duplicateId of duplicates) {
      log(chalk.yellow(`   - ID ${duplicateId}`));
    }
    log('');
    log(chalk.cyan('Run'), chalk.bold('rmplan renumber'), chalk.cyan('to fix duplicate IDs.'));
  }
}
