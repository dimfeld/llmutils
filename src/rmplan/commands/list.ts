// Command handler for 'rmplan list'
// Lists all plan files in the tasks directory

import * as path from 'path';
import chalk from 'chalk';
import { table } from 'table';
import { error, log } from '../../logging.js';
import { getGitRoot } from '../../rmfilter/utils.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readAllPlans, isPlanReady, type PlanSummary } from '../plans.js';
import { getCombinedTitleFromSummary } from '../display_utils.js';

export async function handleListCommand(options: any, command: any) {
  try {
    const globalOpts = command.parent.opts();
    const config = await loadEffectiveConfig(globalOpts.config);

    // Determine directory to search
    let searchDir = options.dir || (await resolveTasksDir(config));

    // Read all plans
    const { plans } = await readAllPlans(searchDir);

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
          const priorityOrder: Record<string, number> = { urgent: 5, high: 4, medium: 3, low: 2 };
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
        default:
          aVal = a.id || '';
          bVal = b.id || '';
          break;
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
          : isReady
            ? chalk.cyan
            : actualStatus === 'in_progress'
              ? chalk.yellow
              : actualStatus === 'pending'
                ? chalk.white
                : chalk.gray;

      const priorityColor =
        plan.priority === 'urgent'
          ? chalk.magenta
          : plan.priority === 'high'
            ? chalk.red
            : plan.priority === 'medium'
              ? chalk.yellow
              : plan.priority === 'low'
                ? chalk.blue
                : chalk.white;

      const priorityDisplay = plan.priority || '';

      tableData.push([
        chalk.cyan(plan.id || 'no-id'),
        getCombinedTitleFromSummary(plan),
        statusColor(statusDisplay),
        priorityColor(priorityDisplay),
        (plan.taskCount || 0).toString(),
        plan.stepCount === 0 || !plan.stepCount ? '-' : plan.stepCount.toString(),
        plan.dependencies?.join(', ') || '-',
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
  } catch (err) {
    error('Failed to list plans:', err);
    process.exit(1);
  }
}

/**
 * Resolves the tasks directory path, handling both absolute and relative paths.
 * If tasks path is relative, it's resolved relative to the git root.
 */
async function resolveTasksDir(config: any): Promise<string> {
  const gitRoot = (await getGitRoot()) || process.cwd();

  if (config.paths?.tasks) {
    return path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  }

  return gitRoot;
}
