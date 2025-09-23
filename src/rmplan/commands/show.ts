// Command handler for 'rmplan show'
// Displays detailed information about a plan

import chalk from 'chalk';
import { stat } from 'node:fs/promises';
import * as clipboard from '../../common/clipboard.js';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolveTasksDir } from '../configSchema.js';
import {
  getCombinedGoal,
  getCombinedTitle,
  getCombinedTitleFromSummary,
} from '../display_utils.js';
import {
  findNextPlan,
  isPlanReady,
  readAllPlans,
  readPlanFile,
  resolvePlanFile,
} from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { findNextReadyDependency } from './find_next_dependency.js';
import { MAX_NOTE_CHARS } from '../truncation.js';

type PlanWithFilename = PlanSchema & { filename: string };

const MIN_TIMESTAMP = Number.NEGATIVE_INFINITY;

function parseIsoTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

async function getPlanTimestamp(plan: PlanWithFilename): Promise<number> {
  const updatedAt = parseIsoTimestamp(plan.updatedAt);
  if (updatedAt !== undefined) {
    return updatedAt;
  }

  const createdAt = parseIsoTimestamp(plan.createdAt);
  if (createdAt !== undefined) {
    return createdAt;
  }

  try {
    const fileStats = await stat(plan.filename);
    return fileStats.mtimeMs;
  } catch {
    return MIN_TIMESTAMP;
  }
}

/**
 * Display plan information based on options
 */
