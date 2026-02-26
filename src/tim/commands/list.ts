// Command handler for 'tim list'
// Lists all plan files in the tasks directory

import chalk from 'chalk';
import * as path from 'path';
import { table } from 'table';

import { log, warn } from '../../logging.js';
import { getRepositoryIdentity, getUserIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import { getAssignmentEntriesByProject, type AssignmentEntry } from '../db/assignment.js';
import { getDatabase } from '../db/database.js';
import {
  getPlanDependenciesByProject,
  getPlansByProject,
  getPlanTasksByProject,
} from '../db/plan.js';
import { getProject } from '../db/project.js';
import {
  formatTagsSummary,
  formatWorkspacePath,
  getCombinedTitleFromSummary,
} from '../display_utils.js';
import type { PlanSchema } from '../planSchema.js';
import { isPlanReady, isTaskDone, readAllPlans } from '../plans.js';
import { getParentChain, isUnderEpic } from '../utils/hierarchy.js';
import { normalizeTags } from '../utils/tags.js';

type PlanWithFilename = PlanSchema & { filename: string };

type ListPlan = PlanWithFilename & {
  assignmentEntry?: AssignmentEntry;
  assignedWorkspaces: string[];
  assignedUsers: string[];
  isAssigned: boolean;
  isAssignedHere: boolean;
};

interface ListPlansLoadResult {
  plans: Map<number, PlanWithFilename>;
  duplicates: Record<number, string[]>;
}

function loadPlansFromDb(searchDir: string, repositoryId: string): ListPlansLoadResult {
  const db = getDatabase();
  const project = getProject(db, repositoryId);
  if (!project) {
    return { plans: new Map(), duplicates: {} };
  }

  const rows = getPlansByProject(db, project.id);
  if (rows.length === 0) {
    return { plans: new Map(), duplicates: {} };
  }

  const planUuidToId = new Map<string, number>();
  for (const row of rows) {
    planUuidToId.set(row.uuid, row.plan_id);
  }

  const tasksByPlanUuid = new Map<
    string,
    Array<{ title: string; description: string; done: boolean }>
  >();
  const taskRows = getPlanTasksByProject(db, project.id);
  for (const taskRow of taskRows) {
    const list = tasksByPlanUuid.get(taskRow.plan_uuid) ?? [];
    list.push({
      title: taskRow.title,
      description: taskRow.description,
      done: taskRow.done === 1,
    });
    tasksByPlanUuid.set(taskRow.plan_uuid, list);
  }

  const dependenciesByPlanUuid = new Map<string, number[]>();
  const dependencyRows = getPlanDependenciesByProject(db, project.id);
  for (const dependencyRow of dependencyRows) {
    const dependencyPlanId = planUuidToId.get(dependencyRow.depends_on_uuid);
    if (dependencyPlanId === undefined) {
      continue;
    }

    const list = dependenciesByPlanUuid.get(dependencyRow.plan_uuid) ?? [];
    list.push(dependencyPlanId);
    dependenciesByPlanUuid.set(dependencyRow.plan_uuid, list);
  }

  const plans = new Map<number, PlanWithFilename>();
  const seenIds = new Map<number, string[]>();

  for (const row of rows) {
    const absoluteFilename = path.join(searchDir, row.filename);
    const existingPaths = seenIds.get(row.plan_id) ?? [];
    existingPaths.push(absoluteFilename);
    seenIds.set(row.plan_id, existingPaths);

    const plan: PlanWithFilename = {
      id: row.plan_id,
      uuid: row.uuid,
      title: row.title ?? undefined,
      goal: row.goal ?? '',
      details: row.details ?? '',
      status: row.status,
      priority: row.priority ?? undefined,
      branch: row.branch ?? undefined,
      epic: row.epic === 1,
      tasks: tasksByPlanUuid.get(row.uuid) ?? [],
      dependencies: dependenciesByPlanUuid.get(row.uuid) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      filename: absoluteFilename,
    };

    plans.set(row.plan_id, plan);
  }

  const duplicates: Record<number, string[]> = {};
  for (const [id, filePaths] of seenIds.entries()) {
    if (filePaths.length > 1) {
      duplicates[id] = filePaths;
    }
  }

  return { plans, duplicates };
}

export async function handleListCommand(options: any, command: any, searchTerms?: string[]) {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  if (options.assigned && options.unassigned) {
    throw new Error('Cannot use --assigned and --unassigned together.');
  }

  if (options.here && (options.assigned || options.unassigned)) {
    throw new Error('Cannot use --here with --assigned or --unassigned.');
  }

  // Determine directory to search
  let searchDir = options.dir || (await resolveTasksDir(config));

  const repository = await getRepositoryIdentity({ cwd: searchDir });

  const useLocalFiles = options.local === true;
  let plans: Map<number, PlanWithFilename>;
  let duplicates: Record<number, string[]>;
  if (useLocalFiles) {
    ({ plans, duplicates } = await readAllPlans(searchDir));
  } else {
    ({ plans, duplicates } = loadPlansFromDb(searchDir, repository.repositoryId));
    if (plans.size === 0) {
      // Fallback keeps list useful in repositories that have not synced plans into SQLite yet.
      ({ plans, duplicates } = await readAllPlans(searchDir));
    }
  }

  if (plans.size === 0) {
    log('No plans found in', searchDir);
    return;
  }

  const db = getDatabase();
  let assignmentsLookup: Record<string, AssignmentEntry> = {};
  const project = getProject(db, repository.repositoryId);
  if (project) {
    assignmentsLookup = getAssignmentEntriesByProject(db, project.id);
  }

  const enrichedPlans = new Map<number, ListPlan>();
  for (const [planId, plan] of plans.entries()) {
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
        (assignmentEntry?.users ?? []).filter((user): user is string =>
          Boolean(user && user.trim())
        )
      )
    );

    if (assignedUsers.length === 0 && plan.assignedTo && plan.assignedTo.trim().length > 0) {
      assignedUsers.push(plan.assignedTo.trim());
    }

    const fallbackAssigned = assignedWorkspaces.length === 0 && assignedUsers.length > 0;

    const listPlan: ListPlan = {
      ...plan,
      assignmentEntry,
      assignedWorkspaces,
      assignedUsers,
      isAssigned: assignedWorkspaces.length > 0 || fallbackAssigned,
      isAssignedHere: assignedWorkspaces.includes(repository.gitRoot),
    };

    enrichedPlans.set(planId, listPlan);
  }

  // Filter plans based on status
  let planArray = Array.from(enrichedPlans.values());

  let userFilter: string | undefined;
  if (options.mine) {
    const identity = getUserIdentity();
    if (identity) {
      userFilter = identity;
    } else {
      warn(`${chalk.yellow('⚠')} Could not determine current user for --mine filter.`);
    }
  } else if (typeof options.user === 'string' && options.user.trim().length > 0) {
    userFilter = options.user.trim();
  }

  if (userFilter) {
    const normalizedFilter = userFilter.toLowerCase();
    planArray = planArray.filter((plan) => {
      if (plan.assignedUsers.some((user) => user.toLowerCase() === normalizedFilter)) {
        return true;
      }

      if (plan.assignedTo && plan.assignedTo.toLowerCase() === normalizedFilter) {
        return true;
      }

      return false;
    });
  }

  // Filter by search terms if provided
  if (searchTerms && searchTerms.length > 0) {
    planArray = planArray.filter((plan) => {
      const title = getCombinedTitleFromSummary(plan).toLowerCase();
      return searchTerms.some((term: string) => title.includes(term.toLowerCase()));
    });
  }

  if (options.assigned) {
    planArray = planArray.filter((plan) => plan.isAssigned);
  } else if (options.unassigned) {
    planArray = planArray.filter((plan) => !plan.isAssigned);
  } else if (options.here) {
    planArray = planArray.filter((plan) => plan.isAssignedHere);
  }

  const desiredTags = normalizeTags(options.tag);
  if (desiredTags.length > 0) {
    const tagFilter = new Set(desiredTags);
    planArray = planArray.filter((plan) => {
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

    const epicPlan = enrichedPlans.get(epicId);
    if (!epicPlan) {
      throw new Error(`Epic plan ${epicId} not found`);
    }

    planArray = planArray.filter(
      (plan) => plan.id === epicId || isUnderEpic(plan, epicId, enrichedPlans)
    );
  }

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
        if (isPlanReady(plan, enrichedPlans)) {
          return true;
        }
      }

      // Handle "blocked" status filter
      if (statusesToShow.has('blocked')) {
        const isBlocked =
          status === 'pending' &&
          plan.dependencies &&
          plan.dependencies.length > 0 &&
          !isPlanReady(plan, enrichedPlans);

        if (isBlocked) {
          return true;
        }
      }

      return statusesToShow.has(status);
    });
  }

  // Sort based on the specified field
  // TODO Secondary sorts for low-cardinality fields like status and priority
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
      case 'updated':
        aVal = a.updatedAt || '';
        bVal = b.updatedAt || '';
        break;
      case 'id': {
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
      case 'created':
      default:
        aVal = a.createdAt || '';
        bVal = b.createdAt || '';
        break;
    }

    if (aVal === bVal) {
      // Always fall back to ID sort.
      aVal = a.id || '';
      bVal = b.id || '';
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

  const workspaceColumnWidth = 22;
  const epicColumnWidth = 6;
  const dependsWidth = 15;
  const fileWidth = 20;
  const tagsColumnWidth = 18;

  // Prepare table data
  const tableData: string[][] = [];

  // Header row
  const headers = [
    chalk.bold('ID'),
    chalk.bold('Epic'),
    chalk.bold('Title'),
    chalk.bold('Status'),
    chalk.bold('Workspace'),
    chalk.bold('Priority'),
    chalk.bold('Tags'),
    chalk.bold('Tasks'),
    chalk.bold('Steps'),
    chalk.bold('Depends On'),
  ];

  if (options.showFiles) {
    headers.push(chalk.bold('File'));
  }

  tableData.push(headers);

  // Data rows
  for (const plan of planArray) {
    // Display "ready" for pending plans whose dependencies are all done
    // Display "blocked" for pending plans that have incomplete dependencies
    const actualStatus = plan.status || 'pending';
    const isReady = isPlanReady(plan, enrichedPlans);

    // Check if plan is blocked (has dependencies that are not all done)
    const isBlocked =
      actualStatus === 'pending' &&
      plan.dependencies?.some((dep) => {
        const numericDep = typeof dep === 'number' ? dep : Number(dep);
        const depPlan = enrichedPlans.get(numericDep);
        return depPlan?.status !== 'done';
      });

    const statusDisplay = isReady ? 'ready' : isBlocked ? 'blocked' : actualStatus;

    const statusColor =
      actualStatus === 'done'
        ? chalk.green
        : actualStatus === 'cancelled'
          ? chalk.strikethrough.gray
          : actualStatus === 'deferred'
            ? chalk.dim.gray
            : isReady
              ? chalk.cyan
              : isBlocked
                ? chalk.magenta
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
          let depPlan: ListPlan | undefined;

          if (typeof depId === 'number') {
            depPlan = enrichedPlans.get(depId);
          } else if (typeof depId === 'string' && /^\d+$/.test(depId)) {
            depPlan = enrichedPlans.get(parseInt(depId, 10));
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

    const workspaceDisplay = (() => {
      if (plan.assignedWorkspaces.length > 0) {
        const formatted = plan.assignedWorkspaces.map((workspace) => {
          const display = formatWorkspacePath(workspace, { currentWorkspace: repository.gitRoot });
          return workspace === repository.gitRoot ? chalk.green(display) : display;
        });
        const [first, ...rest] = formatted;
        return rest.length > 0 ? `${first} (+${rest.length})` : first;
      }

      if (plan.assignedUsers.length > 0) {
        return plan.assignedUsers.join(', ');
      }

      if (plan.assignedTo) {
        return plan.assignedTo;
      }

      return chalk.gray('unassigned');
    })();

    const parentChain = getParentChain(plan, enrichedPlans);
    const epicParent = plan.epic ? plan : parentChain.find((parent) => parent.epic);
    const epicDisplay = epicParent?.id ? chalk.cyan(String(epicParent.id)) : '-';

    const row = [
      chalk.cyan(plan.id || 'no-id'),
      epicDisplay,
      getCombinedTitleFromSummary(plan) + (plan.temp ? chalk.gray(' (temp)') : ''),
      statusColor(statusDisplay),
      workspaceDisplay,
      priorityDisplay ? priorityColor(priorityDisplay) : '-',
      formatTagsSummary(plan.tags, { maxLength: tagsColumnWidth }),
      (() => {
        const taskCount = plan.tasks?.length || 0;
        if (taskCount) {
          const doneTasks = plan.tasks?.filter(isTaskDone);
          if (doneTasks?.length) {
            return `${doneTasks.length}/${taskCount}`;
          }

          return taskCount.toString();
        }
        return plan.epic ? 'EPIC' : '-';
      })(),
      '-',
      dependenciesDisplay,
    ];

    if (options.showFiles) {
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

  const fixedColumnsWidth =
    5 + // ID
    epicColumnWidth +
    12 + // Status
    workspaceColumnWidth +
    10 + // Priority
    tagsColumnWidth +
    7 + // Tasks
    7 + // Steps
    dependsWidth;

  const fileColumnWidth = options.showFiles ? fileWidth : 0;
  const columnCount = options.showFiles ? 11 : 10;
  const borderPadding = columnCount * 3 + 1; // 3 chars per column separator + 1 for end

  const usedWidth = fixedColumnsWidth + fileColumnWidth + borderPadding;
  const availableWidth = terminalWidth - usedWidth;

  const titleWidth = Math.min(Math.max(20, availableWidth), maxTitleLength + 2);

  const dependsColumnIndex = 9;

  const tableConfig: any = {
    columns: {
      2: { width: titleWidth, wrapWord: true },
      4: { width: workspaceColumnWidth, wrapWord: true },
      6: { width: tagsColumnWidth, wrapWord: true },
      [dependsColumnIndex]: { width: dependsWidth, wrapWord: true },
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
  if (options.showFiles) {
    tableConfig.columns[10] = { width: fileWidth, wrapWord: true };
  }

  const output = table(tableData, tableConfig);
  log(output);

  // Display appropriate status message
  if (options.number && options.number > 0 && planArray.length < originalFilteredCount) {
    log(
      `Showing ${planArray.length} of ${originalFilteredCount} plan(s) (limited to ${options.number})`
    );
  } else {
    log(`Showing ${planArray.length} of ${enrichedPlans.size} plan(s)`);
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
    log(chalk.cyan('Run'), chalk.bold('tim renumber'), chalk.cyan('to fix duplicate IDs.'));
  }
}
