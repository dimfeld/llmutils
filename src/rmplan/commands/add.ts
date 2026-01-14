// Command handler for 'rmplan add'
// Creates a new plan stub file that can be filled with tasks using generate

import * as path from 'path';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { log } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { generateNumericPlanId } from '../id_utils.js';
import { generatePlanFilename } from '../utils/filename.js';
import { writePlanFile, readAllPlans, readPlanFile } from '../plans.js';
import { prioritySchema, statusSchema, type PlanSchema } from '../planSchema.js';
import { needArrayOrUndefined } from '../../common/cli.js';
import { updatePlanProperties } from '../planPropertiesUpdater.js';
import { resolvePlanPathContext } from '../path_resolver.js';

export async function handleAddCommand(title: string[], options: any, command: any) {
  const globalOpts = command.parent.opts();

  let planTitle: string;
  let referencedPlan: (PlanSchema & { filename: string }) | null = null;

  // Load the effective configuration
  const config = await loadEffectiveConfig(globalOpts.config);

  // Determine the target directory for the new plan file
  const { tasksDir: targetDir } = await resolvePlanPathContext(config);

  // Ensure the target directory exists
  await fs.mkdir(targetDir, { recursive: true });

  // Load all plans once at the beginning to avoid race conditions
  const { plans: allPlans } = await readAllPlans(targetDir);

  // Validate discoveredFrom option if provided
  if (options.discoveredFrom !== undefined) {
    if (typeof options.discoveredFrom !== 'number' || Number.isNaN(options.discoveredFrom)) {
      throw new Error('--discovered-from option requires a numeric plan ID');
    }
    const discoveredFromPlanId = Number(options.discoveredFrom);
    if (!Number.isInteger(discoveredFromPlanId) || discoveredFromPlanId <= 0) {
      throw new Error('--discovered-from option requires a positive integer plan ID');
    }
    if (!allPlans.has(discoveredFromPlanId)) {
      throw new Error(`Plan with ID ${discoveredFromPlanId} not found`);
    }
    options.discoveredFrom = discoveredFromPlanId;
  }

  // Handle cleanup option
  if (options.cleanup !== undefined) {
    // Validate that cleanup plan ID is provided and is positive
    if (typeof options.cleanup !== 'number') {
      throw new Error('--cleanup option requires a numeric plan ID');
    }
    if (options.cleanup <= 0) {
      throw new Error('--cleanup option requires a positive plan ID');
    }
    const foundPlan = allPlans.get(options.cleanup);
    if (!foundPlan) {
      throw new Error(`Plan with ID ${options.cleanup} not found`);
    }
    referencedPlan = foundPlan;

    // Generate default title if none provided, otherwise use custom title
    if (title.length === 0) {
      planTitle = `${referencedPlan.title} - Cleanup`;
    } else {
      planTitle = title.join(' ');
    }
  } else {
    // Regular flow - title is required when not using cleanup or edit
    if (title.length === 0) {
      if (!options.edit) {
        throw new Error('Plan title is required when not using --cleanup or --edit option');
      }
      // Use empty string when --edit is provided without a title
      planTitle = '';
    } else {
      planTitle = title.join(' ');
    }
  }

  // Generate a unique numeric plan ID
  const planId = await generateNumericPlanId(targetDir);

  // Create filename using plan ID + slugified title
  const filename = generatePlanFilename(planId, planTitle);

  // Construct the full path to the new plan file
  const filePath = path.join(targetDir, filename);

  // Validate priority if provided
  if (options.priority) {
    const validPriorities = prioritySchema.options;
    if (!validPriorities.includes(options.priority)) {
      throw new Error(
        `Invalid priority level: ${options.priority}. Must be one of: ${validPriorities.join(', ')}`
      );
    }
  }

  // Validate status if provided
  if (options.status) {
    const validStatuses = statusSchema.options;
    if (!validStatuses.includes(options.status)) {
      throw new Error(
        `Invalid status: ${options.status}. Must be one of: ${validStatuses.join(', ')}`
      );
    }
  }

  // Create the initial plan object adhering to PlanSchema
  const plan: PlanSchema = {
    id: planId,
    uuid: crypto.randomUUID(),
    title: planTitle,
    goal: '',
    details: '',
    status: options.status || 'pending',
    priority: (options.priority as 'low' | 'medium' | 'high' | 'urgent') || 'medium',
    temp: options.temp || false,
    simple: options.simple || false,
    epic: options.epic || false,
    dependencies: needArrayOrUndefined(options.dependsOn),
    parent: referencedPlan
      ? referencedPlan.id
      : options.parent
        ? Number(options.parent)
        : undefined,
    discoveredFrom:
      options.discoveredFrom !== undefined ? Number(options.discoveredFrom) : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [],
    tags: [],
  };

  // Handle cleanup-specific logic: aggregate changedFiles into rmfilter
  if (referencedPlan) {
    const filePaths = new Set<string>();

    // Add files from the referenced plan
    if (referencedPlan.changedFiles) {
      referencedPlan.changedFiles.forEach((file) => filePaths.add(file));
    }

    // Find all child plans of the referenced plan with status "done"
    for (const childPlan of allPlans.values()) {
      if (
        childPlan.parent === referencedPlan.id &&
        childPlan.status === 'done' &&
        childPlan.changedFiles
      ) {
        childPlan.changedFiles.forEach((file) => filePaths.add(file));
      }
    }

    // Convert to sorted array and set as rmfilter
    plan.rmfilter = Array.from(filePaths).sort();

    // Copy over the rmfilter args from the referenced plan
    if (referencedPlan.rmfilter?.length) {
      if (plan.rmfilter.length) {
        plan.rmfilter.push('--');
      }
      plan.rmfilter.push(...referencedPlan.rmfilter);
    }
  }

  // Apply additional properties using the shared function
  updatePlanProperties(
    plan,
    {
      rmfilter: options.rmfilter,
      issue: options.issue,
      doc: options.doc,
      assign: options.assign,
      tag: options.tag,
    },
    config
  );

  // Collect details if provided
  if (options.details) {
    plan.details = options.details;
  } else if (options.detailsFile) {
    if (options.detailsFile === '-') {
      // Read from stdin
      const { readStdin } = await import('../utils/editor.js');
      plan.details = await readStdin();
    } else {
      // Read from file
      plan.details = await fs.readFile(options.detailsFile, 'utf-8');
    }
  } else if (options.editorDetails) {
    const { openEditorForInput } = await import('../utils/editor.js');
    plan.details = await openEditorForInput('Enter plan details (markdown):');
  }

  // Update parent plan dependencies - handles both regular parent and cleanup cases
  const parentPlanId = referencedPlan ? referencedPlan.id : options.parent;
  if (parentPlanId !== undefined) {
    const parentPlan = allPlans.get(parentPlanId);
    if (!parentPlan) {
      throw new Error(`Parent plan with ID ${parentPlanId} not found`);
    }

    // Add this plan's ID to the parent's dependencies
    if (!parentPlan.dependencies) {
      parentPlan.dependencies = [];
    }
    if (!parentPlan.dependencies.includes(planId)) {
      parentPlan.dependencies.push(planId);
      parentPlan.updatedAt = new Date().toISOString();

      if (parentPlan.status === 'done') {
        parentPlan.status = 'in_progress';
        log(chalk.yellow(`  Parent plan "${parentPlan.title}" marked as in_progress`));
      }

      // Write the updated parent plan
      await writePlanFile(parentPlan.filename, parentPlan);
      log(chalk.gray(`  Updated parent plan ${parentPlan.id} to include dependency on ${planId}`));
    }
  }

  // Write the plan to the new file
  await writePlanFile(filePath, plan);

  // Log success message
  log(chalk.green('\u2713 Created plan stub:'), filePath, 'for ID', chalk.green(planId));
  log(`  Next step: Add plan detail and run the generate process.`);

  // Open in editor if requested
  if (options.edit) {
    const editor = process.env.EDITOR || 'nano';
    const editorProcess = Bun.spawn([editor, filePath], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    await editorProcess.exited;

    // Read the edited plan to check if title was updated
    const editedPlan = await readPlanFile(filePath);

    // If the title changed, rename the file to match
    if (editedPlan.title && editedPlan.title !== planTitle) {
      const newFilename = generatePlanFilename(planId, editedPlan.title);
      const newFilePath = path.join(targetDir, newFilename);

      // Only rename if the new filename is different
      if (newFilename !== filename) {
        await fs.rename(filePath, newFilePath);
        log(chalk.gray(`  Renamed plan file to: ${newFilename}`));
      }
    }
  }
}