async function displayPlanInfo(
  plan: PlanSchema,
  resolvedPlanFile: string,
  allPlans: Map<number, PlanSchema & { filename: string }>,
  options: any
): Promise<number> {
  // Display "ready" for pending plans whose dependencies are done
  const actualStatus = plan.status || 'pending';
  const isReady = plan.id
    ? isPlanReady(
        {
          ...plan,
          filename: resolvedPlanFile,
        },
        allPlans
      )
    : false;
  const statusDisplay = isReady ? 'ready' : actualStatus;
  const statusColor = isReady
    ? chalk.cyan
    : actualStatus === 'done'
      ? chalk.green
      : actualStatus === 'cancelled'
        ? chalk.strikethrough.gray
        : actualStatus === 'deferred'
          ? chalk.dim.gray
          : actualStatus === 'in_progress'
            ? chalk.yellow
            : chalk.white;

  let outputLines = 0;

  if (options.short || options.watch) {
    const output = [];
    output.push(chalk.bold('\nPlan Summary:'));
    output.push('─'.repeat(60));
    output.push(`${chalk.cyan('ID:')} ${plan.id || 'Not set'}`);
    output.push(`${chalk.cyan('Title:')} ${getCombinedTitle(plan)}`);
    output.push(`${chalk.cyan('Status:')} ${statusColor(statusDisplay)}`);

    const notes = plan.progressNotes ?? [];
    if (notes.length > 0) {
      const latestNotes = notes.slice(-10).map((latestNote) => {
        const timestamp = latestNote.timestamp
          ? new Date(latestNote.timestamp).toLocaleString()
          : undefined;
        const sourceLabel = (latestNote.source || '').trim();
        const combined = sourceLabel.length
          ? `[${sourceLabel}] ${latestNote.text ?? ''}`
          : (latestNote.text ?? '');
        const singleLine = combined.replace(/\s+/g, ' ').trim();
        const truncated =
          singleLine.length > MAX_NOTE_CHARS
            ? singleLine.slice(0, Math.max(0, MAX_NOTE_CHARS - 3)) + '...'
            : singleLine;
        if (timestamp) {
          return `  ${chalk.gray(timestamp)}  ${truncated}`;
        } else if (truncated) {
          return `  ${truncated}`;
        } else {
          return '';
        }
      });

      output.push('\n' + chalk.bold('Latest Progress Notes:'));
      output.push('─'.repeat(60));
      for (const note of latestNotes) {
        if (note) {
          output.push(note);
        }
      }
    }

    if (plan.container) {
      output.push('\n' + chalk.bold('Tasks:'));
      output.push('─'.repeat(60));
      output.push(
        chalk.gray('This is a parent-only plan that serves as a container for other plans.')
      );
    } else if (plan.tasks && plan.tasks.length > 0) {
      output.push('\n' + chalk.bold('Tasks:'));
      output.push('─'.repeat(60));
      plan.tasks.forEach((task, i) => {
        const steps = task.steps ?? [];
        const totalSteps = steps.length;
        const doneSteps = steps.filter((s) => s.done).length;
        const taskComplete =
          (totalSteps > 0 && doneSteps === totalSteps) || (totalSteps === 0 && task.done);
        const taskIcon = taskComplete ? '✓' : totalSteps > 0 && doneSteps > 0 ? '⏳' : '○';
        const taskColor = taskComplete
          ? chalk.green
          : totalSteps > 0 && doneSteps > 0
            ? chalk.yellow
            : chalk.white;
        const title = task.title || '(untitled task)';
        const index = (i + 1).toString().padStart(2, ' ');
        output.push(`  ${taskIcon} ${taskColor(index + '. ' + title)}`);
      });
    }

    if (options.watch) {
      output.push('');
      output.push(chalk.gray('(watching... press Ctrl+C to exit)'));
    }

    const fullOutput = output.join('\n');
    log(fullOutput);
    outputLines = fullOutput.split('\n').length;
  } else {
    // Full display logic (existing code)
    log(chalk.bold('\nPlan Information:'));
    log('─'.repeat(60));
    log(`${chalk.cyan('ID:')} ${plan.id || 'Not set'}`);
    log(`${chalk.cyan('Title:')} ${getCombinedTitle(plan)}`);
    log(`${chalk.cyan('Status:')} ${statusColor(statusDisplay)}`);

    if (plan.statusDescription) {
      log(`${chalk.cyan('Status Description:')} ${plan.statusDescription}`);
    }

    const priorityColor =
      plan.priority === 'urgent'
        ? chalk.red
        : plan.priority === 'high'
          ? chalk.magenta
          : plan.priority === 'medium'
            ? chalk.yellow
            : plan.priority === 'low'
              ? chalk.blue
              : plan.priority === 'maybe'
                ? chalk.gray
                : chalk.white;
    log(`${chalk.cyan('Priority:')} ${plan.priority ? priorityColor(plan.priority) : ''}`);
    if (plan.assignedTo) {
      log(`${chalk.cyan('Assigned To:')} ${plan.assignedTo}`);
    }

    // Display parent plan if present
    if (plan.parent) {
      const parentPlan = allPlans.get(plan.parent);
      if (parentPlan) {
        log(
          `${chalk.cyan('Parent:')} ${chalk.cyan(plan.parent)} - ${getCombinedTitleFromSummary(parentPlan)}`
        );
      } else {
        log(`${chalk.cyan('Parent:')} ${chalk.cyan(plan.parent)} ${chalk.red('[Not found]')}`);
      }
    }
    log(`${chalk.cyan('Goal:')} ${getCombinedGoal(plan)}`);
    log(`${chalk.cyan('File:')} ${resolvedPlanFile}`);
    if (plan.progressNotes && plan.progressNotes.length > 0) {
      log(`${chalk.cyan('Progress Notes:')} ${plan.progressNotes.length}`);
    }

    if (plan.baseBranch) {
      log(`${chalk.cyan('Base Branch:')} ${plan.baseBranch}`);
    }

    if (plan.createdAt) {
      log(`${chalk.cyan('Created:')} ${new Date(plan.createdAt).toLocaleString()}`);
    }

    if (plan.updatedAt) {
      log(`${chalk.cyan('Updated:')} ${new Date(plan.updatedAt).toLocaleString()}`);
    }

    // Display dependencies with resolution
    if (plan.dependencies && plan.dependencies.length > 0) {
      log('\n' + chalk.bold('Dependencies:'));
      log('─'.repeat(60));

      for (const depId of plan.dependencies) {
        const depPlan = allPlans.get(depId);
        if (depPlan) {
          const statusIcon =
            depPlan.status === 'done' ? '✓' : depPlan.status === 'in_progress' ? '⏳' : '○';
          const statusColor =
            depPlan.status === 'done'
              ? chalk.green
              : depPlan.status === 'in_progress'
                ? chalk.yellow
                : chalk.gray;
          log(
            `  ${statusIcon} ${chalk.cyan(depId)} - ${getCombinedTitleFromSummary(depPlan)} ${statusColor(`[${depPlan.status || 'pending'}]`)}`
          );
        } else {
          log(`  ○ ${chalk.cyan(depId)} ${chalk.red('[Not found]')}`);
        }
      }
    }

    // Display docs
    if (plan.docs && plan.docs.length > 0) {
      log('\n' + chalk.bold('Documentation Paths:'));
      log('─'.repeat(60));
      plan.docs.forEach((doc) => log(`  • ${doc}`));
    }

    // Display issues and PRs
    if (plan.issue && plan.issue.length > 0) {
      log('\n' + chalk.bold('Issues:'));
      log('─'.repeat(60));
      plan.issue.forEach((url) => log(`  • ${url}`));
    }

    if (plan.pullRequest && plan.pullRequest.length > 0) {
      log('\n' + chalk.bold('Pull Requests:'));
      log('─'.repeat(60));
      plan.pullRequest.forEach((url) => log(`  • ${url}`));
    }

    // Display details
    if (plan.details) {
      log('\n' + chalk.bold('Details:'));
      log('─'.repeat(60));

      if (!options.full) {
        const lines = plan.details.split('\\n');
        if (lines.length > 20) {
          const truncatedLines = lines.slice(0, 20);
          log(truncatedLines.join('\\n'));
          log(chalk.gray(`... and ${lines.length - 20} more lines (use --full to see all)`));
        } else {
          log(plan.details);
        }
      } else {
        log(plan.details);
      }
    }

    // Display progress notes (if any)
    if (plan.progressNotes && plan.progressNotes.length > 0) {
      log('\n' + chalk.bold('Progress Notes:'));
      log('─'.repeat(60));
      const { MAX_SHOW_NOTES, MAX_NOTE_CHARS } = await import('../truncation.js');
      const notes = plan.progressNotes;
      const startIndex = options.full ? 0 : Math.max(0, notes.length - MAX_SHOW_NOTES);
      const visible = notes.slice(startIndex);
      for (const n of visible) {
        const ts = new Date(n.timestamp).toLocaleString();
        const text = n.text || '';
        const sourceLabel = (n.source || '').trim();
        if (options.full) {
          // Show full text, preserving line breaks with indentation
          const lines = text.split('\\n');
          const header = `  • ${chalk.gray(ts)}${sourceLabel.length ? `  [${sourceLabel}]` : ''}`;
          log(header);
          if (text.trim().length > 0) {
            log(`    ${lines.join('\n    ')}`);
          }
        } else {
          // Truncate to a single line for compact display
          const combined = sourceLabel.length ? `[${sourceLabel}] ${text}` : text;
          const singleLine = combined.replace(/\s+/g, ' ').trim();
          const truncated =
            singleLine.length > MAX_NOTE_CHARS
              ? singleLine.slice(0, Math.max(0, MAX_NOTE_CHARS - 3)) + '...'
              : singleLine;
          const body = truncated.length ? truncated : sourceLabel.length ? `[${sourceLabel}]` : '';
          log(`  • ${chalk.gray(ts)}${body ? `  ${body}` : ''}`);
        }
      }
      const hidden = notes.length - visible.length;
      if (hidden > 0) {
        const { formatHiddenNotesSummary } = await import('../truncation.js');
        log(chalk.gray(formatHiddenNotesSummary(hidden)));
      }
    }

    // Display tasks with completion status
    if (plan.container) {
      log('\n' + chalk.bold('Tasks:'));
      log('─'.repeat(60));
      log(chalk.gray('This is a parent-only plan that serves as a container for other plans.'));
    } else if (plan.tasks && plan.tasks.length > 0) {
      log('\n' + chalk.bold('Tasks:'));
      log('─'.repeat(60));

      plan.tasks.forEach((task, taskIdx) => {
        const totalSteps = task.steps.length;
        const doneSteps = task.steps.filter((s) => s.done).length;
        const taskComplete =
          (totalSteps > 0 && doneSteps === totalSteps) || (totalSteps === 0 && task.done);
        const taskIcon = taskComplete ? '✓' : totalSteps > 0 && doneSteps > 0 ? '⏳' : '○';
        const taskColor = taskComplete
          ? chalk.green
          : totalSteps > 0 && doneSteps > 0
            ? chalk.yellow
            : chalk.white;

        log(`\n${taskIcon} ${chalk.bold(`Task ${taskIdx + 1}:`)} ${taskColor(task.title)}`);
        if (totalSteps > 0) {
          log(`  Progress: ${doneSteps}/${totalSteps} steps completed`);
        }
        log(`  ${chalk.rgb(200, 200, 200)(task.description)}`);

        if (task.files && task.files.length > 0) {
          log(`  Files: ${task.files.join(', ')}`);
        }

        if (task.docs && task.docs.length > 0) {
          log(`  Docs: ${task.docs.join(', ')}`);
        }

        if (task.steps && task.steps.length > 0) {
          log('  Steps:');
          task.steps.forEach((step, stepIdx) => {
            const stepIcon = step.done ? '✓' : '○';
            const stepColor = step.done ? chalk.green : chalk.rgb(170, 170, 170);
            const prompt = step.prompt.split('\\n')[0];
            const truncated = prompt.length > 60 ? prompt.substring(0, 60) + '...' : prompt;
            log(`    ${stepIcon} ${stepColor(`Step ${stepIdx + 1}: ${truncated}`)}`);
          });
        }
      });
    }

    // Display rmfilter args if present
    if (plan.rmfilter && plan.rmfilter.length > 0) {
      log('\n' + chalk.bold('rmfilter Arguments:'));
      log('─'.repeat(60));
      log(`  ${plan.rmfilter.join(' ')}`);
    }

    // Display changed files if present
    if (plan.changedFiles && plan.changedFiles.length > 0) {
      log('\n' + chalk.bold('Changed Files:'));
      log('─'.repeat(60));
      plan.changedFiles.forEach((file) => log(`  • ${file}`));
    }

    outputLines = 50; // Approximate for full display
  }

  return outputLines;
}

export async function handleShowCommand(planFile: string | undefined, options: any, command: any) {
  const globalOpts = command.parent.opts();

  const config = await loadEffectiveConfig(globalOpts.config);

  let resolvedPlanFile: string;
  let tasksDir: string | undefined;
  let preloadedPlans: Map<number, PlanWithFilename> | undefined;
  let selectedPlan: PlanWithFilename | undefined;

  if (options.nextReady) {
    // Validate that --next-ready has a value (parent plan ID or file path)
    if (!options.nextReady || options.nextReady === true || options.nextReady.trim() === '') {
      throw new Error('--next-ready requires a parent plan ID or file path');
    }

    // Find the next ready dependency of the specified parent plan
    if (!tasksDir) {
      tasksDir = await resolveTasksDir(config);
    }

    // Convert string ID to number or resolve plan file to get numeric ID
    let parentPlanId: number;
    const planIdNumber = parseInt(options.nextReady, 10);
    if (!isNaN(planIdNumber)) {
      parentPlanId = planIdNumber;
    } else {
      // Try to resolve as a file path and get the plan ID
      const resolvedInput = await resolvePlanFile(options.nextReady, globalOpts.config);
      const planFromFile = await readPlanFile(resolvedInput);
      if (!planFromFile.id || typeof planFromFile.id !== 'number') {
        throw new Error(`Plan file ${resolvedInput} does not have a valid numeric ID`);
      }
      parentPlanId = planFromFile.id;
    }

    const result = await findNextReadyDependency(parentPlanId, tasksDir, true);

    if (!result.plan) {
      log(result.message);
      return;
    }

    log(chalk.green(`Found ready plan: ${result.plan.id} - ${result.plan.title}`));
    resolvedPlanFile = result.plan.filename;
    selectedPlan = result.plan;
  } else if (options.latest) {
    if (!tasksDir) {
      tasksDir = await resolveTasksDir(config);
    }

    const { plans } = await readAllPlans(tasksDir);
    preloadedPlans = plans;

    if (plans.size === 0) {
      log('No plans found in tasks directory.');
      return;
    }

    const candidates = await Promise.all(
      Array.from(plans.values()).map(async (candidate) => ({
        plan: candidate,
        timestamp: await getPlanTimestamp(candidate),
      }))
    );

    let latestEntry = candidates[0];
    for (const entry of candidates.slice(1)) {
      if (entry.timestamp > latestEntry.timestamp) {
        latestEntry = entry;
      }
    }

    const title = getCombinedTitle(latestEntry.plan);
    const label =
      latestEntry.plan.id !== undefined && latestEntry.plan.id !== null
        ? `${latestEntry.plan.id} - ${title}`
        : title || latestEntry.plan.filename;

    log(chalk.green(`Found latest plan: ${label}`));
    resolvedPlanFile = latestEntry.plan.filename;
    selectedPlan = latestEntry.plan;
  } else if (options.next || options.current) {
    // Find the next ready plan or current plan
    if (!tasksDir) {
      tasksDir = await resolveTasksDir(config);
    }

    const plan = await findNextPlan(tasksDir, {
      includePending: true,
      includeInProgress: options.current,
    });

    if (!plan) {
      if (options.current) {
        log('No current plans found. No plans are in progress or ready to be implemented.');
      } else {
        log('No ready plans found. All pending plans have incomplete dependencies.');
      }
      return;
    }

    const message = options.current
      ? `Found current plan: ${plan.id}`
      : `Found next ready plan: ${plan.id}`;
    log(chalk.green(message));
    resolvedPlanFile = plan.filename;
    selectedPlan = plan;
  } else {
    if (!planFile) {
      throw new Error(
        'Please provide a plan file or use --latest/--next/--current/--next-ready to find a plan'
      );
    }
    resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  }

  if (!tasksDir) {
    tasksDir = await resolveTasksDir(config);
  }

  if (!tasksDir) {
    throw new Error('Unable to resolve tasks directory for rmplan show command');
  }

  if (!preloadedPlans) {
    const { plans } = await readAllPlans(tasksDir);
    preloadedPlans = plans;
  }

  const allPlans = preloadedPlans;
  const resolvedTasksDir = tasksDir;

  // Find the specific plan from the collection
  let plan: PlanSchema | undefined = selectedPlan;

  if (!plan) {
    for (const p of allPlans.values()) {
      if (p.filename === resolvedPlanFile) {
        plan = p;
        break;
      }
    }
  }

  if (!plan) {
    // Fallback to reading the file directly if not found in collection
    plan = await readPlanFile(resolvedPlanFile);
  }

  if (!plan) {
    throw new Error(`Failed to load plan from ${resolvedPlanFile}`);
  }

  // Watch mode implementation
  if (options.watch) {
    // Force short mode for watch
    options.short = true;

    let previousLineCount = 0;
    let watchInterval: NodeJS.Timeout;

    // Handle Ctrl+C gracefully
    const handleSigint = () => {
      if (watchInterval) {
        clearInterval(watchInterval);
      }
      log('\n' + chalk.gray('Watch mode stopped.'));
      process.exit(0);
    };

    process.on('SIGINT', handleSigint);

    // Function to refresh the display
    const refreshDisplay = async () => {
      try {
        // Move cursor up by the number of lines from previous output
        if (previousLineCount > 0) {
          process.stdout.write(`\x1b[${previousLineCount}A`);
          // Removed since it causes flicker.
          // process.stdout.write('\x1b[0J'); // Clear from cursor to end
        }

        // Re-read the plan data for updates
        const updatedPlan = await readPlanFile(resolvedPlanFile);
        const { plans: updatedAllPlans } = await readAllPlans(resolvedTasksDir);

        // Display updated information
        previousLineCount = await displayPlanInfo(
          updatedPlan,
          resolvedPlanFile,
          updatedAllPlans,
          options
        );
      } catch (error) {
        // If there's an error reading the plan, just continue with the existing data
        previousLineCount = await displayPlanInfo(plan!, resolvedPlanFile, allPlans, options);
      }
    };

    // Initial display
    previousLineCount = await displayPlanInfo(plan, resolvedPlanFile, allPlans, options);

    // Set up interval to refresh every 5 seconds
    watchInterval = setInterval(refreshDisplay, 5000);

    // Keep the process alive
    return;
  }

  // Normal (non-watch) display
  await displayPlanInfo(plan, resolvedPlanFile, allPlans, options);

  log('');

  if (options.copyDetails && plan.details) {
    await clipboard.write(plan.details);
    log(chalk.green(`Copied details to clipboard`));
  }
}
